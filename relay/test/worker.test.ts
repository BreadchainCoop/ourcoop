import type { Address, Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import {
  RevertError,
  type CastVoteArgs,
  type ChainAccess,
  type FeeEstimate,
  type Receipt,
} from "../src/chain-access.js";
import { GasBudget, dayKey } from "../src/gas-budget.js";
import { NonceManager } from "../src/nonce-manager.js";
import { Store, type JobState } from "../src/store.js";
import { ChainWorker } from "../src/worker.js";

const CHAIN = 100;
const familyId = ("0x" + "ab".repeat(32)) as Hex;
const voter = "0x1111111111111111111111111111111111111111" as Address;
const votingModule = "0x0000000000000000000000000000000000000011" as Address;
const FAR_DEADLINE = "4102444800"; // year 2100
const NOW = 1_700_000_000_000; // fixed clock (ms)

/**
 * Fake ChainAccess: every call is a knob so the worker's state machine
 * (spec section 3 / B.4) can be exercised without a chain.
 */
class FakeAccess implements ChainAccess {
  head = 1000n;
  balance = 10n ** 18n;
  pendingCount = 0;
  lastNonce = 0n;
  votingPower = 100n;
  simulateGas: bigint | RevertError = 21_000n;
  sendResult: Hex | RevertError | Error = ("0x" + "aa".repeat(32)) as Hex;
  receipt: Receipt | null = null;
  fees: FeeEstimate = {
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1n,
  };
  sends = 0;
  /** Fees each send was submitted with — lets tests assert the reaper's cap. */
  sentFees: FeeEstimate[] = [];

  getBlockNumber(): Promise<bigint> {
    return Promise.resolve(this.head);
  }
  getBalance(): Promise<bigint> {
    return Promise.resolve(this.balance);
  }
  getPendingTransactionCount(): Promise<number> {
    return Promise.resolve(this.pendingCount);
  }
  familyInstances(): Promise<null> {
    return Promise.resolve(null);
  }
  readFamilyId(): Promise<Hex> {
    return Promise.resolve(familyId);
  }
  lastCrossChainNonce(): Promise<bigint> {
    return Promise.resolve(this.lastNonce);
  }
  getVotingPower(): Promise<bigint> {
    return Promise.resolve(this.votingPower);
  }
  simulateCastVote(): Promise<bigint> {
    if (this.simulateGas instanceof RevertError)
      return Promise.reject(this.simulateGas);
    return Promise.resolve(this.simulateGas);
  }
  sendCastVote(
    _m: Address,
    _a: CastVoteArgs,
    opts: { nonce: number; gas: bigint } & FeeEstimate,
  ): Promise<Hex> {
    this.sends++;
    this.sentFees.push({
      maxFeePerGas: opts.maxFeePerGas,
      maxPriorityFeePerGas: opts.maxPriorityFeePerGas,
    });
    if (this.sendResult instanceof Error)
      return Promise.reject(this.sendResult);
    return Promise.resolve(this.sendResult);
  }
  getReceipt(): Promise<Receipt | null> {
    return Promise.resolve(this.receipt);
  }
  estimateFees(): Promise<FeeEstimate> {
    return Promise.resolve(this.fees);
  }
}

function makeWorker(
  access: FakeAccess,
  module: Address | null = votingModule,
  opts: {
    budgetWei?: bigint;
    now?: () => number;
    timings?: ConstructorParameters<typeof ChainWorker>[0]["timings"];
  } = {},
) {
  const store = new Store(":memory:");
  const gasBudget = new GasBudget(
    store,
    new Map([[CHAIN, opts.budgetWei ?? 10n ** 20n]]),
  );
  const worker = new ChainWorker({
    chainId: CHAIN,
    chainName: "test",
    store,
    access,
    nonces: new NonceManager(() => access.getPendingTransactionCount()),
    gasBudget,
    resolveVotingModule: () => Promise.resolve(module),
    now: opts.now ?? (() => NOW),
    timings: opts.timings,
  });
  return { store, worker, gasBudget };
}

function enqueue(
  store: Store,
  overrides: Partial<{ nonce: string; deadline: string }> = {},
) {
  const { id } = store.upsertVote({
    familyId,
    voter,
    nonce: overrides.nonce ?? "5",
    deadline: overrides.deadline ?? FAR_DEADLINE,
    points: ["6000", "4000"],
    recipients: [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ] as Address[],
    signature: ("0x" + "11".repeat(65)) as Hex,
  });
  store.ensureJob(id, CHAIN, NOW - 1);
  return id;
}

function stateOf(store: Store, id: number): JobState | undefined {
  return store.getJob(id, CHAIN)?.state;
}

describe("ChainWorker state machine (spec section 3 / B.4)", () => {
  let access: FakeAccess;
  beforeEach(() => {
    access = new FakeAccess();
  });

  it("pending -> submitted -> confirmed on the happy path", async () => {
    const { store, worker } = makeWorker(access);
    const id = enqueue(store);

    await worker.runOnce();
    expect(stateOf(store, id)).toBe("submitted");
    expect(store.getJob(id, CHAIN)?.txHash).toBe(access.sendResult);
    expect(store.getJob(id, CHAIN)?.acctNonce).toBe(0);

    access.receipt = {
      status: "success",
      blockNumber: 1001n,
      gasUsed: 21_000n,
      effectiveGasPrice: 1n,
    };
    await worker.runOnce();
    expect(stateOf(store, id)).toBe("confirmed");
  });

  it("expired: deadline in the past -> terminal expired, never sends", async () => {
    const { store, worker } = makeWorker(access);
    const id = enqueue(store, {
      deadline: String(Math.floor(NOW / 1000) - 10),
    });
    await worker.runOnce();
    expect(stateOf(store, id)).toBe("expired");
    expect(access.sends).toBe(0);
  });

  it("superseded: a newer nonce already landed -> success-class, never sends", async () => {
    const { store, worker } = makeWorker(access);
    const id = enqueue(store, { nonce: "5" });
    access.lastNonce = 7n; // a later ballot landed here
    await worker.runOnce();
    expect(stateOf(store, id)).toBe("superseded");
    expect(access.sends).toBe(0);
  });

  it("skipped_no_power: zero power -> re-queued with backoff while deadline valid", async () => {
    const { store, worker } = makeWorker(access);
    const id = enqueue(store);
    access.votingPower = 0n;
    await worker.runOnce();
    expect(stateOf(store, id)).toBe("skipped_no_power");
    expect(access.sends).toBe(0);
    const job = store.getJob(id, CHAIN);
    expect(job?.notBefore).toBeGreaterThan(NOW); // backoff set
    // Still retryable (not terminal) so power can be re-checked later.
    expect(store.dueJobs(CHAIN, job!.notBefore + 1)).toHaveLength(1);
  });

  it("StaleNonce revert on simulate -> superseded (success-class)", async () => {
    const { store, worker } = makeWorker(access);
    const id = enqueue(store);
    access.simulateGas = new RevertError("StaleNonce");
    await worker.runOnce();
    expect(stateOf(store, id)).toBe("superseded");
    expect(access.sends).toBe(0);
  });

  it("RecipientSetMismatch revert -> recipient_mismatch, retryable with long backoff", async () => {
    const { store, worker } = makeWorker(access);
    const id = enqueue(store);
    access.simulateGas = new RevertError("RecipientSetMismatch");
    await worker.runOnce();
    expect(stateOf(store, id)).toBe("recipient_mismatch");
    const job = store.getJob(id, CHAIN);
    expect(job?.notBefore).toBeGreaterThan(NOW);
    expect(store.dueJobs(CHAIN, job!.notBefore + 1)).toHaveLength(1);
  });

  it("unknown revert -> failed (terminal) with the decoded error name", async () => {
    const { store, worker } = makeWorker(access);
    const id = enqueue(store);
    access.simulateGas = new RevertError("SomethingElse");
    await worker.runOnce();
    expect(stateOf(store, id)).toBe("failed");
    expect(store.getJob(id, CHAIN)?.lastError).toBe("SomethingElse");
    expect(store.dueJobs(CHAIN, Number.MAX_SAFE_INTEGER)).toHaveLength(0);
  });

  it("reverted receipt with a since-advanced nonce -> superseded, not failed", async () => {
    const { store, worker } = makeWorker(access);
    const id = enqueue(store, { nonce: "5" });
    await worker.runOnce();
    expect(stateOf(store, id)).toBe("submitted");
    // The tx mined reverted, but lastCrossChainNonce shows our nonce landed
    // (a racing delivery won) — success-class, not a failure.
    access.receipt = {
      status: "reverted",
      blockNumber: 1001n,
      gasUsed: 21_000n,
      effectiveGasPrice: 1n,
    };
    access.lastNonce = 5n;
    await worker.runOnce();
    expect(stateOf(store, id)).toBe("superseded");
  });

  it("family unresolvable on this chain -> deferred, stays pending, never dropped", async () => {
    const { store, worker } = makeWorker(access, null);
    const id = enqueue(store);
    await worker.runOnce();
    expect(stateOf(store, id)).toBe("pending");
    expect(store.getJob(id, CHAIN)?.lastError).toContain("deferred");
    expect(access.sends).toBe(0);
  });

  it("a successful send reserves gas; a failed send releases it (no phantom spend)", async () => {
    const day = dayKey(NOW);

    // Happy path leaves a reservation on the day's spend.
    const okAccess = new FakeAccess();
    const ok = makeWorker(okAccess);
    enqueue(ok.store);
    await ok.worker.runOnce();
    expect(ok.store.gasSpend(CHAIN, day)).toBeGreaterThan(0n);

    // A non-revert send failure must reconcile back to zero — otherwise
    // repeated failures inflate phantom spend until the breaker trips. Advance
    // the clock past each deferral backoff so the job becomes due again.
    let clock = NOW;
    const failAccess = new FakeAccess();
    failAccess.sendResult = new Error("connection reset");
    const fail = makeWorker(failAccess, votingModule, { now: () => clock });
    const id = enqueue(fail.store);
    for (let i = 0; i < 3; i++) {
      await expect(fail.worker.runOnce()).rejects.toThrow("connection reset");
      clock += 30 * 60_000; // past any exponential backoff
    }
    expect(failAccess.sends).toBe(3);
    // Spend is fully reconciled on every failed send — no phantom accumulation.
    expect(fail.store.gasSpend(CHAIN, dayKey(NOW))).toBe(0n);
    // Job is deferred, never terminal — it can retry once the RPC recovers.
    expect(stateOf(fail.store, id)).toBe("pending");
  });

  it("stuck-tx reaper: reserves budget, caps fees, and rate-limits rebroadcasts", async () => {
    let clock = NOW;
    const { store, worker } = makeWorker(access, votingModule, {
      now: () => clock,
      timings: {
        stuckBlocks: 10n,
        rebroadcastMinIntervalMs: 60_000,
        maxRebroadcastFeeMultiple: 3n,
      },
    });
    const id = enqueue(store);

    // Submit: nonce 0, low fee cap, submittedBlock = head (1000).
    access.fees = { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n };
    await worker.runOnce();
    expect(stateOf(store, id)).toBe("submitted");
    expect(access.sends).toBe(1);
    const spendAfterFirst = store.gasSpend(CHAIN, dayKey(clock));
    expect(spendAfterFirst).toBeGreaterThan(0n);

    // Advance the head past the stuck window; the receipt is still missing.
    access.head = 1100n;
    access.receipt = null;
    clock += 60_000;
    await worker.runOnce();
    expect(access.sends).toBe(2); // rebroadcast happened
    // The rebroadcast reserved MORE budget (a second real send).
    expect(store.gasSpend(CHAIN, dayKey(clock))).toBeGreaterThan(
      spendAfterFirst,
    );

    // Same pass again immediately (only 1s later): rate-limited, no new send.
    clock += 1_000;
    access.head = 1200n;
    await worker.runOnce();
    expect(access.sends).toBe(2);

    // Even after many stuck windows, the fee cap holds at <= 3x the fresh
    // estimate — the compounding +25% bumps can't drain the key.
    for (let i = 0; i < 20; i++) {
      clock += 60_000;
      access.head += 100n;
      await worker.runOnce();
    }
    const last = access.sentFees.at(-1)!;
    expect(last.maxFeePerGas).toBeLessThanOrEqual(
      3n * access.fees.maxFeePerGas,
    );
    expect(last.maxPriorityFeePerGas).toBeLessThanOrEqual(
      3n * access.fees.maxPriorityFeePerGas,
    );
  });

  it("stuck-tx reaper defers (no send) when the daily gas budget is exhausted", async () => {
    let clock = NOW;
    // Budget large enough for the first submit, too small for a rebroadcast.
    const { store, worker } = makeWorker(access, votingModule, {
      now: () => clock,
      budgetWei: ((21_000n * 120n) / 100n) * 1_000_000_000n, // ~ one send
      timings: { stuckBlocks: 10n, rebroadcastMinIntervalMs: 60_000 },
    });
    const id = enqueue(store);
    await worker.runOnce();
    expect(access.sends).toBe(1);

    access.head = 1100n;
    clock += 60_000;
    await worker.runOnce();
    // Breaker open for the day -> no rebroadcast, job stays submitted.
    expect(access.sends).toBe(1);
    expect(stateOf(store, id)).toBe("submitted");
    expect(store.getJob(id, CHAIN)?.lastError).toContain("budget");
  });

  it("stuck-tx reaper: reaps a tx whose submittedBlock is null (dropped post-send)", async () => {
    let clock = NOW;
    const { store, worker } = makeWorker(access, votingModule, {
      now: () => clock,
      timings: { stuckBlocks: 10n, rebroadcastMinIntervalMs: 60_000 },
    });
    const { id: voteId } = store.upsertVote({
      familyId,
      voter,
      nonce: "5",
      deadline: FAR_DEADLINE,
      points: ["6000", "4000"],
      recipients: [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
      ] as Address[],
      signature: ("0x" + "11".repeat(65)) as Hex,
    });
    store.ensureJob(voteId, CHAIN, NOW - 1);
    // A submitted job whose post-send getBlockNumber failed: submittedBlock null.
    store.updateJob(
      voteId,
      CHAIN,
      {
        state: "submitted",
        txHash: ("0x" + "cc".repeat(32)) as Hex,
        acctNonce: 0,
        maxFeePerGas: "1000000000",
        maxPriorityFeePerGas: "1",
        submittedBlock: null,
      },
      NOW,
    );

    // No receipt; block-based check can't fire (null), but the time fallback can.
    access.receipt = null;
    clock += 60_000;
    await worker.runOnce();
    // The dropped tx was rebroadcast instead of being wedged forever.
    expect(access.sends).toBe(1);
    expect(store.getJob(voteId, CHAIN)?.submittedBlock).not.toBeNull();
  });
});
