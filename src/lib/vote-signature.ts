import type { Address, Hex } from "viem";

/**
 * The cross-chain vote's EIP-712 shape — pinned to the contracts' scheme
 * (AbstractVotingModule.crossChainDomainSeparator + CROSS_CHAIN_VOTE_TYPEHASH).
 * The domain is deliberately chainless: no chainId, no verifyingContract —
 * scoping comes from the familyId salt, which is what lets ONE signature land
 * on every sibling chain.
 */

/** Domain per family: EIP712Domain(string name,string version,bytes32 salt). */
export function crossChainVoteDomain(familyId: Hex) {
  return { name: "CrowdstakingVoting", version: "2", salt: familyId } as const;
}

export const CROSS_CHAIN_VOTE_TYPES = {
  CrossChainVote: [
    { name: "voter", type: "address" },
    { name: "points", type: "uint256[]" },
    { name: "recipients", type: "address[]" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** A signed vote stays deliverable for 72 hours. */
export const DEFAULT_DEADLINE_MS = 72 * 60 * 60 * 1000;

/**
 * Next vote nonce: wall-clock ms, bumped past every chain's last-seen nonce so
 * the new signature supersedes the old vote on ALL siblings (nonces are
 * monotonic per chain — a lower nonce is dead on arrival).
 */
export function chooseNonce(lastNonces: bigint[]): bigint {
  const maxSeen = lastNonces.reduce((a, b) => (b > a ? b : a), 0n);
  const now = BigInt(Date.now());
  return now > maxSeen ? now : maxSeen + 1n;
}

/** Deadline in seconds (checked against block.timestamp on-chain). */
export function voteDeadline(nowMs: number = Date.now()): bigint {
  return BigInt(Math.floor((nowMs + DEFAULT_DEADLINE_MS) / 1000));
}

/**
 * The relay POST body (numbers as decimal strings — JSON has no bigint). Also
 * the "Copy signed vote" escape hatch: anyone holding this JSON can deliver
 * the vote via castCrossChainVote.
 */
export interface SignedVotePayload {
  familyId: Hex;
  voter: Address;
  points: string[];
  recipients: Address[];
  nonce: string;
  deadline: string;
  signature: Hex;
}

export function buildVotePayload(
  familyId: Hex,
  voter: Address,
  points: readonly bigint[],
  recipients: readonly Address[],
  nonce: bigint,
  deadline: bigint,
  signature: Hex,
): SignedVotePayload {
  return {
    familyId,
    voter,
    points: points.map((p) => p.toString()),
    recipients: [...recipients],
    nonce: nonce.toString(),
    deadline: deadline.toString(),
    signature,
  };
}
