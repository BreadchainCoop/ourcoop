// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {CrowdStakeFactory} from "../../../src/CrowdStakeFactory.sol";
import {CrowdStakeDeployer} from "../../../src/CrowdStakeDeployer.sol";
import {CycleModule} from "../../../src/implementation/CycleModule.sol";
import {AbstractCycleModule} from "../../../src/abstract/AbstractCycleModule.sol";
import {BasisPointsVotingModule} from "../../../src/base/BasisPointsVotingModule.sol";
import {BaseDistributionManager} from "../../../src/base/BaseDistributionManager.sol";
import {MultiStrategyDistributionManager} from "../../../src/base/MultiStrategyDistributionManager.sol";
import {AbstractDistributionManager} from "../../../src/abstract/AbstractDistributionManager.sol";
import {VotingDistributionStrategy} from "../../../src/implementation/strategies/VotingDistributionStrategy.sol";
import {EqualDistributionStrategy} from "../../../src/implementation/strategies/EqualDistributionStrategy.sol";
import {AdminRecipientRegistry} from "../../../src/implementation/registries/AdminRecipientRegistry.sol";
import {VotingRecipientRegistry} from "../../../src/implementation/registries/VotingRecipientRegistry.sol";
import {SexyDaiYield} from "../../../src/implementation/token/SexyDaiYield.sol";
import {AbstractToken} from "../../../src/abstract/AbstractToken.sol";
import {IVotingPowerStrategy} from "../../../src/interfaces/IVotingPowerStrategy.sol";

import {MockUSD} from "../../../src/examples/cova/mocks/MockUSD.sol";
import {MockUSDVault} from "../../../src/examples/cova/mocks/MockUSDVault.sol";
import {CovaDollarYield} from "../../../src/examples/cova/CovaDollarYield.sol";
import {CovaProjectRegistry} from "../../../src/examples/cova/CovaProjectRegistry.sol";
import {OnePersonOneVotePower} from "../../../src/examples/cova/OnePersonOneVotePower.sol";
import {CovaPointsVotingModule} from "../../../src/examples/cova/CovaPointsVotingModule.sol";
import {CovaArtFundStrategy} from "../../../src/examples/cova/CovaArtFundStrategy.sol";

/// @title CovaWizardDeployTest
/// @notice The COVA system stood up through the creation wizard's path: COVA
///         modules one-off deployed (as script/DeployCovaModules.s.sol does),
///         their addresses passed as CrowdStakeDeployer overrides, the caller
///         performing the two documented follow-ups (token yield-claimer +
///         custom module initialization) — then the front end's worked example
///         must allocate identically to the reference CovaCrowdstakeTest.
contract CovaWizardDeployTest is Test {
    uint256 constant E = 1e18;
    uint256 constant CYCLE = 5;

    address coord = address(this);
    address m1 = address(0xA1);
    address m2 = address(0xA2);

    CrowdStakeDeployer internal deployer;

    // One-off deployed COVA modules (the wizard's paste-in addresses).
    MockUSD usd;
    MockUSDVault vault;
    CovaDollarYield tok;
    CovaProjectRegistry reg;
    OnePersonOneVotePower power;
    CovaPointsVotingModule voting;
    CovaArtFundStrategy strat;

    // Wizard output.
    CrowdStakeDeployer.Instance inst;

    address[6] P = [address(0xB1), address(0xB2), address(0xB3), address(0xB4), address(0xB5), address(0xB6)];

    function setUp() public {
        // --- The canonical deployer, exactly as live chains run it. ---
        CrowdStakeFactory factory = new CrowdStakeFactory(coord);
        address cycleBeacon = address(new UpgradeableBeacon(address(new CycleModule()), coord));
        address registryBeacon = address(new UpgradeableBeacon(address(new AdminRecipientRegistry()), coord));
        address votingRegistryBeacon = address(new UpgradeableBeacon(address(new VotingRecipientRegistry()), coord));
        address tokenBeacon =
            address(new UpgradeableBeacon(address(new SexyDaiYield(address(usd), address(vault))), coord));
        address distBeacon = address(new UpgradeableBeacon(address(new BaseDistributionManager()), coord));
        address multiDistBeacon = address(new UpgradeableBeacon(address(new MultiStrategyDistributionManager()), coord));
        address stratBeacon = address(new UpgradeableBeacon(address(new VotingDistributionStrategy()), coord));
        address equalStratBeacon = address(new UpgradeableBeacon(address(new EqualDistributionStrategy()), coord));
        address votingBeacon = address(new UpgradeableBeacon(address(new BasisPointsVotingModule()), coord));

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

        // --- One-off COVA module deploy (mirrors script/DeployCovaModules.s.sol). ---
        usd = new MockUSD();
        vault = new MockUSDVault(address(usd));
        power = new OnePersonOneVotePower(coord);

        reg = CovaProjectRegistry(Clones.clone(address(new CovaProjectRegistry())));
        reg.initialize(coord);

        tok = CovaDollarYield(payable(Clones.clone(address(new CovaDollarYield(address(usd), address(vault))))));
        tok.initialize("COVA USD", "cUSD", coord);

        // Deployed but NOT initialized — their initializers take the DM the wizard creates.
        voting = CovaPointsVotingModule(Clones.clone(address(new CovaPointsVotingModule())));
        strat = CovaArtFundStrategy(Clones.clone(address(new CovaArtFundStrategy())));

        // --- The wizard deploy: canonical cycle + DM, everything else overridden. ---
        address[] memory vps = new address[](1);
        vps[0] = address(power);
        CrowdStakeDeployer.Params memory p = CrowdStakeDeployer.Params({
            owner: coord,
            cycleLength: CYCLE,
            tokenName: "", // ignored: token overridden
            tokenSymbol: "",
            maxVotingPoints: 10_000, // ignored: voting module overridden
            salt: "cova-wizard",
            registryKind: 0, // ignored: registry overridden
            initialRecipients: new address[](0),
            proposalExpiry: 0,
            distributionKind: 0, // proportional (single custom strategy)
            tokenImageURI: "",
            bannerImageURI: "",
            crossChain: false,
            overrides: CrowdStakeDeployer.ModuleOverrides({
                recipientRegistry: address(reg),
                token: address(tok),
                cycleModule: address(0), // canonical cycle, wired by the deployer
                votingModule: address(voting),
                distributionStrategy: address(strat),
                votingPowerStrategies: vps
            })
        });
        inst = deployer.deploy(p);

        // --- The wizard's documented follow-ups (caller-signed). ---
        tok.setYieldClaimer(inst.distributionManager);
        strat.initialize(address(tok), inst.distributionManager, coord, uint256(5));
        IVotingPowerStrategy[] memory ivps = new IVotingPowerStrategy[](1);
        ivps[0] = IVotingPowerStrategy(address(power));
        voting.initialize(ivps, inst.distributionManager, coord);

        // --- Seed the cooperative (post-deploy admin actions). ---
        address[] memory mem = new address[](3);
        mem[0] = coord;
        mem[1] = m1;
        mem[2] = m2;
        power.addMembers(mem);

        reg.registerProject(P[0], 5000 * E, 2000 * E, "Mural", "s");
        reg.registerProject(P[1], 3000 * E, 1500 * E, "Theatre", "s");
        reg.registerProject(P[2], 1200 * E, 400 * E, "Zine", "s");
        reg.registerProject(P[3], 5000 * E, 1800 * E, "Sculpture", "s");
        reg.registerProject(P[4], 5000 * E, 800 * E, "Workshops", "s");
        reg.registerProject(P[5], 5000 * E, 500 * E, "Print", "s");
        reg.processQueue();
    }

    function _mintCusd(uint256 amount) internal {
        usd.mint(coord, amount);
        usd.approve(address(tok), amount);
        tok.mint(coord, amount);
    }

    function _pts(uint256 a, uint256 b, uint256 c, uint256 d, uint256 e, uint256 f)
        internal
        pure
        returns (uint256[] memory p)
    {
        p = new uint256[](6);
        p[0] = a;
        p[1] = b;
        p[2] = c;
        p[3] = d;
        p[4] = e;
        p[5] = f;
    }

    // ---- The wizard deploy wires the overrides verbatim ----

    function test_InstanceReportsOverrides() public view {
        assertEq(inst.registry, address(reg), "registry override");
        assertEq(inst.token, address(tok), "token override");
        assertEq(inst.votingModule, address(voting), "voting module override");
        assertEq(inst.distributionStrategy, address(strat), "strategy override");
        assertEq(inst.votingPowerStrategy, address(power), "first vps override reported");
        assertTrue(inst.cycleModule != address(0), "canonical cycle deployed");
        assertTrue(inst.distributionManager != address(0), "canonical dm deployed");
    }

    /// @notice The exact read-set src/lib/instance.ts resolveInstance() performs
    ///         when the wizard registers the instance from the DM address.
    function test_ResolveInstanceReadSet() public view {
        AbstractDistributionManager dm = AbstractDistributionManager(inst.distributionManager);
        assertEq(address(dm.cycleManager()), inst.cycleModule, "cycleManager()");
        assertEq(address(dm.votingModule()), address(voting), "votingModule()");
        assertEq(address(dm.recipientRegistry()), address(reg), "recipientRegistry()");
        assertEq(address(dm.baseToken()), address(tok), "baseToken()");
        assertEq(
            address(BaseDistributionManager(inst.distributionManager).distributionStrategy()),
            address(strat),
            "distributionStrategy()"
        );
        IVotingPowerStrategy[] memory vps = voting.getVotingPowerStrategies();
        assertEq(vps.length, 1, "one voting power strategy");
        assertEq(address(vps[0]), address(power), "getVotingPowerStrategies()[0]");
    }

    function test_OwnershipLandsWithCaller() public view {
        assertEq(AbstractToken(address(tok)).owner(), coord, "token caller-owned throughout");
        assertEq(CovaProjectRegistry(address(reg)).owner(), coord, "registry caller-owned throughout");
        assertEq(AbstractDistributionManager(inst.distributionManager).owner(), coord, "dm handed over by the deployer");
        assertEq(AbstractCycleModule(inst.cycleModule).owner(), coord, "cycle handed over by the deployer");
        assertEq(voting.owner(), coord, "voting module owned via caller init");
        assertEq(strat.owner(), coord, "strategy owned via caller init");
    }

    // ---- Canonical interface alignment (the app's vote page calls these) ----

    function test_CanonicalVotingInterface() public {
        assertEq(voting.maxPoints(), 100, "maxPoints() exposed for canonical tooling");
        assertEq(voting.getExpectedPointsLength(), 6, "expected points = active projects");
        assertFalse(voting.hasVotedInCurrentCycle(m1), "not voted yet");

        vm.prank(m1);
        voting.voteWithData(_pts(20, 15, 13, 12, 9, 8), "");
        assertTrue(voting.hasVotedInCurrentCycle(m1), "vote recorded via canonical entrypoint");

        // Canonical semantics: voteWithData blocks recasting within a cycle.
        vm.prank(m1);
        vm.expectRevert();
        voting.voteWithData(_pts(10, 10, 10, 10, 10, 10), "");
    }

    // ---- The front end's worked example, through the wizard-deployed system ----

    function test_WorkedExampleAllocatesIdentically() public {
        _mintCusd(2_000_000 * E);
        vault.simulateYield(8000 * E);

        vm.prank(m1); // 77 pts — canonical entrypoint
        voting.voteWithData(_pts(20, 15, 13, 12, 9, 8), "");
        vm.prank(m2); // 73 pts — COVA direct entrypoint
        voting.castVote(_pts(18, 14, 13, 12, 9, 7));

        vm.roll(block.number + CYCLE + 1);
        BaseDistributionManager dm = BaseDistributionManager(inst.distributionManager);
        assertTrue(dm.isDistributionReady(), "ready: cycle done, votes, yield");
        dm.claimAndDistribute();

        assertEq(tok.balanceOf(P[3]), 0, "sculpture dropped (below min viable)");
        assertEq(tok.balanceOf(P[2]), 1200 * E, "zine capped at full budget");
        assertEq(tok.balanceOf(P[0]), 2584 * E, "mural");
        assertEq(tok.balanceOf(P[1]), 1972 * E, "theatre");
        assertEq(tok.balanceOf(P[4]), 1224 * E, "workshops");
        assertEq(tok.balanceOf(P[5]), 1020 * E, "print (promoted)");
        assertEq(
            tok.balanceOf(P[0]) + tok.balanceOf(P[1]) + tok.balanceOf(P[2]) + tok.balanceOf(P[4]) + tok.balanceOf(P[5]),
            8000 * E,
            "whole Art Fund pool distributed"
        );
        assertEq(AbstractCycleModule(inst.cycleModule).getCurrentCycle(), 2, "cycle advanced with distribution");
    }
}
