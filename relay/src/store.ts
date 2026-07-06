import Database from "better-sqlite3";
import type { Address, Hex } from "viem";

/**
 * Durable store (SQLite, WAL). This is the correctness boundary: an action+jobs
 * row set is written BEFORE any submission, so double POSTs, listener replays
 * and NonceAlreadyUsed-style races collapse onto UNIQUE constraints here —
 * never onto pre-checks.
 *
 * The `actions` table generalizes the original single-kind `votes` table over
 * four cross-chain kinds sharing the same delivery machinery (jobs, workers,
 * fan-out). Each kind carries the fields it needs; the per-kind `dedup_key`
 * (vote/registry-update → nonce, proposal/proposal-vote → proposalKey) plus
 * UNIQUE(family_id, kind, signer, dedup_key) is the idempotency boundary.
 */

/** The four cross-chain action kinds delivered by the relay. */
export type ActionKind =
  "vote" | "registry-update" | "proposal" | "proposal-vote";

export const ACTION_KINDS: readonly ActionKind[] = [
  "vote",
  "registry-update",
  "proposal",
  "proposal-vote",
] as const;

export type JobState =
  | "pending"
  | "submitted"
  | "confirmed"
  | "superseded"
  | "skipped_no_power"
  | "recipient_mismatch"
  | "expired"
  | "failed";

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  "confirmed",
  "superseded",
  "expired",
  "failed",
]);

/** States the worker picks up again (with not_before backoff). */
export const RETRYABLE_STATES: ReadonlySet<JobState> = new Set([
  "pending",
  "skipped_no_power",
  "recipient_mismatch",
]);

/**
 * One stored action, discriminated by `kind`. Columns that don't apply to a
 * kind are null. `signer` is the address that signed (voter / admin / proposer /
 * voter); `dedupKey` is the per-kind idempotency key (nonce or proposalKey).
 */
export interface ActionRow {
  id: number;
  kind: ActionKind;
  familyId: Hex;
  signer: Address;
  /** Per-kind idempotency key: nonce (vote/registry-update) or proposalKey. */
  dedupKey: string;
  /** Signature deadline in seconds (vote / registry-update / proposal-vote). */
  deadline: string | null;
  signature: Hex;
  receivedAt: number;
  // ── vote ──
  nonce: string | null;
  points: string[] | null;
  recipients: Address[] | null;
  // ── proposal ──
  candidate: Address | null;
  isAddition: boolean | null;
  electorate: Address[] | null;
  expiresAt: string | null;
  // ── proposal-vote ──
  proposalKey: Hex | null;
}

/** Back-compat alias: the original single-kind row type is now ActionRow. */
export type VoteRow = ActionRow;

export interface JobRow {
  actionId: number;
  chainId: number;
  state: JobState;
  txHash: Hex | null;
  acctNonce: number | null;
  maxFeePerGas: string | null;
  maxPriorityFeePerGas: string | null;
  submittedBlock: string | null;
  attempts: number;
  lastError: string | null;
  notBefore: number;
  updatedAt: number;
}

export interface FamilyInstance {
  cycleModule: Address;
  registry: Address;
  token: Address;
  votingPowerStrategy: Address;
  distributionManager: Address;
  distributionStrategy: Address;
  secondaryDistributionStrategy: Address;
  votingModule: Address;
}

export interface FamilyCacheRow {
  familyId: Hex;
  chainId: number;
  /** null = resolved to "none" (cached with TTL, never permanently). */
  instance: FamilyInstance | null;
  resolvedAt: number;
}

/** A cross-chain vote action (unchanged field set from the original votes table). */
export interface NewVote {
  kind?: "vote";
  familyId: Hex;
  voter: Address;
  nonce: string;
  deadline: string;
  points: string[];
  recipients: Address[];
  signature: Hex;
}

/** An admin desired-set registry update (signed full recipient set + nonce). */
export interface NewRegistryUpdate {
  kind: "registry-update";
  familyId: Hex;
  admin: Address;
  recipients: Address[];
  nonce: string;
  deadline: string;
  signature: Hex;
}

/** A democratic cross-chain proposal (content-addressed by proposalKey). */
export interface NewProposal {
  kind: "proposal";
  familyId: Hex;
  proposer: Address;
  candidate: Address;
  isAddition: boolean;
  electorate: Address[];
  expiresAt: string;
  nonce: string;
  proposalKey: Hex;
  signature: Hex;
}

/** A vote on a democratic cross-chain proposal (no nonce; keyed by proposalKey). */
export interface NewProposalVote {
  kind: "proposal-vote";
  familyId: Hex;
  voter: Address;
  proposalKey: Hex;
  deadline: string;
  signature: Hex;
}

export type NewAction =
  NewVote | NewRegistryUpdate | NewProposal | NewProposalVote;

/** Current durable schema version; bumped when the layout changes (see migrate). */
const USER_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('vote','registry-update','proposal','proposal-vote')),
  family_id TEXT NOT NULL,
  signer TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  deadline TEXT,
  signature TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  nonce TEXT,
  points TEXT,
  recipients TEXT,
  candidate TEXT,
  is_addition INTEGER,
  electorate TEXT,
  expires_at TEXT,
  proposal_key TEXT,
  UNIQUE(family_id, kind, signer, dedup_key)
);
CREATE TABLE IF NOT EXISTS jobs (
  action_id INTEGER NOT NULL REFERENCES actions(id),
  chain_id INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  tx_hash TEXT,
  acct_nonce INTEGER,
  max_fee_per_gas TEXT,
  max_priority_fee_per_gas TEXT,
  submitted_block TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  not_before INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (action_id, chain_id)
);
CREATE INDEX IF NOT EXISTS jobs_chain_state ON jobs(chain_id, state);
CREATE TABLE IF NOT EXISTS family_cache (
  family_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  instance TEXT,
  voting_module TEXT,
  registry TEXT,
  resolved_at INTEGER NOT NULL,
  PRIMARY KEY (family_id, chain_id)
);
CREATE INDEX IF NOT EXISTS family_cache_module ON family_cache(chain_id, voting_module);
CREATE INDEX IF NOT EXISTS family_cache_registry ON family_cache(chain_id, registry);
CREATE TABLE IF NOT EXISTS listener_cursors (
  chain_id INTEGER PRIMARY KEY,
  block TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seen_logs (
  chain_id INTEGER NOT NULL,
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE TABLE IF NOT EXISTS gas_spend (
  chain_id INTEGER NOT NULL,
  day TEXT NOT NULL,
  wei TEXT NOT NULL,
  PRIMARY KEY (chain_id, day)
);
`;

interface RawAction {
  id: number;
  kind: string;
  family_id: string;
  signer: string;
  dedup_key: string;
  deadline: string | null;
  signature: string;
  received_at: number;
  nonce: string | null;
  points: string | null;
  recipients: string | null;
  candidate: string | null;
  is_addition: number | null;
  electorate: string | null;
  expires_at: string | null;
  proposal_key: string | null;
}

interface RawJob {
  action_id: number;
  chain_id: number;
  state: string;
  tx_hash: string | null;
  acct_nonce: number | null;
  max_fee_per_gas: string | null;
  max_priority_fee_per_gas: string | null;
  submitted_block: string | null;
  attempts: number;
  last_error: string | null;
  not_before: number;
  updated_at: number;
}

interface RawFamily {
  family_id: string;
  chain_id: number;
  instance: string | null;
  resolved_at: number;
}

export class Store {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
    this.db.exec(SCHEMA);
    this.db.pragma(`user_version = ${USER_VERSION}`);
  }

  /**
   * Schema migration gated on PRAGMA user_version. No deployed relay exists yet,
   * so this is deliberately minimal: an old `votes`+`jobs(vote_id)` layout
   * (user_version 0 with a `votes` table) is copied into the new `actions` table
   * as `kind='vote'` rows, preserving ids so the migrated jobs still resolve.
   */
  private migrate(): void {
    const version = this.db.pragma("user_version", { simple: true }) as number;
    if (version >= USER_VERSION) return;

    const hasVotes = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='votes'`,
      )
      .get() as { name: string } | undefined;
    if (!hasVotes) return; // fresh db — nothing to copy; SCHEMA creates actions.

    // Build the new schema alongside the old, copy votes -> actions (kind=vote,
    // dedup_key = nonce, signer = voter), rehome jobs onto action_id, then drop
    // the legacy tables. Runs once, in a transaction.
    this.db.transaction(() => {
      // family_cache is a disposable TTL cache and the old layout lacks the
      // `registry` column — drop it FIRST so the SCHEMA below (which also builds
      // a registry index) recreates it in the new shape. Entries are rebuilt on
      // the next family resolve.
      const oldCache = this.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='family_cache'`,
        )
        .get() as { name: string } | undefined;
      if (oldCache) {
        const cacheCols = this.db
          .prepare(`PRAGMA table_info(family_cache)`)
          .all() as { name: string }[];
        if (!cacheCols.some((c) => c.name === "registry")) {
          this.db.exec(`DROP TABLE family_cache;`);
        }
      }
      this.db.exec(SCHEMA);
      this.db.exec(`
        INSERT INTO actions
          (id, kind, family_id, signer, dedup_key, deadline, signature,
           received_at, nonce, points, recipients)
        SELECT id, 'vote', family_id, voter, nonce, deadline, signature,
               received_at, nonce, points, recipients
        FROM votes;
      `);
      const legacyJobs = this.db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'`,
        )
        .get() as { name: string } | undefined;
      if (legacyJobs) {
        const cols = this.db.prepare(`PRAGMA table_info(jobs)`).all() as {
          name: string;
        }[];
        // Only rehome if the legacy jobs table is keyed on vote_id.
        if (cols.some((c) => c.name === "vote_id")) {
          this.db.exec(`ALTER TABLE jobs RENAME TO jobs_legacy;`);
          this.db.exec(SCHEMA); // recreate jobs with action_id
          this.db.exec(`
            INSERT INTO jobs
              (action_id, chain_id, state, tx_hash, acct_nonce, max_fee_per_gas,
               max_priority_fee_per_gas, submitted_block, attempts, last_error,
               not_before, updated_at)
            SELECT vote_id, chain_id, state, tx_hash, acct_nonce, max_fee_per_gas,
                   max_priority_fee_per_gas, submitted_block, attempts, last_error,
                   not_before, updated_at
            FROM jobs_legacy;
          `);
          this.db.exec(`DROP TABLE jobs_legacy;`);
        }
      }
      this.db.exec(`DROP TABLE votes;`);
    })();
  }

  close(): void {
    this.db.close();
  }

  // ── actions ────────────────────────────────────────────────────────────────

  /** Insert-or-return-existing; idempotent on (familyId, kind, signer, dedupKey). */
  upsertAction(
    action: NewAction,
    now = Date.now(),
  ): { id: number; created: boolean } {
    const row = normalizeAction(action);
    const inserted = this.db
      .prepare(
        `INSERT INTO actions
           (kind, family_id, signer, dedup_key, deadline, signature, received_at,
            nonce, points, recipients, candidate, is_addition, electorate,
            expires_at, proposal_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(family_id, kind, signer, dedup_key) DO NOTHING`,
      )
      .run(
        row.kind,
        row.familyId,
        row.signer,
        row.dedupKey,
        row.deadline,
        row.signature,
        now,
        row.nonce,
        row.points,
        row.recipients,
        row.candidate,
        row.isAddition,
        row.electorate,
        row.expiresAt,
        row.proposalKey,
      );
    const existing = this.db
      .prepare(
        `SELECT id FROM actions
         WHERE family_id = ? AND kind = ? AND signer = ? AND dedup_key = ?`,
      )
      .get(row.familyId, row.kind, row.signer, row.dedupKey) as
      { id: number } | undefined;
    if (!existing) throw new Error("action upsert failed");
    return { id: existing.id, created: inserted.changes > 0 };
  }

  /** Back-compat alias for the vote-only path (thin wrapper over upsertAction). */
  upsertVote(
    vote: NewVote,
    now = Date.now(),
  ): { id: number; created: boolean } {
    return this.upsertAction({ ...vote, kind: "vote" }, now);
  }

  getAction(
    familyId: Hex,
    kind: ActionKind,
    signer: Address,
    dedupKey: string,
  ): ActionRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM actions
         WHERE family_id = ? AND kind = ? AND signer = ? AND dedup_key = ?`,
      )
      .get(familyId.toLowerCase(), kind, signer.toLowerCase(), dedupKey) as
      RawAction | undefined;
    return row ? toAction(row) : undefined;
  }

  /** Back-compat vote lookup, keyed (familyId, voter, nonce). */
  getVote(familyId: Hex, voter: Address, nonce: string): ActionRow | undefined {
    return this.getAction(familyId, "vote", voter, nonce);
  }

  getActionById(id: number): ActionRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM actions WHERE id = ?`)
      .get(id) as RawAction | undefined;
    return row ? toAction(row) : undefined;
  }

  /** Back-compat alias. */
  getVoteById(id: number): ActionRow | undefined {
    return this.getActionById(id);
  }

  /**
   * Actions of a family that are still deliverable: not past their signature
   * deadline (vote / registry-update / proposal-vote) or absolute expiresAt
   * (proposal). Actions with no time bound are always included.
   */
  unexpiredActions(familyId: Hex, nowSec: number): ActionRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM actions
         WHERE family_id = ?
           AND (deadline IS NULL OR CAST(deadline AS INTEGER) >= ?)
           AND (expires_at IS NULL OR CAST(expires_at AS INTEGER) >= ?)`,
      )
      .all(familyId.toLowerCase(), nowSec, nowSec) as RawAction[];
    return rows.map(toAction);
  }

  /** Back-compat alias. */
  unexpiredVotes(familyId: Hex, nowSec: number): ActionRow[] {
    return this.unexpiredActions(familyId, nowSec);
  }

  // ── jobs ─────────────────────────────────────────────────────────────────

  /** Create the job if absent (pending). Returns true when newly created. */
  ensureJob(actionId: number, chainId: number, now = Date.now()): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO jobs (action_id, chain_id, state, updated_at)
         VALUES (?, ?, 'pending', ?)
         ON CONFLICT(action_id, chain_id) DO NOTHING`,
      )
      .run(actionId, chainId, now);
    return res.changes > 0;
  }

  getJob(actionId: number, chainId: number): JobRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE action_id = ? AND chain_id = ?`)
      .get(actionId, chainId) as RawJob | undefined;
    return row ? toJob(row) : undefined;
  }

  jobsForAction(actionId: number): JobRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE action_id = ? ORDER BY chain_id`)
      .all(actionId) as RawJob[];
    return rows.map(toJob);
  }

  /** Back-compat alias. */
  jobsForVote(actionId: number): JobRow[] {
    return this.jobsForAction(actionId);
  }

  updateJob(
    actionId: number,
    chainId: number,
    patch: Partial<
      Pick<
        JobRow,
        | "state"
        | "txHash"
        | "acctNonce"
        | "maxFeePerGas"
        | "maxPriorityFeePerGas"
        | "submittedBlock"
        | "attempts"
        | "lastError"
        | "notBefore"
      >
    >,
    now = Date.now(),
  ): void {
    const sets: string[] = ["updated_at = ?"];
    const values: unknown[] = [now];
    const columns: Record<string, string> = {
      state: "state",
      txHash: "tx_hash",
      acctNonce: "acct_nonce",
      maxFeePerGas: "max_fee_per_gas",
      maxPriorityFeePerGas: "max_priority_fee_per_gas",
      submittedBlock: "submitted_block",
      attempts: "attempts",
      lastError: "last_error",
      notBefore: "not_before",
    };
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        sets.push(`${column} = ?`);
        values.push(patch[key as keyof typeof patch] ?? null);
      }
    }
    values.push(actionId, chainId);
    this.db
      .prepare(
        `UPDATE jobs SET ${sets.join(", ")} WHERE action_id = ? AND chain_id = ?`,
      )
      .run(...values);
  }

  /** Jobs a worker should process now: retryable states past their backoff. */
  dueJobs(chainId: number, now = Date.now(), limit = 25): JobRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE chain_id = ?
           AND state IN ('pending', 'skipped_no_power', 'recipient_mismatch')
           AND not_before <= ?
         ORDER BY updated_at ASC LIMIT ?`,
      )
      .all(chainId, now, limit) as RawJob[];
    return rows.map(toJob);
  }

  submittedJobs(chainId: number): JobRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE chain_id = ? AND state = 'submitted'`)
      .all(chainId) as RawJob[];
    return rows.map(toJob);
  }

  queueDepth(chainId: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM jobs
         WHERE chain_id = ?
           AND state IN ('pending', 'submitted', 'skipped_no_power', 'recipient_mismatch')`,
      )
      .get(chainId) as { n: number };
    return row.n;
  }

  // ── family cache ─────────────────────────────────────────────────────────

  getFamilyChain(familyId: Hex, chainId: number): FamilyCacheRow | undefined {
    const row = this.db
      .prepare(
        `SELECT family_id, chain_id, instance, resolved_at FROM family_cache
         WHERE family_id = ? AND chain_id = ?`,
      )
      .get(familyId.toLowerCase(), chainId) as RawFamily | undefined;
    if (!row) return undefined;
    return {
      familyId: row.family_id as Hex,
      chainId: row.chain_id,
      instance: row.instance
        ? (JSON.parse(row.instance) as FamilyInstance)
        : null,
      resolvedAt: row.resolved_at,
    };
  }

  setFamilyChain(
    familyId: Hex,
    chainId: number,
    instance: FamilyInstance | null,
    now = Date.now(),
  ): void {
    this.db
      .prepare(
        `INSERT INTO family_cache
           (family_id, chain_id, instance, voting_module, registry, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(family_id, chain_id) DO UPDATE SET
           instance = excluded.instance,
           voting_module = excluded.voting_module,
           registry = excluded.registry,
           resolved_at = excluded.resolved_at`,
      )
      .run(
        familyId.toLowerCase(),
        chainId,
        instance ? JSON.stringify(instance) : null,
        instance ? instance.votingModule.toLowerCase() : null,
        instance ? instance.registry.toLowerCase() : null,
        now,
      );
  }

  invalidateFamily(familyId: Hex, chainId?: number): void {
    if (chainId === undefined) {
      this.db
        .prepare(`DELETE FROM family_cache WHERE family_id = ?`)
        .run(familyId.toLowerCase());
    } else {
      this.db
        .prepare(
          `DELETE FROM family_cache WHERE family_id = ? AND chain_id = ?`,
        )
        .run(familyId.toLowerCase(), chainId);
    }
  }

  familyByVotingModule(
    chainId: number,
    votingModule: Address,
  ): Hex | undefined {
    const row = this.db
      .prepare(
        `SELECT family_id FROM family_cache WHERE chain_id = ? AND voting_module = ?`,
      )
      .get(chainId, votingModule.toLowerCase()) as
      { family_id: string } | undefined;
    return row?.family_id as Hex | undefined;
  }

  familyByRegistry(chainId: number, registry: Address): Hex | undefined {
    const row = this.db
      .prepare(
        `SELECT family_id FROM family_cache WHERE chain_id = ? AND registry = ?`,
      )
      .get(chainId, registry.toLowerCase()) as
      { family_id: string } | undefined;
    return row?.family_id as Hex | undefined;
  }

  knownVotingModules(chainId: number): Address[] {
    const rows = this.db
      .prepare(
        `SELECT voting_module FROM family_cache
         WHERE chain_id = ? AND voting_module IS NOT NULL`,
      )
      .all(chainId) as { voting_module: string }[];
    return rows.map((r) => r.voting_module as Address);
  }

  knownRegistries(chainId: number): Address[] {
    const rows = this.db
      .prepare(
        `SELECT registry FROM family_cache
         WHERE chain_id = ? AND registry IS NOT NULL`,
      )
      .all(chainId) as { registry: string }[];
    return rows.map((r) => r.registry as Address);
  }

  // ── listener bookkeeping ─────────────────────────────────────────────────

  getCursor(chainId: number): bigint | undefined {
    const row = this.db
      .prepare(`SELECT block FROM listener_cursors WHERE chain_id = ?`)
      .get(chainId) as { block: string } | undefined;
    return row ? BigInt(row.block) : undefined;
  }

  setCursor(chainId: number, block: bigint): void {
    this.db
      .prepare(
        `INSERT INTO listener_cursors (chain_id, block) VALUES (?, ?)
         ON CONFLICT(chain_id) DO UPDATE SET block = excluded.block`,
      )
      .run(chainId, block.toString());
  }

  /** (txHash, logIndex) dedup probe — true when the log was already recorded. */
  hasSeenLog(chainId: number, txHash: Hex, logIndex: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM seen_logs WHERE chain_id = ? AND tx_hash = ? AND log_index = ?`,
      )
      .get(chainId, txHash.toLowerCase(), logIndex);
    return row !== undefined;
  }

  /** (txHash, logIndex) dedup. Returns true when the log is new. */
  markLogSeen(chainId: number, txHash: Hex, logIndex: number): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO seen_logs (chain_id, tx_hash, log_index) VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(chainId, txHash.toLowerCase(), logIndex);
    return res.changes > 0;
  }

  // ── gas budget ───────────────────────────────────────────────────────────

  gasSpend(chainId: number, day: string): bigint {
    const row = this.db
      .prepare(`SELECT wei FROM gas_spend WHERE chain_id = ? AND day = ?`)
      .get(chainId, day) as { wei: string } | undefined;
    return row ? BigInt(row.wei) : 0n;
  }

  addGasSpend(chainId: number, day: string, wei: bigint): void {
    const current = this.gasSpend(chainId, day);
    this.db
      .prepare(
        `INSERT INTO gas_spend (chain_id, day, wei) VALUES (?, ?, ?)
         ON CONFLICT(chain_id, day) DO UPDATE SET wei = excluded.wei`,
      )
      .run(chainId, day, (current + wei).toString());
  }
}

/** Column values (already lower-cased / JSON-encoded) for one NewAction. */
interface ActionColumns {
  kind: ActionKind;
  familyId: string;
  signer: string;
  dedupKey: string;
  deadline: string | null;
  signature: Hex;
  nonce: string | null;
  points: string | null;
  recipients: string | null;
  candidate: string | null;
  isAddition: number | null;
  electorate: string | null;
  expiresAt: string | null;
  proposalKey: string | null;
}

const lc = (a: Address): string => a.toLowerCase();
const lcArr = (a: Address[]): string => JSON.stringify(a.map(lc));

/** Map a discriminated NewAction to its persisted column set. */
function normalizeAction(action: NewAction): ActionColumns {
  const familyId = action.familyId.toLowerCase();
  const base = {
    familyId,
    signature: action.signature,
    nonce: null as string | null,
    points: null as string | null,
    recipients: null as string | null,
    candidate: null as string | null,
    isAddition: null as number | null,
    electorate: null as string | null,
    expiresAt: null as string | null,
    proposalKey: null as string | null,
    deadline: null as string | null,
  };
  const kind = action.kind ?? "vote";
  switch (kind) {
    case "vote": {
      const a = action as NewVote;
      return {
        ...base,
        kind: "vote",
        signer: lc(a.voter),
        dedupKey: a.nonce,
        deadline: a.deadline,
        nonce: a.nonce,
        points: JSON.stringify(a.points),
        recipients: lcArr(a.recipients),
      };
    }
    case "registry-update": {
      const a = action as NewRegistryUpdate;
      return {
        ...base,
        kind: "registry-update",
        signer: lc(a.admin),
        dedupKey: a.nonce,
        deadline: a.deadline,
        nonce: a.nonce,
        recipients: lcArr(a.recipients),
      };
    }
    case "proposal": {
      const a = action as NewProposal;
      return {
        ...base,
        kind: "proposal",
        signer: lc(a.proposer),
        dedupKey: a.proposalKey.toLowerCase(),
        nonce: a.nonce,
        candidate: lc(a.candidate),
        isAddition: a.isAddition ? 1 : 0,
        electorate: lcArr(a.electorate),
        expiresAt: a.expiresAt,
        proposalKey: a.proposalKey.toLowerCase(),
      };
    }
    case "proposal-vote": {
      const a = action as NewProposalVote;
      return {
        ...base,
        kind: "proposal-vote",
        signer: lc(a.voter),
        dedupKey: a.proposalKey.toLowerCase(),
        deadline: a.deadline,
        proposalKey: a.proposalKey.toLowerCase(),
      };
    }
  }
}

function toAction(row: RawAction): ActionRow {
  return {
    id: row.id,
    kind: row.kind as ActionKind,
    familyId: row.family_id as Hex,
    signer: row.signer as Address,
    dedupKey: row.dedup_key,
    deadline: row.deadline,
    signature: row.signature as Hex,
    receivedAt: row.received_at,
    nonce: row.nonce,
    points: row.points ? (JSON.parse(row.points) as string[]) : null,
    recipients: row.recipients
      ? (JSON.parse(row.recipients) as Address[])
      : null,
    candidate: row.candidate as Address | null,
    isAddition: row.is_addition === null ? null : row.is_addition !== 0,
    electorate: row.electorate
      ? (JSON.parse(row.electorate) as Address[])
      : null,
    expiresAt: row.expires_at,
    proposalKey: row.proposal_key as Hex | null,
  };
}

function toJob(row: RawJob): JobRow {
  return {
    actionId: row.action_id,
    chainId: row.chain_id,
    state: row.state as JobState,
    txHash: row.tx_hash as Hex | null,
    acctNonce: row.acct_nonce,
    maxFeePerGas: row.max_fee_per_gas,
    maxPriorityFeePerGas: row.max_priority_fee_per_gas,
    submittedBlock: row.submitted_block,
    attempts: row.attempts,
    lastError: row.last_error,
    notBefore: row.not_before,
    updatedAt: row.updated_at,
  };
}
