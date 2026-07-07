// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {AbstractToken} from "../src/abstract/AbstractToken.sol";
import {StableYield} from "../src/implementation/token/StableYield.sol";
import {MockUSDC, MockStableVault} from "./StableYield.t.sol";

/// Minimal AbstractToken with simulated vault backing: `assets` moves exactly like the
/// real implementations' vault positions (deposits/remits move it, yield claims don't),
/// so raw yield = assets - totalSupply with no rounding — ideal for exact assertions.
contract HarnessToken is AbstractToken {
    uint256 public assets;

    constructor() {
        _disableInitializers();
    }

    function initialize(string memory name_, string memory symbol_, address owner_) external initializer {
        __ERC20_init(name_, symbol_);
        _initializeOwner(owner_);
    }

    function _deposit(uint256 amount_) internal override {
        assets += amount_;
    }

    function _remit(address, uint256 amount_) internal override {
        assets -= amount_;
    }

    function _yieldAccrued() internal view override returns (uint256) {
        uint256 supply = totalSupply();
        return assets > supply ? assets - supply : 0;
    }

    function addYield(uint256 amount_) external {
        assets += amount_;
    }

    /// Simulates a vault loss event (backing worth less than before).
    function slashAssets(uint256 amount_) external {
        assets -= amount_;
    }
}

contract YieldSplitTest is Test {
    HarnessToken token;
    address claimer = address(0xCAFE);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint16 constant BPS = 10_000;

    function setUp() public {
        HarnessToken impl = new HarnessToken();
        bytes memory data = abi.encodeWithSelector(HarnessToken.initialize.selector, "Stake", "STK", address(this));
        token = HarnessToken(address(new ERC1967Proxy(address(impl), data)));
        token.setYieldClaimer(claimer);
    }

    function _mintFor(address who, uint256 amount) internal {
        vm.prank(who);
        token.mint(who, amount);
    }

    /* ------------------------- default behavior ------------------------- */

    function test_DefaultDonatesEverything() public {
        _mintFor(alice, 100 ether);
        token.addYield(10 ether);

        assertEq(token.yieldAccrued(), 10 ether, "all yield donated by default");
        assertEq(token.totalYieldAccrued(), 10 ether, "raw surplus");
        assertEq(token.keptYieldOf(alice), 0, "nothing kept by default");

        vm.prank(claimer);
        token.claimYield(10 ether, claimer);
        assertEq(token.balanceOf(claimer), 10 ether, "claimer minted the yield");
        assertEq(token.yieldAccrued(), 0, "pool drained");
        assertEq(token.totalYieldAccrued(), 0, "surplus consumed");
    }

    function test_ClaimYieldStillClaimerGated() public {
        _mintFor(alice, 100 ether);
        token.addYield(10 ether);
        vm.prank(alice);
        vm.expectRevert(AbstractToken.OnlyClaimer.selector);
        token.claimYield(1 ether, alice);
    }

    /* --------------------------- setYieldSplit --------------------------- */

    function test_SetYieldSplit_ReadsBackAndEmits() public {
        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit AbstractToken.YieldSplitSet(alice, 2500);
        token.setYieldSplit(2500);
        assertEq(token.yieldSplitOf(alice), 2500, "split stored");
    }

    function test_SetYieldSplit_RevertsAbove100Percent() public {
        vm.prank(alice);
        vm.expectRevert(AbstractToken.InvalidYieldSplit.selector);
        token.setYieldSplit(BPS + 1);
    }

    function test_SplitAppliesOnlyGoingForward() public {
        _mintFor(alice, 100 ether);
        token.addYield(10 ether);

        vm.prank(alice);
        token.setYieldSplit(5000);
        assertEq(token.keptYieldOf(alice), 0, "past yield stays donated");
        assertEq(token.yieldAccrued(), 10 ether, "donated pool untouched");

        token.addYield(10 ether);
        assertEq(token.keptYieldOf(alice), 5 ether, "half of new yield kept");
        assertEq(token.yieldAccrued(), 15 ether, "old 10 + new donated 5");
    }

    /* ------------------------- keeping + claiming ------------------------ */

    function test_SingleHolderKeepsHalf() public {
        vm.prank(alice);
        token.setYieldSplit(5000);
        _mintFor(alice, 100 ether);
        token.addYield(10 ether);

        assertEq(token.keptYieldOf(alice), 5 ether, "kept half");
        assertEq(token.yieldAccrued(), 5 ether, "donated half");
        assertEq(token.totalYieldAccrued(), 10 ether, "raw is the sum");

        // The claimer cannot touch the kept share.
        vm.prank(claimer);
        vm.expectRevert(AbstractToken.YieldInsufficient.selector);
        token.claimYield(6 ether, claimer);

        vm.prank(claimer);
        token.claimYield(5 ether, claimer);

        vm.prank(alice);
        token.claimKeptYield(alice);
        assertEq(token.balanceOf(alice), 105 ether, "kept yield minted to alice");
        assertEq(token.keptYieldOf(alice), 0, "kept claimed");
        assertEq(token.totalYieldAccrued(), 0, "everything consumed");

        vm.prank(alice);
        vm.expectRevert(AbstractToken.ClaimZero.selector);
        token.claimKeptYield(alice);
    }

    function test_ClaimKeptYield_EmitsAndPaysReceiver() public {
        vm.prank(alice);
        token.setYieldSplit(BPS);
        _mintFor(alice, 100 ether);
        token.addYield(10 ether);

        vm.prank(alice);
        vm.expectEmit(true, false, false, true);
        emit AbstractToken.KeptYieldClaimed(alice, bob, 10 ether);
        token.claimKeptYield(bob);

        assertEq(token.balanceOf(bob), 10 ether, "receiver got the tokens");
        assertEq(token.getVotes(bob), 10 ether, "receiver auto-delegated");
    }

    function test_TwoHoldersDifferentSplits() public {
        vm.prank(alice);
        token.setYieldSplit(BPS); // keeps everything
        _mintFor(alice, 100 ether); // 25% of supply
        _mintFor(bob, 300 ether); // donates everything

        token.addYield(40 ether);
        assertEq(token.keptYieldOf(alice), 10 ether, "alice keeps her quarter");
        assertEq(token.keptYieldOf(bob), 0, "bob donates");
        assertEq(token.yieldAccrued(), 30 ether, "bob's share is donated");
    }

    /* ------------------------ transfers + settling ----------------------- */

    function test_TransferSettlesSender() public {
        vm.prank(alice);
        token.setYieldSplit(5000);
        _mintFor(alice, 100 ether);
        token.addYield(10 ether);

        vm.prank(alice);
        token.transfer(bob, 100 ether);
        assertEq(token.keptYieldOf(alice), 5 ether, "pending kept settled on transfer");

        token.addYield(10 ether);
        assertEq(token.keptYieldOf(alice), 5 ether, "no balance, no new kept yield");
        assertEq(token.yieldAccrued(), 15 ether, "bob's new yield all donated");
    }

    function test_TransferToKeeperGrowsTheirShare() public {
        vm.prank(alice);
        token.setYieldSplit(BPS);
        _mintFor(alice, 100 ether);
        _mintFor(bob, 100 ether);

        token.addYield(10 ether); // alice keeps 5
        vm.prank(bob);
        token.transfer(alice, 100 ether); // alice now holds everything

        token.addYield(10 ether); // alice keeps all of it
        assertEq(token.keptYieldOf(alice), 15 ether, "5 from half + 10 from all");
        assertEq(token.yieldAccrued(), 5 ether, "only bob's pre-transfer share donated");
    }

    function test_SelfTransferDoesNotDoubleCount() public {
        vm.prank(alice);
        token.setYieldSplit(5000);
        _mintFor(alice, 100 ether);
        token.addYield(10 ether);

        vm.prank(alice);
        token.transfer(alice, 40 ether);

        assertEq(token.keptYieldOf(alice), 5 ether, "kept unchanged");
        assertEq(token.yieldAccrued(), 5 ether, "donated unchanged");
        token.addYield(10 ether);
        assertEq(token.keptYieldOf(alice), 10 ether, "accounting still healthy");
    }

    function test_MintAfterYieldGetsNoRetroactiveShare() public {
        _mintFor(bob, 100 ether);
        token.addYield(10 ether);

        vm.prank(alice);
        token.setYieldSplit(BPS);
        _mintFor(alice, 100 ether);
        assertEq(token.keptYieldOf(alice), 0, "no share of prior yield");

        token.addYield(10 ether);
        assertEq(token.keptYieldOf(alice), 5 ether, "half of new yield only");
        assertEq(token.yieldAccrued(), 15 ether, "prior 10 + bob's 5");
    }

    /* -------------------------- changing splits -------------------------- */

    function test_ChangeSplitSettlesAtOldRate() public {
        vm.prank(alice);
        token.setYieldSplit(BPS);
        _mintFor(alice, 100 ether);
        token.addYield(10 ether);

        vm.prank(alice);
        token.setYieldSplit(0); // stop keeping
        assertEq(token.keptYieldOf(alice), 10 ether, "pre-change yield kept at old split");

        token.addYield(10 ether);
        assertEq(token.keptYieldOf(alice), 10 ether, "new yield donated");
        assertEq(token.yieldAccrued(), 10 ether, "new yield in the pool");
    }

    /* ----------------------------- burning ------------------------------- */

    function test_BurnSettlesAndKeptSurvivesExit() public {
        vm.prank(alice);
        token.setYieldSplit(5000);
        _mintFor(alice, 100 ether);
        token.addYield(10 ether);

        vm.prank(alice);
        token.burn(100 ether, alice);
        assertEq(token.balanceOf(alice), 0, "fully exited");
        assertEq(token.keptYieldOf(alice), 5 ether, "kept yield survives exit");

        vm.prank(alice);
        token.claimKeptYield(alice);
        assertEq(token.balanceOf(alice), 5 ether, "claimed after exit");
        assertEq(token.yieldAccrued(), 5 ether, "donated half still claimable");
    }

    /* ------------------------- adversarial cases ------------------------- */

    function test_TransferFromSettlesLikeTransfer() public {
        vm.prank(alice);
        token.setYieldSplit(5000);
        _mintFor(alice, 100 ether);
        token.addYield(10 ether);

        vm.prank(alice);
        token.approve(bob, 100 ether);
        vm.prank(bob);
        token.transferFrom(alice, bob, 100 ether);

        assertEq(token.keptYieldOf(alice), 5 ether, "settled through transferFrom");
        token.addYield(10 ether);
        assertEq(token.keptYieldOf(alice), 5 ether, "no balance, no new kept");
        assertEq(token.yieldAccrued(), 15 ether, "aggregates stayed consistent");
    }

    function test_ZeroValueTransferKeepsAggregatesIntact() public {
        vm.prank(alice);
        token.setYieldSplit(5000);
        _mintFor(alice, 100 ether);
        token.addYield(10 ether);

        vm.prank(alice);
        token.transfer(bob, 0);

        assertEq(token.keptYieldOf(alice), 5 ether, "kept intact");
        assertEq(token.yieldAccrued(), 5 ether, "donated intact");
        token.addYield(10 ether);
        assertEq(token.keptYieldOf(alice), 10 ether, "accrual still works");
    }

    /// The donated pool pre-counts keepers' unsettled donated halves; make sure a
    /// full manager claim followed by a late settlement can't double-spend them.
    function test_ManagerClaimThenLateSettleCannotDoubleSpend() public {
        vm.prank(alice);
        token.setYieldSplit(5000);
        _mintFor(alice, 100 ether);
        _mintFor(bob, 100 ether);
        token.addYield(20 ether); // alice: 5 kept / 5 donated; bob: 10 donated

        vm.prank(claimer);
        token.claimYield(15 ether, claimer); // drains the whole donated pool

        // Alice settles only now (first touch since the yield event)...
        vm.prank(alice);
        token.transfer(alice, 0);
        // ...and her settlement must not conjure new donated yield.
        assertEq(token.yieldAccrued(), 0, "no donated yield re-appears");
        assertEq(token.keptYieldOf(alice), 5 ether, "her kept share is intact");

        vm.prank(alice);
        token.claimKeptYield(alice);
        assertEq(token.totalYieldAccrued(), 0, "fully consumed, nothing double-spent");
    }

    /// Accrual runs before balances change, so a just-in-time deposit cannot
    /// capture yield that arrived before it — even at a 100% keep split.
    function test_JitDepositCannotCaptureEarlierYield() public {
        _mintFor(bob, 100 ether);
        token.addYield(10 ether); // arrives while bob is the only holder

        vm.startPrank(alice);
        token.setYieldSplit(BPS);
        token.mint(alice, 900 ether); // 90% of supply, right after the yield
        vm.stopPrank();

        assertEq(token.keptYieldOf(alice), 0, "nothing captured retroactively");
        assertEq(token.yieldAccrued(), 10 ether, "prior yield fully donated");
    }

    function test_VaultLossFreezesKeptClaimsUntilRecovery() public {
        vm.prank(alice);
        token.setYieldSplit(BPS);
        _mintFor(alice, 100 ether);
        token.addYield(10 ether);
        vm.prank(alice);
        token.transfer(alice, 0); // settle the 10 into her kept balance

        token.slashAssets(105 ether); // deep loss: surplus now 5 < kept 10

        assertEq(token.yieldAccrued(), 0, "donated pool clamps to zero");
        vm.prank(alice);
        vm.expectRevert(AbstractToken.YieldInsufficient.selector);
        token.claimKeptYield(alice); // unbacked mint is refused

        token.addYield(105 ether); // vault recovers
        vm.prank(alice);
        token.claimKeptYield(alice);
        assertEq(token.balanceOf(alice), 110 ether, "kept share survives the loss");
    }

    function test_RepeatedClaimsAcrossYieldEvents() public {
        vm.prank(alice);
        token.setYieldSplit(5000);
        _mintFor(alice, 100 ether);

        token.addYield(10 ether);
        vm.prank(alice);
        token.claimKeptYield(alice); // +5

        token.addYield(21 ether); // alice now holds 105 of 105 supply
        assertEq(token.keptYieldOf(alice), 10.5 ether, "full share of second event");
        vm.prank(alice);
        token.claimKeptYield(alice);
        assertEq(token.balanceOf(alice), 115.5 ether, "both claims minted");

        vm.prank(claimer);
        token.claimYield(15.5 ether, claimer); // 5 + 10.5 donated
        assertEq(token.totalYieldAccrued(), 0, "conserved across repeated claims");
    }

    /* --------------------------- conservation ---------------------------- */

    function testFuzz_KeptPlusDonatedNeverExceedRaw(uint16 bpsA, uint16 bpsB, uint96 y1, uint96 y2, uint96 moved)
        public
    {
        bpsA = uint16(bound(bpsA, 0, BPS));
        bpsB = uint16(bound(bpsB, 0, BPS));
        y1 = uint96(bound(y1, 0, 1_000_000 ether));
        y2 = uint96(bound(y2, 0, 1_000_000 ether));
        moved = uint96(bound(moved, 0, 100 ether));

        vm.prank(alice);
        token.setYieldSplit(bpsA);
        vm.prank(bob);
        token.setYieldSplit(bpsB);
        _mintFor(alice, 100 ether);
        _mintFor(bob, 200 ether);

        token.addYield(y1);
        if (moved > 0) {
            vm.prank(alice);
            token.transfer(bob, moved);
        }
        token.addYield(y2);

        uint256 raw = token.totalYieldAccrued();
        uint256 attributed = token.keptYieldOf(alice) + token.keptYieldOf(bob) + token.yieldAccrued();
        assertLe(attributed, raw, "attribution never exceeds the vault surplus");
        // Truncation dust always lands in the donated pool; a couple of floor
        // divisions per settlement bound it to a handful of wei.
        assertApproxEqAbs(attributed, raw, 10, "nothing material leaks");

        // Everyone can actually exit with their full attribution.
        uint256 donated = token.yieldAccrued();
        if (donated > 0) {
            vm.prank(claimer);
            token.claimYield(donated, claimer);
        }
        if (token.keptYieldOf(alice) > 0) {
            vm.prank(alice);
            token.claimKeptYield(alice);
        }
        if (token.keptYieldOf(bob) > 0) {
            vm.prank(bob);
            token.claimKeptYield(bob);
        }
        assertLe(token.totalYieldAccrued(), 10, "only dust remains");
    }

    function testFuzz_SplitMatchesProRataShare(uint16 keep, uint96 yieldAmount) public {
        keep = uint16(bound(keep, 0, BPS));
        yieldAmount = uint96(bound(yieldAmount, 0, 1_000_000 ether));

        vm.prank(alice);
        token.setYieldSplit(keep);
        _mintFor(alice, 400 ether); // 40% of supply
        _mintFor(bob, 600 ether);

        token.addYield(yieldAmount);

        uint256 aliceShare = (uint256(yieldAmount) * 400) / 1000;
        uint256 expectedKept = (aliceShare * keep) / BPS;
        assertApproxEqAbs(token.keptYieldOf(alice), expectedKept, 2, "kept = share * split");
        assertApproxEqAbs(token.yieldAccrued(), yieldAmount - expectedKept, 2, "donated = rest");
    }
}

/// End-to-end sanity on a real token implementation (StableYield + ERC-4626-style
/// vault with 6-decimal underlying), exercising the same yield-split surface.
contract YieldSplitStableYieldTest is Test {
    MockUSDC usdc;
    MockStableVault vault;
    StableYield token;
    address claimer = address(0xCAFE);
    address user = address(0xBEEF);

    uint256 constant ONE = 1e6;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new MockStableVault(address(usdc));
        StableYield impl = new StableYield(address(usdc), address(vault));
        bytes memory data = abi.encodeWithSelector(StableYield.initialize.selector, "Stake", "STK", address(this));
        token = StableYield(payable(address(new ERC1967Proxy(address(impl), data))));
        token.setYieldClaimer(claimer);
        usdc.mintTo(user, 1_000 * ONE);
    }

    function test_KeepSplitOnRealImplementation() public {
        vm.startPrank(user);
        token.setYieldSplit(4000); // keep 40%
        usdc.approve(address(token), 100 * ONE);
        token.mint(user, 100 * ONE);
        vm.stopPrank();

        vault.setRateBps(10_500); // +5% → 5 USDC of yield
        usdc.mintTo(address(vault), 5 * ONE); // back the appreciation with real USDC
        assertEq(token.totalYieldAccrued(), 5 * ONE, "raw surplus");
        assertEq(token.keptYieldOf(user), 2 * ONE, "40% kept");
        assertEq(token.yieldAccrued(), 3 * ONE, "60% donated");

        vm.prank(user);
        token.claimKeptYield(user);
        assertEq(token.balanceOf(user), 102 * ONE, "kept yield minted");

        vm.prank(claimer);
        token.claimYield(3 * ONE, claimer);
        assertEq(token.balanceOf(claimer), 3 * ONE, "donated pool distributed");
        assertEq(token.yieldAccrued(), 0, "drained");

        // Withdrawing principal + kept yield redeems 1:1 for the underlying.
        vm.prank(user);
        token.burn(102 * ONE, user);
        assertEq(usdc.balanceOf(user), 1_002 * ONE, "principal + kept yield redeemed");
    }
}
