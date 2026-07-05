// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {BasisPointsVotingModule} from "../src/base/BasisPointsVotingModule.sol";
import {IVotingModule} from "../src/interfaces/IVotingModule.sol";
import {IVotingPowerStrategy} from "../src/interfaces/IVotingPowerStrategy.sol";
import {CycleModule} from "../src/implementation/CycleModule.sol";
import {AbstractCycleModule} from "../src/abstract/AbstractCycleModule.sol";
import {MockRecipientRegistry} from "./mocks/MockRecipientRegistry.sol";
import {MockDistributionModule} from "./mocks/MockDistributionModule.sol";

/// @notice Voting power strategy with directly settable per-account power.
contract MockVotingPowerStrategy is IVotingPowerStrategy {
    mapping(address => uint256) public power;

    function setPower(address account, uint256 value) external {
        power[account] = value;
    }

    function getCurrentVotingPower(address account) external view returns (uint256) {
        return power[account];
    }
}

contract CrossChainVotingTest is Test {
    // Pinned parity vector inputs (mirrored by the relay + frontend parity tests —
    // see relay/test/crosschain-vector.json; regenerate it if any of these change).
    bytes32 internal constant FAMILY_ID = keccak256("test.family");
    uint256 internal constant VOTER_PK = 0xBEEF;
    address internal constant RECIPIENT_A = address(0x1111111111111111111111111111111111111111);
    address internal constant RECIPIENT_B = address(0x2222222222222222222222222222222222222222);
    address internal constant RECIPIENT_C = address(0x3333333333333333333333333333333333333333);
    uint256 internal constant NONCE = 1;
    uint256 internal constant DEADLINE = 4102444800; // 2100-01-01T00:00:00Z

    // Pinned parity vector outputs (logged once via test_DigestParityVector, then hardcoded).
    bytes32 internal constant PINNED_DOMAIN_SEPARATOR =
        0x577d21fde5a041ff7085c02c10e79d939308aa0b4334b248f5b63c341a025976;
    bytes32 internal constant PINNED_DIGEST = 0x2e4f5c3f51540e6c76cd3239ddb06339d02ca33c89e3f81950079cda3788c931;

    uint256 internal constant MAX_POINTS = 10_000;
    uint256 internal constant PRECISION = 1e18;

    // Family instance A: local recipient order [A, B] (the "signing chain").
    BasisPointsVotingModule internal moduleA;
    MockRecipientRegistry internal registryA;
    // Family instance B: SAME membership, DIFFERENT local order [B, A] (the "sibling chain").
    BasisPointsVotingModule internal moduleB;
    // Family instance C: DIFFERENT membership [A, C] (drifted sibling).
    BasisPointsVotingModule internal moduleC;
    // Classic v2 instance: familyId == 0 via the 5-arg initializer.
    BasisPointsVotingModule internal moduleClassic;

    MockVotingPowerStrategy internal strategy;
    address internal voter;
    uint256 internal powerlessPk;
    address internal powerlessVoter;

    event VoteCast(address indexed voter, uint256[] points, uint256 votingPower, uint256 nonce, bytes signature);
    event CrossChainVoteCast(
        address indexed voter,
        uint256[] points,
        address[] recipients,
        uint256 votingPower,
        uint256 nonce,
        uint256 deadline,
        bytes signature
    );

    function setUp() public {
        voter = vm.addr(VOTER_PK);
        powerlessPk = 0xD00D;
        powerlessVoter = vm.addr(powerlessPk);

        strategy = new MockVotingPowerStrategy();
        strategy.setPower(voter, 1e18);

        address[] memory orderAB = new address[](2);
        orderAB[0] = RECIPIENT_A;
        orderAB[1] = RECIPIENT_B;
        (moduleA, registryA) = _deployModule(orderAB, FAMILY_ID);

        address[] memory orderBA = new address[](2);
        orderBA[0] = RECIPIENT_B;
        orderBA[1] = RECIPIENT_A;
        (moduleB,) = _deployModule(orderBA, FAMILY_ID);

        address[] memory drifted = new address[](2);
        drifted[0] = RECIPIENT_A;
        drifted[1] = RECIPIENT_C;
        (moduleC,) = _deployModule(drifted, FAMILY_ID);

        (moduleClassic,) = _deployModule(orderAB, bytes32(0));
    }

    // ============ Helpers ============

    function _deployModule(address[] memory recipients, bytes32 familyId_)
        internal
        returns (BasisPointsVotingModule module, MockRecipientRegistry registry)
    {
        registry = new MockRecipientRegistry(recipients);

        CycleModule cycle;
        {
            CycleModule cycleImpl = new CycleModule();
            bytes memory cycleInit =
                abi.encodeWithSelector(AbstractCycleModule.initialize.selector, 1000, address(this));
            cycle = CycleModule(address(new ERC1967Proxy(address(cycleImpl), cycleInit)));
        }

        MockDistributionModule dist = new MockDistributionModule(address(registry), address(cycle));

        IVotingPowerStrategy[] memory strategies = new IVotingPowerStrategy[](1);
        strategies[0] = IVotingPowerStrategy(address(strategy));

        BasisPointsVotingModule impl = new BasisPointsVotingModule();
        // encodeWithSignature: `initialize` is overloaded, so `.selector` is ambiguous.
        bytes memory init = abi.encodeWithSignature(
            "initialize(uint256,address[],address,address,bytes32)",
            MAX_POINTS,
            strategies,
            address(dist),
            address(this),
            familyId_
        );
        module = BasisPointsVotingModule(address(new ERC1967Proxy(address(impl), init)));
    }

    function _defaultBallot() internal pure returns (uint256[] memory points, address[] memory recipients) {
        points = new uint256[](2);
        points[0] = 6000;
        points[1] = 4000;
        recipients = new address[](2);
        recipients[0] = RECIPIENT_A;
        recipients[1] = RECIPIENT_B;
    }

    function _crossChainDigest(
        BasisPointsVotingModule module,
        address voter_,
        uint256[] memory points,
        address[] memory recipients,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes32 structHash, bytes32 digest) {
        structHash = keccak256(
            abi.encode(
                module.CROSS_CHAIN_VOTE_TYPEHASH(),
                voter_,
                keccak256(abi.encodePacked(points)),
                keccak256(abi.encodePacked(recipients)),
                nonce,
                deadline
            )
        );
        digest = keccak256(abi.encodePacked(hex"1901", module.crossChainDomainSeparator(), structHash));
    }

    function _signCrossChain(
        BasisPointsVotingModule module,
        uint256 pk,
        uint256[] memory points,
        address[] memory recipients,
        uint256 nonce,
        uint256 deadline
    ) internal view returns (bytes memory signature) {
        (, bytes32 digest) = _crossChainDigest(module, vm.addr(pk), points, recipients, nonce, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        signature = abi.encodePacked(r, s, v);
    }

    // ============ Digest parity vector (pinned — relay/frontend depend on it) ============

    function test_DigestParityVector() public view {
        // Hand-computed family domain: EIP712Domain(string name,string version,bytes32 salt),
        // name "CrowdstakingVoting", version "2", salt = familyId. No chainId/verifyingContract.
        bytes32 expectedDomainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,bytes32 salt)"),
                keccak256(bytes("CrowdstakingVoting")),
                keccak256(bytes("2")),
                FAMILY_ID
            )
        );
        assertEq(moduleA.crossChainDomainSeparator(), expectedDomainSeparator, "domain separator");

        (uint256[] memory points, address[] memory recipients) = _defaultBallot();
        (bytes32 structHash, bytes32 digest) = _crossChainDigest(moduleA, voter, points, recipients, NONCE, DEADLINE);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(VOTER_PK, digest);
        bytes memory signature = abi.encodePacked(r, s, v);

        assertTrue(
            moduleA.validateCrossChainSignature(voter, points, recipients, NONCE, DEADLINE, signature),
            "contract accepts the vector signature"
        );
        // Same signature verifies on the sibling: the domain has no chainId/verifyingContract.
        assertTrue(
            moduleB.validateCrossChainSignature(voter, points, recipients, NONCE, DEADLINE, signature),
            "sibling accepts the vector signature"
        );

        // Vector source for relay/test/crosschain-vector.json (run with -vv to print).
        // Logged before the pinned asserts so a re-pin run still prints the new values.
        console2.log("voter:", voter);
        console2.logBytes32(moduleA.familyId());
        console2.logBytes32(expectedDomainSeparator);
        console2.logBytes32(structHash);
        console2.logBytes32(digest);
        console2.logBytes(signature);

        assertEq(expectedDomainSeparator, PINNED_DOMAIN_SEPARATOR, "pinned domain separator");
        assertEq(digest, PINNED_DIGEST, "pinned digest");
    }

    function test_ValidateCrossChainSignature_WrongSigner() public view {
        (uint256[] memory points, address[] memory recipients) = _defaultBallot();
        bytes memory signature = _signCrossChain(moduleA, powerlessPk, points, recipients, NONCE, DEADLINE);
        assertFalse(
            moduleA.validateCrossChainSignature(voter, points, recipients, NONCE, DEADLINE, signature),
            "wrong signer rejected"
        );
    }

    // ============ Lockstep domain views ============

    function test_FamilyDomainViews() public {
        assertEq(moduleA.familyId(), FAMILY_ID, "familyId");
        assertEq(moduleA.DOMAIN_SEPARATOR(), moduleA.crossChainDomainSeparator(), "DOMAIN_SEPARATOR lockstep");

        // Chain-agnostic: the same on every chainId and for every sibling address.
        vm.chainId(100);
        bytes32 onGnosis = moduleA.DOMAIN_SEPARATOR();
        vm.chainId(42161);
        assertEq(moduleA.DOMAIN_SEPARATOR(), onGnosis, "chain-independent");
        assertEq(moduleB.DOMAIN_SEPARATOR(), onGnosis, "address-independent");

        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        ) = moduleA.eip712Domain();
        assertEq(fields, bytes1(0x13), "fields = name|version|salt");
        assertEq(name, "CrowdstakingVoting", "name");
        assertEq(version, "2", "version");
        assertEq(chainId, 0, "no chainId");
        assertEq(verifyingContract, address(0), "no verifyingContract");
        assertEq(salt, FAMILY_ID, "salt = familyId");
        assertEq(extensions.length, 0, "no extensions");
    }

    function test_ClassicDomainViewsUnchanged() public view {
        assertEq(moduleClassic.familyId(), bytes32(0), "classic familyId");
        // Classic instances keep the OZ chain-bound domain.
        assertTrue(
            moduleClassic.DOMAIN_SEPARATOR() != moduleClassic.crossChainDomainSeparator(),
            "classic DOMAIN_SEPARATOR stays chain-bound"
        );
        (bytes1 fields,,, uint256 chainId, address verifyingContract,,) = moduleClassic.eip712Domain();
        assertEq(fields, bytes1(0x0f), "classic fields");
        assertEq(chainId, block.chainid, "classic chainId");
        assertEq(verifyingContract, address(moduleClassic), "classic verifyingContract");
    }

    function test_RecipientsHash() public view {
        assertEq(
            moduleA.recipientsHash(),
            keccak256(abi.encodePacked(registryA.getRecipients())),
            "recipientsHash = packed recipient set"
        );
        assertTrue(moduleA.recipientsHash() != moduleB.recipientsHash(), "order-sensitive probe");
    }

    // ============ castCrossChainVote — happy paths ============

    function test_SameSignatureCastsOnTwoSimulatedChains() public {
        (uint256[] memory points, address[] memory recipients) = _defaultBallot();
        bytes memory signature = _signCrossChain(moduleA, VOTER_PK, points, recipients, NONCE, DEADLINE);

        vm.chainId(100);
        moduleA.castCrossChainVote(voter, points, recipients, NONCE, DEADLINE, signature);
        assertEq(moduleA.lastCrossChainNonce(voter), NONCE, "nonce recorded on A");

        vm.chainId(42161);
        moduleB.castCrossChainVote(voter, points, recipients, NONCE, DEADLINE, signature);
        assertEq(moduleB.lastCrossChainNonce(voter), NONCE, "nonce recorded on B");

        // Identity mapping: B's local order is [B, A], so the ballot lands reordered.
        uint256[] memory distA = moduleA.getProjectDistributions(1);
        uint256[] memory distB = moduleB.getProjectDistributions(1);
        assertEq(distA[0], (6000 * 1e18 * PRECISION) / 10_000 / PRECISION, "A: recipient A gets 60%");
        assertEq(distA[1], (4000 * 1e18 * PRECISION) / 10_000 / PRECISION, "A: recipient B gets 40%");
        assertEq(distB[0], distA[1], "B: recipient B (local index 0) gets 40%");
        assertEq(distB[1], distA[0], "B: recipient A (local index 1) gets 60%");
    }

    function test_EmitsCrossChainVoteCastAndVoteCast() public {
        (uint256[] memory points, address[] memory recipients) = _defaultBallot();
        bytes memory signature = _signCrossChain(moduleA, VOTER_PK, points, recipients, NONCE, DEADLINE);

        // On the reordered sibling, VoteCast carries the LOCAL points; CrossChainVoteCast
        // re-emits the signed payload verbatim (so listeners can re-deliver it).
        uint256[] memory localPoints = new uint256[](2);
        localPoints[0] = 4000;
        localPoints[1] = 6000;

        vm.expectEmit(true, false, false, true);
        emit CrossChainVoteCast(voter, points, recipients, 1e18, NONCE, DEADLINE, signature);
        vm.expectEmit(true, false, false, true);
        emit VoteCast(voter, localPoints, 1e18, NONCE, signature);
        moduleB.castCrossChainVote(voter, points, recipients, NONCE, DEADLINE, signature);
    }

    function test_HigherNonceRecastsBallot() public {
        (uint256[] memory points, address[] memory recipients) = _defaultBallot();
        bytes memory signature = _signCrossChain(moduleA, VOTER_PK, points, recipients, NONCE, DEADLINE);
        moduleA.castCrossChainVote(voter, points, recipients, NONCE, DEADLINE, signature);

        // Nonces are monotonic, not sequential (the frontend uses timestamps).
        uint256[] memory newPoints = new uint256[](2);
        newPoints[0] = 1000;
        newPoints[1] = 9000;
        uint256 newNonce = 1_700_000_000_000;
        bytes memory newSignature = _signCrossChain(moduleA, VOTER_PK, newPoints, recipients, newNonce, DEADLINE);
        moduleA.castCrossChainVote(voter, newPoints, recipients, newNonce, DEADLINE, newSignature);

        assertEq(moduleA.lastCrossChainNonce(voter), newNonce, "nonce advanced");
        uint256[] memory dist = moduleA.getProjectDistributions(1);
        assertEq(dist[0], (1000 * 1e18 * PRECISION) / 10_000 / PRECISION, "recast replaced allocation A");
        assertEq(dist[1], (9000 * 1e18 * PRECISION) / 10_000 / PRECISION, "recast replaced allocation B");
        assertEq(moduleA.totalCycleVotingPower(1), 1e18, "power counted once");
    }

    // ============ castCrossChainVote — reverts ============

    function test_RevertWhen_ClassicInstance_CrossChainNotEnabled() public {
        (uint256[] memory points, address[] memory recipients) = _defaultBallot();
        vm.expectRevert(IVotingModule.CrossChainNotEnabled.selector);
        moduleClassic.castCrossChainVote(voter, points, recipients, NONCE, DEADLINE, "");
    }

    function test_RevertWhen_DeadlinePassed_SignatureExpired() public {
        (uint256[] memory points, address[] memory recipients) = _defaultBallot();
        bytes memory signature = _signCrossChain(moduleA, VOTER_PK, points, recipients, NONCE, DEADLINE);
        vm.warp(DEADLINE + 1);
        vm.expectRevert(IVotingModule.SignatureExpired.selector);
        moduleA.castCrossChainVote(voter, points, recipients, NONCE, DEADLINE, signature);
    }

    function test_RevertWhen_NonceReplayedOrRolledBack_StaleNonce() public {
        (uint256[] memory points, address[] memory recipients) = _defaultBallot();
        uint256 nonce = 5;
        bytes memory signature = _signCrossChain(moduleA, VOTER_PK, points, recipients, nonce, DEADLINE);
        moduleA.castCrossChainVote(voter, points, recipients, nonce, DEADLINE, signature);

        // Exact replay is dead.
        vm.expectRevert(IVotingModule.StaleNonce.selector);
        moduleA.castCrossChainVote(voter, points, recipients, nonce, DEADLINE, signature);

        // A superseded (lower-nonce) signature is dead forever — no rollback.
        bytes memory oldSignature = _signCrossChain(moduleA, VOTER_PK, points, recipients, 3, DEADLINE);
        vm.expectRevert(IVotingModule.StaleNonce.selector);
        moduleA.castCrossChainVote(voter, points, recipients, 3, DEADLINE, oldSignature);
    }

    function test_RevertWhen_MembershipDrift_RecipientSetMismatch() public {
        (uint256[] memory points, address[] memory recipients) = _defaultBallot();
        bytes memory signature = _signCrossChain(moduleA, VOTER_PK, points, recipients, NONCE, DEADLINE);
        // moduleC's registry is [A, C]; the ballot names [A, B] — B is unknown, C unmatched.
        vm.expectRevert(IVotingModule.RecipientSetMismatch.selector);
        moduleC.castCrossChainVote(voter, points, recipients, NONCE, DEADLINE, signature);
    }

    function test_RevertWhen_DuplicateSignedRecipient_RecipientSetMismatch() public {
        uint256[] memory points = new uint256[](2);
        points[0] = 6000;
        points[1] = 4000;
        address[] memory recipients = new address[](2);
        recipients[0] = RECIPIENT_A;
        recipients[1] = RECIPIENT_A;
        vm.expectRevert(IVotingModule.RecipientSetMismatch.selector);
        moduleA.castCrossChainVote(voter, points, recipients, NONCE, DEADLINE, "");
    }

    function test_RevertWhen_LengthMismatch_RecipientSetMismatch() public {
        uint256[] memory points = new uint256[](1);
        points[0] = 6000;
        address[] memory recipients = new address[](1);
        recipients[0] = RECIPIENT_A;
        vm.expectRevert(IVotingModule.RecipientSetMismatch.selector);
        moduleA.castCrossChainVote(voter, points, recipients, NONCE, DEADLINE, "");
    }

    function test_RevertWhen_PointsExceedMax_ExceedsMaxPoints() public {
        (, address[] memory recipients) = _defaultBallot();
        uint256[] memory points = new uint256[](2);
        points[0] = MAX_POINTS + 1;
        points[1] = 0;
        vm.expectRevert(IVotingModule.ExceedsMaxPoints.selector);
        moduleA.castCrossChainVote(voter, points, recipients, NONCE, DEADLINE, "");
    }

    function test_RevertWhen_AllPointsZero_ZeroVotePoints() public {
        (, address[] memory recipients) = _defaultBallot();
        uint256[] memory points = new uint256[](2);
        vm.expectRevert(IVotingModule.ZeroVotePoints.selector);
        moduleA.castCrossChainVote(voter, points, recipients, NONCE, DEADLINE, "");
    }

    function test_RevertWhen_BadSignature_InvalidSignature() public {
        (uint256[] memory points, address[] memory recipients) = _defaultBallot();
        bytes memory signature = _signCrossChain(moduleA, powerlessPk, points, recipients, NONCE, DEADLINE);
        vm.expectRevert(IVotingModule.InvalidSignature.selector);
        moduleA.castCrossChainVote(voter, points, recipients, NONCE, DEADLINE, signature);
    }

    function test_RevertWhen_NoLocalStake_ZeroVotingPower() public {
        (uint256[] memory points, address[] memory recipients) = _defaultBallot();
        bytes memory signature = _signCrossChain(moduleA, powerlessPk, points, recipients, NONCE, DEADLINE);
        vm.expectRevert(IVotingModule.ZeroVotingPower.selector);
        moduleA.castCrossChainVote(powerlessVoter, points, recipients, NONCE, DEADLINE, signature);
        // The nonce was NOT burned — the vote can land once the voter has stake here.
        assertEq(moduleA.lastCrossChainNonce(powerlessVoter), 0, "no nonce burn");
    }

    // ============ Single-path rule: legacy entrypoints are closed on family instances ============

    function test_RevertWhen_LegacyEntrypointsOnFamilyInstance_CrossChainOnly() public {
        uint256[] memory points = new uint256[](2);
        points[0] = 6000;
        points[1] = 4000;

        vm.expectRevert(IVotingModule.CrossChainOnly.selector);
        moduleA.voteWithData(points, "");

        address[] memory voters = new address[](1);
        voters[0] = voter;
        uint256[][] memory batchPoints = new uint256[][](1);
        batchPoints[0] = points;
        bytes[] memory batchData = new bytes[](1);
        vm.expectRevert(IVotingModule.CrossChainOnly.selector);
        moduleA.voteWithDataBatch(voters, batchPoints, batchData);

        vm.expectRevert(IVotingModule.CrossChainOnly.selector);
        moduleA.castVoteWithSignature(voter, points, NONCE, "");

        vm.expectRevert(IVotingModule.CrossChainOnly.selector);
        moduleA.castVoteWithSignatureAndParams(voter, points, NONCE, "", "");

        uint256[] memory nonces = new uint256[](1);
        nonces[0] = NONCE;
        bytes[] memory signatures = new bytes[](1);
        vm.expectRevert(IVotingModule.CrossChainOnly.selector);
        moduleA.castBatchVotesWithSignature(voters, batchPoints, nonces, signatures);
    }

    // ============ familyId == 0 v2 instance behaves exactly like today ============

    function test_ClassicV2Instance_LegacyPathsStillWork() public {
        uint256[] memory points = new uint256[](2);
        points[0] = 6000;
        points[1] = 4000;

        // castVoteWithSignature with the OZ chain-bound domain.
        bytes32 structHash =
            keccak256(abi.encode(moduleClassic.VOTE_TYPEHASH(), voter, keccak256(abi.encodePacked(points)), NONCE));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", moduleClassic.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(VOTER_PK, digest);
        moduleClassic.castVoteWithSignature(voter, points, NONCE, abi.encodePacked(r, s, v));
        assertTrue(moduleClassic.isNonceUsed(voter, NONCE), "legacy nonce used");

        // voteWithData from a fresh direct voter.
        address direct = address(0xD1237);
        strategy.setPower(direct, 5e17);
        vm.prank(direct);
        moduleClassic.voteWithData(points, "");
        assertEq(moduleClassic.totalCycleVotingPower(1), 1e18 + 5e17, "both votes counted");
    }

    // ============ Recast exactness (regression: rounding must never underflow) ============

    function test_RecastExactness_AwkwardPowerValues() public {
        (uint256[] memory points, address[] memory recipients) = _defaultBallot();
        // Prime-ish points that don't divide the power evenly → rounding dust on every cast.
        points[0] = 3333;
        points[1] = 6667;

        // A second voter shares the pool so any subtraction error would corrupt their share.
        uint256 otherPk = 0xCAFE;
        address other = vm.addr(otherPk);
        strategy.setPower(other, 999_999_999_999_999_999);
        bytes memory otherSig = _signCrossChain(moduleA, otherPk, points, recipients, NONCE, DEADLINE);
        moduleA.castCrossChainVote(other, points, recipients, NONCE, DEADLINE, otherSig);

        strategy.setPower(voter, 1_000_000_000_000_000_001);
        bytes memory sig1 = _signCrossChain(moduleA, VOTER_PK, points, recipients, 1, DEADLINE);
        moduleA.castCrossChainVote(voter, points, recipients, 1, DEADLINE, sig1);

        // Recast twice with different awkward powers — must never revert.
        strategy.setPower(voter, 7);
        bytes memory sig2 = _signCrossChain(moduleA, VOTER_PK, points, recipients, 2, DEADLINE);
        moduleA.castCrossChainVote(voter, points, recipients, 2, DEADLINE, sig2);

        strategy.setPower(voter, 123_456_789);
        bytes memory sig3 = _signCrossChain(moduleA, VOTER_PK, points, recipients, 3, DEADLINE);
        moduleA.castCrossChainVote(voter, points, recipients, 3, DEADLINE, sig3);

        // Distributions must equal EXACTLY the sum of both voters' stored allocations.
        uint256[] memory dist = moduleA.getProjectDistributions(1);
        for (uint256 i = 0; i < dist.length; i++) {
            assertEq(
                dist[i],
                moduleA.voterCycleAllocations(1, voter, i) + moduleA.voterCycleAllocations(1, other, i),
                "distributions == sum of exact applied allocations"
            );
        }
        assertEq(moduleA.totalCycleVotingPower(1), 123_456_789 + 999_999_999_999_999_999, "power replaced exactly");
    }

    function test_RecastExactness_ClassicPath() public {
        uint256[] memory points = new uint256[](2);
        points[0] = 3333;
        points[1] = 6667;

        strategy.setPower(voter, 1_000_000_000_000_000_001);
        bytes32 structHash =
            keccak256(abi.encode(moduleClassic.VOTE_TYPEHASH(), voter, keccak256(abi.encodePacked(points)), 1));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", moduleClassic.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(VOTER_PK, digest);
        moduleClassic.castVoteWithSignature(voter, points, 1, abi.encodePacked(r, s, v));

        strategy.setPower(voter, 7);
        structHash = keccak256(abi.encode(moduleClassic.VOTE_TYPEHASH(), voter, keccak256(abi.encodePacked(points)), 2));
        digest = keccak256(abi.encodePacked("\x19\x01", moduleClassic.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(VOTER_PK, digest);
        moduleClassic.castVoteWithSignature(voter, points, 2, abi.encodePacked(r, s, v));

        uint256[] memory dist = moduleClassic.getProjectDistributions(1);
        assertEq(dist[0], moduleClassic.voterCycleAllocations(1, voter, 0), "exact allocation A");
        assertEq(dist[1], moduleClassic.voterCycleAllocations(1, voter, 1), "exact allocation B");
        assertEq(moduleClassic.totalCycleVotingPower(1), 7, "power replaced exactly");
    }
}
