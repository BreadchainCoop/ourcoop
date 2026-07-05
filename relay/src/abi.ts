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

export const familyDeployedEvent = deployerAbi[1];
export const crossChainVoteCastEvent = votingModuleAbi[5];
