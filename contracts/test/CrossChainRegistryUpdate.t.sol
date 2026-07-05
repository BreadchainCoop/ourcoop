// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {AdminRecipientRegistry} from "../src/implementation/registries/AdminRecipientRegistry.sol";
import {CrossChainRegistryBase} from "../src/abstract/CrossChainRegistryBase.sol";
import {IRecipientRegistry} from "../src/interfaces/IRecipientRegistry.sol";

/// @notice Cross-chain admin registry "desired set" signature-replay tests. Two family instances
///         simulate two chains: one owner signature over the desired set converges arbitrary drift
///         on both, regardless of local order.
contract CrossChainRegistryUpdateTest is Test {
    bytes32 internal constant FAMILY_ID = keccak256("test.family");
    uint256 internal constant OWNER_PK = 0xBEEF;
    uint256 internal constant DEADLINE = 4102444800;

    address internal constant R1 = address(0x1111111111111111111111111111111111111111);
    address internal constant R2 = address(0x2222222222222222222222222222222222222222);
    address internal constant R3 = address(0x3333333333333333333333333333333333333333);
    address internal constant R4 = address(0x4444444444444444444444444444444444444444);

    AdminRecipientRegistry internal regA; // "chain A"
    AdminRecipientRegistry internal regB; // "chain B" (drifted / reordered)
    AdminRecipientRegistry internal classic; // familyId == 0
    address internal owner;

    event CrossChainRegistryUpdated(
        address indexed admin, address[] recipients, uint256 nonce, uint256 deadline, bytes signature
    );

    function setUp() public {
        owner = vm.addr(OWNER_PK);
        regA = _deploy(FAMILY_ID);
        regB = _deploy(FAMILY_ID);
        classic = _deploy(bytes32(0));
    }

    function _deploy(bytes32 familyId_) internal returns (AdminRecipientRegistry reg) {
        AdminRecipientRegistry impl = new AdminRecipientRegistry();
        reg = AdminRecipientRegistry(
            address(
                new ERC1967Proxy(
                    address(impl), abi.encodeWithSignature("initialize(address,bytes32)", owner, familyId_)
                )
            )
        );
    }

    /// @dev Seed a registry's active set directly through the owner's classic paths.
    function _seed(AdminRecipientRegistry reg, address[] memory recipients) internal {
        vm.startPrank(owner);
        for (uint256 i = 0; i < recipients.length; i++) {
            reg.queueRecipientAddition(recipients[i]);
        }
        vm.stopPrank();
        reg.processQueue();
    }

    function _sign(AdminRecipientRegistry reg, address[] memory recipients, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory signature)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                reg.CROSS_CHAIN_REGISTRY_UPDATE_TYPEHASH(),
                owner,
                keccak256(abi.encodePacked(recipients)),
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", reg.crossChainDomainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_PK, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _set2(address a, address b) internal pure returns (address[] memory arr) {
        arr = new address[](2);
        arr[0] = a;
        arr[1] = b;
    }

    function _sorted(address[] memory a) internal pure returns (bool) {
        for (uint256 i = 1; i < a.length; i++) {
            if (uint160(a[i]) <= uint160(a[i - 1])) return false;
        }
        return true;
    }

    // ---- convergence ----

    /// @dev The SAME signature converges two drifted siblings to the identical set.
    function test_OneSignatureConvergesDriftedSiblings() public {
        // A has [R1, R3]; B has [R2, R4]. Desired canonical set = [R1, R2].
        _seed(regA, _set2(R1, R3));
        _seed(regB, _set2(R2, R4));

        address[] memory desired = _set2(R1, R2); // strictly ascending
        assertTrue(_sorted(desired));
        bytes memory sig = _sign(regA, desired, 1, DEADLINE);

        regA.applyCrossChainRegistryUpdate(owner, desired, 1, DEADLINE, sig);
        regB.applyCrossChainRegistryUpdate(owner, desired, 1, DEADLINE, sig);

        _assertSetEquals(regA, desired);
        _assertSetEquals(regB, desired);
        assertEq(regA.lastRegistryUpdateNonce(), 1, "A nonce");
        assertEq(regB.lastRegistryUpdateNonce(), 1, "B nonce");
    }

    /// @dev Converges even when the local order differs from the desired order.
    function test_ConvergesRegardlessOfLocalOrder() public {
        // Seed B in descending-ish order by adding higher addresses via separate txs.
        _seed(regB, _set2(R1, R4));
        address[] memory desired = _set2(R2, R3);
        bytes memory sig = _sign(regB, desired, 5, DEADLINE);
        regB.applyCrossChainRegistryUpdate(owner, desired, 5, DEADLINE, sig);
        _assertSetEquals(regB, desired);
    }

    /// @dev Redelivery onto an already-converged set is a cheap nonce-burn no-op that still lands.
    function test_AlreadyEqualSet_BurnsNonce_NoOp() public {
        _seed(regA, _set2(R1, R2));
        address[] memory desired = _set2(R1, R2);
        bytes memory sig = _sign(regA, desired, 9, DEADLINE);
        regA.applyCrossChainRegistryUpdate(owner, desired, 9, DEADLINE, sig);
        assertEq(regA.lastRegistryUpdateNonce(), 9, "nonce burned");
        _assertSetEquals(regA, desired);
    }

    /// @dev A half-run manual mirror (pending queues) is cleared before the delta is applied.
    function test_ClearsPoisonedQueuesBeforeApplying() public {
        _seed(regA, _set2(R1, R3));

        // Poison: queue a stray addition and removal that must NOT survive the update.
        vm.startPrank(owner);
        regA.queueRecipientAddition(R4); // stray addition
        regA.queueRecipientRemoval(R1); // stray removal
        vm.stopPrank();
        assertTrue(regA.isQueuedForAddition(R4), "poison addition queued");
        assertTrue(regA.isQueuedForRemoval(R1), "poison removal queued");

        address[] memory desired = _set2(R1, R2);
        bytes memory sig = _sign(regA, desired, 2, DEADLINE);
        regA.applyCrossChainRegistryUpdate(owner, desired, 2, DEADLINE, sig);

        _assertSetEquals(regA, desired); // R1 kept, R2 added, R3 removed, R4 NOT added
        assertFalse(regA.isQueuedForAddition(R4), "poison addition cleared");
        assertFalse(regA.isQueuedForRemoval(R1), "poison removal cleared");
    }

    function test_EmitsFullPayload() public {
        _seed(regA, _set2(R1, R3));
        address[] memory desired = _set2(R1, R2);
        bytes memory sig = _sign(regA, desired, 3, DEADLINE);

        vm.expectEmit(true, false, false, true);
        emit CrossChainRegistryUpdated(owner, desired, 3, DEADLINE, sig);
        regA.applyCrossChainRegistryUpdate(owner, desired, 3, DEADLINE, sig);
    }

    // ---- reverts ----

    function test_RevertWhen_ClassicInstance() public {
        address[] memory desired = _set2(R1, R2);
        vm.expectRevert(CrossChainRegistryBase.CrossChainNotEnabled.selector);
        classic.applyCrossChainRegistryUpdate(owner, desired, 1, DEADLINE, "");
    }

    function test_RevertWhen_DeadlinePassed() public {
        address[] memory desired = _set2(R1, R2);
        bytes memory sig = _sign(regA, desired, 1, DEADLINE);
        vm.warp(DEADLINE + 1);
        vm.expectRevert(CrossChainRegistryBase.SignatureExpired.selector);
        regA.applyCrossChainRegistryUpdate(owner, desired, 1, DEADLINE, sig);
    }

    function test_RevertWhen_StaleNonce() public {
        address[] memory desired = _set2(R1, R2);
        bytes memory sig = _sign(regA, desired, 5, DEADLINE);
        regA.applyCrossChainRegistryUpdate(owner, desired, 5, DEADLINE, sig);

        // Exact replay is dead.
        vm.expectRevert(CrossChainRegistryBase.StaleNonce.selector);
        regA.applyCrossChainRegistryUpdate(owner, desired, 5, DEADLINE, sig);

        // A superseded lower nonce is dead forever.
        bytes memory old = _sign(regA, desired, 3, DEADLINE);
        vm.expectRevert(CrossChainRegistryBase.StaleNonce.selector);
        regA.applyCrossChainRegistryUpdate(owner, desired, 3, DEADLINE, old);
    }

    function test_RevertWhen_SignerNotOwner() public {
        address[] memory desired = _set2(R1, R2);
        // Signed by a non-owner key, but claims admin == owner → recovery mismatch.
        bytes32 structHash = keccak256(
            abi.encode(
                regA.CROSS_CHAIN_REGISTRY_UPDATE_TYPEHASH(),
                owner,
                keccak256(abi.encodePacked(desired)),
                uint256(1),
                DEADLINE
            )
        );
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", regA.crossChainDomainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xD00D, digest);
        vm.expectRevert(CrossChainRegistryBase.InvalidSignature.selector);
        regA.applyCrossChainRegistryUpdate(owner, desired, 1, DEADLINE, abi.encodePacked(r, s, v));
    }

    function test_RevertWhen_AdminMismatchesOwner() public {
        address[] memory desired = _set2(R1, R2);
        address notOwner = address(0xCAFE);
        bytes memory sig = _sign(regA, desired, 1, DEADLINE);
        // admin field != owner() → InvalidSignature before recovery.
        vm.expectRevert(CrossChainRegistryBase.InvalidSignature.selector);
        regA.applyCrossChainRegistryUpdate(notOwner, desired, 1, DEADLINE, sig);
    }

    function test_RevertWhen_NotAscending() public {
        address[] memory desired = _set2(R2, R1); // descending
        bytes memory sig = _sign(regA, desired, 1, DEADLINE);
        vm.expectRevert(CrossChainRegistryBase.NotAscending.selector);
        regA.applyCrossChainRegistryUpdate(owner, desired, 1, DEADLINE, sig);
    }

    function test_RevertWhen_DuplicateInDesired() public {
        address[] memory desired = _set2(R1, R1); // equal → not strictly ascending
        bytes memory sig = _sign(regA, desired, 1, DEADLINE);
        vm.expectRevert(CrossChainRegistryBase.NotAscending.selector);
        regA.applyCrossChainRegistryUpdate(owner, desired, 1, DEADLINE, sig);
    }

    function test_RevertWhen_ZeroInDesired() public {
        address[] memory desired = _set2(address(0), R1);
        bytes memory sig = _sign(regA, desired, 1, DEADLINE);
        vm.expectRevert(IRecipientRegistry.InvalidRecipient.selector);
        regA.applyCrossChainRegistryUpdate(owner, desired, 1, DEADLINE, sig);
    }

    function test_RevertWhen_TooManyRecipients() public {
        address[] memory desired = new address[](101);
        for (uint256 i = 0; i < 101; i++) {
            desired[i] = address(uint160(i + 1));
        }
        bytes memory sig = _sign(regA, desired, 1, DEADLINE);
        vm.expectRevert(IRecipientRegistry.MaxQueueSizeReached.selector);
        regA.applyCrossChainRegistryUpdate(owner, desired, 1, DEADLINE, sig);
    }

    /// @dev Classic owner paths stay ENABLED on family (admin-kind) instances.
    function test_ClassicOwnerPathsStayEnabledOnFamilyInstance() public {
        vm.startPrank(owner);
        regA.queueRecipientAddition(R1);
        vm.stopPrank();
        regA.processQueue();
        assertTrue(regA.isRecipient(R1), "classic owner add still works on family admin instance");
    }

    // ---- helpers ----

    function _assertSetEquals(AdminRecipientRegistry reg, address[] memory expected) internal view {
        address[] memory got = reg.getRecipients();
        assertEq(got.length, expected.length, "set size");
        for (uint256 i = 0; i < expected.length; i++) {
            assertTrue(reg.isRecipient(expected[i]), "expected recipient present");
        }
    }
}
