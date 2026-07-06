import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, pad, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  crossChainVoteDigest,
  crossChainVoteTypedData,
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
  VECTOR_CANDIDATES.find((p) => existsSync(p)) ?? VECTOR_CANDIDATES[1];

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
    const vector = JSON.parse(readFileSync(VECTOR_PATH, "utf8")) as {
      digest: Hex;
    };
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
