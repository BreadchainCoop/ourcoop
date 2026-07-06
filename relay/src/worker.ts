import type { Address, Hex } from "viem";
import {
  RevertError,
  resolveTarget,
  type ChainAccess,
  type DeliveryArgs,
} from "./chain-access.js";
import type { GasBudget } from "./gas-budget.js";
import { errorMessage, log, warn } from "./log.js";
import type { NonceManager } from "./nonce-manager.js";
import type {
  ActionRow,
  FamilyInstance,
  JobRow,
  JobState,
  Store,
} from "./store.js";

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
  /** Resolve the full family instance on this chain, or null when absent. The
   *  worker derives the per-kind target (votingModule vs registry) from it. */
  resolveInstance: (
    familyId: ActionRow["familyId"],
  ) => Promise<FamilyInstance | null>;
  timings?: Partial<WorkerTimings>;
  now?: () => number;
}

/**
 * Per-chain worker (spec B.4) — the ONLY sender for its chain. One serialized
 * loop: confirm/reap submitted txs, then process due jobs in order. All state
 * transitions land in the durable store before/after each side effect.
 *
 * Delivery is kind-dispatched: each action (vote / registry-update / proposal /
 * proposal-vote) has its own settlement read + skip-checks + revert
 * classification, but shares one simulate → gas-budget → send → confirm → reap
 * pipeline.
 */
export class ChainWorker {
  readonly chainId: number;
  private readonly name: string;
  private readonly store: Store;
  private readonly access: ChainAccess;
  private readonly nonces: NonceManager;
  private readonly gasBudget: GasBudget;
  private readonly resolveInstance: ChainWorkerDeps["resolveInstance"];
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
    this.resolveInstance = deps.resolveInstance;
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
    const action = this.store.getActionById(job.actionId);
    if (!action) {
      this.transition(job, "failed", { lastError: "action row missing" });
      return;
    }
    try {
      // Expiry check in spec order (deadline for vote/registry-update/
      // proposal-vote, absolute expiresAt for a proposal).
      const nowSec = BigInt(Math.floor(this.now() / 1000));
      if (this.isExpired(action, nowSec)) {
        this.transition(job, "expired", { lastError: null });
        return;
      }

      const instance = await this.resolveInstance(action.familyId);
      if (!instance) {
        this.defer(job, "family instance not resolvable on this chain");
        return;
      }
      const target = resolveTarget(action.kind, instance);

      // Per-kind skip-checks: the chain is the authority; these only save gas
      // and classify terminal / success-class outcomes early.
      const decided = await this.skipChecks(job, action, instance, target);
      if (decided) return;

      const delivery = buildDelivery(action);
      await this.deliver(job, target, delivery);
    } catch (e) {
      this.defer(job, errorMessage(e));
      throw e;
    }
  }

  /** True when the signed action is past its time bound on this chain. */
  private isExpired(action: ActionRow, nowSec: bigint): boolean {
    if (action.deadline !== null && BigInt(action.deadline) < nowSec)
      return true;
    if (action.expiresAt !== null && BigInt(action.expiresAt) < nowSec)
      return true;
    return false;
  }

  /**
   * Per-kind pre-flight. Returns true when it settled the job (no send needed):
   * superseded / skipped_no_power / recipient_mismatch / confirmed / deferred.
   */
  private async skipChecks(
    job: JobRow,
    action: ActionRow,
    instance: FamilyInstance,
    target: Address,
  ): Promise<boolean> {
    switch (action.kind) {
      case "vote": {
        const last = await this.access.lastCrossChainNonce(
          target,
          action.signer,
        );
        if (last >= BigInt(action.nonce!)) {
          // Success-class: this or a newer ballot already landed here.
          this.transition(job, "superseded", { lastError: null });
          return true;
        }
        const power = await this.access.getVotingPower(target, action.signer);
        if (power === 0n) {
          this.transition(job, "skipped_no_power", {
            notBefore: this.now() + this.timings.noPowerRetryMs,
            lastError: "no voting power on this chain (will re-check)",
          });
          return true;
        }
        return false;
      }
      case "registry-update": {
        // On-chain nonce >= signed → superseded. Otherwise DELIVER even when the
        // set already matches: applying burns the nonce and kills older floating
        // signatures. (No "already-equal" skip.)
        const last = await this.access.lastRegistryUpdateNonce(target);
        if (last >= BigInt(action.nonce!)) {
          this.transition(job, "superseded", { lastError: null });
          return true;
        }
        return false;
      }
      case "proposal": {
        // Content-addressed: if the key already exists here, creation landed
        // (by us, a sibling relay, or an on-chain submission) — confirmed.
        const existing = await this.access.getCrossChainProposal(
          target,
          action.proposalKey!,
        );
        if (existing) {
          this.transition(job, "confirmed", { lastError: null });
          return true;
        }
        return false;
      }
      case "proposal-vote": {
        const proposal = await this.access.getCrossChainProposal(
          target,
          action.proposalKey!,
        );
        if (!proposal) {
          // The creation job may not have landed yet — DEFER with backoff,
          // never terminal. (A missing proposal is not a permanent failure.)
          this.defer(job, "proposal not yet on-chain (awaiting creation)");
          return true;
        }
        if (proposal.executed) {
          // Threshold reached (our vote or others') — success-class.
          this.transition(job, "superseded", { lastError: null });
          return true;
        }
        if (
          await this.access.hasVotedCrossChain(
            target,
            action.proposalKey!,
            action.signer,
          )
        ) {
          this.transition(job, "superseded", { lastError: null });
          return true;
        }
        return false;
      }
    }
  }

  /** Shared simulate → gas-budget → send → submitted pipeline. */
  private async deliver(
    job: JobRow,
    target: Address,
    delivery: DeliveryArgs,
  ): Promise<void> {
    let gas: bigint;
    try {
      gas = await this.access.simulate(target, delivery);
    } catch (e) {
      if (e instanceof RevertError) {
        this.applyRevert(job, delivery.kind, e);
        return;
      }
      throw e;
    }

    const fees = await this.access.estimateFees();
    const gasLimit = (gas * 120n) / 100n;
    const cost = gasLimit * fees.maxFeePerGas;
    if (!this.gasBudget.tryReserve(this.chainId, cost, this.now())) {
      this.store.updateJob(
        job.actionId,
        job.chainId,
        {
          lastError: "deferred: daily gas budget exhausted",
          notBefore: this.now() + 60 * 60_000,
        },
        this.now(),
      );
      warn(
        this.name,
        `gas budget exhausted — deferring action ${job.actionId}`,
      );
      return;
    }

    let acctNonce: number;
    let txHash;
    try {
      acctNonce = await this.nonces.allocate();
      txHash = await this.access.send(target, delivery, {
        nonce: acctNonce,
        gas: gasLimit,
        ...fees,
      });
    } catch (e) {
      // The send never landed — no gas was burned, so give the reservation
      // back. Otherwise repeated failures inflate phantom spend until the
      // breaker defers everything for the rest of the day.
      this.gasBudget.release(this.chainId, cost, this.now());
      // The account nonce may now be gapped — refetch before the next send.
      this.nonces.reset();
      const revert = e instanceof RevertError ? e : null;
      if (revert) {
        this.applyRevert(job, delivery.kind, revert);
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
    log(this.name, `submitted ${delivery.kind} ${job.actionId}`, {
      txHash,
      acctNonce,
    });
  }

  /** Map a decoded revert to a job state (spec B.4), per delivery kind. */
  private applyRevert(
    job: JobRow,
    kind: ActionRow["kind"],
    e: RevertError,
  ): void {
    // Shared success/expiry-class reverts across kinds.
    switch (e.errorName) {
      case "SignatureExpired":
      case "ProposalExpired":
      case "ExpiryTooFar":
        this.transition(job, "expired", { lastError: null });
        return;
      case "RecipientSetMismatch":
        this.transition(job, "recipient_mismatch", {
          notBefore: this.now() + this.timings.mismatchRetryMs,
          lastError: "recipient list out of sync on this chain (will re-check)",
        });
        return;
    }

    switch (kind) {
      case "vote": {
        if (e.errorName === "StaleNonce") {
          // A newer ballot landed first — success-class.
          this.transition(job, "superseded", { lastError: null });
          return;
        }
        if (e.errorName === "ZeroVotingPower") {
          this.transition(job, "skipped_no_power", {
            notBefore: this.now() + this.timings.noPowerRetryMs,
            lastError: "no voting power on this chain (will re-check)",
          });
          return;
        }
        break;
      }
      case "registry-update": {
        if (e.errorName === "StaleNonce") {
          // A newer (or equal) desired-set update already burned this nonce.
          this.transition(job, "superseded", { lastError: null });
          return;
        }
        break;
      }
      case "proposal": {
        // The key already exists here (created by us, a sibling, or on-chain).
        if (e.errorName === "ProposalAlreadyExists") {
          this.transition(job, "superseded", { lastError: null });
          return;
        }
        break;
      }
      case "proposal-vote": {
        // Already counted here, or the proposal already executed — success-class.
        if (
          e.errorName === "AlreadyVoted" ||
          e.errorName === "ProposalAlreadyExecuted"
        ) {
          this.transition(job, "superseded", { lastError: null });
          return;
        }
        // The creation tx may still be in flight — DEFER, never terminal.
        if (e.errorName === "ProposalNotFound") {
          this.defer(job, "proposal not yet on-chain (awaiting creation)");
          return;
        }
        break;
      }
    }
    this.transition(job, "failed", { lastError: e.errorName });
  }

  /** Transient failure: keep the state, back off exponentially. Never drops. */
  private defer(job: JobRow, reason: string): void {
    const attempts = job.attempts + 1;
    const backoff = Math.min(
      this.timings.backoffBaseMs * 2 ** Math.min(attempts, 10),
      this.timings.backoffMaxMs,
    );
    this.store.updateJob(
      job.actionId,
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
      job.actionId,
      job.chainId,
      { state, ...patch },
      this.now(),
    );
    log(this.name, `action ${job.actionId}: ${job.state} -> ${state}`);
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

  /**
   * On-chain revert without a decoded error: re-derive success-class outcomes
   * from settlement reads per kind (a racing delivery may have won). Everything
   * else is failed.
   */
  private async classifyRevertedReceipt(job: JobRow): Promise<void> {
    const action = this.store.getActionById(job.actionId);
    if (action) {
      const settled = await this.isSettled(action).catch(() => false);
      if (settled) {
        this.transition(job, "superseded", { lastError: null });
        return;
      }
    }
    this.transition(job, "failed", { lastError: "transaction reverted" });
  }

  /** Per-kind "did the intended effect already land here?" settlement read. */
  private async isSettled(action: ActionRow): Promise<boolean> {
    const instance = await this.resolveInstance(action.familyId).catch(
      () => null,
    );
    if (!instance) return false;
    const target = resolveTarget(action.kind, instance);
    switch (action.kind) {
      case "vote": {
        const last = await this.access.lastCrossChainNonce(
          target,
          action.signer,
        );
        return last >= BigInt(action.nonce!);
      }
      case "registry-update": {
        const last = await this.access.lastRegistryUpdateNonce(target);
        return last >= BigInt(action.nonce!);
      }
      case "proposal": {
        const existing = await this.access.getCrossChainProposal(
          target,
          action.proposalKey!,
        );
        return existing !== undefined;
      }
      case "proposal-vote": {
        const proposal = await this.access.getCrossChainProposal(
          target,
          action.proposalKey!,
        );
        if (proposal?.executed) return true;
        return this.access.hasVotedCrossChain(
          target,
          action.proposalKey!,
          action.signer,
        );
      }
    }
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
    const action = this.store.getActionById(job.actionId);
    if (!action) return;
    const instance = await this.resolveInstance(action.familyId);
    if (!instance) return;
    const target = resolveTarget(action.kind, instance);
    const delivery = buildDelivery(action);

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

    let gas: bigint;
    try {
      gas = await this.access.simulate(target, delivery);
    } catch (e) {
      // Record the attempt (bump updated_at) so the rate limit applies, then
      // let the next confirm pass settle via receipt / settlement read.
      this.markRebroadcastAttempt(job, `rebroadcast simulate failed`);
      warn(
        this.name,
        `rebroadcast simulate failed for action ${job.actionId}`,
        {
          error: errorMessage(e),
        },
      );
      return;
    }
    const gasLimit = (gas * 120n) / 100n;
    const cost = gasLimit * fees.maxFeePerGas;
    // Rebroadcasts spend real gas too — reserve against the daily budget. When
    // the breaker is open, defer (record the attempt so we back off).
    if (!this.gasBudget.tryReserve(this.chainId, cost, this.now())) {
      this.markRebroadcastAttempt(job, "rebroadcast deferred: gas budget");
      warn(
        this.name,
        `rebroadcast deferred (budget) for action ${job.actionId}`,
      );
      return;
    }
    try {
      const txHash = await this.access.send(target, delivery, {
        nonce: job.acctNonce,
        gas: gasLimit,
        ...fees,
      });
      this.store.updateJob(
        job.actionId,
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
      log(this.name, `rebroadcast action ${job.actionId}`, { txHash });
    } catch (e) {
      // The rebroadcast never landed — refund the reservation. "nonce too low"
      // usually means the original tx just mined; the next confirm pass settles
      // it via the receipt / settlement read.
      this.gasBudget.release(this.chainId, cost, this.now());
      this.markRebroadcastAttempt(job, "rebroadcast send failed");
      warn(this.name, `rebroadcast failed for action ${job.actionId}`, {
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
      job.actionId,
      job.chainId,
      { lastError: reason },
      this.now(),
    );
  }
}

/** Build the kind-tagged delivery args from a stored action row. */
export function buildDelivery(action: ActionRow): DeliveryArgs {
  switch (action.kind) {
    case "vote":
      return {
        kind: "vote",
        args: {
          voter: action.signer,
          points: action.points!.map(BigInt),
          recipients: action.recipients!,
          nonce: BigInt(action.nonce!),
          deadline: BigInt(action.deadline!),
          signature: action.signature,
        },
      };
    case "registry-update":
      return {
        kind: "registry-update",
        args: {
          admin: action.signer,
          recipients: action.recipients!,
          nonce: BigInt(action.nonce!),
          deadline: BigInt(action.deadline!),
          signature: action.signature,
        },
      };
    case "proposal":
      return {
        kind: "proposal",
        args: {
          proposer: action.signer,
          candidate: action.candidate!,
          isAddition: action.isAddition!,
          electorate: action.electorate!,
          expiresAt: BigInt(action.expiresAt!),
          nonce: BigInt(action.nonce!),
          signature: action.signature,
        },
      };
    case "proposal-vote":
      return {
        kind: "proposal-vote",
        args: {
          voter: action.signer,
          proposalKey: action.proposalKey! as Hex,
          deadline: BigInt(action.deadline!),
          signature: action.signature,
        },
      };
  }
}
