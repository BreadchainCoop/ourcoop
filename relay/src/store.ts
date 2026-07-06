import Database from "better-sqlite3";
import type { Address, Hex } from "viem";

/**
 * Durable store (SQLite, WAL). This is the correctness boundary: a vote+jobs
 * row set is written BEFORE any submission, so double POSTs, listener replays
 * and NonceAlreadyUsed-style races collapse onto UNIQUE constraints here —
 * never onto pre-checks.
 */

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

export interface VoteRow {
  id: number;
  familyId: Hex;
  voter: Address;
  nonce: string;
  deadline: string;
  points: string[];
  recipients: Address[];
  signature: Hex;
  receivedAt: number;
}

export interface JobRow {
  voteId: number;
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

export interface NewVote {
  familyId: Hex;
  voter: Address;
  nonce: string;
  deadline: string;
  points: string[];
  recipients: Address[];
  signature: Hex;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id TEXT NOT NULL,
  voter TEXT NOT NULL,
  nonce TEXT NOT NULL,
  deadline TEXT NOT NULL,
  points TEXT NOT NULL,
  recipients TEXT NOT NULL,
  signature TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE(family_id, voter, nonce)
);
CREATE TABLE IF NOT EXISTS jobs (
  vote_id INTEGER NOT NULL REFERENCES votes(id),
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
  PRIMARY KEY (vote_id, chain_id)
);
CREATE INDEX IF NOT EXISTS jobs_chain_state ON jobs(chain_id, state);
CREATE TABLE IF NOT EXISTS family_cache (
  family_id TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  instance TEXT,
  voting_module TEXT,
  resolved_at INTEGER NOT NULL,
  PRIMARY KEY (family_id, chain_id)
);
CREATE INDEX IF NOT EXISTS family_cache_module ON family_cache(chain_id, voting_module);
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

interface RawVote {
  id: number;
  family_id: string;
  voter: string;
  nonce: string;
  deadline: string;
  points: string;
  recipients: string;
  signature: string;
  received_at: number;
}

interface RawJob {
  vote_id: number;
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
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ── votes ────────────────────────────────────────────────────────────────

  /** Insert-or-return-existing; idempotent on (familyId, voter, nonce). */
  upsertVote(
    vote: NewVote,
    now = Date.now(),
  ): { id: number; created: boolean } {
    const inserted = this.db
      .prepare(
        `INSERT INTO votes (family_id, voter, nonce, deadline, points, recipients, signature, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(family_id, voter, nonce) DO NOTHING`,
      )
      .run(
        vote.familyId.toLowerCase(),
        vote.voter.toLowerCase(),
        vote.nonce,
        vote.deadline,
        JSON.stringify(vote.points),
        JSON.stringify(vote.recipients.map((r) => r.toLowerCase())),
        vote.signature,
        now,
      );
    const row = this.db
      .prepare(
        `SELECT id FROM votes WHERE family_id = ? AND voter = ? AND nonce = ?`,
      )
      .get(
        vote.familyId.toLowerCase(),
        vote.voter.toLowerCase(),
        vote.nonce,
      ) as { id: number } | undefined;
    if (!row) throw new Error("vote upsert failed");
    return { id: row.id, created: inserted.changes > 0 };
  }

  getVote(familyId: Hex, voter: Address, nonce: string): VoteRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM votes WHERE family_id = ? AND voter = ? AND nonce = ?`,
      )
      .get(familyId.toLowerCase(), voter.toLowerCase(), nonce) as
      RawVote | undefined;
    return row ? toVote(row) : undefined;
  }

  getVoteById(id: number): VoteRow | undefined {
    const row = this.db.prepare(`SELECT * FROM votes WHERE id = ?`).get(id) as
      RawVote | undefined;
    return row ? toVote(row) : undefined;
  }

  /** Votes of a family whose deadline (seconds) is still in the future. */
  unexpiredVotes(familyId: Hex, nowSec: number): VoteRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM votes WHERE family_id = ? AND CAST(deadline AS INTEGER) >= ?`,
      )
      .all(familyId.toLowerCase(), nowSec) as RawVote[];
    return rows.map(toVote);
  }

  // ── jobs ─────────────────────────────────────────────────────────────────

  /** Create the job if absent (pending). Returns true when newly created. */
  ensureJob(voteId: number, chainId: number, now = Date.now()): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO jobs (vote_id, chain_id, state, updated_at)
         VALUES (?, ?, 'pending', ?)
         ON CONFLICT(vote_id, chain_id) DO NOTHING`,
      )
      .run(voteId, chainId, now);
    return res.changes > 0;
  }

  getJob(voteId: number, chainId: number): JobRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE vote_id = ? AND chain_id = ?`)
      .get(voteId, chainId) as RawJob | undefined;
    return row ? toJob(row) : undefined;
  }

  jobsForVote(voteId: number): JobRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE vote_id = ? ORDER BY chain_id`)
      .all(voteId) as RawJob[];
    return rows.map(toJob);
  }

  updateJob(
    voteId: number,
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
    values.push(voteId, chainId);
    this.db
      .prepare(
        `UPDATE jobs SET ${sets.join(", ")} WHERE vote_id = ? AND chain_id = ?`,
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
        `INSERT INTO family_cache (family_id, chain_id, instance, voting_module, resolved_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(family_id, chain_id) DO UPDATE SET
           instance = excluded.instance,
           voting_module = excluded.voting_module,
           resolved_at = excluded.resolved_at`,
      )
      .run(
        familyId.toLowerCase(),
        chainId,
        instance ? JSON.stringify(instance) : null,
        instance ? instance.votingModule.toLowerCase() : null,
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

  knownVotingModules(chainId: number): Address[] {
    const rows = this.db
      .prepare(
        `SELECT voting_module FROM family_cache
         WHERE chain_id = ? AND voting_module IS NOT NULL`,
      )
      .all(chainId) as { voting_module: string }[];
    return rows.map((r) => r.voting_module as Address);
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

function toVote(row: RawVote): VoteRow {
  return {
    id: row.id,
    familyId: row.family_id as Hex,
    voter: row.voter as Address,
    nonce: row.nonce,
    deadline: row.deadline,
    points: JSON.parse(row.points) as string[],
    recipients: JSON.parse(row.recipients) as Address[],
    signature: row.signature as Hex,
    receivedAt: row.received_at,
  };
}

function toJob(row: RawJob): JobRow {
  return {
    voteId: row.vote_id,
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
