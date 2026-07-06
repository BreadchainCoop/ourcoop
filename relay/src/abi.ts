// Hand-written minimal ABIs, pinned to the multichain design spec (section A).
// Do NOT regenerate from artifacts — the relay must compile without the
// contracts build present.

/** CrowdStakeDeployer v2 surface: familyInstances getter + FamilyDeployed. */
export const deployerAbi = [
  {
    type: "function",
    name: "familyInstances",
    stateMutability: "view",
    inputs: [{ name: "familyId", type: "bytes32" }],
    outputs: [
      { name: "cycleModule", type: "address" },
      { name: "registry", type: "address" },
      { name: "token", type: "address" },
      { name: "votingPowerStrategy", type: "address" },
      { name: "distributionManager", type: "address" },
      { name: "distributionStrategy", type: "address" },
      { name: "secondaryDistributionStrategy", type: "address" },
      { name: "votingModule", type: "address" },
    ],
  },
  {
    type: "event",
    name: "FamilyDeployed",
    inputs: [
      { name: "familyId", type: "bytes32", indexed: true },
      { name: "creator", type: "address", indexed: true },
      { name: "owner", type: "address", indexed: true },
    ],
  },
] as const;

/** BasisPointsVotingModule cross-chain surface. */
export const votingModuleAbi = [
  {
    type: "function",
    name: "castCrossChainVote",
    stateMutability: "nonpayable",
    inputs: [
      { name: "voter", type: "address" },
      { name: "points", type: "uint256[]" },
      { name: "recipients", type: "address[]" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "lastCrossChainNonce",
    stateMutability: "view",
    inputs: [{ name: "voter", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "getVotingPower",
    stateMutability: "view",
    inputs: [{ name: "voter", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "recipientsHash",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "familyId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "event",
    name: "CrossChainVoteCast",
    inputs: [
      { name: "voter", type: "address", indexed: true },
      { name: "points", type: "uint256[]", indexed: false },
      { name: "recipients", type: "address[]", indexed: false },
      { name: "votingPower", type: "uint256", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
      { name: "deadline", type: "uint256", indexed: false },
      { name: "signature", type: "bytes", indexed: false },
    ],
  },
  { type: "error", name: "CrossChainNotEnabled", inputs: [] },
  { type: "error", name: "SignatureExpired", inputs: [] },
  { type: "error", name: "StaleNonce", inputs: [] },
  { type: "error", name: "RecipientSetMismatch", inputs: [] },
  { type: "error", name: "ZeroVotingPower", inputs: [] },
  { type: "error", name: "InvalidSignature", inputs: [] },
] as const;

/**
 * Recipient registry cross-chain surface. AdminRecipientRegistry and
 * VotingRecipientRegistry share the familyId getter + a per-kind entrypoint /
 * settlement read / re-emitted event. Combined into one ABI (viem tolerates
 * unused fragments) so the relay can talk to either registry kind by address.
 */
export const registryAbi = [
  // ── shared ──
  {
    type: "function",
    name: "familyId",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "getRecipients",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address[]" }],
  },
  // ── admin (desired-set registry update) ──
  {
    type: "function",
    name: "lastRegistryUpdateNonce",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "applyCrossChainRegistryUpdate",
    stateMutability: "nonpayable",
    inputs: [
      { name: "admin", type: "address" },
      { name: "recipients", type: "address[]" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "CrossChainRegistryUpdated",
    inputs: [
      { name: "admin", type: "address", indexed: true },
      { name: "recipients", type: "address[]", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
      { name: "deadline", type: "uint256", indexed: false },
      { name: "signature", type: "bytes", indexed: false },
    ],
  },
  // ── democratic (proposal creation) ──
  {
    type: "function",
    name: "createCrossChainProposal",
    stateMutability: "nonpayable",
    inputs: [
      { name: "proposer", type: "address" },
      { name: "candidate", type: "address" },
      { name: "isAddition", type: "bool" },
      { name: "electorate", type: "address[]" },
      { name: "expiresAt", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "proposalKey", type: "bytes32" }],
  },
  {
    type: "function",
    name: "getCrossChainProposal",
    stateMutability: "view",
    inputs: [{ name: "proposalKey", type: "bytes32" }],
    outputs: [
      { name: "candidate", type: "address" },
      { name: "isAddition", type: "bool" },
      { name: "executed", type: "bool" },
      { name: "expiresAt", type: "uint256" },
      { name: "voteCount", type: "uint256" },
      { name: "requiredVotes", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "CrossChainProposalCreated",
    inputs: [
      { name: "proposalKey", type: "bytes32", indexed: true },
      { name: "proposer", type: "address", indexed: false },
      { name: "candidate", type: "address", indexed: false },
      { name: "isAddition", type: "bool", indexed: false },
      { name: "electorate", type: "address[]", indexed: false },
      { name: "expiresAt", type: "uint256", indexed: false },
      { name: "nonce", type: "uint256", indexed: false },
      { name: "signature", type: "bytes", indexed: false },
    ],
  },
  // ── democratic (proposal vote) ──
  {
    type: "function",
    name: "castCrossChainProposalVote",
    stateMutability: "nonpayable",
    inputs: [
      { name: "voter", type: "address" },
      { name: "proposalKey", type: "bytes32" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "hasVotedCrossChain",
    stateMutability: "view",
    inputs: [
      { name: "proposalKey", type: "bytes32" },
      { name: "voter", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "CrossChainProposalVoteCast",
    inputs: [
      { name: "proposalKey", type: "bytes32", indexed: true },
      { name: "voter", type: "address", indexed: false },
      { name: "deadline", type: "uint256", indexed: false },
      { name: "signature", type: "bytes", indexed: false },
    ],
  },
  // ── errors (shared CrossChainRegistryBase + VotingRecipientRegistry) ──
  { type: "error", name: "CrossChainNotEnabled", inputs: [] },
  { type: "error", name: "CrossChainOnly", inputs: [] },
  { type: "error", name: "SignatureExpired", inputs: [] },
  { type: "error", name: "StaleNonce", inputs: [] },
  { type: "error", name: "InvalidSignature", inputs: [] },
  { type: "error", name: "RecipientSetMismatch", inputs: [] },
  { type: "error", name: "NotAscending", inputs: [] },
  { type: "error", name: "MaxQueueSizeReached", inputs: [] },
  { type: "error", name: "InvalidRecipient", inputs: [] },
  { type: "error", name: "ProposalAlreadyExists", inputs: [] },
  { type: "error", name: "ProposalNotFound", inputs: [] },
  { type: "error", name: "ProposalAlreadyExecuted", inputs: [] },
  { type: "error", name: "ProposalExpired", inputs: [] },
  { type: "error", name: "ExpiryTooFar", inputs: [] },
  { type: "error", name: "AlreadyVoted", inputs: [] },
  { type: "error", name: "NotEligibleVoter", inputs: [] },
  { type: "error", name: "NotEnoughVotes", inputs: [] },
  { type: "error", name: "RecipientAlreadyExists", inputs: [] },
  { type: "error", name: "RecipientNotFound", inputs: [] },
] as const;

export const familyDeployedEvent = deployerAbi[1];
export const crossChainVoteCastEvent = votingModuleAbi[5];
export const crossChainRegistryUpdatedEvent = registryAbi.find(
  (f) => f.type === "event" && f.name === "CrossChainRegistryUpdated",
) as Extract<
  (typeof registryAbi)[number],
  { type: "event"; name: "CrossChainRegistryUpdated" }
>;
export const crossChainProposalCreatedEvent = registryAbi.find(
  (f) => f.type === "event" && f.name === "CrossChainProposalCreated",
) as Extract<
  (typeof registryAbi)[number],
  { type: "event"; name: "CrossChainProposalCreated" }
>;
export const crossChainProposalVoteCastEvent = registryAbi.find(
  (f) => f.type === "event" && f.name === "CrossChainProposalVoteCast",
) as Extract<
  (typeof registryAbi)[number],
  { type: "event"; name: "CrossChainProposalVoteCast" }
>;
