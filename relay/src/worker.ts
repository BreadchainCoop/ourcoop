import type { Address } from "viem";
import {
  RevertError,
  type CastVoteArgs,
  type ChainAccess,
} from "./chain-access.js";
import type { GasBudget } from "./gas-budget.js";
import { errorMessage, log, warn } from "./log.js";
import type { NonceManager } from "./nonce-manager.js";
import type { JobRow, JobState, Store, VoteRow } from "./store.js";

export interface WorkerTimings {
  pollIntervalMs: number;
  /** skipped_no_power re-check cadence (spec: max every 30 min). */
  noPowerRetryMs: number;
  /** recipient_mismatch long backoff. */
  mismatchRetryMs: number;
  /** Base for exponential deferral backoff on transient errors. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Rebroadcast a submitted tx unmined for more than this many blocks. */
  stuckBlocks: bigint;
  /** Minimum wall-clock gap between rebroadcast attempts for one tx, so a tx
   *  that keeps failing to rebroadcast can't be retried every poll pass. */
  rebroadcastMinIntervalMs: number;
  /** Hard ceiling on a rebroadcast's fees as a multiple of a FRESH estimate —
   *  caps the compounding +25% bumps so a stuck tx can't drain the key. */
  maxRebroadcastFeeMultiple: bigint;
  /** RPC-down circuit breaker: consecutive errors before pausing. */
  breakerThreshold: number;
  breakerPauseMs: number;
}

export const DEFAULT_TIMINGS: WorkerTimings = {
  pollIntervalMs: 3_000,
  noPowerRetryMs: 30 * 60_000,
  mismatchRetryMs: 30 * 60_000,
  backoffBaseMs: 5_000,
  backoffMaxMs: 10 * 60_000,
  stuckBlocks: 10n,
  rebroadcastMinIntervalMs: 30_000,
  maxRebroadcastFeeMultiple: 3n,
  breakerThreshold: 5,
  breakerPauseMs: 30_000,
};

export interface ChainWorkerDeps {
  chainId: number;
  chainName: string;
  store: Store;
  access: ChainAccess;
  nonces: NonceManager;
  gasBudget: GasBudget;
  resolveVotingModule: (
    familyId: VoteRow["familyId"],
  ) => Promise<Address | null>;
  timings?: Partial<WorkerTimings>;
  now?: () => number;
}

/**
 * Per-chain worker (spec B.4) — the ONLY sender for its chain. One serialized
 * loop: confirm/reap submitted txs, then process due jobs in order. All state
 * transitions land in the durable store before/after each side effect.
 */
export class ChainWorker {
  readonly chainId: number;
  private readonly name: string;
  private readonly store: Store;
  private readonly access: ChainAccess;
  private readonly nonces: NonceManager;
  private readonly gasBudget: GasBudget;
  private readonly resolveVotingModule: ChainWorkerDeps["resolveVotingModule"];
  private readonly timings: WorkerTimings;
  private readonly now: () => number;

  private running = false;
  private stopped = Promise.resolve();
  private wake: (() => void) | null = null;
  private consecutiveErrors = 0;

  constructor(deps: ChainWorkerDeps) {
    this.chainId = deps.chainId;
    this.name = deps.chainName;
    this.store = deps.store;
    this.access = deps.access;
    this.nonces = deps.nonces;
    this.gasBudget = deps.gasBudget;
    this.resolveVotingModule = deps.resolveVotingModule;
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.kick();
    await this.stopped;
  }

  /** Wake the loop early (e.g. a fresh POST just enqueued a job). */
  kick(): void {
    this.wake?.();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runOnce();
        this.consecutiveErrors = 0;
      } catch (e) {
        this.consecutiveErrors++;
        warn(this.name, `worker pass failed`, { error: errorMessage(e) });
      }
      const pause =
        this.consecutiveErrors >= this.timings.breakerThreshold
          ? this.timings.breakerPauseMs
          : this.timings.pollIntervalMs;
      if (this.consecutiveErrors >= this.timings.breakerThreshold) {
        warn(this.name, `circuit breaker open — pausing ${pause}ms`);
      }
      await this.sleep(pause);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      this.wake = done;
      function done() {
        clearTimeout(t);
        resolve();
      }
    });
  }

  /** One full pass: confirm submitted, then process due jobs. Public for tests. */
  async runOnce(): Promise<void> {
    await this.confirmSubmitted();
    const due = this.store.dueJobs(this.chainId, this.now());
    for (const job of due) {
      await this.processJob(job);
    }
  }

  // ── delivery ─────────────────────────────────────────────────────────────

  private async processJob(job: JobRow): Promise<void> {
    const vote = this.store.getVoteById(job.voteId);
    if (!vote) {
      this.transition(job, "failed", { lastError: "vote row missing" });
      return;
    }
    try {
      // Skip-checks in spec order. The chain is the authority; these only
      // save gas and classify terminal outcomes.
      const nowSec = BigInt(Math.floor(this.now() / 1000));
      if (BigInt(vote.deadline) < nowSec) {
        this.transition(job, "expired", { lastError: null });
        return;
      }

      const votingModule = await this.resolveVotingModule(vote.familyId);
      if (!votingModule) {
        this.defer(job, "family instance not resolvable on this chain");
        return;
      }

      const last = await this.access.lastCrossChainNonce(
        votingModule,
        vote.voter,
      );
      if (last >= BigInt(vote.nonce)) {
        // Success-class: this or a newer ballot already landed here.
        this.transition(job, "superseded", { lastError: null });
        return;
      }

      const power = await this.access.getVotingPower(votingModule, vote.voter);
      if (power === 0n) {
        this.transition(job, "skipped_no_power", {
          notBefore: this.now() + this.timings.noPowerRetryMs,
          lastError: "no voting power on this chain (will re-check)",
        });
        return;
      }

      const args: CastVoteArgs = {
        voter: vote.voter,
        points: vote.points.map(BigInt),
        recipients: vote.recipients,
        nonce: BigInt(vote.nonce),
        deadline: BigInt(vote.deadline),
        signature: vote.signature,
      };

      let gas: bigint;
      try {
        gas = await this.access.simulateCastVote(votingModule, args);
      } catch (e) {
        if (e instanceof RevertError) {
          this.applyRevert(job, e);
          return;
        }
        throw e;
      }

      const fees = await this.access.estimateFees();
      const gasLimit = (gas * 120n) / 100n;
      const cost = gasLimit * fees.maxFeePerGas;
      if (!this.gasBudget.tryReserve(this.chainId, cost, this.now())) {
        this.store.updateJob(
          job.voteId,
          job.chainId,
          {
            lastError: "deferred: daily gas budget exhausted",
            notBefore: this.now() + 60 * 60_000,
          },
          this.now(),
        );
        warn(this.name, `gas budget exhausted — deferring vote ${job.voteId}`);
        return;
      }

      let acctNonce: number;
      let txHash;
      try {
        acctNonce = await this.nonces.allocate();
        txHash = await this.access.sendCastVote(votingModule, args, {
          nonce: acctNonce,
          gas: gasLimit,
          ...fees,
        });
      } catch (e) {
        // The send never landed — no gas was burned, so give the reservation
        // back. Otherwise repeated failures inflate phantom spend until the
        // breaker defers every vote for the rest of the day.
        this.gasBudget.release(this.chainId, cost, this.now());
        // The account nonce may now be gapped — refetch before the next send.
        this.nonces.reset();
        const revert = e instanceof RevertError ? e : null;
        if (revert) {
          this.applyRevert(job, revert);
          return;
        }
        throw e;
      }

      const head = await this.access.getBlockNumber().catch(() => null);
      this.transition(job, "submitted", {
        txHash,
        acctNonce,
        maxFeePerGas: fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
        submittedBlock: head === null ? null : head.toString(),
        lastError: null,
      });
      log(this.name, `submitted vote ${job.voteId}`, { txHash, acctNonce });
    } catch (e) {
      this.defer(job, errorMessage(e));
      throw e;
    }
  }

  /** Map a decoded revert to a job state (spec B.4). */
  private applyRevert(job: JobRow, e: RevertError): void {
    switch (e.errorName) {
      case "StaleNonce":
        // Success-class: a newer ballot landed first.
        this.transition(job, "superseded", { lastError: null });
        return;
      case "SignatureExpired":
        this.transition(job, "expired", { lastError: null });
        return;
      case "RecipientSetMismatch":
        this.transition(job, "recipient_mismatch", {
          notBefore: this.now() + this.timings.mismatchRetryMs,
          lastError: "recipient list out of sync on this chain (will re-check)",
        });
        return;
      case "ZeroVotingPower":
        this.transition(job, "skipped_no_power", {
          notBefore: this.now() + this.timings.noPowerRetryMs,
          lastError: "no voting power on this chain (will re-check)",
        });
        return;
      default:
        this.transition(job, "failed", { lastError: e.errorName });
    }
  }

  /** Transient failure: keep the state, back off exponentially. Never drops. */
  private defer(job: JobRow, reason: string): void {
    const attempts = job.attempts + 1;
    const backoff = Math.min(
      this.timings.backoffBaseMs * 2 ** Math.min(attempts, 10),
      this.timings.backoffMaxMs,
    );
    this.store.updateJob(
      job.voteId,
      job.chainId,
      {
        attempts,
        lastError: `deferred: ${reason}`,
        notBefore: this.now() + backoff,
      },
      this.now(),
    );
  }

  private transition(
    job: JobRow,
    state: JobState,
    patch: Parameters<Store["updateJob"]>[2] = {},
  ): void {
    this.store.updateJob(
      job.voteId,
      job.chainId,
      { state, ...patch },
      this.now(),
    );
    log(this.name, `vote ${job.voteId}: ${job.state} -> ${state}`);
  }

  // ── confirmation + stuck-tx reaper ───────────────────────────────────────

  private async confirmSubmitted(): Promise<void> {
    const submitted = this.store.submittedJobs(this.chainId);
    if (submitted.length === 0) return;
    let head: bigint | null = null;
    for (const job of submitted) {
      if (!job.txHash) {
        this.transition(job, "failed", {
          lastError: "submitted without txHash",
        });
        continue;
      }
      const receipt = await this.access.getReceipt(job.txHash);
      if (receipt) {
        if (receipt.status === "success") {
          this.transition(job, "confirmed", { lastError: null });
        } else {
          await this.classifyRevertedReceipt(job);
        }
        continue;
      }
      head ??= await this.access.getBlockNumber();
      await this.reapIfStuck(job, head);
    }
  }

  /** On-chain revert without a decoded error: StaleNonce-shaped outcomes are
   *  success-class, everything else is failed. */
  private async classifyRevertedReceipt(job: JobRow): Promise<void> {
    const vote = this.store.getVoteById(job.voteId);
    if (vote) {
      const votingModule = await this.resolveVotingModule(vote.familyId).catch(
        () => null,
      );
      if (votingModule) {
        const last = await this.access
          .lastCrossChainNonce(votingModule, vote.voter)
          .catch(() => null);
        if (last !== null && last >= BigInt(vote.nonce)) {
          this.transition(job, "superseded", { lastError: null });
          return;
        }
      }
    }
    this.transition(job, "failed", { lastError: "transaction reverted" });
  }

  /** Fee-bump rebroadcast on the SAME account nonce when unmined too long. */
  private async reapIfStuck(job: JobRow, head: bigint): Promise<void> {
    if (job.acctNonce === null) return;
    if (!this.isStuck(job, head)) return;
    // Rate-limit: one rebroadcast attempt per stuck window. Every attempt
    // (success OR failure) bumps updated_at, so a tx that keeps failing to
    // rebroadcast is retried on this cadence, not every ~3s poll pass.
    if (this.now() - job.updatedAt < this.timings.rebroadcastMinIntervalMs)
      return;
    const vote = this.store.getVoteById(job.voteId);
    if (!vote) return;
    const votingModule = await this.resolveVotingModule(vote.familyId);
    if (!votingModule) return;

    const fresh = await this.access.estimateFees();
    // Bump +25% over the previous cap, floored at a fresh estimate and CEILED
    // at a fixed multiple of that fresh estimate — the ceiling stops the
    // compounding bumps from draining the key over a long stuck window.
    const mult = this.timings.maxRebroadcastFeeMultiple;
    const cap = (v: string | null, floor: bigint): bigint => {
      const prev = v === null ? 0n : BigInt(v);
      const bumped = (prev * 125n) / 100n + 1n;
      const ceil = floor * mult;
      const withFloor = bumped > floor ? bumped : floor;
      return withFloor > ceil ? ceil : withFloor;
    };
    const fees = {
      maxFeePerGas: cap(job.maxFeePerGas, fresh.maxFeePerGas),
      maxPriorityFeePerGas: cap(
        job.maxPriorityFeePerGas,
        fresh.maxPriorityFeePerGas,
      ),
    };
    const args: CastVoteArgs = {
      voter: vote.voter,
      points: vote.points.map(BigInt),
      recipients: vote.recipients,
      nonce: BigInt(vote.nonce),
      deadline: BigInt(vote.deadline),
      signature: vote.signature,
    };

    let gas: bigint;
    try {
      gas = await this.access.simulateCastVote(votingModule, args);
    } catch (e) {
      // Record the attempt (bump updated_at) so the rate limit applies, then
      // let the next confirm pass settle via receipt / lastCrossChainNonce.
      this.markRebroadcastAttempt(job, `rebroadcast simulate failed`);
      warn(this.name, `rebroadcast simulate failed for vote ${job.voteId}`, {
        error: errorMessage(e),
      });
      return;
    }
    const gasLimit = (gas * 120n) / 100n;
    const cost = gasLimit * fees.maxFeePerGas;
    // Rebroadcasts spend real gas too — reserve against the daily budget. When
    // the breaker is open, defer (record the attempt so we back off).
    if (!this.gasBudget.tryReserve(this.chainId, cost, this.now())) {
      this.markRebroadcastAttempt(job, "rebroadcast deferred: gas budget");
      warn(this.name, `rebroadcast deferred (budget) for vote ${job.voteId}`);
      return;
    }
    try {
      const txHash = await this.access.sendCastVote(votingModule, args, {
        nonce: job.acctNonce,
        gas: gasLimit,
        ...fees,
      });
      this.store.updateJob(
        job.voteId,
        job.chainId,
        {
          txHash,
          maxFeePerGas: fees.maxFeePerGas.toString(),
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
          submittedBlock: head.toString(),
          lastError: "rebroadcast with bumped fees",
        },
        this.now(),
      );
      log(this.name, `rebroadcast vote ${job.voteId}`, { txHash });
    } catch (e) {
      // The rebroadcast never landed — refund the reservation. "nonce too low"
      // usually means the original tx just mined; the next confirm pass settles
      // it via the receipt / lastCrossChainNonce.
      this.gasBudget.release(this.chainId, cost, this.now());
      this.markRebroadcastAttempt(job, "rebroadcast send failed");
      warn(this.name, `rebroadcast failed for vote ${job.voteId}`, {
        error: errorMessage(e),
      });
    }
  }

  /** A submitted tx is stuck when it has sat unmined past `stuckBlocks`. When
   *  its submittedBlock is null (the post-send getBlockNumber failed), fall
   *  back to a time-based check so a dropped tx isn't wedged forever. */
  private isStuck(job: JobRow, head: bigint): boolean {
    if (job.submittedBlock !== null) {
      return head - BigInt(job.submittedBlock) > this.timings.stuckBlocks;
    }
    return this.now() - job.updatedAt >= this.timings.rebroadcastMinIntervalMs;
  }

  /** Persist a rebroadcast attempt without changing state — bumps updated_at so
   *  the rate limit engages even when nothing was actually sent. */
  private markRebroadcastAttempt(job: JobRow, reason: string): void {
    this.store.updateJob(
      job.voteId,
      job.chainId,
      { lastError: reason },
      this.now(),
    );
  }
}
