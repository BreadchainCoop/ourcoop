import Database from "better-sqlite3";
import type { Address, Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import {
  Store,
  type NewProposal,
  type NewProposalVote,
  type NewRegistryUpdate,
  type NewVote,
} from "../src/store.js";

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

    const jobs = store.jobsForAction(first.id);
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

  it("dedups per (familyId, kind, signer, dedupKey) — same nonce, different kind is distinct", () => {
    // A vote and a registry-update with the SAME signer + nonce are distinct
    // rows: the kind is part of the unique key.
    const vote = store.upsertVote(newVote({ nonce: "7" }));
    const update = store.upsertAction({
      kind: "registry-update",
      familyId,
      admin: voter,
      recipients: ["0x1111111111111111111111111111111111111111"] as Address[],
      nonce: "7",
      deadline: "4102444800",
      signature: ("0x" + "22".repeat(65)) as Hex,
    });
    expect(update.created).toBe(true);
    expect(update.id).not.toBe(vote.id);
    // Re-upsert of each is a no-op.
    expect(store.upsertVote(newVote({ nonce: "7" })).created).toBe(false);
    expect(
      store.upsertAction({
        kind: "registry-update",
        familyId,
        admin: voter,
        recipients: ["0x1111111111111111111111111111111111111111"] as Address[],
        nonce: "7",
        deadline: "4102444800",
        signature: ("0x" + "22".repeat(65)) as Hex,
      }).created,
    ).toBe(false);
  });

  it("registry-update round-trips with recipients + nonce dedup", () => {
    const update: NewRegistryUpdate = {
      kind: "registry-update",
      familyId,
      admin: voter,
      recipients: [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
      ] as Address[],
      nonce: "3",
      deadline: "4102444800",
      signature: ("0x" + "33".repeat(65)) as Hex,
    };
    const { id } = store.upsertAction(update);
    const row = store.getAction(familyId, "registry-update", voter, "3");
    expect(row?.id).toBe(id);
    expect(row?.kind).toBe("registry-update");
    expect(row?.recipients).toHaveLength(2);
    expect(row?.nonce).toBe("3");
  });

  it("proposal is content-addressed: keyed by proposalKey, electorate + flags round-trip", () => {
    const proposalKey = ("0x" + "cd".repeat(32)) as Hex;
    const proposal: NewProposal = {
      kind: "proposal",
      familyId,
      proposer: voter,
      candidate: "0x3333333333333333333333333333333333333333" as Address,
      isAddition: true,
      electorate: [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
      ] as Address[],
      expiresAt: "4102444800",
      nonce: "1",
      proposalKey,
      signature: ("0x" + "44".repeat(65)) as Hex,
    };
    const { id, created } = store.upsertAction(proposal);
    expect(created).toBe(true);
    const row = store.getAction(familyId, "proposal", voter, proposalKey);
    expect(row?.id).toBe(id);
    expect(row?.candidate?.toLowerCase()).toBe(
      "0x3333333333333333333333333333333333333333",
    );
    expect(row?.isAddition).toBe(true);
    expect(row?.electorate).toHaveLength(2);
    expect(row?.expiresAt).toBe("4102444800");
    expect(row?.proposalKey?.toLowerCase()).toBe(proposalKey);
    // Same key re-upsert is a no-op.
    expect(store.upsertAction(proposal).created).toBe(false);
  });

  it("proposal-vote round-trips (no nonce; keyed by proposalKey)", () => {
    const proposalKey = ("0x" + "ef".repeat(32)) as Hex;
    const pv: NewProposalVote = {
      kind: "proposal-vote",
      familyId,
      voter,
      proposalKey,
      deadline: "4102444800",
      signature: ("0x" + "55".repeat(65)) as Hex,
    };
    const { id } = store.upsertAction(pv);
    const row = store.getAction(familyId, "proposal-vote", voter, proposalKey);
    expect(row?.id).toBe(id);
    expect(row?.proposalKey?.toLowerCase()).toBe(proposalKey);
    expect(row?.nonce).toBeNull();
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
    expect(store.dueJobs(100, 2_000).map((j) => j.actionId)).toEqual([id]);

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

  it("unexpiredActions honors deadline AND absolute expiresAt", () => {
    const nowSec = 1_000;
    // A future-deadline vote is included; a past-deadline one is not.
    const live = store.upsertVote(newVote({ nonce: "1", deadline: "2000" }));
    store.upsertVote(newVote({ nonce: "2", deadline: "500" }));
    // A proposal is bounded by expiresAt (no deadline column).
    const liveProp = store.upsertAction({
      kind: "proposal",
      familyId,
      proposer: voter,
      candidate: "0x3333333333333333333333333333333333333333" as Address,
      isAddition: true,
      electorate: [voter] as Address[],
      expiresAt: "2000",
      nonce: "1",
      proposalKey: ("0x" + "01".repeat(32)) as Hex,
      signature: ("0x" + "66".repeat(65)) as Hex,
    });
    store.upsertAction({
      kind: "proposal",
      familyId,
      proposer: voter,
      candidate: "0x4444444444444444444444444444444444444444" as Address,
      isAddition: true,
      electorate: [voter] as Address[],
      expiresAt: "500",
      nonce: "2",
      proposalKey: ("0x" + "02".repeat(32)) as Hex,
      signature: ("0x" + "77".repeat(65)) as Hex,
    });
    const ids = store
      .unexpiredActions(familyId, nowSec)
      .map((a) => a.id)
      .sort();
    expect(ids).toEqual([live.id, liveProp.id].sort());
  });

  it("dedups listener logs by (txHash, logIndex) per chain", () => {
    const tx = ("0x" + "33".repeat(32)) as Hex;
    expect(store.markLogSeen(100, tx, 0)).toBe(true);
    expect(store.markLogSeen(100, tx, 0)).toBe(false);
    expect(store.markLogSeen(100, tx, 1)).toBe(true);
    expect(store.markLogSeen(10, tx, 0)).toBe(true);
  });

  it("family cache maps BOTH voting modules and registries, and invalidates", () => {
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
    expect(store.familyByRegistry(100, instance.registry as Address)).toBe(
      familyId,
    );
    expect(store.knownVotingModules(100)).toEqual([
      instance.votingModule.toLowerCase(),
    ]);
    expect(store.knownRegistries(100)).toEqual([
      instance.registry.toLowerCase(),
    ]);

    // 'none' is cached too (with TTL upstream), never as a module/registry.
    store.setFamilyChain(familyId, 10, null);
    expect(store.getFamilyChain(familyId, 10)?.instance).toBeNull();
    expect(store.knownVotingModules(10)).toEqual([]);
    expect(store.knownRegistries(10)).toEqual([]);

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

describe("store migration (user_version 0 votes -> actions)", () => {
  it("copies a legacy votes+jobs(vote_id) layout into actions/jobs", () => {
    // Build the OLD schema by hand (user_version 0), insert a vote + a job,
    // then open a Store over the same file — the constructor migrates it.
    const path = `/tmp/relay-migrate-${Date.now()}-${Math.random()}.db`;
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE votes (
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
      CREATE TABLE jobs (
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
    `);
    raw
      .prepare(
        `INSERT INTO votes (family_id, voter, nonce, deadline, points, recipients, signature, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        familyId.toLowerCase(),
        voter.toLowerCase(),
        "9",
        "4102444800",
        JSON.stringify(["6000", "4000"]),
        JSON.stringify([voter.toLowerCase()]),
        "0x" + "11".repeat(65),
        1234,
      );
    raw
      .prepare(
        `INSERT INTO jobs (vote_id, chain_id, state, updated_at) VALUES (1, 100, 'confirmed', 5678)`,
      )
      .run();
    // A legacy family_cache WITHOUT the `registry` column — the migration must
    // recreate it in the new shape so knownRegistries() works after upgrade.
    raw.exec(`
      CREATE TABLE family_cache (
        family_id TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        instance TEXT,
        voting_module TEXT,
        resolved_at INTEGER NOT NULL,
        PRIMARY KEY (family_id, chain_id)
      );
    `);
    raw.close();

    const store = new Store(path);
    // The new registry-aware cache column exists after migration.
    expect(store.knownRegistries(100)).toEqual([]);
    // The legacy vote is now an action of kind 'vote'.
    const row = store.getAction(familyId, "vote", voter, "9");
    expect(row?.id).toBe(1);
    expect(row?.nonce).toBe("9");
    expect(row?.points).toEqual(["6000", "4000"]);
    // The legacy job rehomed onto action_id (same id) with its state preserved.
    const job = store.getJob(1, 100);
    expect(job?.state).toBe("confirmed");
    // Re-opening is a no-op (user_version now current).
    store.close();
    const reopened = new Store(path);
    expect(reopened.getAction(familyId, "vote", voter, "9")?.id).toBe(1);
    reopened.close();
  });
});
