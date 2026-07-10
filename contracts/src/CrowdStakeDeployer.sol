// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AbstractCycleModule} from "./abstract/AbstractCycleModule.sol";
import {BaseDistributionManager} from "./base/BaseDistributionManager.sol";
import {MultiStrategyDistributionManager} from "./base/MultiStrategyDistributionManager.sol";
import {AbstractDistributionManager} from "./abstract/AbstractDistributionManager.sol";
import {VotingDistributionStrategy} from "./implementation/strategies/VotingDistributionStrategy.sol";
import {EqualDistributionStrategy} from "./implementation/strategies/EqualDistributionStrategy.sol";
import {AdminRecipientRegistry} from "./implementation/registries/AdminRecipientRegistry.sol";
import {VotingRecipientRegistry} from "./implementation/registries/VotingRecipientRegistry.sol";
import {SexyDaiYield} from "./implementation/token/SexyDaiYield.sol";
import {AbstractToken} from "./abstract/AbstractToken.sol";
import {TimeWeightedVotingPower} from "./implementation/TimeWeightedVotingPower.sol";
import {IVotingPowerStrategy} from "./interfaces/IVotingPowerStrategy.sol";
import {IVotesCheckpoints} from "./interfaces/IVotesCheckpoints.sol";
import {IDistributionStrategy} from "./interfaces/IDistributionStrategy.sol";

/// @notice Minimal view of CrowdStakeFactory's deployment entrypoints.
interface ICrowdStakeFactory {
    function create(address beacon, bytes calldata payload, bytes32 salt) external returns (address);
    function createToken(address beacon, bytes calldata payload, bytes32 salt) external returns (address);
}

/// @title CrowdStakeDeployer
/// @notice The one canonical, one-transaction deployer for a complete, fully-wired
///         CrowdStake instance. The caller chooses:
///           - the recipient registry kind — an admin-controlled registry or a democratic
///             VotingRecipientRegistry where current recipients vote to add/remove members;
///           - the yield distribution strategy — proportional to votes, split equally among
///             recipients, or a 50/50 split of the two (see {DistributionKind});
///         and optionally supplies instance artwork (token + banner image URIs) that is
///         written to the distribution manager (the app's canonical per-instance key) in the
///         same tx. Reuses one CrowdStakeFactory + its allowlisted beacons.
contract CrowdStakeDeployer {
    /// @notice Protocol tag mixed into every familyId — prevents cross-protocol collisions.
    bytes32 private constant FAMILY_TAG = keccak256("crowdstake.family.v2");

    ICrowdStakeFactory public immutable FACTORY;
    address public immutable CYCLE_BEACON;
    address public immutable REGISTRY_BEACON; // AdminRecipientRegistry
    address public immutable VOTING_REGISTRY_BEACON; // VotingRecipientRegistry
    address public immutable TOKEN_BEACON;
    address public immutable DIST_MANAGER_BEACON; // BaseDistributionManager (single strategy)
    address public immutable MULTI_DIST_MANAGER_BEACON; // MultiStrategyDistributionManager
    address public immutable STRATEGY_BEACON; // VotingDistributionStrategy
    address public immutable EQUAL_STRATEGY_BEACON; // EqualDistributionStrategy
    address public immutable VOTING_BEACON;

    /// @notice 0 = admin-controlled registry, 1 = democratic (recipient-voted).
    enum RegistryKind {
        Admin,
        Voting
    }

    /// @notice How claimed yield is split among recipients each cycle.
    /// @dev Proportional uses BaseDistributionManager + VotingDistributionStrategy (votes drive
    ///      the split; a cycle with zero votes never distributes). Equal and Split use
    ///      MultiStrategyDistributionManager, which permits zero-voter cycles:
    ///        - Equal: a single EqualDistributionStrategy (every recipient gets 1/N).
    ///        - Split: [VotingDistributionStrategy, EqualDistributionStrategy] — half the yield
    ///          is distributed by votes, half equally. (The vote half still needs votes to be
    ///          present at cycle end, otherwise the proportional strategy reverts.)
    enum DistributionKind {
        Proportional,
        Equal,
        Split
    }

    /// @notice Optional pre-deployed custom modules; address(0) / empty = deploy the
    ///         canonical module. Custom modules must implement the corresponding
    ///         crowdstake interface. Registry/token/cycle overrides are expected to be
    ///         ALREADY initialized (owned by the caller); votingModule/distributionStrategy
    ///         overrides are wired by address here and must be initialized by the caller
    ///         AFTER this deploy (their initializers take the new distribution manager).
    ///         Wiring the deployer cannot do on caller-owned overrides is left to the
    ///         caller: cycle.setDistributionManager(dm) and token.setYieldClaimer(dm).
    struct ModuleOverrides {
        address recipientRegistry;
        address token;
        address cycleModule;
        address votingModule;
        address distributionStrategy;
        address[] votingPowerStrategies;
    }

    struct Params {
        address owner;
        uint256 cycleLength;
        string tokenName;
        string tokenSymbol;
        uint256 maxVotingPoints;
        bytes32 salt;
        // Recipient governance
        uint8 registryKind; // 0 = admin, 1 = democratic
        address[] initialRecipients; // democratic only: the founding recipient cohort
        uint256 proposalExpiry; // democratic only: seconds a proposal stays open
        // Yield distribution
        uint8 distributionKind; // 0 = proportional, 1 = equal, 2 = split (half/half)
        // Instance artwork (off-chain URIs: ipfs/https/data). Empty = none.
        string tokenImageURI;
        string bannerImageURI;
        // Cross-chain family: true = this instance joins the familyIdOf(...) family and its
        // voting module accepts ONLY chain-agnostic castCrossChainVote ballots.
        bool crossChain;
        // Custom pre-deployed modules (see ModuleOverrides). Incompatible with crossChain:
        // family instances rely on familyId being threaded through the canonical modules.
        ModuleOverrides overrides;
    }

    struct Instance {
        address cycleModule;
        address registry;
        address token;
        address votingPowerStrategy;
        address distributionManager;
        address distributionStrategy; // primary: voting strat (proportional/split) or equal strat (equal)
        address secondaryDistributionStrategy; // split only: the equal strat; else address(0)
        address votingModule;
    }

    error ZeroOwner();
    error ZeroCycleLength();
    error InvalidRegistryKind();
    error InvalidDistributionKind();
    error EmptyInitialRecipients();
    error ZeroProposalExpiry();
    error FamilyAlreadyDeployed();
    /// @notice A module override was provided but has no deployed code.
    error OverrideHasNoCode(address module);
    /// @notice A custom distribution strategy only composes with the proportional
    ///         (single-strategy) manager; equal/split are canonical-only for now.
    error StrategyOverrideRequiresProportional();
    /// @notice Module overrides cannot join a cross-chain family: familyId is threaded
    ///         through the canonical modules' initializers, which overrides skip.
    error OverridesIncompatibleWithCrossChain();

    /// @notice Emitted once a full instance is deployed and handed to its owner.
    event SystemDeployed(address indexed owner, address indexed deployer, bytes32 indexed salt, Instance instance);

    /// @notice Emitted when a cross-chain family instance is deployed on this chain.
    event FamilyDeployed(bytes32 indexed familyId, address indexed creator, address indexed owner);

    /// @notice The family instance deployed on this chain, by familyId (zero addresses = none).
    /// @dev The public getter returns the full 8-address tuple, so ONE eth_call per chain
    ///      resolves a sibling completely.
    mapping(bytes32 => Instance) public familyInstances;

    constructor(
        address factory,
        address cycleBeacon,
        address registryBeacon,
        address votingRegistryBeacon,
        address tokenBeacon,
        address distManagerBeacon,
        address multiDistManagerBeacon,
        address strategyBeacon,
        address equalStrategyBeacon,
        address votingBeacon
    ) {
        FACTORY = ICrowdStakeFactory(factory);
        CYCLE_BEACON = cycleBeacon;
        REGISTRY_BEACON = registryBeacon;
        VOTING_REGISTRY_BEACON = votingRegistryBeacon;
        TOKEN_BEACON = tokenBeacon;
        DIST_MANAGER_BEACON = distManagerBeacon;
        MULTI_DIST_MANAGER_BEACON = multiDistManagerBeacon;
        STRATEGY_BEACON = strategyBeacon;
        EQUAL_STRATEGY_BEACON = equalStrategyBeacon;
        VOTING_BEACON = votingBeacon;
    }

    /// @notice The deterministic identity a deploy(p) with p.crossChain would create/extend.
    /// @dev Creator-scoped (only the same wallet can extend its family), protocol-tagged, and
    ///      config-committing: a different name/symbol/maxPoints/registryKind/distributionKind
    ///      can NEVER merge into one family.
    function familyIdOf(
        address creator,
        bytes32 salt,
        string memory tokenName,
        string memory tokenSymbol,
        uint256 maxVotingPoints,
        uint8 registryKind,
        uint8 distributionKind
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                FAMILY_TAG,
                creator,
                salt,
                keccak256(bytes(tokenName)),
                keccak256(bytes(tokenSymbol)),
                maxVotingPoints,
                registryKind,
                distributionKind
            )
        );
    }

    /// @notice The familyId for a Voting-kind cross-chain deploy — commits the founding cohort.
    /// @dev A democratic family MUST commit its initialRecipients and proposalExpiry: same
    ///      creator/salt with different founders on two chains would otherwise mint one family
    ///      with permanently drifted electorates and no heal path. Folds the base familyIdOf with
    ///      keccak256(abi.encodePacked(initialRecipients)) and proposalExpiry. Admin-kind stays on
    ///      the base familyIdOf (byte-identical to today).
    function votingFamilyIdOf(
        address creator,
        bytes32 salt,
        string memory tokenName,
        string memory tokenSymbol,
        uint256 maxVotingPoints,
        uint8 distributionKind,
        address[] memory initialRecipients,
        uint256 proposalExpiry
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                familyIdOf(
                    creator, salt, tokenName, tokenSymbol, maxVotingPoints, uint8(RegistryKind.Voting), distributionKind
                ),
                keccak256(abi.encodePacked(initialRecipients)),
                proposalExpiry
            )
        );
    }

    /// @notice Deploy a full, working CrowdStake instance in one transaction.
    ///         Any slot in p.overrides replaces the canonical module: the deployer wires
    ///         the given address instead of creating one. Caller-owned overrides keep the
    ///         wiring the deployer cannot perform (see ModuleOverrides docs).
    function deploy(Params calldata p) external returns (Instance memory inst) {
        _validate(p);

        bytes32 familyId;
        if (p.crossChain) {
            // Voting-kind families commit their founding cohort + expiry; admin-kind stays on the
            // base derivation (byte-identical to today).
            if (p.registryKind == uint8(RegistryKind.Voting)) {
                familyId = votingFamilyIdOf(
                    msg.sender,
                    p.salt,
                    p.tokenName,
                    p.tokenSymbol,
                    p.maxVotingPoints,
                    p.distributionKind,
                    p.initialRecipients,
                    p.proposalExpiry
                );
            } else {
                familyId = familyIdOf(
                    msg.sender,
                    p.salt,
                    p.tokenName,
                    p.tokenSymbol,
                    p.maxVotingPoints,
                    p.registryKind,
                    p.distributionKind
                );
            }
            if (familyInstances[familyId].votingModule != address(0)) revert FamilyAlreadyDeployed();
        }

        bytes32 baseSalt = keccak256(abi.encodePacked(p.salt, msg.sender));
        address self = address(this);
        bool customCycle = p.overrides.cycleModule != address(0);
        bool customToken = p.overrides.token != address(0);

        // 1. Cycle module (deployer-owned for wiring), unless overridden.
        inst.cycleModule = customCycle
            ? p.overrides.cycleModule
            : FACTORY.create(
                CYCLE_BEACON,
                abi.encodeWithSelector(AbstractCycleModule.initialize.selector, p.cycleLength, self),
                keccak256(abi.encodePacked(baseSalt, "cycle"))
            );

        // 2. Recipient registry — custom, admin-controlled, or democratic. familyId (0 when
        //    !crossChain) is threaded in so family instances accept the chain-agnostic
        //    governance signatures. encodeWithSignature: `initialize` is overloaded, so
        //    `.selector` is ambiguous.
        if (p.overrides.recipientRegistry != address(0)) {
            inst.registry = p.overrides.recipientRegistry;
        } else if (p.registryKind == uint8(RegistryKind.Voting)) {
            inst.registry = FACTORY.create(
                VOTING_REGISTRY_BEACON,
                abi.encodeWithSignature(
                    "initialize(address,address[],uint256,bytes32)",
                    p.owner,
                    p.initialRecipients,
                    p.proposalExpiry,
                    familyId
                ),
                keccak256(abi.encodePacked(baseSalt, "registry"))
            );
        } else {
            inst.registry = FACTORY.create(
                REGISTRY_BEACON,
                abi.encodeWithSignature("initialize(address,bytes32)", p.owner, familyId),
                keccak256(abi.encodePacked(baseSalt, "registry"))
            );
        }

        // 3. Token (deployer-owned so it can set the yield claimer), unless overridden.
        inst.token = customToken
            ? p.overrides.token
            : FACTORY.createToken(
                TOKEN_BEACON,
                abi.encodeWithSelector(SexyDaiYield.initialize.selector, p.tokenName, p.tokenSymbol, self),
                keccak256(abi.encodePacked(baseSalt, "token"))
            );

        // 4. Voting power. Custom strategies are used as-is; otherwise deploy the
        //    canonical time-weighted strategy — but only when the voting module is
        //    canonical too (a custom module brings its own strategies at its init).
        if (p.overrides.votingPowerStrategies.length != 0) {
            inst.votingPowerStrategy = p.overrides.votingPowerStrategies[0];
        } else if (p.overrides.votingModule == address(0)) {
            inst.votingPowerStrategy = address(
                new TimeWeightedVotingPower(IVotesCheckpoints(inst.token), AbstractCycleModule(inst.cycleModule))
            );
        }

        // 5-6. Distribution manager + strategies (kind-dependent; deployer-owned, wired below).
        if (p.distributionKind == uint8(DistributionKind.Proportional)) {
            _deployProportional(inst, baseSalt, self, p.owner, p.overrides.distributionStrategy);
        } else {
            _deployMulti(inst, baseSalt, self, p.owner, p.distributionKind == uint8(DistributionKind.Split));
        }

        // 7. Voting module, unless overridden (a custom module is wired by address and
        //    initialized by the caller afterwards — its initializer needs the DM above).
        //    familyId = 0 → classic chain-bound instance. encodeWithSignature:
        //    `initialize` is overloaded, so `.selector` is ambiguous.
        if (p.overrides.votingModule != address(0)) {
            inst.votingModule = p.overrides.votingModule;
        } else {
            inst.votingModule = FACTORY.create(
                VOTING_BEACON,
                abi.encodeWithSignature(
                    "initialize(uint256,address[],address,address,bytes32)",
                    p.maxVotingPoints,
                    _votingPowerSet(p, inst),
                    inst.distributionManager,
                    p.owner,
                    familyId
                ),
                keccak256(abi.encodePacked(baseSalt, "voting"))
            );
        }

        // Wire shared references + authorise the manager as the token's yield claimer.
        // Caller-owned overrides are skipped: the deployer has no privileges on them,
        // so cycle.setDistributionManager(dm) / token.setYieldClaimer(dm) stay with the caller.
        AbstractDistributionManager(inst.distributionManager).setVotingModule(inst.votingModule);
        if (!customCycle) AbstractCycleModule(inst.cycleModule).setDistributionManager(inst.distributionManager);
        if (!customToken) AbstractToken(inst.token).setYieldClaimer(inst.distributionManager);

        // Seed instance artwork on the distribution manager while still owner-of-record.
        if (bytes(p.tokenImageURI).length != 0 || bytes(p.bannerImageURI).length != 0) {
            AbstractDistributionManager(inst.distributionManager).setInstanceMetadata(p.tokenImageURI, p.bannerImageURI);
        }

        // Hand the temporarily-owned contracts to the final owner (overrides never
        // belonged to the deployer, so there is nothing to hand over for them).
        if (!customToken) AbstractToken(inst.token).transferOwnership(p.owner);
        AbstractDistributionManager(inst.distributionManager).transferOwnership(p.owner);
        if (!customCycle) AbstractCycleModule(inst.cycleModule).transferOwnership(p.owner);

        // Record the family sibling only after full wiring, so a resolved instance is usable.
        if (p.crossChain) {
            familyInstances[familyId] = inst;
            emit FamilyDeployed(familyId, msg.sender, p.owner);
        }

        emit SystemDeployed(p.owner, msg.sender, p.salt, inst);
    }

    /// @dev Parameter validation, pulled out of deploy() for stack room. Overridden
    ///      slots relax the checks their canonical params would need (cycleLength,
    ///      democratic config) and must point at deployed code.
    function _validate(Params calldata p) private view {
        if (p.owner == address(0)) revert ZeroOwner();
        if (p.registryKind > uint8(RegistryKind.Voting)) revert InvalidRegistryKind();
        if (p.distributionKind > uint8(DistributionKind.Split)) revert InvalidDistributionKind();
        if (p.overrides.cycleModule == address(0) && p.cycleLength == 0) revert ZeroCycleLength();
        if (p.overrides.recipientRegistry == address(0) && p.registryKind == uint8(RegistryKind.Voting)) {
            // Pre-validate here so a bad config reverts cleanly instead of deep in
            // the registry's initialize (which would abort the whole one-tx deploy).
            if (p.initialRecipients.length == 0) revert EmptyInitialRecipients();
            if (p.proposalExpiry == 0) revert ZeroProposalExpiry();
        }
        // A custom strategy is a single-strategy wiring; the multi-manager kinds
        // (equal/split) compose canonical strategies only for now.
        if (
            p.overrides.distributionStrategy != address(0) && p.distributionKind != uint8(DistributionKind.Proportional)
        ) {
            revert StrategyOverrideRequiresProportional();
        }
        // Families thread familyId through the canonical modules' initializers, which
        // overridden modules never receive — the combination would silently break
        // sign-once cross-chain governance, so reject it outright.
        if (p.crossChain && _hasAnyOverride(p.overrides)) revert OverridesIncompatibleWithCrossChain();
        _requireCode(p.overrides.recipientRegistry);
        _requireCode(p.overrides.token);
        _requireCode(p.overrides.cycleModule);
        _requireCode(p.overrides.votingModule);
        _requireCode(p.overrides.distributionStrategy);
        for (uint256 i = 0; i < p.overrides.votingPowerStrategies.length; i++) {
            address s = p.overrides.votingPowerStrategies[i];
            if (s == address(0) || s.code.length == 0) revert OverrideHasNoCode(s);
        }
    }

    /// @dev Whether any override slot is filled (used to gate crossChain).
    function _hasAnyOverride(ModuleOverrides calldata o) private pure returns (bool) {
        return o.recipientRegistry != address(0) || o.token != address(0) || o.cycleModule != address(0)
            || o.votingModule != address(0) || o.distributionStrategy != address(0)
            || o.votingPowerStrategies.length != 0;
    }

    /// @dev Overrides must be live contracts — a codeless override would deploy a
    ///      wired-but-dead instance.
    function _requireCode(address module) private view {
        if (module != address(0) && module.code.length == 0) revert OverrideHasNoCode(module);
    }

    /// @dev The strategy set for the canonical voting module: the override array when
    ///      provided, else the single canonical time-weighted strategy deployed above.
    function _votingPowerSet(Params calldata p, Instance memory inst)
        private
        pure
        returns (IVotingPowerStrategy[] memory vps)
    {
        uint256 n = p.overrides.votingPowerStrategies.length;
        if (n == 0) {
            vps = new IVotingPowerStrategy[](1);
            vps[0] = IVotingPowerStrategy(inst.votingPowerStrategy);
        } else {
            vps = new IVotingPowerStrategy[](n);
            for (uint256 i = 0; i < n; i++) {
                vps[i] = IVotingPowerStrategy(p.overrides.votingPowerStrategies[i]);
            }
        }
    }

    /// @dev Proportional: BaseDistributionManager (single strategy) + VotingDistributionStrategy.
    ///      The manager is created with a placeholder strategy, then wired via
    ///      setDistributionStrategy once the strategy (which references the manager) exists.
    ///      A custom strategy override is wired by address instead — its initializer takes
    ///      this manager's address, so the caller initializes it after this deploy.
    function _deployProportional(
        Instance memory inst,
        bytes32 baseSalt,
        address self,
        address owner,
        address strategyOverride
    ) private {
        inst.distributionManager = FACTORY.create(
            DIST_MANAGER_BEACON,
            abi.encodeWithSelector(
                BaseDistributionManager.initialize.selector,
                inst.cycleModule,
                inst.registry,
                inst.token,
                self, // placeholder votingModule
                address(0), // placeholder strategy
                self // deployer owns it temporarily
            ),
            keccak256(abi.encodePacked(baseSalt, "dist-manager"))
        );

        inst.distributionStrategy = strategyOverride != address(0)
            ? strategyOverride
            : FACTORY.create(
                STRATEGY_BEACON,
                abi.encodeWithSelector(
                    VotingDistributionStrategy.initialize.selector, inst.token, inst.distributionManager, owner
                ),
                keccak256(abi.encodePacked(baseSalt, "strategy"))
            );

        BaseDistributionManager(inst.distributionManager).setDistributionStrategy(inst.distributionStrategy);
    }

    /// @dev Equal / Split: MultiStrategyDistributionManager (permits zero-voter cycles). Created
    ///      with an empty strategy set, then wired via setStrategies once the strategies (which
    ///      reference the manager) exist. `split` adds a VotingDistributionStrategy so half the
    ///      yield is distributed by votes and half equally; otherwise it is purely equal.
    function _deployMulti(Instance memory inst, bytes32 baseSalt, address self, address owner, bool split) private {
        IDistributionStrategy[] memory none = new IDistributionStrategy[](0);
        inst.distributionManager = FACTORY.create(
            MULTI_DIST_MANAGER_BEACON,
            abi.encodeWithSelector(
                MultiStrategyDistributionManager.initialize.selector,
                inst.cycleModule,
                inst.registry,
                inst.token,
                self, // placeholder votingModule
                none, // empty; strategies wired below via setStrategies
                self // deployer owns it temporarily
            ),
            keccak256(abi.encodePacked(baseSalt, "dist-manager"))
        );

        address equalStrat = FACTORY.create(
            EQUAL_STRATEGY_BEACON,
            abi.encodeWithSelector(
                EqualDistributionStrategy.initialize.selector, inst.token, inst.distributionManager, owner
            ),
            keccak256(abi.encodePacked(baseSalt, "equal-strategy"))
        );

        IDistributionStrategy[] memory strategies;
        if (split) {
            // Primary = voting (proportional half), secondary = equal half.
            inst.distributionStrategy = FACTORY.create(
                STRATEGY_BEACON,
                abi.encodeWithSelector(
                    VotingDistributionStrategy.initialize.selector, inst.token, inst.distributionManager, owner
                ),
                keccak256(abi.encodePacked(baseSalt, "strategy"))
            );
            inst.secondaryDistributionStrategy = equalStrat;
            strategies = new IDistributionStrategy[](2);
            strategies[0] = IDistributionStrategy(inst.distributionStrategy);
            strategies[1] = IDistributionStrategy(equalStrat);
        } else {
            // Pure equal: the equal strategy is the primary and only strategy.
            inst.distributionStrategy = equalStrat;
            strategies = new IDistributionStrategy[](1);
            strategies[0] = IDistributionStrategy(equalStrat);
        }

        MultiStrategyDistributionManager(inst.distributionManager).setStrategies(strategies);
    }
}
