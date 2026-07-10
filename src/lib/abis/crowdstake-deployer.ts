import { parseAbi } from "viem";

/**
 * CrowdStakeDeployer — the one canonical one-tx deployer. Params carries the
 * recipient-registry kind (admin vs democratic), the democratic config, the
 * yield distribution kind (0 = proportional, 1 = equal, 2 = split half/half),
 * two instance artwork URIs seeded onto the distribution manager at deploy,
 * the `crossChain` flag: when true the deployer derives a creator-scoped
 * familyId (familyIdOf) so sibling instances on other chains can share one
 * signed ballot; familyInstances(familyId) resolves a chain's sibling in one
 * eth_call — and a ModuleOverrides struct of optional pre-deployed custom
 * modules (address(0)/empty = deploy the canonical module; see the wizard's
 * "Custom modules" section; incompatible with crossChain). The Instance
 * tuple's `registry` is remapped to `recipientRegistry` in use-deploy;
 * `secondaryDistributionStrategy` is the equal strategy in split mode (zero
 * address otherwise).
 */
export const deployerAbi = parseAbi([
  "function deploy((address owner, uint256 cycleLength, string tokenName, string tokenSymbol, uint256 maxVotingPoints, bytes32 salt, uint8 registryKind, address[] initialRecipients, uint256 proposalExpiry, uint8 distributionKind, string tokenImageURI, string bannerImageURI, bool crossChain, (address recipientRegistry, address token, address cycleModule, address votingModule, address distributionStrategy, address[] votingPowerStrategies) overrides) p) returns ((address cycleModule, address registry, address token, address votingPowerStrategy, address distributionManager, address distributionStrategy, address secondaryDistributionStrategy, address votingModule))",
  "function familyIdOf(address creator, bytes32 salt, string tokenName, string tokenSymbol, uint256 maxVotingPoints, uint8 registryKind, uint8 distributionKind) pure returns (bytes32)",
  "function votingFamilyIdOf(address creator, bytes32 salt, string tokenName, string tokenSymbol, uint256 maxVotingPoints, uint8 distributionKind, address[] initialRecipients, uint256 proposalExpiry) pure returns (bytes32)",
  "function familyInstances(bytes32 familyId) view returns ((address cycleModule, address registry, address token, address votingPowerStrategy, address distributionManager, address distributionStrategy, address secondaryDistributionStrategy, address votingModule))",
  "event SystemDeployed(address indexed owner, address indexed deployer, bytes32 indexed salt, (address cycleModule, address registry, address token, address votingPowerStrategy, address distributionManager, address distributionStrategy, address secondaryDistributionStrategy, address votingModule) instance)",
  "event FamilyDeployed(bytes32 indexed familyId, address indexed creator, address indexed owner)",
  "error ZeroOwner()",
  "error ZeroCycleLength()",
  "error InvalidRegistryKind()",
  "error InvalidDistributionKind()",
  "error EmptyInitialRecipients()",
  "error ZeroProposalExpiry()",
  "error FamilyAlreadyDeployed()",
  "error OverrideHasNoCode(address module)",
  "error StrategyOverrideRequiresProportional()",
  "error OverridesIncompatibleWithCrossChain()",
]);
