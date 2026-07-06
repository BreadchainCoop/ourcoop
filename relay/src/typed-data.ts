import {
  hashTypedData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";

/**
 * EIP-712 shape pinned to the contracts (multichain-design.md A.3):
 * domain = { name: "CrowdstakingVoting", version: "2", salt: familyId }
 * (bytes32 salt, deliberately NO chainId / verifyingContract — the same
 * signature is valid on every family instance).
 */
export const CROSS_CHAIN_VOTE_TYPES = {
  CrossChainVote: [
    { name: "voter", type: "address" },
    { name: "points", type: "uint256[]" },
    { name: "recipients", type: "address[]" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface CrossChainVoteMessage {
  voter: Address;
  points: readonly bigint[];
  recipients: readonly Address[];
  nonce: bigint;
  deadline: bigint;
}

export function crossChainVoteTypedData(
  familyId: Hex,
  message: CrossChainVoteMessage,
) {
  return {
    domain: {
      name: "CrowdstakingVoting",
      version: "2",
      salt: familyId,
    },
    types: CROSS_CHAIN_VOTE_TYPES,
    primaryType: "CrossChainVote",
    message: {
      voter: message.voter,
      points: [...message.points],
      recipients: [...message.recipients],
      nonce: message.nonce,
      deadline: message.deadline,
    },
  } as const;
}

/** The digest the contract's ECDSA.recover sees. */
export function crossChainVoteDigest(
  familyId: Hex,
  message: CrossChainVoteMessage,
): Hex {
  return hashTypedData(crossChainVoteTypedData(familyId, message));
}

/** Local (pure-ECDSA) signature pre-check; the chain is the authority. */
export async function verifyCrossChainVote(
  familyId: Hex,
  message: CrossChainVoteMessage,
  signature: Hex,
): Promise<boolean> {
  try {
    const recovered = await recoverTypedDataAddress({
      ...crossChainVoteTypedData(familyId, message),
      signature,
    });
    return recovered.toLowerCase() === message.voter.toLowerCase();
  } catch {
    return false;
  }
}
