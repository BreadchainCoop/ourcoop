// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {CrowdStakeFactory} from "../src/CrowdStakeFactory.sol";
import {CrowdStakeDeployer} from "../src/CrowdStakeDeployer.sol";

import {CycleModule} from "../src/implementation/CycleModule.sol";
import {AbstractCycleModule} from "../src/abstract/AbstractCycleModule.sol";
import {BasisPointsVotingModule} from "../src/base/BasisPointsVotingModule.sol";
import {BaseDistributionManager} from "../src/base/BaseDistributionManager.sol";
import {MultiStrategyDistributionManager} from "../src/base/MultiStrategyDistributionManager.sol";
import {AbstractDistributionManager} from "../src/abstract/AbstractDistributionManager.sol";
import {VotingDistributionStrategy} from "../src/implementation/strategies/VotingDistributionStrategy.sol";
import {EqualDistributionStrategy} from "../src/implementation/strategies/EqualDistributionStrategy.sol";
import {AdminRecipientRegistry} from "../src/implementation/registries/AdminRecipientRegistry.sol";
import {VotingRecipientRegistry} from "../src/implementation/registries/VotingRecipientRegistry.sol";
import {SexyDaiYield} from "../src/implementation/token/SexyDaiYield.sol";
import {IVotingPowerStrategy} from "../src/interfaces/IVotingPowerStrategy.sol";
import {AbstractToken} from "../src/abstract/AbstractToken.sol";

interface IOwnable {
    function owner() external view returns (address);
}

interface IFamilyId {
    function familyId() external view returns (bytes32);
    function lastRegistryUpdateNonce() external view returns (uint256);
}

contract CrowdStakeDeployerTest is Test {
    CrowdStakeDeployer internal deployer;

    address internal constant WXDAI = address(0x11dA1);
    address internal constant SXDAI = address(0x5DA1);
    address internal constant OWNER = address(0xABCD);
    address internal constant FOUNDER = address(0xF00D);

    string internal constant TOKEN_IMG = "ipfs://bafyTokenImage";
    string internal constant BANNER_IMG = "https://example.org/banner.png";

    function setUp() public {
        CrowdStakeFactory factory = new CrowdStakeFactory(address(this));

        address cycleBeacon = address(new UpgradeableBeacon(address(new CycleModule()), address(this)));
        address registryBeacon = address(new UpgradeableBeacon(address(new AdminRecipientRegistry()), address(this)));
        address votingRegistryBeacon =
            address(new UpgradeableBeacon(address(new VotingRecipientRegistry()), address(this)));
        address tokenBeacon = address(new UpgradeableBeacon(address(new SexyDaiYield(WXDAI, SXDAI)), address(this)));
        address distBeacon = address(new UpgradeableBeacon(address(new BaseDistributionManager()), address(this)));
        address multiDistBeacon =
            address(new UpgradeableBeacon(address(new MultiStrategyDistributionManager()), address(this)));
        address stratBeacon = address(new UpgradeableBeacon(address(new VotingDistributionStrategy()), address(this)));
        address equalStratBeacon =
            address(new UpgradeableBeacon(address(new EqualDistributionStrategy()), address(this)));
        address votingBeacon = address(new UpgradeableBeacon(address(new BasisPointsVotingModule()), address(this)));

        address[] memory beacons = new address[](9);
        beacons[0] = cycleBeacon;
        beacons[1] = registryBeacon;
        beacons[2] = votingRegistryBeacon;
        beacons[3] = tokenBeacon;
        beacons[4] = distBeacon;
        beacons[5] = multiDistBeacon;
        beacons[6] = stratBeacon;
        beacons[7] = equalStratBeacon;
        beacons[8] = votingBeacon;
        factory.allowlistBeacons(beacons);

        deployer = new CrowdStakeDeployer(
            address(factory),
            cycleBeacon,
            registryBeacon,
            votingRegistryBeacon,
            tokenBeacon,
            distBeacon,
            multiDistBeacon,
            stratBeacon,
            equalStratBeacon,
            votingBeacon
        );
    }

    function _noOverrides() internal pure returns (CrowdStakeDeployer.ModuleOverrides memory) {
        return CrowdStakeDeployer.ModuleOverrides({
            recipientRegistry: address(0),
            token: address(0),
            cycleModule: address(0),
            votingModule: address(0),
            distributionStrategy: address(0),
            votingPowerStrategies: new address[](0)
        });
    }

    function _adminParams(bytes32 salt) internal pure returns (CrowdStakeDeployer.Params memory) {
        return CrowdStakeDeployer.Params({
            owner: OWNER,
            cycleLength: 100,
            tokenName: "Admin Stake",
            tokenSymbol: "ADMN",
            maxVotingPoints: 10_000,
            salt: salt,
            registryKind: 0,
            initialRecipients: new address[](0),
            proposalExpiry: 0,
            distributionKind: 0, // proportional
            tokenImageURI: "",
            bannerImageURI: "",
            crossChain: false,
            overrides: _noOverrides()
        });
    }

    function _votingParams(bytes32 salt, address[] memory founders, uint256 expiry)
        internal
        pure
        returns (CrowdStakeDeployer.Params memory)
    {
        return CrowdStakeDeployer.Params({
            owner: OWNER,
            cycleLength: 100,
            tokenName: "Demo Stake",
            tokenSymbol: "DEMO",
            maxVotingPoints: 10_000,
            salt: salt,
            registryKind: 1,
            initialRecipients: founders,
            proposalExpiry: expiry,
            distributionKind: 0, // proportional
            tokenImageURI: "",
            bannerImageURI: "",
            crossChain: false,
            overrides: _noOverrides()
        });
    }

    function test_DeploysAdminInstance() public {
        CrowdStakeDeployer.Instance memory i = deployer.deploy(_adminParams("admin-1"));
        assertEq(IOwnable(i.registry).owner(), OWNER, "registry owner");
        assertEq(AdminRecipientRegistry(i.registry).getRecipientCount(), 0, "admin starts empty");
        assertEq(AbstractToken(i.token).yieldClaimer(), i.distributionManager, "yieldClaimer wired");
        assertEq(AbstractCycleModule(i.cycleModule).getCurrentCycle(), 1, "cycle #1");
    }

    function test_DeploysVotingInstance() public {
        address[] memory founders = new address[](1);
        founders[0] = FOUNDER;
        CrowdStakeDeployer.Instance memory i = deployer.deploy(_votingParams("voting-1", founders, 7 days));

        VotingRecipientRegistry reg = VotingRecipientRegistry(i.registry);
        assertEq(reg.owner(), OWNER, "registry owner");
        assertEq(reg.proposalExpiry(), 7 days, "proposal expiry");
        assertEq(reg.getRecipientCount(), 1, "one founding recipient");
        assertTrue(reg.isRecipient(FOUNDER), "founder is a recipient");

        assertEq(AbstractToken(i.token).yieldClaimer(), i.distributionManager, "yieldClaimer wired");
        assertEq(AbstractCycleModule(i.cycleModule).distributionManager(), i.distributionManager, "cycle->distMgr");
    }

    function test_VotingFounderCanProposeExecuteProcess() public {
        address[] memory founders = new address[](1);
        founders[0] = FOUNDER;
        CrowdStakeDeployer.Instance memory i = deployer.deploy(_votingParams("voting-2", founders, 7 days));
        VotingRecipientRegistry reg = VotingRecipientRegistry(i.registry);

        vm.prank(FOUNDER);
        uint256 pid = reg.proposeAddition(address(0xBEEF));
        reg.executeProposal(pid);
        reg.processQueue();
        assertEq(reg.getRecipientCount(), 2, "candidate added by unanimous (n=1) vote");
        assertTrue(reg.isRecipient(address(0xBEEF)), "new recipient active");
    }

    // ---- Distribution strategy kinds ----

    function test_DeploysEqualDistribution() public {
        CrowdStakeDeployer.Params memory p = _adminParams("equal-1");
        p.distributionKind = 1; // equal
        CrowdStakeDeployer.Instance memory i = deployer.deploy(p);

        MultiStrategyDistributionManager dm = MultiStrategyDistributionManager(i.distributionManager);
        assertEq(dm.getStrategyCount(), 1, "single equal strategy");
        assertEq(address(dm.strategies(0)), i.distributionStrategy, "equal strat wired as strategy[0]");
        assertEq(i.secondaryDistributionStrategy, address(0), "no secondary for pure equal");
        assertEq(IOwnable(i.distributionManager).owner(), OWNER, "manager owner");
        assertEq(AbstractToken(i.token).yieldClaimer(), i.distributionManager, "yieldClaimer wired");
    }

    function test_DeploysSplitDistribution() public {
        CrowdStakeDeployer.Params memory p = _adminParams("split-1");
        p.distributionKind = 2; // split (half votes / half equal)
        CrowdStakeDeployer.Instance memory i = deployer.deploy(p);

        MultiStrategyDistributionManager dm = MultiStrategyDistributionManager(i.distributionManager);
        assertEq(dm.getStrategyCount(), 2, "voting + equal strategies");
        assertEq(address(dm.strategies(0)), i.distributionStrategy, "voting strat is primary/strategy[0]");
        assertEq(address(dm.strategies(1)), i.secondaryDistributionStrategy, "equal strat is secondary/strategy[1]");
        assertTrue(i.distributionStrategy != address(0) && i.secondaryDistributionStrategy != address(0), "both set");
        assertEq(IOwnable(i.distributionManager).owner(), OWNER, "manager owner");
    }

    function test_RevertWhen_InvalidDistributionKind() public {
        CrowdStakeDeployer.Params memory p = _adminParams("bad-dist");
        p.distributionKind = 3; // out of range
        vm.expectRevert(CrowdStakeDeployer.InvalidDistributionKind.selector);
        deployer.deploy(p);
    }

    // ---- Instance metadata ----

    function test_DeploySeedsMetadata() public {
        CrowdStakeDeployer.Params memory p = _adminParams("meta-1");
        p.tokenImageURI = TOKEN_IMG;
        p.bannerImageURI = BANNER_IMG;
        CrowdStakeDeployer.Instance memory i = deployer.deploy(p);

        AbstractDistributionManager dm = AbstractDistributionManager(i.distributionManager);
        assertEq(dm.tokenImageURI(), TOKEN_IMG, "token image seeded");
        assertEq(dm.bannerImageURI(), BANNER_IMG, "banner image seeded");
        assertGt(bytes(dm.contractURI()).length, 0, "contractURI assembled");
        // The token pulls contractURI from its distribution manager (the claimer).
        assertEq(AbstractToken(i.token).contractURI(), dm.contractURI(), "token pulls contractURI from dist manager");
    }

    function test_OwnerCanUpdateMetadata() public {
        CrowdStakeDeployer.Instance memory i = deployer.deploy(_adminParams("meta-2"));
        AbstractDistributionManager dm = AbstractDistributionManager(i.distributionManager);
        assertEq(dm.tokenImageURI(), "", "starts empty");

        vm.prank(OWNER);
        dm.setInstanceMetadata(TOKEN_IMG, BANNER_IMG);
        assertEq(dm.tokenImageURI(), TOKEN_IMG, "owner updated token image");
        assertEq(dm.bannerImageURI(), BANNER_IMG, "owner updated banner");
    }

    function test_RevertWhen_NonOwnerSetsMetadata() public {
        CrowdStakeDeployer.Instance memory i = deployer.deploy(_adminParams("meta-3"));
        vm.prank(address(0xDEAD));
        vm.expectRevert();
        AbstractDistributionManager(i.distributionManager).setInstanceMetadata(TOKEN_IMG, BANNER_IMG);
    }

    // ---- Guards ----

    function test_RevertWhen_VotingEmptyInitialRecipients() public {
        vm.expectRevert(CrowdStakeDeployer.EmptyInitialRecipients.selector);
        deployer.deploy(_votingParams("bad-1", new address[](0), 7 days));
    }

    function test_RevertWhen_VotingZeroProposalExpiry() public {
        address[] memory founders = new address[](1);
        founders[0] = FOUNDER;
        vm.expectRevert(CrowdStakeDeployer.ZeroProposalExpiry.selector);
        deployer.deploy(_votingParams("bad-2", founders, 0));
    }

    function test_RevertWhen_OwnerIsZero() public {
        CrowdStakeDeployer.Params memory p = _adminParams("z");
        p.owner = address(0);
        vm.expectRevert(CrowdStakeDeployer.ZeroOwner.selector);
        deployer.deploy(p);
    }

    // ---- Cross-chain family ----

    /// @dev familyIdOf must exactly mirror the pure derivation (protocol tag + config commit).
    function test_FamilyIdOf_MirrorsDerivation() public view {
        CrowdStakeDeployer.Params memory p = _adminParams("fam-id");
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("crowdstake.family.v2"),
                FOUNDER,
                p.salt,
                keccak256(bytes(p.tokenName)),
                keccak256(bytes(p.tokenSymbol)),
                p.maxVotingPoints,
                p.registryKind,
                p.distributionKind
            )
        );
        assertEq(
            deployer.familyIdOf(
                FOUNDER, p.salt, p.tokenName, p.tokenSymbol, p.maxVotingPoints, p.registryKind, p.distributionKind
            ),
            expected,
            "familyIdOf derivation"
        );

        // Config-committing: a different symbol yields a different family (no accidental merge).
        assertTrue(
            deployer.familyIdOf(
                FOUNDER, p.salt, p.tokenName, "OTHER", p.maxVotingPoints, p.registryKind, p.distributionKind
            ) != expected,
            "symbol change -> different family"
        );
        // Creator-scoped: a different creator yields a different family.
        assertTrue(
            deployer.familyIdOf(
                OWNER, p.salt, p.tokenName, p.tokenSymbol, p.maxVotingPoints, p.registryKind, p.distributionKind
            ) != expected,
            "creator change -> different family"
        );
    }

    /// @dev A cross-chain deploy wires the familyId into the voting module, records the sibling,
    ///      and emits FamilyDeployed alongside SystemDeployed.
    function test_CrossChainDeploy_WiresFamilyAndRecordsSibling() public {
        CrowdStakeDeployer.Params memory p = _adminParams("fam-1");
        p.crossChain = true;

        bytes32 familyId = deployer.familyIdOf(
            FOUNDER, p.salt, p.tokenName, p.tokenSymbol, p.maxVotingPoints, p.registryKind, p.distributionKind
        );

        vm.expectEmit(true, true, true, false);
        emit CrowdStakeDeployer.FamilyDeployed(familyId, FOUNDER, OWNER);
        vm.prank(FOUNDER);
        CrowdStakeDeployer.Instance memory i = deployer.deploy(p);

        // The voting module knows its family and gates on castCrossChainVote.
        assertEq(BasisPointsVotingModule(i.votingModule).familyId(), familyId, "familyId wired into module");

        // familyInstances round-trip returns the full 8-address tuple.
        (
            address cycleModule,
            address registry,
            address token,
            address votingPowerStrategy,
            address distributionManager,
            address distributionStrategy,
            address secondaryDistributionStrategy,
            address votingModule
        ) = deployer.familyInstances(familyId);
        assertEq(cycleModule, i.cycleModule, "sibling cycleModule");
        assertEq(registry, i.registry, "sibling registry");
        assertEq(token, i.token, "sibling token");
        assertEq(votingPowerStrategy, i.votingPowerStrategy, "sibling votingPowerStrategy");
        assertEq(distributionManager, i.distributionManager, "sibling distributionManager");
        assertEq(distributionStrategy, i.distributionStrategy, "sibling distributionStrategy");
        assertEq(secondaryDistributionStrategy, i.secondaryDistributionStrategy, "sibling secondary");
        assertEq(votingModule, i.votingModule, "sibling votingModule");
    }

    /// @dev A classic deploy leaves familyInstances empty and the module familyId zero.
    function test_ClassicDeploy_LeavesFamilyUnset() public {
        CrowdStakeDeployer.Instance memory i = deployer.deploy(_adminParams("classic-fam"));
        assertEq(BasisPointsVotingModule(i.votingModule).familyId(), bytes32(0), "classic module familyId 0");
    }

    /// @dev The same creator+config can only seed a family once per chain.
    function test_RevertWhen_FamilyAlreadyDeployed() public {
        CrowdStakeDeployer.Params memory p = _adminParams("fam-dup");
        p.crossChain = true;

        vm.prank(FOUNDER);
        deployer.deploy(p);

        vm.prank(FOUNDER);
        vm.expectRevert(CrowdStakeDeployer.FamilyAlreadyDeployed.selector);
        deployer.deploy(p);
    }

    // ---- Registry familyId wiring ----

    /// @dev An admin cross-chain deploy uses the base familyIdOf (byte-identical to today) and
    ///      wires it into the registry, which now exposes familyId() + lastRegistryUpdateNonce().
    function test_CrossChainAdminDeploy_WiresRegistryFamilyId() public {
        CrowdStakeDeployer.Params memory p = _adminParams("xchain-admin");
        p.crossChain = true;
        bytes32 familyId = deployer.familyIdOf(
            FOUNDER, p.salt, p.tokenName, p.tokenSymbol, p.maxVotingPoints, p.registryKind, p.distributionKind
        );

        vm.prank(FOUNDER);
        CrowdStakeDeployer.Instance memory i = deployer.deploy(p);

        assertEq(IFamilyId(i.registry).familyId(), familyId, "registry familyId = base familyIdOf");
        assertEq(IFamilyId(i.registry).lastRegistryUpdateNonce(), 0, "fresh update nonce");
        assertEq(BasisPointsVotingModule(i.votingModule).familyId(), familyId, "module familyId matches registry");
    }

    /// @dev A classic admin deploy leaves the registry familyId zero.
    function test_ClassicAdminDeploy_RegistryFamilyIdZero() public {
        CrowdStakeDeployer.Instance memory i = deployer.deploy(_adminParams("classic-admin"));
        assertEq(IFamilyId(i.registry).familyId(), bytes32(0), "classic registry familyId 0");
    }

    // ---- votingFamilyIdOf: commits founders + expiry ----

    /// @dev votingFamilyIdOf folds the base familyIdOf with the founding cohort + expiry.
    function test_VotingFamilyIdOf_CommitsFoundersAndExpiry() public view {
        address[] memory founders = new address[](2);
        founders[0] = address(0x1111);
        founders[1] = address(0x2222);
        bytes32 salt = "vfid";

        bytes32 base = deployer.familyIdOf(FOUNDER, salt, "Demo Stake", "DEMO", 10_000, 1, 0);
        bytes32 expected = keccak256(abi.encode(base, keccak256(abi.encodePacked(founders)), uint256(7 days)));

        assertEq(
            deployer.votingFamilyIdOf(FOUNDER, salt, "Demo Stake", "DEMO", 10_000, 0, founders, 7 days),
            expected,
            "votingFamilyIdOf derivation"
        );

        // Different founders → different family (the critical drift-prevention property).
        address[] memory other = new address[](2);
        other[0] = address(0x1111);
        other[1] = address(0x3333);
        assertTrue(
            deployer.votingFamilyIdOf(FOUNDER, salt, "Demo Stake", "DEMO", 10_000, 0, other, 7 days) != expected,
            "founder change -> different family"
        );

        // Different expiry → different family.
        assertTrue(
            deployer.votingFamilyIdOf(FOUNDER, salt, "Demo Stake", "DEMO", 10_000, 0, founders, 8 days) != expected,
            "expiry change -> different family"
        );
    }

    /// @dev A voting cross-chain deploy wires votingFamilyIdOf (not the base id) into both the
    ///      registry and voting module, and records the sibling under that id.
    function test_CrossChainVotingDeploy_WiresVotingFamilyId() public {
        address[] memory founders = new address[](1);
        founders[0] = FOUNDER;
        CrowdStakeDeployer.Params memory p = _votingParams("xchain-voting", founders, 7 days);
        p.crossChain = true;

        bytes32 votingFamilyId = deployer.votingFamilyIdOf(
            FOUNDER,
            p.salt,
            p.tokenName,
            p.tokenSymbol,
            p.maxVotingPoints,
            p.distributionKind,
            founders,
            p.proposalExpiry
        );
        bytes32 baseFamilyId = deployer.familyIdOf(
            FOUNDER, p.salt, p.tokenName, p.tokenSymbol, p.maxVotingPoints, p.registryKind, p.distributionKind
        );
        assertTrue(votingFamilyId != baseFamilyId, "voting-kind id diverges from base id");

        vm.prank(FOUNDER);
        CrowdStakeDeployer.Instance memory i = deployer.deploy(p);

        assertEq(IFamilyId(i.registry).familyId(), votingFamilyId, "registry uses votingFamilyIdOf");
        assertEq(BasisPointsVotingModule(i.votingModule).familyId(), votingFamilyId, "module uses votingFamilyIdOf");

        // Sibling recorded under the voting-kind id.
        (,,,,,,, address votingModule) = deployer.familyInstances(votingFamilyId);
        assertEq(votingModule, i.votingModule, "sibling recorded under voting-kind id");
    }

    // ---- Module overrides (custom pre-deployed implementations) ----

    function test_RegistryOverride() public {
        address reg = Clones.clone(address(new AdminRecipientRegistry()));
        AdminRecipientRegistry(reg).initialize(OWNER);

        CrowdStakeDeployer.Params memory p = _adminParams("ovr-reg");
        p.overrides.recipientRegistry = reg;
        CrowdStakeDeployer.Instance memory i = deployer.deploy(p);

        assertEq(i.registry, reg, "override used verbatim");
        assertEq(
            address(AbstractDistributionManager(i.distributionManager).recipientRegistry()), reg, "dm wired to override"
        );
        assertEq(IOwnable(reg).owner(), OWNER, "registry ownership untouched");
    }

    function test_TokenOverride_SkipsClaimerAndOwnership() public {
        address tok = Clones.clone(address(new SexyDaiYield(WXDAI, SXDAI)));
        SexyDaiYield(payable(tok)).initialize("Custom", "CSTM", OWNER);

        CrowdStakeDeployer.Params memory p = _adminParams("ovr-tok");
        p.overrides.token = tok;
        CrowdStakeDeployer.Instance memory i = deployer.deploy(p);

        assertEq(i.token, tok, "override used verbatim");
        assertEq(address(AbstractDistributionManager(i.distributionManager).baseToken()), tok, "dm wired to override");
        assertEq(IOwnable(tok).owner(), OWNER, "token stays caller-owned");
        // Deployer cannot set the claimer on a caller-owned token — the caller does it.
        assertEq(AbstractToken(tok).yieldClaimer(), address(0), "claimer left for the caller");
        vm.prank(OWNER);
        AbstractToken(tok).setYieldClaimer(i.distributionManager);
        assertEq(AbstractToken(tok).yieldClaimer(), i.distributionManager, "caller follow-up wires claimer");
    }

    function test_CycleOverride_SkipsWiringAndOwnership() public {
        address cyc = Clones.clone(address(new CycleModule()));
        AbstractCycleModule(cyc).initialize(77, OWNER);

        CrowdStakeDeployer.Params memory p = _adminParams("ovr-cyc");
        p.overrides.cycleModule = cyc;
        p.cycleLength = 0; // ignored when overridden — must not revert
        CrowdStakeDeployer.Instance memory i = deployer.deploy(p);

        assertEq(i.cycleModule, cyc, "override used verbatim");
        assertEq(AbstractCycleModule(cyc).distributionManager(), address(0), "dm wiring left for the caller");
        vm.prank(OWNER);
        AbstractCycleModule(cyc).setDistributionManager(i.distributionManager);
        assertEq(AbstractCycleModule(cyc).distributionManager(), i.distributionManager, "caller follow-up wires dm");
    }

    function test_VotingPowerStrategiesOverride() public {
        address[] memory vps = new address[](2);
        vps[0] = address(new MockVotingPower());
        vps[1] = address(new MockVotingPower());

        CrowdStakeDeployer.Params memory p = _adminParams("ovr-vps");
        p.overrides.votingPowerStrategies = vps;
        CrowdStakeDeployer.Instance memory i = deployer.deploy(p);

        assertEq(i.votingPowerStrategy, vps[0], "first override reported");
        BasisPointsVotingModule vm_ = BasisPointsVotingModule(i.votingModule);
        assertEq(address(vm_.votingPowerStrategies(0)), vps[0], "strategy 0 wired");
        assertEq(address(vm_.votingPowerStrategies(1)), vps[1], "strategy 1 wired");
    }

    function test_VotingModuleOverride_InitializedByCallerAfter() public {
        address vmOvr = Clones.clone(address(new BasisPointsVotingModule()));

        CrowdStakeDeployer.Params memory p = _adminParams("ovr-vm");
        p.overrides.votingModule = vmOvr;
        CrowdStakeDeployer.Instance memory i = deployer.deploy(p);

        assertEq(i.votingModule, vmOvr, "override used verbatim");
        assertEq(
            address(AbstractDistributionManager(i.distributionManager).votingModule()), vmOvr, "dm wired to override"
        );
        assertEq(i.votingPowerStrategy, address(0), "no canonical TWVP for a custom module");

        // Caller initializes the module afterwards with the fresh DM.
        IVotingPowerStrategy[] memory vps = new IVotingPowerStrategy[](1);
        vps[0] = IVotingPowerStrategy(address(new MockVotingPower()));
        BasisPointsVotingModule(vmOvr).initialize(100, vps, i.distributionManager, OWNER);
        assertEq(IOwnable(vmOvr).owner(), OWNER, "caller-init sets owner");
    }

    function test_StrategyOverride_InitializedByCallerAfter() public {
        address strat = Clones.clone(address(new VotingDistributionStrategy()));

        CrowdStakeDeployer.Params memory p = _adminParams("ovr-strat");
        p.overrides.distributionStrategy = strat;
        CrowdStakeDeployer.Instance memory i = deployer.deploy(p);

        assertEq(i.distributionStrategy, strat, "override used verbatim");
        assertEq(
            address(BaseDistributionManager(i.distributionManager).distributionStrategy()),
            strat,
            "dm wired to override"
        );

        VotingDistributionStrategy(strat).initialize(i.token, i.distributionManager, OWNER);
        assertEq(IOwnable(strat).owner(), OWNER, "caller-init sets owner");
    }

    function test_RevertWhen_OverrideHasNoCode() public {
        CrowdStakeDeployer.Params memory p = _adminParams("ovr-eoa");
        p.overrides.recipientRegistry = address(0xEA0); // EOA — no code
        vm.expectRevert(abi.encodeWithSelector(CrowdStakeDeployer.OverrideHasNoCode.selector, address(0xEA0)));
        deployer.deploy(p);
    }

    function test_RevertWhen_StrategyOverrideWithNonProportionalKind() public {
        address strat = Clones.clone(address(new VotingDistributionStrategy()));
        CrowdStakeDeployer.Params memory p = _adminParams("ovr-strat-split");
        p.overrides.distributionStrategy = strat;
        p.distributionKind = 2; // split
        vm.expectRevert(CrowdStakeDeployer.StrategyOverrideRequiresProportional.selector);
        deployer.deploy(p);
    }
}

/// @dev Minimal voting-power strategy for override tests.
contract MockVotingPower {
    function getCurrentVotingPower(address) external pure returns (uint256) {
        return 1e18;
    }

    function getVotingPowerForPeriod(uint256, uint256, address) external pure returns (uint256) {
        return 1e18;
    }
}
