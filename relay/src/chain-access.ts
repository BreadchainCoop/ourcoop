import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  HttpRequestError,
  TimeoutError,
  createPublicClient,
  createWalletClient,
  http,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Account,
  type Transport,
} from "viem";
import { arbitrum, gnosis, mainnet, optimism } from "viem/chains";
import { deployerAbi, registryAbi, votingModuleAbi } from "./abi.js";
import type { ActionKind, FamilyInstance } from "./store.js";

/** A contract revert decoded to its custom-error name. */
export class RevertError extends Error {
  constructor(
    readonly errorName: string,
    message?: string,
  ) {
    super(message ?? `reverted: ${errorName}`);
    this.name = "RevertError";
  }
}

export interface CastVoteArgs {
  voter: Address;
  points: bigint[];
  recipients: Address[];
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
}

export interface RegistryUpdateArgs {
  admin: Address;
  recipients: Address[];
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
}

export interface ProposalArgs {
  proposer: Address;
  candidate: Address;
  isAddition: boolean;
  electorate: Address[];
  expiresAt: bigint;
  nonce: bigint;
  signature: Hex;
}

export interface ProposalVoteArgs {
  voter: Address;
  proposalKey: Hex;
  deadline: bigint;
  signature: Hex;
}

/** Kind-tagged delivery arguments — the worker's single dispatch surface. */
export type DeliveryArgs =
  | { kind: "vote"; args: CastVoteArgs }
  | { kind: "registry-update"; args: RegistryUpdateArgs }
  | { kind: "proposal"; args: ProposalArgs }
  | { kind: "proposal-vote"; args: ProposalVoteArgs };

/** On-chain cross-chain proposal view (undefined when the key doesn't exist). */
export interface CrossChainProposalView {
  candidate: Address;
  isAddition: boolean;
  executed: boolean;
  expiresAt: bigint;
  voteCount: bigint;
  requiredVotes: bigint;
}

export interface FeeEstimate {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface Receipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

/**
 * The narrow chain surface the relay uses. Production wraps viem clients;
 * tests inject fakes. Delivery is kind-dispatched: `simulate`/`send` take a
 * DeliveryArgs and route to the right entrypoint on the right target contract
 * (votingModule for votes, registry for the three registry-governance kinds).
 */
export interface ChainAccess {
  getBlockNumber(): Promise<bigint>;
  getBalance(address: Address): Promise<bigint>;
  getPendingTransactionCount(address: Address): Promise<number>;
  /** null when the family has no instance here ('none') — incl. v1 deployers
   *  where familyInstances doesn't exist yet; network errors throw. */
  familyInstances(
    deployer: Address,
    familyId: Hex,
  ): Promise<FamilyInstance | null>;
  /** familyId() on a voting module OR a registry — both share the getter. */
  readFamilyId(target: Address): Promise<Hex>;
  // ── vote reads ──
  lastCrossChainNonce(votingModule: Address, voter: Address): Promise<bigint>;
  getVotingPower(votingModule: Address, voter: Address): Promise<bigint>;
  // ── registry reads ──
  lastRegistryUpdateNonce(registry: Address): Promise<bigint>;
  getRecipients(registry: Address): Promise<Address[]>;
  /** undefined when the proposalKey does not exist on this chain. */
  getCrossChainProposal(
    registry: Address,
    proposalKey: Hex,
  ): Promise<CrossChainProposalView | undefined>;
  hasVotedCrossChain(
    registry: Address,
    proposalKey: Hex,
    voter: Address,
  ): Promise<boolean>;
  // ── kind-dispatched delivery ──
  /** Simulates + estimates gas; throws RevertError on decoded revert. */
  simulate(target: Address, delivery: DeliveryArgs): Promise<bigint>;
  send(
    target: Address,
    delivery: DeliveryArgs,
    opts: { nonce: number; gas: bigint } & FeeEstimate,
  ): Promise<Hex>;
  getReceipt(txHash: Hex): Promise<Receipt | null>;
  estimateFees(): Promise<FeeEstimate>;
}

const VIEM_CHAINS: Record<number, Chain> = {
  [gnosis.id]: gnosis,
  [arbitrum.id]: arbitrum,
  [optimism.id]: optimism,
  [mainnet.id]: mainnet,
};

export function viemChain(
  chainId: number,
  name: string,
  rpcUrl: string,
): Chain {
  return (
    VIEM_CHAINS[chainId] ?? {
      id: chainId,
      name,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    }
  );
}

export function createChainAccess(opts: {
  chainId: number;
  name: string;
  rpcUrl: string;
  account: Account;
}): ChainAccess {
  const chain = viemChain(opts.chainId, opts.name, opts.rpcUrl);
  const transport = http(opts.rpcUrl, { timeout: 15_000 });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({
    chain,
    transport,
    account: opts.account,
  });
  return new ViemChainAccess(publicClient, walletClient, opts.account);
}

/** The write function name + arg tuple for one kind of delivery. */
function writeCall(delivery: DeliveryArgs): {
  abi: typeof votingModuleAbi | typeof registryAbi;
  functionName: string;
  args: readonly unknown[];
} {
  switch (delivery.kind) {
    case "vote": {
      const a = delivery.args;
      return {
        abi: votingModuleAbi,
        functionName: "castCrossChainVote",
        args: [
          a.voter,
          a.points,
          a.recipients,
          a.nonce,
          a.deadline,
          a.signature,
        ],
      };
    }
    case "registry-update": {
      const a = delivery.args;
      return {
        abi: registryAbi,
        functionName: "applyCrossChainRegistryUpdate",
        args: [a.admin, a.recipients, a.nonce, a.deadline, a.signature],
      };
    }
    case "proposal": {
      const a = delivery.args;
      return {
        abi: registryAbi,
        functionName: "createCrossChainProposal",
        args: [
          a.proposer,
          a.candidate,
          a.isAddition,
          a.electorate,
          a.expiresAt,
          a.nonce,
          a.signature,
        ],
      };
    }
    case "proposal-vote": {
      const a = delivery.args;
      return {
        abi: registryAbi,
        functionName: "castCrossChainProposalVote",
        args: [a.voter, a.proposalKey, a.deadline, a.signature],
      };
    }
  }
}

class ViemChainAccess implements ChainAccess {
  constructor(
    private publicClient: PublicClient<Transport, Chain>,
    private walletClient: WalletClient<Transport, Chain, Account>,
    private account: Account,
  ) {}

  getBlockNumber(): Promise<bigint> {
    return this.publicClient.getBlockNumber({ cacheTime: 0 });
  }

  getBalance(address: Address): Promise<bigint> {
    return this.publicClient.getBalance({ address });
  }

  getPendingTransactionCount(address: Address): Promise<number> {
    return this.publicClient.getTransactionCount({
      address,
      blockTag: "pending",
    });
  }

  async familyInstances(
    deployer: Address,
    familyId: Hex,
  ): Promise<FamilyInstance | null> {
    let out: readonly [
      Address,
      Address,
      Address,
      Address,
      Address,
      Address,
      Address,
      Address,
    ];
    try {
      out = await this.publicClient.readContract({
        address: deployer,
        abi: deployerAbi,
        functionName: "familyInstances",
        args: [familyId],
      });
    } catch (e) {
      // v1 deployers have no familyInstances: the call reverts or returns
      // zero data. Both mean "no instance here" — only network-ish failures
      // propagate as 'unreachable'.
      if (isCallFailure(e)) return null;
      throw e;
    }
    const instance: FamilyInstance = {
      cycleModule: out[0],
      registry: out[1],
      token: out[2],
      votingPowerStrategy: out[3],
      distributionManager: out[4],
      distributionStrategy: out[5],
      secondaryDistributionStrategy: out[6],
      votingModule: out[7],
    };
    return instance.votingModule === zeroAddress ? null : instance;
  }

  readFamilyId(target: Address): Promise<Hex> {
    return this.publicClient.readContract({
      address: target,
      abi: votingModuleAbi,
      functionName: "familyId",
    });
  }

  lastCrossChainNonce(votingModule: Address, voter: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: votingModule,
      abi: votingModuleAbi,
      functionName: "lastCrossChainNonce",
      args: [voter],
    });
  }

  getVotingPower(votingModule: Address, voter: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: votingModule,
      abi: votingModuleAbi,
      functionName: "getVotingPower",
      args: [voter],
    });
  }

  lastRegistryUpdateNonce(registry: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "lastRegistryUpdateNonce",
    });
  }

  getRecipients(registry: Address): Promise<Address[]> {
    return this.publicClient
      .readContract({
        address: registry,
        abi: registryAbi,
        functionName: "getRecipients",
      })
      .then((r) => [...r]);
  }

  async getCrossChainProposal(
    registry: Address,
    proposalKey: Hex,
  ): Promise<CrossChainProposalView | undefined> {
    try {
      const out = await this.publicClient.readContract({
        address: registry,
        abi: registryAbi,
        functionName: "getCrossChainProposal",
        args: [proposalKey],
      });
      return {
        candidate: out[0],
        isAddition: out[1],
        executed: out[2],
        expiresAt: out[3],
        voteCount: out[4],
        requiredVotes: out[5],
      };
    } catch (e) {
      // ProposalNotFound reverts — that is a valid "does not exist yet" answer.
      const revert = toRevertError(e);
      if (revert?.errorName === "ProposalNotFound") return undefined;
      throw e;
    }
  }

  hasVotedCrossChain(
    registry: Address,
    proposalKey: Hex,
    voter: Address,
  ): Promise<boolean> {
    return this.publicClient.readContract({
      address: registry,
      abi: registryAbi,
      functionName: "hasVotedCrossChain",
      args: [proposalKey, voter],
    });
  }

  async simulate(target: Address, delivery: DeliveryArgs): Promise<bigint> {
    const call = writeCall(delivery);
    try {
      return await this.publicClient.estimateContractGas({
        account: this.account,
        address: target,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args,
      } as Parameters<PublicClient["estimateContractGas"]>[0]);
    } catch (e) {
      const revert = toRevertError(e);
      if (revert) throw revert;
      throw e;
    }
  }

  async send(
    target: Address,
    delivery: DeliveryArgs,
    opts: { nonce: number; gas: bigint } & FeeEstimate,
  ): Promise<Hex> {
    const call = writeCall(delivery);
    // The ABI + functionName are chosen at runtime, so viem's per-function
    // inference cannot apply; cast the options through unknown (the call shape
    // is correct, only the compile-time overload resolution is defeated).
    return this.walletClient.writeContract({
      address: target,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
      nonce: opts.nonce,
      gas: opts.gas,
      maxFeePerGas: opts.maxFeePerGas,
      maxPriorityFeePerGas: opts.maxPriorityFeePerGas,
    } as unknown as Parameters<WalletClient["writeContract"]>[0]);
  }

  async getReceipt(txHash: Hex): Promise<Receipt | null> {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({
        hash: txHash,
      });
      return {
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed,
        effectiveGasPrice: receipt.effectiveGasPrice,
      };
    } catch (e) {
      if (
        e instanceof BaseError &&
        e.name === "TransactionReceiptNotFoundError"
      )
        return null;
      if (
        e instanceof BaseError &&
        e.walk(
          (err) => (err as Error).name === "TransactionReceiptNotFoundError",
        )
      )
        return null;
      throw e;
    }
  }

  async estimateFees(): Promise<FeeEstimate> {
    const fees = await this.publicClient.estimateFeesPerGas();
    return {
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    };
  }
}

/**
 * The on-chain target for a delivery kind on a resolved family instance: the
 * votingModule for votes, the registry for the three registry-governance kinds.
 */
export function resolveTarget(
  kind: ActionKind,
  instance: FamilyInstance,
): Address {
  return kind === "vote" ? instance.votingModule : instance.registry;
}

/** Decode a viem contract error into a RevertError, if it is one. */
export function toRevertError(e: unknown): RevertError | null {
  if (!(e instanceof BaseError)) return null;
  const revert = e.walk((err) => err instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError) {
    const name = revert.data?.errorName ?? revert.signature ?? "UnknownRevert";
    return new RevertError(name, revert.shortMessage);
  }
  return null;
}

/** True when the error is the call failing (revert / no code / zero data),
 *  as opposed to the RPC being unreachable. */
function isCallFailure(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  if (
    e.walk(
      (err) => err instanceof HttpRequestError || err instanceof TimeoutError,
    )
  )
    return false;
  return !!e.walk(
    (err) =>
      err instanceof ContractFunctionRevertedError ||
      err instanceof ContractFunctionZeroDataError ||
      (err as Error).name === "ContractFunctionExecutionError" ||
      (err as Error).name === "CallExecutionError" ||
      (err as Error).name === "AbiDecodingZeroDataError",
  );
}
