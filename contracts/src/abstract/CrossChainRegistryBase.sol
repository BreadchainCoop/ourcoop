// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title CrossChainRegistryBase
/// @author BreadKit Protocol
/// @notice Shared cross-chain (family) plumbing for recipient registries: the chain-agnostic
///         EIP-712 family domain, the familyId identity, gating modifiers, and shared errors.
/// @dev The domain math (name "CrowdstakingVoting", version "2", salt = familyId, and NO
///      chainId/verifyingContract) is duplicated VERBATIM from AbstractVotingModule so one
///      signature is valid on every sibling instance sharing the same familyId — kept in a fresh
///      EIP-7201 namespace so registries can mix this in without disturbing existing layouts.
abstract contract CrossChainRegistryBase {
    // ============ Constants ============

    /// @notice EIP-712 domain name for the family (chain-agnostic) signature domain
    /// @dev Must match AbstractVotingModule.EIP712_NAME so registries and voting modules
    ///      share one family domain per familyId.
    string private constant EIP712_NAME = "CrowdstakingVoting";

    /// @notice EIP-712 domain version for cross-chain (family) signature verification
    /// @dev Must match AbstractVotingModule.CROSS_CHAIN_EIP712_VERSION.
    string private constant CROSS_CHAIN_EIP712_VERSION = "2";

    /// @notice EIP-712 domain typehash for the chain-agnostic family domain
    /// @dev name + version + salt only — deliberately NO chainId/verifyingContract, so one
    ///      signature is valid on every instance sharing the same familyId.
    bytes32 private constant CROSS_CHAIN_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,bytes32 salt)");

    // ============ EIP-7201 Namespaced Storage ============

    /// @custom:storage-location erc7201:crowdstake.storage.CrossChainRegistryBase
    struct CrossChainRegistryBaseStorage {
        /// @notice Cross-chain family identity; 0 = classic chain-bound instance
        /// @dev Salts the chain-agnostic EIP-712 domain shared by all family siblings
        bytes32 familyId;
    }

    // keccak256(abi.encode(uint256(keccak256("crowdstake.storage.CrossChainRegistryBase")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant CROSS_CHAIN_REGISTRY_BASE_STORAGE =
        0x220a872acd67c89040bbb7b050473a000086693e9d0b4d37b292a0ecb0abb400;

    function _getCrossChainRegistryBaseStorage() internal pure returns (CrossChainRegistryBaseStorage storage $) {
        assembly {
            $.slot := CROSS_CHAIN_REGISTRY_BASE_STORAGE
        }
    }

    // ============ Errors ============

    /// @notice Thrown when a cross-chain entrypoint is used on a classic (familyId == 0) instance
    error CrossChainNotEnabled();

    /// @notice Thrown when a classic mutation path is used on a family instance that gates it
    error CrossChainOnly();

    /// @notice Thrown when a signed payload is submitted after its deadline
    error SignatureExpired();

    /// @notice Thrown when a monotonic nonce is not strictly greater than the last accepted one
    error StaleNonce();

    /// @notice Thrown when an EIP-712 signature does not recover to the expected signer
    error InvalidSignature();

    /// @notice Thrown when a signed recipient/electorate set does not match the local set
    error RecipientSetMismatch();

    /// @notice Thrown when a signed recipient array is not in strictly ascending order
    error NotAscending();

    // ============ Modifiers ============

    /// @notice Restricts a cross-chain entrypoint to family instances (familyId != 0)
    modifier crossChainOnly() {
        if (_getCrossChainRegistryBaseStorage().familyId == bytes32(0)) revert CrossChainNotEnabled();
        _;
    }

    /// @notice Restricts a classic mutation path to classic instances (familyId == 0)
    /// @dev A no-op on classic instances; reverts CrossChainOnly on gated family instances.
    modifier onlyClassicRegistry() {
        if (_getCrossChainRegistryBaseStorage().familyId != bytes32(0)) revert CrossChainOnly();
        _;
    }

    // ============ Initialization ============

    /// @notice Records the cross-chain family identity for this instance
    /// @dev Called once from the inheriting registry's initializer. familyId 0 keeps the
    ///      instance classic (chain-bound); a non-zero id enables the family signature paths.
    /// @param _familyId Cross-chain family identity (0 = classic chain-bound instance)
    // solhint-disable-next-line func-name-mixedcase
    function __CrossChainRegistryBase_init(bytes32 _familyId) internal {
        _getCrossChainRegistryBaseStorage().familyId = _familyId;
    }

    // ============ Public Getters ============

    /// @notice Returns the cross-chain family identity (0 = classic chain-bound instance)
    /// @dev The relay listener reads this to attribute registry logs to a family.
    function familyId() public view returns (bytes32) {
        return _getCrossChainRegistryBaseStorage().familyId;
    }

    // ============ Domain Helpers ============

    /// @notice Returns the chain-agnostic EIP-712 domain separator for the family signature path
    /// @dev keccak256(CROSS_CHAIN_DOMAIN_TYPEHASH, name, version, salt = familyId) — identical on
    ///      every chain, which is what makes one signature family-wide. Duplicated VERBATIM from
    ///      AbstractVotingModule.crossChainDomainSeparator so registry and voting signatures share
    ///      one domain per familyId.
    function crossChainDomainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                CROSS_CHAIN_DOMAIN_TYPEHASH,
                keccak256(bytes(EIP712_NAME)),
                keccak256(bytes(CROSS_CHAIN_EIP712_VERSION)),
                _getCrossChainRegistryBaseStorage().familyId
            )
        );
    }

    /// @notice Builds the EIP-712 digest for a struct hash under the family domain
    /// @dev digest = keccak256(0x1901 || crossChainDomainSeparator() || structHash) — the OZ
    ///      chain-bound domain is never used for family digests.
    /// @param structHash The keccak256 hash of the encoded typed struct
    /// @return The full EIP-712 digest to recover the signer from
    function _hashCrossChainTypedData(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", crossChainDomainSeparator(), structHash));
    }
}
