// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {AdminRecipientRegistry} from "../src/implementation/registries/AdminRecipientRegistry.sol";
import {VotingRecipientRegistry} from "../src/implementation/registries/VotingRecipientRegistry.sol";

/// @notice Pinned EIP-712 parity vectors for the three cross-chain registry-governance types,
///         plus the proposalKey. Mirrors CrossChainVoting.t.sol's digest-vector pattern: the
///         relay + frontend depend on these exact digests (see relay/test/crosschain-vector.json).
///         Regenerate both vector JSONs if any pinned input changes.
contract CrossChainRegistryParityTest is Test {
    // Pinned parity vector inputs (identical style to CrossChainVoting.t.sol).
    bytes32 internal constant FAMILY_ID = keccak256("test.family");
    uint256 internal constant SIGNER_PK = 0xBEEF;
    address internal constant RECIPIENT_A = address(0x1111111111111111111111111111111111111111);
    address internal constant RECIPIENT_B = address(0x2222222222222222222222222222222222222222);
    address internal constant CANDIDATE = address(0x3333333333333333333333333333333333333333);
    uint256 internal constant NONCE = 1;
    uint256 internal constant DEADLINE = 4102444800; // 2100-01-01T00:00:00Z
    uint256 internal constant EXPIRES_AT = 4102444800;

    // Pinned family domain separator — identical to CrossChainVoting.t.sol (same familyId, name,
    // version). Registry and voting-module signatures share one family domain per familyId.
    bytes32 internal constant PINNED_DOMAIN_SEPARATOR =
        0x577d21fde5a041ff7085c02c10e79d939308aa0b4334b248f5b63c341a025976;

    // Pinned outputs (logged once via the vector tests below with -vv, then hardcoded).
    bytes32 internal constant PINNED_REGISTRY_UPDATE_STRUCT_HASH =
        0x7a11807b965001197e4841447ce60658e4ca3b4c0d7964f8a65ae2a31b2282c3;
    bytes32 internal constant PINNED_REGISTRY_UPDATE_DIGEST =
        0x2e90db8d9fe7edc89b4bc9f858e940ed8acf5db498e31456c69e2c1dc5f8d4b4;

    bytes32 internal constant PINNED_PROPOSAL_KEY = 0x7c50bf5911a2c3b71e1ac06ed569af4529b69cf5e659932cd51b6f2ee24381fa;
    bytes32 internal constant PINNED_PROPOSAL_DIGEST =
        0x3996939165510c24ce51dd0d7243b61c13c32488f229570b076b0c3ac3e94dee;

    bytes32 internal constant PINNED_PROPOSAL_VOTE_STRUCT_HASH =
        0xf5b33d8a8ad2e640129428f50b95a5d88a23a4663d3739cc6ee40671f74a6fc9;
    bytes32 internal constant PINNED_PROPOSAL_VOTE_DIGEST =
        0x45b7303afde59666044befe3a9d0e86cf321918c3bc9303d8c5d0537d908b4cd;

    AdminRecipientRegistry internal adminRegistry;
    VotingRecipientRegistry internal votingRegistry;
    address internal signer;

    function setUp() public {
        signer = vm.addr(SIGNER_PK);

        AdminRecipientRegistry adminImpl = new AdminRecipientRegistry();
        adminRegistry = AdminRecipientRegistry(
            address(
                new ERC1967Proxy(
                    address(adminImpl), abi.encodeWithSignature("initialize(address,bytes32)", signer, FAMILY_ID)
                )
            )
        );

        address[] memory founders = new address[](2);
        founders[0] = RECIPIENT_A;
        founders[1] = RECIPIENT_B;
        VotingRecipientRegistry votingImpl = new VotingRecipientRegistry();
        votingRegistry = VotingRecipientRegistry(
            address(
                new ERC1967Proxy(
                    address(votingImpl),
                    abi.encodeWithSignature(
                        "initialize(address,address[],uint256,bytes32)", signer, founders, uint256(30 days), FAMILY_ID
                    )
                )
            )
        );
    }

    function _recipients() internal pure returns (address[] memory recipients) {
        recipients = new address[](2);
        recipients[0] = RECIPIENT_A;
        recipients[1] = RECIPIENT_B;
    }

    function _digest(bytes32 domainSeparator, bytes32 structHash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator, structHash));
    }

    // Both registries derive the SAME family domain separator (same name/version/salt).
    function test_DomainSeparatorParity() public view {
        assertEq(adminRegistry.crossChainDomainSeparator(), PINNED_DOMAIN_SEPARATOR, "admin domain");
        assertEq(votingRegistry.crossChainDomainSeparator(), PINNED_DOMAIN_SEPARATOR, "voting domain");
    }

    // ---- CrossChainRegistryUpdate ----
    function test_RegistryUpdateVector() public view {
        address[] memory recipients = _recipients();
        bytes32 structHash = keccak256(
            abi.encode(
                adminRegistry.CROSS_CHAIN_REGISTRY_UPDATE_TYPEHASH(),
                signer,
                keccak256(abi.encodePacked(recipients)),
                NONCE,
                DEADLINE
            )
        );
        bytes32 digest = _digest(adminRegistry.crossChainDomainSeparator(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        console2.log("=== registryUpdate ===");
        console2.log("admin:", signer);
        console2.logBytes32(structHash);
        console2.logBytes32(digest);
        console2.logBytes(signature);

        assertEq(structHash, PINNED_REGISTRY_UPDATE_STRUCT_HASH, "registryUpdate structHash");
        assertEq(digest, PINNED_REGISTRY_UPDATE_DIGEST, "registryUpdate digest");
    }

    // ---- CrossChainProposal (proposalKey == structHash) ----
    function test_ProposalVector() public view {
        address[] memory electorate = _recipients();
        bytes32 proposalKey = keccak256(
            abi.encode(
                votingRegistry.CROSS_CHAIN_PROPOSAL_TYPEHASH(),
                signer,
                CANDIDATE,
                true,
                keccak256(abi.encodePacked(electorate)),
                EXPIRES_AT,
                NONCE
            )
        );
        bytes32 digest = _digest(votingRegistry.crossChainDomainSeparator(), proposalKey);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        console2.log("=== proposal ===");
        console2.log("proposer:", signer);
        console2.log("candidate:", CANDIDATE);
        console2.logBytes32(proposalKey);
        console2.logBytes32(digest);
        console2.logBytes(signature);

        assertEq(proposalKey, PINNED_PROPOSAL_KEY, "proposalKey");
        assertEq(digest, PINNED_PROPOSAL_DIGEST, "proposal digest");
    }

    // ---- CrossChainProposalVote ----
    function test_ProposalVoteVector() public view {
        // Votes are cast against the proposalKey computed above.
        address[] memory electorate = _recipients();
        bytes32 proposalKey = keccak256(
            abi.encode(
                votingRegistry.CROSS_CHAIN_PROPOSAL_TYPEHASH(),
                signer,
                CANDIDATE,
                true,
                keccak256(abi.encodePacked(electorate)),
                EXPIRES_AT,
                NONCE
            )
        );
        bytes32 structHash =
            keccak256(abi.encode(votingRegistry.CROSS_CHAIN_PROPOSAL_VOTE_TYPEHASH(), signer, proposalKey, DEADLINE));
        bytes32 digest = _digest(votingRegistry.crossChainDomainSeparator(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        console2.log("=== proposalVote ===");
        console2.log("voter:", signer);
        console2.logBytes32(proposalKey);
        console2.logBytes32(structHash);
        console2.logBytes32(digest);
        console2.logBytes(signature);

        assertEq(structHash, PINNED_PROPOSAL_VOTE_STRUCT_HASH, "proposalVote structHash");
        assertEq(digest, PINNED_PROPOSAL_VOTE_DIGEST, "proposalVote digest");
    }
}
