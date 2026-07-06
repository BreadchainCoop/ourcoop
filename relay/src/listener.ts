import type { Address, Hex } from "viem";
import { errorMessage, log, warn } from "./log.js";
import type { Store } from "./store.js";

/** Split [from..to] into inclusive windows of at most `max` blocks. */
export function planWindows(
  from: bigint,
  to: bigint,
  max: bigint,
): Array<[bigint, bigint]> {
  if (max <= 0n) throw new Error("maxLogRange must be positive");
  const windows: Array<[bigint, bigint]> = [];
  for (let start = from; start <= to; start += max) {
    const end = start + max - 1n < to ? start + max - 1n : to;
    windows.push([start, end]);
  }
  return windows;
}

/** Heuristic for provider "range too large"-style errors worth bisecting. */
export function isRangeError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /range|limit|too (many|large|big)|response size|exceed|10.?000|query returned more/i.test(
    msg,
  );
}

/**
 * getLogs with bisect-on-range-error: halve the window until the provider
 * accepts it; a single-block failure (or a non-range error) propagates.
 */
export async function getLogsBisect<T>(
  fetch: (from: bigint, to: bigint) => Promise<T[]>,
  from: bigint,
  to: bigint,
  isRange: (e: unknown) => boolean = isRangeError,
): Promise<T[]> {
  try {
    return await fetch(from, to);
  } catch (e) {
    if (from >= to || !isRange(e)) throw e;
    const mid = from + (to - from) / 2n;
    const left = await getLogsBisect(fetch, from, mid, isRange);
    const right = await getLogsBisect(fetch, mid + 1n, to, isRange);
    return [...left, ...right];
  }
}

export interface FamilyDeployedLog {
  txHash: Hex;
  logIndex: number;
  familyId: Hex;
}

export interface VoteCastLog {
  txHash: Hex;
  logIndex: number;
  votingModule: Address;
  voter: Address;
  points: bigint[];
  recipients: Address[];
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
}

/** The chain surface the listener needs; production wraps viem getLogs. */
export interface ListenerRpc {
  getBlockNumber(): Promise<bigint>;
  getFamilyDeployedLogs(from: bigint, to: bigint): Promise<FamilyDeployedLog[]>;
  getVoteCastLogs(
    addresses: Address[],
    from: bigint,
    to: bigint,
  ): Promise<VoteCastLog[]>;
  readFamilyId(votingModule: Address): Promise<Hex>;
}

export interface ChainListenerDeps {
  chainId: number;
  chainName: string;
  store: Store;
  rpc: ListenerRpc;
  confirmations: bigint;
  maxLogRange: bigint;
  /** Called with the familyId when FamilyDeployed is seen (cache invalidation + backfill). */
  onFamilyDeployed: (familyId: Hex, chainId: number) => Promise<void>;
  /** Called after votes were ingested (once per pass) with the affected
   *  families so their ballots can be fanned out to every sibling chain. */
  onVotesIngested: (familyIds: Set<Hex>) => Promise<void> | void;
  pollIntervalMs?: number;
  now?: () => number;
}

/**
 * Listener mode (spec B.6): tails CrossChainVoteCast on known family voting
 * modules + FamilyDeployed on the pinned deployer. Bounded windows, bisect on
 * range errors, cursor lags head by `confirmations`, (txHash,logIndex) dedup
 * plus (voter,nonce) dedup via the votes UNIQUE constraint. Ingested votes
 * feed the SAME store/workers as the API.
 */
export class ChainListener {
  private readonly deps: Required<
    Pick<ChainListenerDeps, "pollIntervalMs" | "now">
  > &
    ChainListenerDeps;
  private running = false;
  private stopped = Promise.resolve();

  constructor(deps: ChainListenerDeps) {
    this.deps = { pollIntervalMs: 5_000, now: Date.now, ...deps };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.stopped;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
      } catch (e) {
        warn(this.deps.chainName, "listener pass failed", {
          error: errorMessage(e),
        });
      }
      await new Promise((r) => setTimeout(r, this.deps.pollIntervalMs));
    }
  }

  /** One tail pass; advances the durable cursor window by window. */
  async runOnce(): Promise<void> {
    const { store, chainId, rpc, confirmations, maxLogRange } = this.deps;
    const head = await rpc.getBlockNumber();
    const safe = head - confirmations;
    if (safe < 0n) return;
    const cursor = store.getCursor(chainId);
    if (cursor === undefined) {
      // First run: anchor at the safe head and scan nothing — historical
      // backfill is not the listener's job (votes are reconstructible; re-run
      // with a manual cursor if needed). The next pass tails forward from here.
      store.setCursor(chainId, safe - 1n < 0n ? -1n : safe - 1n);
      return;
    }
    if (cursor >= safe) return;

    for (const [from, to] of planWindows(cursor + 1n, safe, maxLogRange)) {
      await this.processWindow(from, to);
      store.setCursor(chainId, to);
    }
  }

  private async processWindow(from: bigint, to: bigint): Promise<void> {
    const { store, chainId, chainName, rpc } = this.deps;

    // Deployer logs first: a family deployed in this window must be known
    // before we choose which voting modules to tail for votes.
    const deployed = await getLogsBisect(
      (f, t) => rpc.getFamilyDeployedLogs(f, t),
      from,
      to,
    );
    // Mark-seen must be the LAST durable write per log: it autocommits, and a
    // crash between it and the ingestion below would drop the log forever
    // (dedup hides it on replay). So we probe for dedup first and only record
    // the log as seen after its side effects have committed — replaying an
    // un-marked log is safe (upsertVote/ensureJob/onFamilyDeployed idempotent).
    for (const evt of deployed) {
      if (store.hasSeenLog(chainId, evt.txHash, evt.logIndex)) continue;
      log(chainName, `FamilyDeployed ${evt.familyId}`, { txHash: evt.txHash });
      await this.deps.onFamilyDeployed(evt.familyId, chainId);
      store.markLogSeen(chainId, evt.txHash, evt.logIndex);
    }

    const modules = store.knownVotingModules(chainId);
    if (modules.length === 0) return;
    const votes = await getLogsBisect(
      (f, t) => rpc.getVoteCastLogs(modules, f, t),
      from,
      to,
    );
    // Fan out every family whose vote landed here — a vote seen on the origin
    // chain must still reach its siblings (the API path does this via
    // fanOutFamily; the listener mirrors it).
    const affected = new Set<Hex>();
    const toMark: VoteCastLog[] = [];
    for (const evt of votes) {
      if (store.hasSeenLog(chainId, evt.txHash, evt.logIndex)) continue;
      const familyId = await this.ingestVote(evt);
      if (familyId) affected.add(familyId);
      toMark.push(evt);
    }
    // Fan-out first (creates sibling jobs), then mark seen — so a crash before
    // fan-out replays the whole vote instead of silently losing its siblings.
    if (affected.size > 0) await this.deps.onVotesIngested(affected);
    for (const evt of toMark) {
      store.markLogSeen(chainId, evt.txHash, evt.logIndex);
    }
  }

  /** Extract the full vote from the event and upsert it (spec: the event
   *  re-emits the signature precisely so any listener can reconstruct).
   *  Returns the resolved familyId when a vote row was ingested. */
  private async ingestVote(evt: VoteCastLog): Promise<Hex | undefined> {
    const { store, chainId, chainName, rpc } = this.deps;
    let familyId = store.familyByVotingModule(chainId, evt.votingModule);
    if (!familyId) {
      familyId = await rpc
        .readFamilyId(evt.votingModule)
        .catch(() => undefined);
      if (!familyId) {
        warn(chainName, "vote log from unknown module — skipped", {
          votingModule: evt.votingModule,
        });
        return undefined;
      }
    }
    const { id, created } = store.upsertVote({
      familyId,
      voter: evt.voter,
      nonce: evt.nonce.toString(),
      deadline: evt.deadline.toString(),
      points: evt.points.map((p) => p.toString()),
      recipients: evt.recipients,
      signature: evt.signature,
    });
    // The vote already landed on THIS chain — record the origin job as
    // confirmed with the emitting tx, then let workers fan out to siblings.
    if (store.ensureJob(id, chainId)) {
      store.updateJob(id, chainId, { state: "confirmed", txHash: evt.txHash });
    }
    if (created) {
      log(chainName, `ingested vote from chain`, {
        voteId: id,
        voter: evt.voter,
        nonce: evt.nonce,
      });
    }
    return familyId;
  }
}
