import {
  formatUnits,
  parseAbiItem,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { publicClientFor } from "@/lib/instance";

/**
 * Client-side, serverless cross-chain indexer for yield distributions.
 *
 * Every distribution strategy emits `Distributed(recipient, amount)` once per
 * recipient each time yield is paid out, in the same tx as one
 * `DistributionExecuted`. We read those logs from each family chain's strategy
 * over a bounded block window, group them by transaction into distribution
 * "rounds", and aggregate across chains — so a family (e.g. RonCoin) gets one
 * history summarising how yield was distributed on every chain.
 *
 * No server: reads go straight to each chain's RPC via viem `getLogs`, chunked
 * (bisecting on range-limit errors) and cached incrementally in localStorage.
 */

export const DISTRIBUTED_EVENT = parseAbiItem(
  "event Distributed(address indexed recipient, uint256 amount)",
);

export interface RecipientAmount {
  recipient: Address;
  amount: bigint;
}

/** One distribution payout on one chain (all recipients paid in a single tx). */
export interface DistributionRound {
  chainId: number;
  txHash: Hex;
  blockNumber: bigint;
  /** Unix seconds. */
  timestamp: number;
  /** Sum over recipients (yield-token base units on this chain). */
  total: bigint;
  recipients: RecipientAmount[];
}

/** A chain + the strategy contract whose `Distributed` events we index. */
export interface DistributionTarget {
  chainId: number;
  strategy: Address;
}

type DistLog = Log<bigint, number, false, typeof DISTRIBUTED_EVENT, true>;

/** Split [from, to] into ≤maxRange windows. */
function windows(
  from: bigint,
  to: bigint,
  maxRange: bigint,
): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let lo = from; lo <= to; lo += maxRange) {
    const hi = lo + maxRange - 1n;
    out.push([lo, hi > to ? to : hi]);
  }
  return out;
}

/**
 * Fetch `Distributed` logs for one strategy over [fromBlock, toBlock], chunked
 * by `maxRange` and bisecting any window the RPC rejects (range too large).
 */
async function fetchDistributedLogs(
  chainId: number,
  strategy: Address,
  fromBlock: bigint,
  toBlock: bigint,
  maxRange: bigint,
): Promise<DistLog[]> {
  const client = publicClientFor(chainId);
  const stack = windows(fromBlock, toBlock, maxRange).reverse();
  const logs: DistLog[] = [];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    if (lo > hi) continue;
    try {
      const got = await client.getLogs({
        address: strategy,
        event: DISTRIBUTED_EVENT,
        fromBlock: lo,
        toBlock: hi,
      });
      logs.push(...(got as DistLog[]));
    } catch {
      // Range too large / rate limited → split and retry, unless single block.
      if (hi > lo) {
        const mid = lo + (hi - lo) / 2n;
        stack.push([mid + 1n, hi], [lo, mid]);
      }
      // A single block that still fails is dropped (next refresh retries).
    }
  }
  return logs;
}

/** Group per-recipient logs into rounds (one per tx) and attach timestamps. */
async function logsToRounds(
  chainId: number,
  logs: DistLog[],
): Promise<DistributionRound[]> {
  const byTx = new Map<Hex, DistLog[]>();
  for (const log of logs) {
    const list = byTx.get(log.transactionHash) ?? [];
    list.push(log);
    byTx.set(log.transactionHash, list);
  }
  // Fetch each unique block's timestamp once.
  const client = publicClientFor(chainId);
  const blocks = new Map<bigint, number>();
  await Promise.all(
    [...new Set(logs.map((l) => l.blockNumber))].map(async (bn) => {
      try {
        const block = await client.getBlock({ blockNumber: bn });
        blocks.set(bn, Number(block.timestamp));
      } catch {
        blocks.set(bn, 0);
      }
    }),
  );
  const rounds: DistributionRound[] = [];
  for (const [txHash, list] of byTx) {
    const blockNumber = list[0].blockNumber;
    const recipients = list.map((l) => ({
      recipient: l.args.recipient as Address,
      amount: l.args.amount as bigint,
    }));
    rounds.push({
      chainId,
      txHash,
      blockNumber,
      timestamp: blocks.get(blockNumber) ?? 0,
      total: recipients.reduce((s, r) => s + r.amount, 0n),
      recipients,
    });
  }
  return rounds;
}

/* --------------------------- localStorage cache ---------------------------- */

interface CacheEntry {
  /** Lowest block scanned so far (inclusive). */
  fromBlock: string;
  /** Highest block scanned so far (inclusive). */
  toBlock: string;
  rounds: SerializedRound[];
}
interface SerializedRound {
  chainId: number;
  txHash: Hex;
  blockNumber: string;
  timestamp: number;
  recipients: { recipient: Address; amount: string }[];
}

const cacheKey = (chainId: number, strategy: Address) =>
  `crowdstake.dist-history.v1:${chainId}:${strategy.toLowerCase()}`;

function readCache(chainId: number, strategy: Address): CacheEntry | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(chainId, strategy));
    return raw ? (JSON.parse(raw) as CacheEntry) : null;
  } catch {
    return null;
  }
}

function writeCache(
  chainId: number,
  strategy: Address,
  from: bigint,
  to: bigint,
  rounds: DistributionRound[],
): void {
  if (typeof window === "undefined") return;
  const entry: CacheEntry = {
    fromBlock: from.toString(),
    toBlock: to.toString(),
    rounds: rounds.map((r) => ({
      chainId: r.chainId,
      txHash: r.txHash,
      blockNumber: r.blockNumber.toString(),
      timestamp: r.timestamp,
      recipients: r.recipients.map((x) => ({
        recipient: x.recipient,
        amount: x.amount.toString(),
      })),
    })),
  };
  try {
    window.localStorage.setItem(
      cacheKey(chainId, strategy),
      JSON.stringify(entry),
    );
  } catch {
    /* quota — skip caching */
  }
}

function deserializeRounds(entry: CacheEntry): DistributionRound[] {
  return entry.rounds.map((r) => {
    const recipients = r.recipients.map((x) => ({
      recipient: x.recipient,
      amount: BigInt(x.amount),
    }));
    return {
      chainId: r.chainId,
      txHash: r.txHash,
      blockNumber: BigInt(r.blockNumber),
      timestamp: r.timestamp,
      total: recipients.reduce((s, x) => s + x.amount, 0n),
      recipients,
    };
  });
}

/* ------------------------------ public API -------------------------------- */

/**
 * Load one chain's distribution rounds. Uses the localStorage cache and only
 * scans the gap up to the latest block (cheap on repeat visits). On the first
 * scan it looks back `initialLookback` blocks; pass `olderBlocks` to extend the
 * window further into the past ("load older").
 */
export async function loadChainDistributions(
  target: DistributionTarget,
  opts: { initialLookback: bigint; maxRange: bigint; olderBlocks?: bigint } = {
    initialLookback: 200_000n,
    maxRange: 9_000n,
  },
): Promise<DistributionRound[]> {
  const { chainId, strategy } = target;
  const client = publicClientFor(chainId);
  const latest = await client.getBlockNumber();
  const cached = readCache(chainId, strategy);

  let cachedRounds: DistributionRound[] = [];
  let scanFrom: bigint;
  let scanTo: bigint = latest;
  let coveredFrom: bigint;

  if (cached) {
    cachedRounds = deserializeRounds(cached);
    const cachedFrom = BigInt(cached.fromBlock);
    const cachedTo = BigInt(cached.toBlock);
    if (opts.olderBlocks && opts.olderBlocks > 0n) {
      // Extend the window backwards from the oldest scanned block.
      scanTo = cachedFrom - 1n;
      scanFrom =
        scanTo < opts.olderBlocks ? 0n : scanTo - opts.olderBlocks + 1n;
      coveredFrom = scanFrom < cachedFrom ? scanFrom : cachedFrom;
    } else {
      // Top up forward to the latest block.
      scanFrom = cachedTo + 1n;
      coveredFrom = cachedFrom;
    }
  } else {
    scanFrom =
      latest < opts.initialLookback ? 0n : latest - opts.initialLookback + 1n;
    coveredFrom = scanFrom;
  }

  let fresh: DistributionRound[] = [];
  if (scanFrom <= scanTo) {
    const logs = await fetchDistributedLogs(
      chainId,
      strategy,
      scanFrom,
      scanTo,
      opts.maxRange,
    );
    fresh = await logsToRounds(chainId, logs);
  }

  // Merge (dedupe by txHash), newest first.
  const byTx = new Map<Hex, DistributionRound>();
  for (const r of [...cachedRounds, ...fresh]) byTx.set(r.txHash, r);
  const merged = [...byTx.values()].sort(
    (a, b) =>
      b.timestamp - a.timestamp || Number(b.blockNumber - a.blockNumber),
  );

  const newFrom = coveredFrom;
  const newTo = cached ? bigMax(BigInt(cached.toBlock), latest) : latest;
  writeCache(chainId, strategy, newFrom, newTo, merged);
  return merged;
}

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Normalize a base-unit amount to a decimal number (for cross-chain sums). */
export function toDecimal(amount: bigint, decimals: number): number {
  return Number(formatUnits(amount, decimals));
}
