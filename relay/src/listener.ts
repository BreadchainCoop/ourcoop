import type { Address, Hex } from "viem";
import { errorMessage, log, warn } from "./log.js";
import type { NewAction, Store } from "./store.js";

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

export interface RegistryUpdatedLog {
  kind: "registry-update";
  txHash: Hex;
  logIndex: number;
  registry: Address;
  admin: Address;
  recipients: Address[];
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
}

export interface ProposalCreatedLog {
  kind: "proposal";
  txHash: Hex;
  logIndex: number;
  registry: Address;
  proposalKey: Hex;
  proposer: Address;
  candidate: Address;
  isAddition: boolean;
  electorate: Address[];
  expiresAt: bigint;
  nonce: bigint;
  signature: Hex;
}

export interface ProposalVoteCastLog {
  kind: "proposal-vote";
  txHash: Hex;
  logIndex: number;
  registry: Address;
  proposalKey: Hex;
  voter: Address;
  deadline: bigint;
  signature: Hex;
}

/** Any of the three registry-governance events, discriminated by kind. */
export type RegistryLog =
  RegistryUpdatedLog | ProposalCreatedLog | ProposalVoteCastLog;

/** The chain surface the listener needs; production wraps viem getLogs. */
export interface ListenerRpc {
  getBlockNumber(): Promise<bigint>;
  getFamilyDeployedLogs(from: bigint, to: bigint): Promise<FamilyDeployedLog[]>;
  getVoteCastLogs(
    addresses: Address[],
    from: bigint,
    to: bigint,
  ): Promise<VoteCastLog[]>;
  /** The three CrossChain* registry events across the given registry addresses. */
  getRegistryLogs(
    addresses: Address[],
    from: bigint,
    to: bigint,
  ): Promise<RegistryLog[]>;
  /** familyId() on a voting module OR a registry — both share the getter. */
  readFamilyId(target: Address): Promise<Hex>;
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
  /** Called after actions were ingested (once per pass) with the affected
   *  families so their unexpired actions can be fanned out to every sibling. */
  onActionsIngested: (familyIds: Set<Hex>) => Promise<void> | void;
  pollIntervalMs?: number;
  now?: () => number;
}

/**
 * Listener mode (spec B.6): tails CrossChainVoteCast on known voting modules,
 * the three CrossChain* registry events on known registries, and FamilyDeployed
 * on the pinned deployer. Bounded windows, bisect on range errors, cursor lags
 * head by `confirmations`, (txHash,logIndex) dedup plus the actions UNIQUE
 * constraint. Ingested actions feed the SAME store/workers as the API.
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
      // backfill is not the listener's job (actions are reconstructible; re-run
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
    // before we choose which voting modules / registries to tail.
    const deployed = await getLogsBisect(
      (f, t) => rpc.getFamilyDeployedLogs(f, t),
      from,
      to,
    );
    // Mark-seen must be the LAST durable write per log: it autocommits, and a
    // crash between it and the ingestion below would drop the log forever
    // (dedup hides it on replay). So we probe for dedup first and only record
    // the log as seen after its side effects have committed — replaying an
    // un-marked log is safe (upsertAction/ensureJob/onFamilyDeployed idempotent).
    for (const evt of deployed) {
      if (store.hasSeenLog(chainId, evt.txHash, evt.logIndex)) continue;
      log(chainName, `FamilyDeployed ${evt.familyId}`, { txHash: evt.txHash });
      await this.deps.onFamilyDeployed(evt.familyId, chainId);
      store.markLogSeen(chainId, evt.txHash, evt.logIndex);
    }

    const affected = new Set<Hex>();
    // Logs whose side effects committed but whose mark-seen waits on fan-out.
    const toMark: Array<{ txHash: Hex; logIndex: number }> = [];

    // Votes on known voting modules.
    const modules = store.knownVotingModules(chainId);
    if (modules.length > 0) {
      const votes = await getLogsBisect(
        (f, t) => rpc.getVoteCastLogs(modules, f, t),
        from,
        to,
      );
      await this.ingestBatch(
        votes,
        (evt) => this.ingestVote(evt),
        affected,
        toMark,
      );
    }

    // Registry-governance events on known registries.
    const registries = store.knownRegistries(chainId);
    if (registries.length > 0) {
      const regLogs = await getLogsBisect(
        (f, t) => rpc.getRegistryLogs(registries, f, t),
        from,
        to,
      );
      await this.ingestBatch(
        regLogs,
        (evt) => this.ingestRegistryLog(evt),
        affected,
        toMark,
      );
    }

    // Fan-out first (creates sibling jobs), then mark seen — so a crash before
    // fan-out replays the whole action instead of silently losing its siblings.
    if (affected.size > 0) await this.deps.onActionsIngested(affected);
    for (const evt of toMark) {
      store.markLogSeen(chainId, evt.txHash, evt.logIndex);
    }
  }

  /**
   * Crash-safe ingestion for one event batch: probe hasSeenLog first (skip
   * already-recorded logs), ingest side effects, and collect the log into
   * `toMark` — the caller marks them seen only AFTER the pass's fan-out has
   * committed, so a crash before fan-out replays the whole log.
   */
  private async ingestBatch<T extends { txHash: Hex; logIndex: number }>(
    logs: T[],
    ingest: (evt: T) => Promise<Hex | undefined>,
    affected: Set<Hex>,
    toMark: Array<{ txHash: Hex; logIndex: number }>,
  ): Promise<void> {
    const { store, chainId } = this.deps;
    for (const evt of logs) {
      if (store.hasSeenLog(chainId, evt.txHash, evt.logIndex)) continue;
      const familyId = await ingest(evt);
      if (familyId) affected.add(familyId);
      toMark.push({ txHash: evt.txHash, logIndex: evt.logIndex });
    }
  }

  /** Extract the full vote from the event and upsert it. Returns the familyId
   *  when a vote row was ingested. */
  private async ingestVote(evt: VoteCastLog): Promise<Hex | undefined> {
    const { store, chainName } = this.deps;
    const familyId = await this.resolveFamilyByModule(evt.votingModule);
    if (!familyId) return undefined;
    const { id, created } = store.upsertAction({
      kind: "vote",
      familyId,
      voter: evt.voter,
      nonce: evt.nonce.toString(),
      deadline: evt.deadline.toString(),
      points: evt.points.map((p) => p.toString()),
      recipients: evt.recipients,
      signature: evt.signature,
    });
    this.confirmOrigin(id, evt.txHash);
    if (created) {
      log(chainName, `ingested vote from chain`, {
        actionId: id,
        voter: evt.voter,
        nonce: evt.nonce,
      });
    }
    return familyId;
  }

  /** Extract a registry-governance action from its event and upsert it. */
  private async ingestRegistryLog(evt: RegistryLog): Promise<Hex | undefined> {
    const { store, chainName } = this.deps;
    const familyId = await this.resolveFamilyByRegistry(evt.registry);
    if (!familyId) return undefined;

    let action: NewAction;
    switch (evt.kind) {
      case "registry-update":
        action = {
          kind: "registry-update",
          familyId,
          admin: evt.admin,
          recipients: evt.recipients,
          nonce: evt.nonce.toString(),
          deadline: evt.deadline.toString(),
          signature: evt.signature,
        };
        break;
      case "proposal":
        action = {
          kind: "proposal",
          familyId,
          proposer: evt.proposer,
          candidate: evt.candidate,
          isAddition: evt.isAddition,
          electorate: evt.electorate,
          expiresAt: evt.expiresAt.toString(),
          nonce: evt.nonce.toString(),
          proposalKey: evt.proposalKey,
          signature: evt.signature,
        };
        break;
      case "proposal-vote":
        action = {
          kind: "proposal-vote",
          familyId,
          voter: evt.voter,
          proposalKey: evt.proposalKey,
          deadline: evt.deadline.toString(),
          signature: evt.signature,
        };
        break;
    }
    const { id, created } = store.upsertAction(action);
    this.confirmOrigin(id, evt.txHash);
    if (created) {
      log(chainName, `ingested ${evt.kind} from chain`, {
        actionId: id,
        registry: evt.registry,
      });
    }
    return familyId;
  }

  /** The action already landed on THIS chain — record the origin job confirmed
   *  with the emitting tx, then let fan-out reach the siblings. */
  private confirmOrigin(actionId: number, txHash: Hex): void {
    const { store, chainId } = this.deps;
    if (store.ensureJob(actionId, chainId)) {
      store.updateJob(actionId, chainId, { state: "confirmed", txHash });
    }
  }

  private async resolveFamilyByModule(
    votingModule: Address,
  ): Promise<Hex | undefined> {
    const { store, chainId, chainName, rpc } = this.deps;
    let familyId = store.familyByVotingModule(chainId, votingModule);
    if (!familyId) {
      familyId = await rpc.readFamilyId(votingModule).catch(() => undefined);
      if (!familyId) {
        warn(chainName, "vote log from unknown module — skipped", {
          votingModule,
        });
        return undefined;
      }
    }
    return familyId;
  }

  private async resolveFamilyByRegistry(
    registry: Address,
  ): Promise<Hex | undefined> {
    const { store, chainId, chainName, rpc } = this.deps;
    let familyId = store.familyByRegistry(chainId, registry);
    if (!familyId) {
      // Unknown registry → familyId() read fallback (the registry inherits the
      // same getter as the voting module).
      familyId = await rpc.readFamilyId(registry).catch(() => undefined);
      if (!familyId) {
        warn(chainName, "registry log from unknown registry — skipped", {
          registry,
        });
        return undefined;
      }
    }
    return familyId;
  }
}
