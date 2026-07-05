import type { Address, Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import { Store, type NewVote } from "../src/store.js";

const familyId = ("0x" + "ab".repeat(32)) as Hex;
const voter = "0x1111111111111111111111111111111111111111" as Address;

function newVote(overrides: Partial<NewVote> = {}): NewVote {
  return {
    familyId,
    voter,
    nonce: "1",
    deadline: "4102444800",
    points: ["6000", "4000"],
    recipients: [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ] as Address[],
    signature: ("0x" + "11".repeat(65)) as Hex,
    ...overrides,
  };
}

describe("store", () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(":memory:");
  });

  it("upsertVote is idempotent: double POST -> one vote, one job set", () => {
    const first = store.upsertVote(newVote());
    expect(first.created).toBe(true);
    const second = store.upsertVote(newVote());
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);

    expect(store.ensureJob(first.id, 100)).toBe(true);
    expect(store.ensureJob(first.id, 10)).toBe(true);
    // Re-POST re-ensures the same jobs — no duplicates, no state reset.
    store.updateJob(first.id, 100, { state: "confirmed" });
    expect(store.ensureJob(first.id, 100)).toBe(false);
    expect(store.ensureJob(first.id, 10)).toBe(false);

    const jobs = store.jobsForVote(first.id);
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.chainId === 100)?.state).toBe("confirmed");
    expect(jobs.find((j) => j.chainId === 10)?.state).toBe("pending");
  });

  it("votes are keyed on (familyId, voter, nonce) — a new nonce is a new vote", () => {
    const a = store.upsertVote(newVote({ nonce: "1" }));
    const b = store.upsertVote(newVote({ nonce: "2" }));
    expect(b.id).not.toBe(a.id);
    expect(store.getVote(familyId, voter, "1")?.id).toBe(a.id);
    expect(store.getVote(familyId, voter, "2")?.id).toBe(b.id);
  });

  it("job state transitions persist with metadata", () => {
    const { id } = store.upsertVote(newVote());
    store.ensureJob(id, 100);
    store.updateJob(id, 100, {
      state: "submitted",
      txHash: ("0x" + "22".repeat(32)) as Hex,
      acctNonce: 7,
      maxFeePerGas: "1000000000",
      maxPriorityFeePerGas: "100000000",
      submittedBlock: "123",
    });
    let job = store.getJob(id, 100);
    expect(job?.state).toBe("submitted");
    expect(job?.acctNonce).toBe(7);
    expect(job?.submittedBlock).toBe("123");

    store.updateJob(id, 100, { state: "confirmed", lastError: null });
    job = store.getJob(id, 100);
    expect(job?.state).toBe("confirmed");
    expect(job?.lastError).toBeNull();
  });

  it("dueJobs honors states and not_before backoff", () => {
    const { id } = store.upsertVote(newVote());
    store.ensureJob(id, 100, 1_000);
    expect(store.dueJobs(100, 2_000).map((j) => j.voteId)).toEqual([id]);

    store.updateJob(id, 100, { state: "skipped_no_power", notBefore: 5_000 });
    expect(store.dueJobs(100, 2_000)).toHaveLength(0);
    expect(store.dueJobs(100, 5_000)).toHaveLength(1);

    // Terminal states never come back.
    for (const state of [
      "confirmed",
      "superseded",
      "expired",
      "failed",
    ] as const) {
      store.updateJob(id, 100, { state, notBefore: 0 });
      expect(store.dueJobs(100, Number.MAX_SAFE_INTEGER)).toHaveLength(0);
    }
  });

  it("dedups listener logs by (txHash, logIndex) per chain", () => {
    const tx = ("0x" + "33".repeat(32)) as Hex;
    expect(store.markLogSeen(100, tx, 0)).toBe(true);
    expect(store.markLogSeen(100, tx, 0)).toBe(false);
    expect(store.markLogSeen(100, tx, 1)).toBe(true);
    expect(store.markLogSeen(10, tx, 0)).toBe(true);
  });

  it("family cache round-trips, maps voting modules, and invalidates", () => {
    const instance = {
      cycleModule: "0x000000000000000000000000000000000000000A",
      registry: "0x000000000000000000000000000000000000000b",
      token: "0x000000000000000000000000000000000000000C",
      votingPowerStrategy: "0x000000000000000000000000000000000000000d",
      distributionManager: "0x000000000000000000000000000000000000000E",
      distributionStrategy: "0x000000000000000000000000000000000000000F",
      secondaryDistributionStrategy:
        "0x0000000000000000000000000000000000000010",
      votingModule: "0x0000000000000000000000000000000000000011",
    } as const;
    store.setFamilyChain(familyId, 100, { ...instance });
    expect(store.getFamilyChain(familyId, 100)?.instance?.votingModule).toBe(
      instance.votingModule,
    );
    expect(
      store.familyByVotingModule(100, instance.votingModule as Address),
    ).toBe(familyId);
    expect(store.knownVotingModules(100)).toEqual([
      instance.votingModule.toLowerCase(),
    ]);

    // 'none' is cached too (with TTL upstream), never as a module.
    store.setFamilyChain(familyId, 10, null);
    expect(store.getFamilyChain(familyId, 10)?.instance).toBeNull();
    expect(store.knownVotingModules(10)).toEqual([]);

    store.invalidateFamily(familyId, 100);
    expect(store.getFamilyChain(familyId, 100)).toBeUndefined();
    expect(store.getFamilyChain(familyId, 10)).toBeDefined();
    store.invalidateFamily(familyId);
    expect(store.getFamilyChain(familyId, 10)).toBeUndefined();
  });

  it("gas spend accumulates per chain per day", () => {
    store.addGasSpend(100, "2026-07-04", 100n);
    store.addGasSpend(100, "2026-07-04", 50n);
    store.addGasSpend(100, "2026-07-05", 1n);
    expect(store.gasSpend(100, "2026-07-04")).toBe(150n);
    expect(store.gasSpend(100, "2026-07-05")).toBe(1n);
    expect(store.gasSpend(10, "2026-07-04")).toBe(0n);
  });
});
