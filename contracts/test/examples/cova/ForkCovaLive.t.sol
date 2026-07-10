// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {CrowdStakeFactory} from "../../../src/CrowdStakeFactory.sol";
import {CrowdStakeDeployer} from "../../../src/CrowdStakeDeployer.sol";
import {CycleModule} from "../../../src/implementation/CycleModule.sol";
import {BasisPointsVotingModule} from "../../../src/base/BasisPointsVotingModule.sol";
import {BaseDistributionManager} from "../../../src/base/BaseDistributionManager.sol";
import {MultiStrategyDistributionManager} from "../../../src/base/MultiStrategyDistributionManager.sol";
import {AbstractDistributionManager} from "../../../src/abstract/AbstractDistributionManager.sol";
import {AbstractCycleModule} from "../../../src/abstract/AbstractCycleModule.sol";
import {VotingDistributionStrategy} from "../../../src/implementation/strategies/VotingDistributionStrategy.sol";
import {EqualDistributionStrategy} from "../../../src/implementation/strategies/EqualDistributionStrategy.sol";
import {AdminRecipientRegistry} from "../../../src/implementation/registries/AdminRecipientRegistry.sol";
import {VotingRecipientRegistry} from "../../../src/implementation/registries/VotingRecipientRegistry.sol";
import {SexyDaiYield} from "../../../src/implementation/token/SexyDaiYield.sol";
import {AbstractToken} from "../../../src/abstract/AbstractToken.sol";
import {IVotingPowerStrategy} from "../../../src/interfaces/IVotingPowerStrategy.sol";

import {CovaDollarYield} from "../../../src/examples/cova/CovaDollarYield.sol";
import {CovaProjectRegistry} from "../../../src/examples/cova/CovaProjectRegistry.sol";
import {OnePersonOneVotePower} from "../../../src/examples/cova/OnePersonOneVotePower.sol";
import {CovaPointsVotingModule} from "../../../src/examples/cova/CovaPointsVotingModule.sol";
import {CovaArtFundStrategy} from "../../../src/examples/cova/CovaArtFundStrategy.sol";

/// @title ForkCovaLiveTest
/// @notice End-to-end proof against the REAL COVA modules deployed to Gnosis by
///         script/DeployCovaModules.s.sol (tx block 47024140) and REAL WXDAI/sDAI:
///         stand a new overrides-capable CrowdStakeDeployer on a Gnosis fork,
///         feed it the live module addresses as the wizard would, run the caller
///         follow-ups, then vote -> accrue real sDAI yield -> distribute.
///         Skipped automatically unless a Gnosis RPC is configured:
///           GNOSIS_RPC_URL=https://rpc.gnosischain.com forge test --match-contract ForkCovaLive
contract ForkCovaLiveTest is Test {
    uint256 constant E = 1e18;
    uint256 constant CYCLE = 5;

    // Live Gnosis deployment (DeployCovaModules.s.sol, chain 100).
    address constant COORD = 0x6636A1CCBdf54485067304C1a590DE016DeaD9F0;
    CovaProjectRegistry constant REG = CovaProjectRegistry(0xD6f51fD6B8576dcDE219E8406e8492D391febAf9);
    CovaDollarYield constant TOK = CovaDollarYield(payable(0xC0e2dA5d4F3Bd607D63355C8B85CA878F59B9836));
    CovaPointsVotingModule constant VOTING = CovaPointsVotingModule(0x7023Db7E686C7eaf26B533ACf17b2f4709EB2a5f);
    CovaArtFundStrategy constant STRAT = CovaArtFundStrategy(0x34871c6514d364c7c0e524E695e5339dae4646b4);
    OnePersonOneVotePower constant POWER = OnePersonOneVotePower(0x05233074b7c480e29bFE0D266AA411aB29420E8B);

    IERC20 constant WXDAI = IERC20(0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d);
    IERC4626 constant SDAI = IERC4626(0xaf204776c7245bF4147c2612BF6e5972Ee483701);

    address m1 = address(0xA1);
    address m2 = address(0xA2);
    address[6] P = [address(0xB1), address(0xB2), address(0xB3), address(0xB4), address(0xB5), address(0xB6)];

    CrowdStakeDeployer internal deployer;
    CrowdStakeDeployer.Instance internal inst;
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("GNOSIS_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return; // no RPC -> tests self-skip
        vm.createSelectFork(rpc);
        forked = true;

        // A fresh overrides-capable deployer + its own factory/beacons on the fork.
        deployer = _newDeployer();

        // The wizard deploy: canonical cycle + DM, live COVA modules as overrides.
        address[] memory vps = new address[](1);
        vps[0] = address(POWER);
        CrowdStakeDeployer.Params memory p = CrowdStakeDeployer.Params({
            owner: COORD,
            cycleLength: CYCLE,
            tokenName: "",
            tokenSymbol: "",
            maxVotingPoints: 10_000,
            salt: "cova-fork",
            registryKind: 0,
            initialRecipients: new address[](0),
            proposalExpiry: 0,
            distributionKind: 0,
            tokenImageURI: "",
            bannerImageURI: "",
            crossChain: false,
            overrides: CrowdStakeDeployer.ModuleOverrides({
                recipientRegistry: address(REG),
                token: address(TOK),
                cycleModule: address(0),
                votingModule: address(VOTING),
                distributionStrategy: address(STRAT),
                votingPowerStrategies: vps
            })
        });
        inst = deployer.deploy(p);

        // Caller follow-ups (coordinator owns the live modules).
        vm.startPrank(COORD);
        TOK.setYieldClaimer(inst.distributionManager);
        STRAT.initialize(address(TOK), inst.distributionManager, COORD, uint256(5));
        IVotingPowerStrategy[] memory ivps = new IVotingPowerStrategy[](1);
        ivps[0] = IVotingPowerStrategy(address(POWER));
        VOTING.initialize(ivps, inst.distributionManager, COORD);

        // Seed the cooperative.
        address[] memory mem = new address[](2);
        mem[0] = m1;
        mem[1] = m2;
        POWER.addMembers(mem);
        REG.registerProject(P[0], 5000 * E, 2000 * E, "Mural", "s");
        REG.registerProject(P[1], 3000 * E, 1500 * E, "Theatre", "s");
        REG.registerProject(P[2], 1200 * E, 400 * E, "Zine", "s");
        REG.registerProject(P[3], 5000 * E, 1800 * E, "Sculpture", "s");
        REG.registerProject(P[4], 5000 * E, 800 * E, "Workshops", "s");
        REG.registerProject(P[5], 5000 * E, 500 * E, "Print", "s");
        REG.processQueue();
        vm.stopPrank();
    }

    function _newDeployer() internal returns (CrowdStakeDeployer) {
        CrowdStakeFactory f = new CrowdStakeFactory(address(this));
        address cycleBeacon = address(new UpgradeableBeacon(address(new CycleModule()), address(this)));
        address regBeacon = address(new UpgradeableBeacon(address(new AdminRecipientRegistry()), address(this)));
        address vRegBeacon = address(new UpgradeableBeacon(address(new VotingRecipientRegistry()), address(this)));
        // Token beacon impl never used here (token is overridden) but the ctor
        // needs a valid asset/vault pair, so reuse the live WXDAI/sDAI.
        address tokBeacon =
            address(new UpgradeableBeacon(address(new SexyDaiYield(address(WXDAI), address(SDAI))), address(this)));
        address distBeacon = address(new UpgradeableBeacon(address(new BaseDistributionManager()), address(this)));
        address multiBeacon =
            address(new UpgradeableBeacon(address(new MultiStrategyDistributionManager()), address(this)));
        address stratBeacon = address(new UpgradeableBeacon(address(new VotingDistributionStrategy()), address(this)));
        address eqBeacon = address(new UpgradeableBeacon(address(new EqualDistributionStrategy()), address(this)));
        address votingBeacon = address(new UpgradeableBeacon(address(new BasisPointsVotingModule()), address(this)));

        address[] memory beacons = new address[](9);
        beacons[0] = cycleBeacon;
        beacons[1] = regBeacon;
        beacons[2] = vRegBeacon;
        beacons[3] = tokBeacon;
        beacons[4] = distBeacon;
        beacons[5] = multiBeacon;
        beacons[6] = stratBeacon;
        beacons[7] = eqBeacon;
        beacons[8] = votingBeacon;
        f.allowlistBeacons(beacons);

        return new CrowdStakeDeployer(
            address(f),
            cycleBeacon,
            regBeacon,
            vRegBeacon,
            tokBeacon,
            distBeacon,
            multiBeacon,
            stratBeacon,
            eqBeacon,
            votingBeacon
        );
    }

    /// @dev Mint `principal` cUSD by depositing real WXDAI into real sDAI, then
    ///      fake `yield` of accrued interest by topping up the token's sDAI
    ///      balance to what `principal + yield` assets are worth at the live rate.
    function _seedPrincipalAndYield(uint256 principal, uint256 yield) internal {
        deal(address(WXDAI), COORD, principal);
        vm.startPrank(COORD);
        WXDAI.approve(address(TOK), principal);
        TOK.mint(COORD, principal);
        vm.stopPrank();
        uint256 targetShares = SDAI.convertToShares(TOK.totalSupply() + yield);
        deal(address(SDAI), address(TOK), targetShares);
    }

    function _pts(uint256 a, uint256 b, uint256 c, uint256 d, uint256 e, uint256 f)
        internal
        pure
        returns (uint256[] memory pts)
    {
        pts = new uint256[](6);
        pts[0] = a;
        pts[1] = b;
        pts[2] = c;
        pts[3] = d;
        pts[4] = e;
        pts[5] = f;
    }

    // ---- The wizard wired the live modules verbatim ----

    function test_Fork_WiredCorrectly() public view {
        if (!forked) return;
        assertEq(inst.registry, address(REG), "registry override");
        assertEq(inst.token, address(TOK), "token override");
        assertEq(inst.votingModule, address(VOTING), "voting override");
        assertEq(inst.distributionStrategy, address(STRAT), "strategy override");
        assertEq(inst.votingPowerStrategy, address(POWER), "vps override reported");

        // The exact read-set src/lib/instance.ts resolveInstance() performs.
        AbstractDistributionManager dm = AbstractDistributionManager(inst.distributionManager);
        assertEq(address(dm.cycleManager()), inst.cycleModule, "cycleManager()");
        assertEq(address(dm.votingModule()), address(VOTING), "votingModule()");
        assertEq(address(dm.recipientRegistry()), address(REG), "recipientRegistry()");
        assertEq(address(dm.baseToken()), address(TOK), "baseToken()");
        assertEq(
            address(BaseDistributionManager(inst.distributionManager).distributionStrategy()),
            address(STRAT),
            "distributionStrategy()"
        );
        assertEq(TOK.yieldClaimer(), inst.distributionManager, "yield claimer follow-up");
        assertEq(VOTING.getVotingPowerStrategies().length, 1, "voting module initialized");
    }

    // ---- Real vote -> real sDAI yield -> distribution, on the live contracts ----

    function test_Fork_FullCycle() public {
        if (!forked) return;
        _seedPrincipalAndYield(2_000_000 * E, 8000 * E);
        uint256 accrued = TOK.yieldAccrued();
        assertApproxEqAbs(accrued, 8000 * E, 1e12, "~8000 cUSD of real sDAI yield");

        vm.prank(m1);
        VOTING.voteWithData(_pts(20, 15, 13, 12, 9, 8), ""); // canonical entrypoint
        vm.prank(m2);
        VOTING.castVote(_pts(18, 14, 13, 12, 9, 7)); // COVA entrypoint

        vm.roll(block.number + CYCLE + 1);
        BaseDistributionManager dm = BaseDistributionManager(inst.distributionManager);
        assertTrue(dm.isDistributionReady(), "ready: cycle done, votes, yield");

        uint256 supplyBefore = TOK.totalSupply();
        dm.claimAndDistribute();
        uint256 minted = TOK.totalSupply() - supplyBefore; // cUSD minted for the claimed yield

        // Min-viable allocation: sculpture dropped, zine capped at full budget,
        // the front end's worked example reproduced against real sDAI (~1e12
        // tolerance absorbs sub-wei sDAI share rounding on the yield claim).
        assertEq(TOK.balanceOf(P[3]), 0, "sculpture dropped (below min viable)");
        assertEq(TOK.balanceOf(P[2]), 1200 * E, "zine capped at full budget");
        assertApproxEqAbs(TOK.balanceOf(P[0]), 2584 * E, 1e12, "mural");
        assertApproxEqAbs(TOK.balanceOf(P[1]), 1972 * E, 1e12, "theatre");
        assertApproxEqAbs(TOK.balanceOf(P[4]), 1224 * E, 1e12, "workshops");
        assertApproxEqAbs(TOK.balanceOf(P[5]), 1020 * E, 1e12, "print (promoted)");
        uint256 handedOut =
            TOK.balanceOf(P[0]) + TOK.balanceOf(P[1]) + TOK.balanceOf(P[2]) + TOK.balanceOf(P[4]) + TOK.balanceOf(P[5]);
        // The strategy hands out the claimed pool minus at most a few wei of
        // allocation dust left in its escrow.
        assertLe(handedOut, minted, "never distributes more than claimed");
        assertApproxEqAbs(handedOut, minted, 100, "whole claimed pool distributed (bar dust)");
        assertApproxEqAbs(handedOut, 8000 * E, 1e12, "~full 8000 pool distributed");
        assertEq(AbstractCycleModule(inst.cycleModule).getCurrentCycle(), 2, "cycle advanced");
    }
}
