// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {AbstractRecipientRegistry} from "../../abstract/AbstractRecipientRegistry.sol";
import {CrossChainRegistryBase} from "../../abstract/CrossChainRegistryBase.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title AdminRecipientRegistry
/// @notice Admin-controlled registry for managing yield recipients with queue-based updates
/// @dev Admin can queue recipients for addition/removal, distributor manager processes the queue
/// @dev This implementation provides centralized control where only the admin can modify recipients
/// @dev Family instances (familyId != 0) additionally accept a chain-agnostic "desired set"
///      signature via applyCrossChainRegistryUpdate so one owner signature heals arbitrary drift
///      across every sibling chain. The classic owner paths stay ENABLED on family instances
///      (trusted admin; manual mirror remains the documented fallback).
/// @author BreadKit Protocol
contract AdminRecipientRegistry is AbstractRecipientRegistry, CrossChainRegistryBase {
    using ECDSA for bytes32;

    /// @notice EIP-712 typehash for the cross-chain registry update signature
    /// @dev The signed array is the FULL DESIRED SET (strictly ascending, canonical), not a
    ///      delta. Pinned for frontend/relay parity — do NOT change without updating both.
    bytes32 public constant CROSS_CHAIN_REGISTRY_UPDATE_TYPEHASH =
        keccak256("CrossChainRegistryUpdate(address admin,address[] recipients,uint256 nonce,uint256 deadline)");

    /// @notice Maximum queue size mirrored from AbstractRecipientRegistry (which keeps it private)
    /// @dev Used to fail fast before queueing; the base still enforces it during _queueFor*.
    uint256 private constant MAX_QUEUE_SIZE = 100;

    // ============ EIP-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:crowdstake.storage.AdminRecipientRegistry
    struct AdminRecipientRegistryStorage {
        /// @notice Highest cross-chain registry-update nonce accepted on this chain
        /// @dev Monotonic — updates supersede, so a superseded (stale) update is dead forever.
        uint256 lastRegistryUpdateNonce;
    }

    // keccak256(abi.encode(uint256(keccak256("crowdstake.storage.AdminRecipientRegistry")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ADMIN_RECIPIENT_REGISTRY_STORAGE =
        0xa2e2283558e082e592190b2aa2a384014f965b14df1e554382bbf2fe151a3e00;

    function _getAdminRecipientRegistryStorage() private pure returns (AdminRecipientRegistryStorage storage $) {
        assembly {
            $.slot := ADMIN_RECIPIENT_REGISTRY_STORAGE
        }
    }

    // ============ Events ============

    /// @notice Emitted when a cross-chain registry update is applied on this chain
    /// @dev Re-emits the full signed payload so the relay listener can propagate an update
    ///      submitted directly on-chain to sibling registries.
    /// @param admin The owner who signed the desired set
    /// @param recipients The full desired recipient set (strictly ascending)
    /// @param nonce Monotonic per-registry nonce
    /// @param deadline Unix timestamp after which the signature is invalid
    /// @param signature The chain-agnostic EIP-712 signature over the family domain
    event CrossChainRegistryUpdated(
        address indexed admin, address[] recipients, uint256 nonce, uint256 deadline, bytes signature
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialize the registry with an admin (classic chain-bound instance)
    /// @dev Back-compat overload: familyId = 0 (cross-chain path disabled).
    /// @param admin The address that will have administrative control over the registry
    function initialize(address admin) public initializer {
        _initialize(admin, bytes32(0));
    }

    /// @notice Initialize the registry with an admin and a cross-chain family identity
    /// @dev This function replaces the constructor for upgradeable contracts
    /// @dev Sets the admin as the owner who can queue recipient changes
    /// @dev Can only be called once due to the initializer modifier
    /// @param admin The address that will have administrative control over the registry
    /// @param _familyId Cross-chain family identity (0 = classic chain-bound instance)
    function initialize(address admin, bytes32 _familyId) public initializer {
        _initialize(admin, _familyId);
    }

    /// @dev Shared initializer body — the overloads must not nest `initializer` calls
    ///      (OpenZeppelin v5 reverts InvalidInitialization on reentrant initialization).
    function _initialize(address admin, bytes32 _familyId) private {
        __Ownable_init(admin);
        __CrossChainRegistryBase_init(_familyId);
    }

    /// @notice Returns the highest cross-chain registry-update nonce accepted on this chain
    /// @dev Settlement authority for the relay: an update whose nonce <= this is superseded.
    function lastRegistryUpdateNonce() public view returns (uint256) {
        return _getAdminRecipientRegistryStorage().lastRegistryUpdateNonce;
    }

    /// @notice Queue a single recipient for addition to the registry
    /// @dev Only the admin (owner) can call this function
    /// @dev The recipient will be added when processQueue() is called
    /// @dev Validates that the recipient is not the zero address and not already active
    /// @dev Emits RecipientQueued event upon successful queuing
    /// @param recipient The address to queue for addition to the recipient list
    function queueRecipientAddition(address recipient) external onlyOwner {
        _queueForAddition(recipient);
    }

    /// @notice Queue a single recipient for removal from the registry
    /// @dev Only the admin (owner) can call this function
    /// @dev The recipient will be removed when processQueue() is called
    /// @dev Validates that the recipient is currently active and not already queued for removal
    /// @dev Emits RecipientQueued event upon successful queuing
    /// @param recipient The address to queue for removal from the recipient list
    function queueRecipientRemoval(address recipient) external onlyOwner {
        _queueForRemoval(recipient);
    }

    /// @notice Queue multiple recipients for addition in a single transaction
    /// @dev Only the admin (owner) can call this function
    /// @dev More gas efficient than calling queueRecipientAddition multiple times
    /// @dev Each recipient is validated individually, failure of one stops the entire transaction
    /// @dev Emits a RecipientQueued event for each successfully queued recipient
    /// @param _recipients Array of addresses to queue for addition to the recipient list
    function queueRecipientsAddition(address[] calldata _recipients) external onlyOwner {
        for (uint256 i = 0; i < _recipients.length; i++) {
            _queueForAddition(_recipients[i]);
        }
    }

    /// @notice Queue multiple recipients for removal in a single transaction
    /// @dev Only the admin (owner) can call this function
    /// @dev More gas efficient than calling queueRecipientRemoval multiple times
    /// @dev Each recipient is validated individually, failure of one stops the entire transaction
    /// @dev Emits a RecipientQueued event for each successfully queued recipient
    /// @param _recipients Array of addresses to queue for removal from the recipient list
    function queueRecipientsRemoval(address[] calldata _recipients) external onlyOwner {
        for (uint256 i = 0; i < _recipients.length; i++) {
            _queueForRemoval(_recipients[i]);
        }
    }

    /// @notice Apply a chain-agnostic "desired set" registry update signed by the owner
    /// @dev Permissionless delivery: anyone (relay, listener, the owner) can submit. The signed
    ///      array is the FULL DESIRED SET (strictly ascending, canonical), NOT a delta — each
    ///      chain computes its own delta against the local set, so one signature heals arbitrary
    ///      drift and redelivery is a cheap nonce-burn no-op. Both pending queues are cleared
    ///      first (a half-run manual mirror must not poison the result), then the delta is queued
    ///      and processed in the same call.
    /// @dev A desired set requiring >MAX_QUEUE_SIZE additions or removals in one shot reverts
    ///      MaxQueueSizeReached — split the transition across two updates.
    /// @param admin The owner address that signed the desired set (must equal owner())
    /// @param recipients The full desired recipient set (strictly ascending, no zero, no dups)
    /// @param nonce Monotonic per-registry nonce (must exceed lastRegistryUpdateNonce)
    /// @param deadline Unix timestamp after which the signature is invalid
    /// @param signature Chain-agnostic EIP-712 signature over the family domain
    function applyCrossChainRegistryUpdate(
        address admin,
        address[] calldata recipients,
        uint256 nonce,
        uint256 deadline,
        bytes calldata signature
    ) external crossChainOnly {
        AdminRecipientRegistryStorage storage $ = _getAdminRecipientRegistryStorage();

        if (block.timestamp > deadline) revert SignatureExpired();
        if (nonce <= $.lastRegistryUpdateNonce) revert StaleNonce();
        if (admin != owner()) revert InvalidSignature();

        // Validate the desired set: strictly ascending, non-zero, within one-shot bounds.
        if (recipients.length > MAX_QUEUE_SIZE) revert MaxQueueSizeReached();
        for (uint256 i = 0; i < recipients.length; i++) {
            if (recipients[i] == address(0)) revert InvalidRecipient();
            if (i > 0 && uint160(recipients[i]) <= uint160(recipients[i - 1])) revert NotAscending();
        }

        // Verify the chain-agnostic signature recovers to the owner.
        bytes32 structHash = keccak256(
            abi.encode(
                CROSS_CHAIN_REGISTRY_UPDATE_TYPEHASH, admin, keccak256(abi.encodePacked(recipients)), nonce, deadline
            )
        );
        if (_hashCrossChainTypedData(structHash).recover(signature) != admin) revert InvalidSignature();

        // Burn the nonce — a superseded update is dead forever on this chain.
        $.lastRegistryUpdateNonce = nonce;

        // Clear both pending queues so a half-run manual mirror cannot poison the result.
        delete _getAbstractRecipientRegistryStorage().queuedRecipientsForAddition;
        delete _getAbstractRecipientRegistryStorage().queuedRecipientsForRemoval;

        // Compute and queue the delta against the local set, then process it in one tx.
        _queueDesiredSetDelta(recipients);
        _processQueue();

        // Re-emit the full signed payload so any listener can re-deliver it to siblings.
        emit CrossChainRegistryUpdated(admin, recipients, nonce, deadline, signature);
    }

    /// @notice Transfer administrative control to a new address
    /// @dev Only the current admin (owner) can call this function
    /// @dev The new admin will have full control over queuing recipients
    /// @dev This action is irreversible, the current admin loses all control
    /// @dev Uses OpenZeppelin's transferOwnership which includes zero address validation
    /// @param newAdmin The address that will become the new admin of the registry
    function transferAdmin(address newAdmin) external onlyOwner {
        transferOwnership(newAdmin);
    }

    /// @dev Queues the delta between the local active set and the desired set.
    ///      Additions are drawn from the desired set (already strictly ascending, so pushing them
    ///      in order satisfies the queue's ascending invariant). Removals are the local recipients
    ///      absent from the desired set; they are collected then insertion-sorted in memory before
    ///      queueing so the removal queue's ascending invariant holds regardless of local order.
    function _queueDesiredSetDelta(address[] calldata desired) private {
        AbstractRecipientRegistryStorage storage base = _getAbstractRecipientRegistryStorage();

        // Additions: desired entries not already active (desired is ascending → queue is sorted).
        for (uint256 i = 0; i < desired.length; i++) {
            if (!base.isRecipientMapping[desired[i]]) {
                _queueForAddition(desired[i]);
            }
        }

        // Removals: local recipients not present in the desired set.
        address[] memory local = base.recipients;
        uint256 removeCount = 0;
        address[] memory toRemove = new address[](local.length);
        for (uint256 i = 0; i < local.length; i++) {
            bool keep = false;
            for (uint256 j = 0; j < desired.length; j++) {
                if (local[i] == desired[j]) {
                    keep = true;
                    break;
                }
            }
            if (!keep) {
                toRemove[removeCount++] = local[i];
            }
        }

        // Insertion-sort the removals ascending (the removal queue requires ascending order).
        for (uint256 i = 1; i < removeCount; i++) {
            address key = toRemove[i];
            uint256 j = i;
            while (j > 0 && uint160(toRemove[j - 1]) > uint160(key)) {
                toRemove[j] = toRemove[j - 1];
                j--;
            }
            toRemove[j] = key;
        }

        for (uint256 i = 0; i < removeCount; i++) {
            _queueForRemoval(toRemove[i]);
        }
    }
}
