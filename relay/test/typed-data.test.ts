import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, pad, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  computeProposalKey,
  crossChainProposalDigest,
  crossChainProposalTypedData,
  crossChainProposalVoteDigest,
  crossChainProposalVoteTypedData,
  crossChainRegistryUpdateDigest,
  crossChainRegistryUpdateTypedData,
  crossChainVoteDigest,
  crossChainVoteTypedData,
  verifyCrossChainProposal,
  verifyCrossChainProposalVote,
  verifyCrossChainRegistryUpdate,
  verifyCrossChainVote,
} from "../src/typed-data.js";

// The pinned vector from the forge test (contracts/test/CrossChainVoting.t.sol
// per spec A.6). The committed fixture next to this file is the canonical copy;
// a freshly regenerated .context/crosschain-vector.json (written by the
// contracts build) takes precedence so digest changes surface immediately.
const HERE = dirname(fileURLToPath(import.meta.url));
const VECTOR_CANDIDATES = [
  join(HERE, "..", "..", ".context", "crosschain-vector.json"),
  join(HERE, "crosschain-vector.json"),
];
const VECTOR_PATH =
  VECTOR_CANDIDATES.find((p) => existsSync(p)) ?? VECTOR_CANDIDATES[1]!;

interface Vector {
  familyId: Hex;
  domainSeparator: Hex;
  digest: Hex;
  voter: Address;
  signature: Hex;
  registryUpdate: {
    admin: Address;
    recipients: Address[];
    nonce: string;
    deadline: string;
    digest: Hex;
    signature: Hex;
  };
  proposal: {
    proposer: Address;
    candidate: Address;
    isAddition: boolean;
    electorate: Address[];
    expiresAt: string;
    nonce: string;
    proposalKey: Hex;
    digest: Hex;
    signature: Hex;
  };
  proposalVote: {
    voter: Address;
    proposalKey: Hex;
    deadline: string;
    digest: Hex;
    signature: Hex;
  };
}

function loadVector(): Vector {
  return JSON.parse(readFileSync(VECTOR_PATH, "utf8")) as Vector;
}

const familyId = keccak256(stringToHex("test.family"));
const privateKey = pad("0xBEEF", { size: 32 });
const account = privateKeyToAccount(privateKey);
const message = {
  voter: account.address,
  points: [6000n, 4000n],
  recipients: [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
  ] as Address[],
  nonce: 1n,
  deadline: 4102444800n,
};

describe("cross-chain vote typed data (pinned vector)", () => {
  it("computes the digest for the pinned vector and matches the forge vector when present", () => {
    const digest = crossChainVoteDigest(familyId, message);
    // Always print — the contracts side pins against this exact value.
    console.log(`\n  pinned-vector familyId: ${familyId}`);
    console.log(`  pinned-vector voter:    ${account.address}`);
    console.log(`  pinned-vector digest:   ${digest}\n`);

    expect(digest).toMatch(/^0x[0-9a-f]{64}$/);

    if (!existsSync(VECTOR_PATH)) {
      console.warn(
        `\n  ⚠⚠⚠ PARITY ASSERTION SKIPPED: ${VECTOR_PATH} not found.\n` +
          `  The contracts build has not written the cross-chain test vector yet.\n` +
          `  Digest parity with the Solidity implementation is UNVERIFIED.\n`,
      );
      return;
    }
    const vector = loadVector();
    expect(digest.toLowerCase()).toBe(vector.digest.toLowerCase());
  });

  it("builds the exact pinned domain (name/version/salt, no chainId/verifyingContract)", () => {
    const typed = crossChainVoteTypedData(familyId, message);
    expect(typed.domain).toEqual({
      name: "CrowdstakingVoting",
      version: "2",
      salt: familyId,
    });
    expect(Object.keys(typed.domain)).not.toContain("chainId");
    expect(Object.keys(typed.domain)).not.toContain("verifyingContract");
    expect(
      typed.types.CrossChainVote.map((f) => `${f.name}:${f.type}`),
    ).toEqual([
      "voter:address",
      "points:uint256[]",
      "recipients:address[]",
      "nonce:uint256",
      "deadline:uint256",
    ]);
  });

  it("round-trips sign -> verify locally", async () => {
    const signature = await account.signTypedData(
      crossChainVoteTypedData(familyId, message),
    );
    expect(await verifyCrossChainVote(familyId, message, signature)).toBe(true);
    // Tampered points must not verify.
    expect(
      await verifyCrossChainVote(
        familyId,
        { ...message, points: [4000n, 6000n] },
        signature,
      ),
    ).toBe(false);
    // Another family (different salt) must not verify.
    expect(
      await verifyCrossChainVote(
        keccak256(stringToHex("other.family")),
        message,
        signature,
      ),
    ).toBe(false);
  });
});

// The three registry-governance kinds pin against the SAME tracked vector
// (regenerated with registryUpdate / proposal / proposalVote sections). These
// are HARD asserts — the vector's familyId is the domain salt for all three.
describe("cross-chain registry governance typed data (pinned vector, HARD)", () => {
  const vector = loadVector();
  const fid = vector.familyId;

  it("registry-update: digest + struct types match the forge vector", () => {
    const ru = vector.registryUpdate;
    const msg = {
      admin: ru.admin,
      recipients: ru.recipients,
      nonce: BigInt(ru.nonce),
      deadline: BigInt(ru.deadline),
    };
    const digest = crossChainRegistryUpdateDigest(fid, msg);
    expect(digest.toLowerCase()).toBe(ru.digest.toLowerCase());

    const typed = crossChainRegistryUpdateTypedData(fid, msg);
    expect(typed.domain).toEqual({
      name: "CrowdstakingVoting",
      version: "2",
      salt: fid,
    });
    expect(
      typed.types.CrossChainRegistryUpdate.map((f) => `${f.name}:${f.type}`),
    ).toEqual([
      "admin:address",
      "recipients:address[]",
      "nonce:uint256",
      "deadline:uint256",
    ]);
  });

  it("registry-update: the vector's signature verifies to the admin", async () => {
    const ru = vector.registryUpdate;
    expect(
      await verifyCrossChainRegistryUpdate(
        fid,
        {
          admin: ru.admin,
          recipients: ru.recipients,
          nonce: BigInt(ru.nonce),
          deadline: BigInt(ru.deadline),
        },
        ru.signature,
      ),
    ).toBe(true);
  });

  it("proposal: proposalKey (struct hash) + digest match the forge vector", () => {
    const p = vector.proposal;
    const msg = {
      proposer: p.proposer,
      candidate: p.candidate,
      isAddition: p.isAddition,
      electorate: p.electorate,
      expiresAt: BigInt(p.expiresAt),
      nonce: BigInt(p.nonce),
    };
    // proposalKey IS the EIP-712 struct hash — the firewall + content address.
    expect(computeProposalKey(msg).toLowerCase()).toBe(
      p.proposalKey.toLowerCase(),
    );
    expect(crossChainProposalDigest(fid, msg).toLowerCase()).toBe(
      p.digest.toLowerCase(),
    );

    const typed = crossChainProposalTypedData(fid, msg);
    expect(
      typed.types.CrossChainProposal.map((f) => `${f.name}:${f.type}`),
    ).toEqual([
      "proposer:address",
      "candidate:address",
      "isAddition:bool",
      "electorate:address[]",
      "expiresAt:uint256",
      "nonce:uint256",
    ]);
  });

  it("proposal: the vector's signature verifies to the proposer", async () => {
    const p = vector.proposal;
    expect(
      await verifyCrossChainProposal(
        fid,
        {
          proposer: p.proposer,
          candidate: p.candidate,
          isAddition: p.isAddition,
          electorate: p.electorate,
          expiresAt: BigInt(p.expiresAt),
          nonce: BigInt(p.nonce),
        },
        p.signature,
      ),
    ).toBe(true);
  });

  it("proposal-vote: digest + struct types match the forge vector", () => {
    const pv = vector.proposalVote;
    const msg = {
      voter: pv.voter,
      proposalKey: pv.proposalKey,
      deadline: BigInt(pv.deadline),
    };
    expect(crossChainProposalVoteDigest(fid, msg).toLowerCase()).toBe(
      pv.digest.toLowerCase(),
    );
    const typed = crossChainProposalVoteTypedData(fid, msg);
    expect(
      typed.types.CrossChainProposalVote.map((f) => `${f.name}:${f.type}`),
    ).toEqual(["voter:address", "proposalKey:bytes32", "deadline:uint256"]);
  });

  it("proposal-vote: the vector's signature verifies to the voter", async () => {
    const pv = vector.proposalVote;
    expect(
      await verifyCrossChainProposalVote(
        fid,
        {
          voter: pv.voter,
          proposalKey: pv.proposalKey,
          deadline: BigInt(pv.deadline),
        },
        pv.signature,
      ),
    ).toBe(true);
  });

  it("proposal-vote's proposalKey equals the proposal's proposalKey (same content)", () => {
    expect(vector.proposalVote.proposalKey.toLowerCase()).toBe(
      vector.proposal.proposalKey.toLowerCase(),
    );
  });
});
