// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {VotingRecipientRegistry} from "../src/implementation/registries/VotingRecipientRegistry.sol";
import {CrossChainRegistryBase} from "../src/abstract/CrossChainRegistryBase.sol";
import {IRecipientRegistry} from "../src/interfaces/IRecipientRegistry.sol";

/// @notice Cross-chain democratic registry: proposals + votes replayed via chain-agnostic
///         signatures. Two family instances simulate two chains; the same proposalKey exists on
///         both, and execution converges to identical sets regardless of vote-delivery order.
contract CrossChainVotingRegistryTest is Test {
    bytes32 internal constant FAMILY_ID = keccak256("test.family");
    uint256 internal constant EXPIRY = 30 days;
    uint256 internal constant DEADLINE = 4102444800;

    // Electorate members keyed by pk so they can sign votes.
    uint256 internal pk1 = 0xA11CE;
    uint256 internal pk2 = 0xB0B;
    uint256 internal pk3 = 0xC0FFEE;
    address internal m1;
    address internal m2;
    address internal m3;
    address internal candidate = address(0xCAFE);

    address internal admin = address(0xAD);

    VotingRecipientRegistry internal regA; // "chain A"
    VotingRecipientRegistry internal regB; // "chain B"
    VotingRecipientRegistry internal classic; // familyId == 0

    event CrossChainProposalCreated(
        bytes32 indexed proposalKey,
        address proposer,
        address candidate,
        bool isAddition,
        address[] electorate,
        uint256 expiresAt,
        uint256 nonce,
        bytes signature
    );
    event CrossChainProposalVoteCast(bytes32 indexed proposalKey, address voter, uint256 deadline, bytes signature);
    event CrossChainProposalExecuted(bytes32 indexed proposalKey);

    function setUp() public {
        m1 = vm.addr(pk1);
        m2 = vm.addr(pk2);
        m3 = vm.addr(pk3);

        address[] memory founders = _sortedElectorate();
        regA = _deploy(founders, FAMILY_ID);
        regB = _deploy(founders, FAMILY_ID);
        classic = _deploy(founders, bytes32(0));
    }

    function _deploy(address[] memory founders, bytes32 familyId_) internal returns (VotingRecipientRegistry reg) {
        VotingRecipientRegistry impl = new VotingRecipientRegistry();
        reg = VotingRecipientRegistry(
            address(
                new ERC1967Proxy(
                    address(impl),
                    abi.encodeWithSignature(
                        "initialize(address,address[],uint256,bytes32)", admin, founders, EXPIRY, familyId_
                    )
                )
            )
        );
    }

    /// @dev The three members sorted ascending (a valid, canonical electorate).
    function _sortedElectorate() internal view returns (address[] memory arr) {
        address[3] memory tmp = [m1, m2, m3];
        // insertion sort
        for (uint256 i = 1; i < 3; i++) {
            address key = tmp[i];
            uint256 j = i;
            while (j > 0 && uint160(tmp[j - 1]) > uint160(key)) {
                tmp[j] = tmp[j - 1];
                j--;
            }
            tmp[j] = key;
        }
        arr = new address[](3);
        arr[0] = tmp[0];
        arr[1] = tmp[1];
        arr[2] = tmp[2];
    }

    function _proposalKey(
        VotingRecipientRegistry reg,
        address proposer,
        address candidate_,
        bool isAddition,
        address[] memory electorate,
        uint256 expiresAt,
        uint256 nonce
    ) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                reg.CROSS_CHAIN_PROPOSAL_TYPEHASH(),
                proposer,
                candidate_,
                isAddition,
                keccak256(abi.encodePacked(electorate)),
                expiresAt,
                nonce
            )
        );
    }

    function _signProposal(VotingRecipientRegistry reg, uint256 pk, bytes32 proposalKey)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", reg.crossChainDomainSeparator(), proposalKey));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signVote(VotingRecipientRegistry reg, uint256 pk, address voter, bytes32 proposalKey, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash =
            keccak256(abi.encode(reg.CROSS_CHAIN_PROPOSAL_VOTE_TYPEHASH(), voter, proposalKey, deadline));
        bytes32 digest = keccak256(abi.encodePacked(hex"1901", reg.crossChainDomainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Create an addition proposal for `candidate` on `reg`, proposer = m1, returns key.
    function _createAdd(VotingRecipientRegistry reg, uint256 expiresAt, uint256 nonce) internal returns (bytes32 key) {
        address[] memory electorate = _sortedElectorate();
        key = _proposalKey(reg, m1, candidate, true, electorate, expiresAt, nonce);
        bytes memory sig = _signProposal(reg, pk1, key);
        reg.createCrossChainProposal(m1, candidate, true, electorate, expiresAt, nonce, sig);
    }

    // ---- creation ----

    function test_CreateProposal_AutoVotesAndSnapshots() public {
        uint256 expiresAt = block.timestamp + EXPIRY;
        bytes32 key = _createAdd(regA, expiresAt, 1);

        (address c, bool isAddition, bool executed, uint256 exp, uint256 votes, uint256 required) =
            regA.getCrossChainProposal(key);
        assertEq(c, candidate);
        assertTrue(isAddition);
        assertFalse(executed);
        assertEq(exp, expiresAt);
        assertEq(votes, 1, "proposer auto-voted");
        assertEq(required, 3, "N add");
        assertTrue(regA.hasVotedCrossChain(key, m1), "proposer recorded");
        assertTrue(regA.isEligibleCrossChainVoter(key, m2), "electorate snapshot");
        assertEq(regA.crossChainProposalCount(), 1);
        assertEq(regA.crossChainProposalKeyAt(0), key);
    }

    function test_RevertWhen_DuplicateProposalKey() public {
        uint256 expiresAt = block.timestamp + EXPIRY;
        _createAdd(regA, expiresAt, 1);

        address[] memory electorate = _sortedElectorate();
        bytes32 key = _proposalKey(regA, m1, candidate, true, electorate, expiresAt, 1);
        bytes memory sig = _signProposal(regA, pk1, key);
        vm.expectRevert(VotingRecipientRegistry.ProposalAlreadyExists.selector);
        regA.createCrossChainProposal(m1, candidate, true, electorate, expiresAt, 1, sig);
    }

    function test_RevertWhen_ElectorateMismatch() public {
        // Electorate omits m3 → set-inequality vs local [m1,m2,m3].
        address[] memory bad = new address[](2);
        bad[0] = m1;
        bad[1] = m2;
        uint256 expiresAt = block.timestamp + EXPIRY;
        bytes32 key = _proposalKey(regA, m1, candidate, true, bad, expiresAt, 1);
        bytes memory sig = _signProposal(regA, pk1, key);
        vm.expectRevert(CrossChainRegistryBase.RecipientSetMismatch.selector);
        regA.createCrossChainProposal(m1, candidate, true, bad, expiresAt, 1, sig);
    }

    function test_RevertWhen_ProposerNotInElectorate() public {
        address[] memory electorate = _sortedElectorate();
        uint256 expiresAt = block.timestamp + EXPIRY;
        // Proposer = candidate (not a member); signature by candidate's implied key is irrelevant,
        // eligibility check fires first.
        bytes32 key = _proposalKey(regA, candidate, candidate, true, electorate, expiresAt, 1);
        bytes memory sig = _signProposal(regA, pk1, key); // signer irrelevant; reverts before recover
        vm.expectRevert(VotingRecipientRegistry.NotEligibleVoter.selector);
        regA.createCrossChainProposal(candidate, candidate, true, electorate, expiresAt, 1, sig);
    }

    function test_RevertWhen_BadProposerSignature() public {
        address[] memory electorate = _sortedElectorate();
        uint256 expiresAt = block.timestamp + EXPIRY;
        bytes32 key = _proposalKey(regA, m1, candidate, true, electorate, expiresAt, 1);
        // Signed by m2, but proposer claims m1 → recovery mismatch.
        bytes memory sig = _signProposal(regA, pk2, key);
        vm.expectRevert(CrossChainRegistryBase.InvalidSignature.selector);
        regA.createCrossChainProposal(m1, candidate, true, electorate, expiresAt, 1, sig);
    }

    // ---- expiry bounds ----

    function test_ExpiryBoundary_TimestampEqualsExpiresAt_Ok() public {
        uint256 expiresAt = block.timestamp + EXPIRY;
        bytes32 key = _createAdd(regA, expiresAt, 1);
        // Warp exactly to expiresAt — voting still allowed (block.timestamp > expiresAt is false).
        vm.warp(expiresAt);
        bytes memory sig = _signVote(regA, pk2, m2, key, DEADLINE);
        regA.castCrossChainProposalVote(m2, key, DEADLINE, sig);
        (,,,, uint256 votes,) = regA.getCrossChainProposal(key);
        assertEq(votes, 2, "vote at ts==expiresAt accepted");
    }

    function test_ExpiryBoundary_TimestampPastExpiresAt_Reverts() public {
        uint256 expiresAt = block.timestamp + EXPIRY;
        bytes32 key = _createAdd(regA, expiresAt, 1);
        vm.warp(expiresAt + 1);
        bytes memory sig = _signVote(regA, pk2, m2, key, DEADLINE);
        vm.expectRevert(VotingRecipientRegistry.ProposalExpired.selector);
        regA.castCrossChainProposalVote(m2, key, DEADLINE, sig);
    }

    function test_RevertWhen_ExpiresAtTooFar() public {
        // Signed expiry beyond block.timestamp + proposalExpiry ceiling.
        uint256 expiresAt = block.timestamp + EXPIRY + 1;
        address[] memory electorate = _sortedElectorate();
        bytes32 key = _proposalKey(regA, m1, candidate, true, electorate, expiresAt, 1);
        bytes memory sig = _signProposal(regA, pk1, key);
        vm.expectRevert(VotingRecipientRegistry.ExpiryTooFar.selector);
        regA.createCrossChainProposal(m1, candidate, true, electorate, expiresAt, 1, sig);
    }

    function test_RevertWhen_VoteDeadlinePassed() public {
        uint256 expiresAt = block.timestamp + EXPIRY;
        bytes32 key = _createAdd(regA, expiresAt, 1);
        bytes memory sig = _signVote(regA, pk2, m2, key, DEADLINE);
        vm.warp(DEADLINE + 1);
        vm.expectRevert(CrossChainRegistryBase.SignatureExpired.selector);
        regA.castCrossChainProposalVote(m2, key, DEADLINE, sig);
    }

    // ---- voting + execution ----

    function test_FullVoteReachesThresholdAndExecutes() public {
        uint256 expiresAt = block.timestamp + EXPIRY;
        bytes32 key = _createAdd(regA, expiresAt, 1);

        regA.castCrossChainProposalVote(m2, key, DEADLINE, _signVote(regA, pk2, m2, key, DEADLINE));
        // Third vote reaches threshold (3/3) → auto-execute + processQueue in one call.
        regA.castCrossChainProposalVote(m3, key, DEADLINE, _signVote(regA, pk3, m3, key, DEADLINE));

        (,, bool executed,,,) = regA.getCrossChainProposal(key);
        assertTrue(executed, "executed");
        assertTrue(regA.isRecipient(candidate), "candidate added AND queue processed");
        assertEq(regA.getRecipientCount(), 4);
    }

    /// @dev Opposite vote-delivery order on two chains still converges to the identical set,
    ///      and the same proposalKey identifies the proposal on both.
    function test_OppositeOrderExecutionConverges() public {
        uint256 expiresAt = block.timestamp + EXPIRY;
        bytes32 keyA = _createAdd(regA, expiresAt, 1);
        bytes32 keyB = _createAdd(regB, expiresAt, 1);
        assertEq(keyA, keyB, "content-addressed: same key on both chains");

        // Chain A: m2 then m3.
        regA.castCrossChainProposalVote(m2, keyA, DEADLINE, _signVote(regA, pk2, m2, keyA, DEADLINE));
        regA.castCrossChainProposalVote(m3, keyA, DEADLINE, _signVote(regA, pk3, m3, keyA, DEADLINE));

        // Chain B: m3 then m2 (opposite order). Vote signatures are chain-agnostic → reusable.
        regB.castCrossChainProposalVote(m3, keyB, DEADLINE, _signVote(regB, pk3, m3, keyB, DEADLINE));
        regB.castCrossChainProposalVote(m2, keyB, DEADLINE, _signVote(regB, pk2, m2, keyB, DEADLINE));

        assertTrue(regA.isRecipient(candidate) && regB.isRecipient(candidate), "both added the candidate");
        assertEq(regA.getRecipientCount(), regB.getRecipientCount(), "identical final set size");
        assertEq(regA.getRecipientCount(), 4);
    }

    /// @dev A vote signature is chain-agnostic: the exact same signature verifies on both siblings.
    function test_VoteSignatureIsChainAgnostic() public {
        uint256 expiresAt = block.timestamp + EXPIRY;
        bytes32 keyA = _createAdd(regA, expiresAt, 1);
        bytes32 keyB = _createAdd(regB, expiresAt, 1);
        assertEq(keyA, keyB);

        bytes memory sig = _signVote(regA, pk2, m2, keyA, DEADLINE);
        regA.castCrossChainProposalVote(m2, keyA, DEADLINE, sig);
        regB.castCrossChainProposalVote(m2, keyB, DEADLINE, sig); // SAME signature on sibling
        assertTrue(regA.hasVotedCrossChain(keyA, m2) && regB.hasVotedCrossChain(keyB, m2));
    }

    /// @dev Converged execution (effect already in place) is a no-op, not a stuck revert.
    ///      Two addition proposals for the SAME candidate are open concurrently (different nonces,
    ///      distinct keys — concurrent proposals must not supersede each other). P2 executes first
    ///      and adds the candidate; P1 then reaches threshold and executes as a no-op.
    function test_ConvergedExecutionIsNoOp() public {
        address[] memory electorate = _sortedElectorate();
        uint256 expiresAt = block.timestamp + EXPIRY;

        // P1 and P2 both propose adding `candidate` while it is still absent → both create OK.
        bytes32 p1 = _proposalKey(regA, m1, candidate, true, electorate, expiresAt, 1);
        regA.createCrossChainProposal(m1, candidate, true, electorate, expiresAt, 1, _signProposal(regA, pk1, p1));
        bytes32 p2 = _proposalKey(regA, m2, candidate, true, electorate, expiresAt, 2);
        regA.createCrossChainProposal(m2, candidate, true, electorate, expiresAt, 2, _signProposal(regA, pk2, p2));
        assertTrue(p1 != p2, "concurrent proposals have distinct keys");

        // Drive P2 to threshold first → candidate added.
        regA.castCrossChainProposalVote(m1, p2, DEADLINE, _signVote(regA, pk1, m1, p2, DEADLINE));
        regA.castCrossChainProposalVote(m3, p2, DEADLINE, _signVote(regA, pk3, m3, p2, DEADLINE));
        assertTrue(regA.isRecipient(candidate), "candidate added by P2");
        assertEq(regA.getRecipientCount(), 4);

        // Now drive P1 to threshold → effect already in place → executes as a NO-OP (no revert).
        regA.castCrossChainProposalVote(m2, p1, DEADLINE, _signVote(regA, pk2, m2, p1, DEADLINE));
        regA.castCrossChainProposalVote(m3, p1, DEADLINE, _signVote(regA, pk3, m3, p1, DEADLINE));
        (,, bool executed,,,) = regA.getCrossChainProposal(p1);
        assertTrue(executed, "P1 marked executed");
        assertTrue(regA.isRecipient(candidate), "still a recipient");
        assertEq(regA.getRecipientCount(), 4, "no double-add");
    }

    /// @dev Re-executing an already-executed proposal reverts cleanly.
    function test_RevertWhen_DoubleExecute() public {
        uint256 expiresAt = block.timestamp + EXPIRY;
        bytes32 key = _createAdd(regA, expiresAt, 1);
        regA.castCrossChainProposalVote(m2, key, DEADLINE, _signVote(regA, pk2, m2, key, DEADLINE));
        regA.castCrossChainProposalVote(m3, key, DEADLINE, _signVote(regA, pk3, m3, key, DEADLINE));
        vm.expectRevert(VotingRecipientRegistry.ProposalAlreadyExecuted.selector);
        regA.executeCrossChainProposal(key);
    }

    /// @dev A member added mid-proposal is NOT eligible to vote on the earlier proposal.
    function test_MidProposalMemberNotEligible() public {
        uint256 expiresAt = block.timestamp + EXPIRY;
        // Proposal P1 (add `candidate`) snapshots electorate [m1,m2,m3].
        bytes32 p1 = _createAdd(regA, expiresAt, 1);

        // Fully add `candidate` via a SEPARATE proposal P2 so the live set becomes 4.
        // But candidate is the same address; instead add a different member `newM` via P2.
        address newM = address(0xBEEF);
        address[] memory electorate = _sortedElectorate();
        bytes32 p2 = _proposalKey(regA, m1, newM, true, electorate, expiresAt, 2);
        regA.createCrossChainProposal(m1, newM, true, electorate, expiresAt, 2, _signProposal(regA, pk1, p2));
        regA.castCrossChainProposalVote(m2, p2, DEADLINE, _signVote(regA, pk2, m2, p2, DEADLINE));
        regA.castCrossChainProposalVote(m3, p2, DEADLINE, _signVote(regA, pk3, m3, p2, DEADLINE));
        assertTrue(regA.isRecipient(newM), "newM added");

        // newM is NOT in P1's snapshotted electorate → cannot vote on P1.
        assertFalse(regA.isEligibleCrossChainVoter(p1, newM));
        bytes memory sig = _signVoteAddr(regA, newM, p1, DEADLINE);
        vm.expectRevert(VotingRecipientRegistry.NotEligibleVoter.selector);
        regA.castCrossChainProposalVote(newM, p1, DEADLINE, sig);
    }

    // ---- classic gating both ways ----

    /// @dev Cross-chain entrypoints are disabled on a classic (familyId==0) instance.
    function test_RevertWhen_CrossChainOnClassicInstance() public {
        address[] memory electorate = _sortedElectorate();
        uint256 expiresAt = block.timestamp + EXPIRY;
        bytes32 key = _proposalKey(classic, m1, candidate, true, electorate, expiresAt, 1);
        bytes memory sig = _signProposal(classic, pk1, key);
        vm.expectRevert(CrossChainRegistryBase.CrossChainNotEnabled.selector);
        classic.createCrossChainProposal(m1, candidate, true, electorate, expiresAt, 1, sig);

        vm.expectRevert(CrossChainRegistryBase.CrossChainNotEnabled.selector);
        classic.castCrossChainProposalVote(m1, key, DEADLINE, "");

        vm.expectRevert(CrossChainRegistryBase.CrossChainNotEnabled.selector);
        classic.executeCrossChainProposal(key);
    }

    /// @dev Classic mutation paths are gated on a family (democratic) instance.
    function test_RevertWhen_ClassicPathsOnFamilyInstance() public {
        vm.startPrank(m1);
        vm.expectRevert(CrossChainRegistryBase.CrossChainOnly.selector);
        regA.proposeAddition(candidate);

        vm.expectRevert(CrossChainRegistryBase.CrossChainOnly.selector);
        regA.proposeRemoval(m2);

        vm.expectRevert(CrossChainRegistryBase.CrossChainOnly.selector);
        regA.queueRecipientAddition(candidate);

        vm.expectRevert(CrossChainRegistryBase.CrossChainOnly.selector);
        regA.queueRecipientRemoval(m2);

        vm.expectRevert(CrossChainRegistryBase.CrossChainOnly.selector);
        regA.vote(0);

        vm.expectRevert(CrossChainRegistryBase.CrossChainOnly.selector);
        regA.executeProposal(0);
        vm.stopPrank();
    }

    /// @dev Classic paths still work on a classic instance (the family gate is inert there).
    function test_ClassicPathsWorkOnClassicInstance() public {
        vm.prank(m1);
        uint256 pid = classic.proposeAddition(candidate);
        vm.prank(m2);
        classic.vote(pid);
        vm.prank(m3);
        classic.vote(pid);
        classic.processQueue();
        assertTrue(classic.isRecipient(candidate), "classic democratic add works");
    }

    // ---- misc reverts ----

    function test_RevertWhen_VoteOnUnknownProposal() public {
        bytes32 key = keccak256("nope");
        bytes memory sig = _signVote(regA, pk2, m2, key, DEADLINE);
        vm.expectRevert(VotingRecipientRegistry.ProposalNotFound.selector);
        regA.castCrossChainProposalVote(m2, key, DEADLINE, sig);
    }

    function test_RevertWhen_DoubleVote() public {
        uint256 expiresAt = block.timestamp + EXPIRY;
        bytes32 key = _createAdd(regA, expiresAt, 1);
        // m1 already auto-voted on creation.
        bytes memory sig = _signVote(regA, pk1, m1, key, DEADLINE);
        vm.expectRevert(VotingRecipientRegistry.AlreadyVoted.selector);
        regA.castCrossChainProposalVote(m1, key, DEADLINE, sig);
    }

    function test_RevertWhen_IneligibleVoter() public {
        uint256 expiresAt = block.timestamp + EXPIRY;
        bytes32 key = _createAdd(regA, expiresAt, 1);
        // candidate is not in the electorate.
        bytes memory sig = _signVoteAddr(regA, candidate, key, DEADLINE);
        vm.expectRevert(VotingRecipientRegistry.NotEligibleVoter.selector);
        regA.castCrossChainProposalVote(candidate, key, DEADLINE, sig);
    }

    /// @dev Empty signature — used only where an earlier check (eligibility) fires before
    ///      signature recovery, so the bytes are never passed to ECDSA.
    function _signVoteAddr(VotingRecipientRegistry, address, bytes32, uint256) internal pure returns (bytes memory) {
        return "";
    }
}
