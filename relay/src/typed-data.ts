import {
  encodeAbiParameters,
  encodePacked,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";

/**
 * EIP-712 shape pinned to the contracts (multichain-design.md A.3):
 * domain = { name: "CrowdstakingVoting", version: "2", salt: familyId }
 * (bytes32 salt, deliberately NO chainId / verifyingContract — the same
 * signature is valid on every family instance).
 *
 * The three registry-governance kinds (registry-update, proposal, proposal-vote)
 * share the SAME domain; distinct EIP-712 primary types are the firewall between
 * action kinds. Struct strings here must match the contracts byte-for-byte —
 * pinned by the tracked crosschain-vector.json parity assertion.
 */

/** The chain-agnostic family EIP-712 domain (identical on every sibling chain). */
export function familyDomain(familyId: Hex) {
  return { name: "CrowdstakingVoting", version: "2", salt: familyId } as const;
}

// ── vote ─────────────────────────────────────────────────────────────────────

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
    domain: familyDomain(familyId),
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

// ── registry-update ──────────────────────────────────────────────────────────

export const CROSS_CHAIN_REGISTRY_UPDATE_TYPES = {
  CrossChainRegistryUpdate: [
    { name: "admin", type: "address" },
    { name: "recipients", type: "address[]" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface CrossChainRegistryUpdateMessage {
  admin: Address;
  recipients: readonly Address[];
  nonce: bigint;
  deadline: bigint;
}

export function crossChainRegistryUpdateTypedData(
  familyId: Hex,
  message: CrossChainRegistryUpdateMessage,
) {
  return {
    domain: familyDomain(familyId),
    types: CROSS_CHAIN_REGISTRY_UPDATE_TYPES,
    primaryType: "CrossChainRegistryUpdate",
    message: {
      admin: message.admin,
      recipients: [...message.recipients],
      nonce: message.nonce,
      deadline: message.deadline,
    },
  } as const;
}

export function crossChainRegistryUpdateDigest(
  familyId: Hex,
  message: CrossChainRegistryUpdateMessage,
): Hex {
  return hashTypedData(crossChainRegistryUpdateTypedData(familyId, message));
}

export async function verifyCrossChainRegistryUpdate(
  familyId: Hex,
  message: CrossChainRegistryUpdateMessage,
  signature: Hex,
): Promise<boolean> {
  try {
    const recovered = await recoverTypedDataAddress({
      ...crossChainRegistryUpdateTypedData(familyId, message),
      signature,
    });
    return recovered.toLowerCase() === message.admin.toLowerCase();
  } catch {
    return false;
  }
}

// ── proposal ─────────────────────────────────────────────────────────────────

export const CROSS_CHAIN_PROPOSAL_TYPES = {
  CrossChainProposal: [
    { name: "proposer", type: "address" },
    { name: "candidate", type: "address" },
    { name: "isAddition", type: "bool" },
    { name: "electorate", type: "address[]" },
    { name: "expiresAt", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** The typehash matching the contract's CROSS_CHAIN_PROPOSAL_TYPEHASH. */
export const CROSS_CHAIN_PROPOSAL_TYPEHASH = keccak256(
  encodePacked(
    ["string"],
    [
      "CrossChainProposal(address proposer,address candidate,bool isAddition,address[] electorate,uint256 expiresAt,uint256 nonce)",
    ],
  ),
);

export interface CrossChainProposalMessage {
  proposer: Address;
  candidate: Address;
  isAddition: boolean;
  electorate: readonly Address[];
  expiresAt: bigint;
  nonce: bigint;
}

export function crossChainProposalTypedData(
  familyId: Hex,
  message: CrossChainProposalMessage,
) {
  return {
    domain: familyDomain(familyId),
    types: CROSS_CHAIN_PROPOSAL_TYPES,
    primaryType: "CrossChainProposal",
    message: {
      proposer: message.proposer,
      candidate: message.candidate,
      isAddition: message.isAddition,
      electorate: [...message.electorate],
      expiresAt: message.expiresAt,
      nonce: message.nonce,
    },
  } as const;
}

/**
 * proposalKey = the EIP-712 struct hash itself (content-addressed, chain-agnostic).
 * Hand-rolled to mirror the contract's keccak256(abi.encode(typehash, proposer,
 * candidate, isAddition, keccak256(abi.encodePacked(electorate)), expiresAt,
 * nonce)) EXACTLY — pinned by the parity vector.
 */
export function computeProposalKey(message: CrossChainProposalMessage): Hex {
  const electorateHash = keccak256(
    encodePacked(["address[]"], [[...message.electorate]]),
  );
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "bool" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        CROSS_CHAIN_PROPOSAL_TYPEHASH,
        message.proposer,
        message.candidate,
        message.isAddition,
        electorateHash,
        message.expiresAt,
        message.nonce,
      ],
    ),
  );
}

/**
 * The proposal's EIP-712 digest. Because proposalKey IS the struct hash, the
 * digest is keccak256(0x1901 || domainSeparator || proposalKey) — equal to
 * hashTypedData over the struct. We compute it via hashTypedData for viem parity.
 */
export function crossChainProposalDigest(
  familyId: Hex,
  message: CrossChainProposalMessage,
): Hex {
  return hashTypedData(crossChainProposalTypedData(familyId, message));
}

export async function verifyCrossChainProposal(
  familyId: Hex,
  message: CrossChainProposalMessage,
  signature: Hex,
): Promise<boolean> {
  try {
    const recovered = await recoverTypedDataAddress({
      ...crossChainProposalTypedData(familyId, message),
      signature,
    });
    return recovered.toLowerCase() === message.proposer.toLowerCase();
  } catch {
    return false;
  }
}

// ── proposal-vote ────────────────────────────────────────────────────────────

export const CROSS_CHAIN_PROPOSAL_VOTE_TYPES = {
  CrossChainProposalVote: [
    { name: "voter", type: "address" },
    { name: "proposalKey", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export interface CrossChainProposalVoteMessage {
  voter: Address;
  proposalKey: Hex;
  deadline: bigint;
}

export function crossChainProposalVoteTypedData(
  familyId: Hex,
  message: CrossChainProposalVoteMessage,
) {
  return {
    domain: familyDomain(familyId),
    types: CROSS_CHAIN_PROPOSAL_VOTE_TYPES,
    primaryType: "CrossChainProposalVote",
    message: {
      voter: message.voter,
      proposalKey: message.proposalKey,
      deadline: message.deadline,
    },
  } as const;
}

export function crossChainProposalVoteDigest(
  familyId: Hex,
  message: CrossChainProposalVoteMessage,
): Hex {
  return hashTypedData(crossChainProposalVoteTypedData(familyId, message));
}

export async function verifyCrossChainProposalVote(
  familyId: Hex,
  message: CrossChainProposalVoteMessage,
  signature: Hex,
): Promise<boolean> {
  try {
    const recovered = await recoverTypedDataAddress({
      ...crossChainProposalVoteTypedData(familyId, message),
      signature,
    });
    return recovered.toLowerCase() === message.voter.toLowerCase();
  } catch {
    return false;
  }
}
