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
import { deployerAbi, votingModuleAbi } from "./abi.js";
import type { FamilyInstance } from "./store.js";

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
 * tests inject fakes.
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
  readFamilyId(votingModule: Address): Promise<Hex>;
  lastCrossChainNonce(votingModule: Address, voter: Address): Promise<bigint>;
  getVotingPower(votingModule: Address, voter: Address): Promise<bigint>;
  /** Simulates + estimates gas; throws RevertError on decoded revert. */
  simulateCastVote(votingModule: Address, args: CastVoteArgs): Promise<bigint>;
  sendCastVote(
    votingModule: Address,
    args: CastVoteArgs,
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

  readFamilyId(votingModule: Address): Promise<Hex> {
    return this.publicClient.readContract({
      address: votingModule,
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

  async simulateCastVote(
    votingModule: Address,
    args: CastVoteArgs,
  ): Promise<bigint> {
    try {
      return await this.publicClient.estimateContractGas({
        account: this.account,
        address: votingModule,
        abi: votingModuleAbi,
        functionName: "castCrossChainVote",
        args: [
          args.voter,
          args.points,
          args.recipients,
          args.nonce,
          args.deadline,
          args.signature,
        ],
      });
    } catch (e) {
      const revert = toRevertError(e);
      if (revert) throw revert;
      throw e;
    }
  }

  async sendCastVote(
    votingModule: Address,
    args: CastVoteArgs,
    opts: { nonce: number; gas: bigint } & FeeEstimate,
  ): Promise<Hex> {
    return this.walletClient.writeContract({
      address: votingModule,
      abi: votingModuleAbi,
      functionName: "castCrossChainVote",
      args: [
        args.voter,
        args.points,
        args.recipients,
        args.nonce,
        args.deadline,
        args.signature,
      ],
      nonce: opts.nonce,
      gas: opts.gas,
      maxFeePerGas: opts.maxFeePerGas,
      maxPriorityFeePerGas: opts.maxPriorityFeePerGas,
    });
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
