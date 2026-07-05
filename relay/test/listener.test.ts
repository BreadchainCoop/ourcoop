import type { Address, Hex } from "viem";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ChainListener,
  getLogsBisect,
  isRangeError,
  planWindows,
  type FamilyDeployedLog,
  type ListenerRpc,
  type VoteCastLog,
} from "../src/listener.js";
import { Store } from "../src/store.js";

describe("planWindows", () => {
  it("splits a range into bounded inclusive windows", () => {
    expect(planWindows(1n, 10n, 4n)).toEqual([
      [1n, 4n],
      [5n, 8n],
      [9n, 10n],
    ]);
  });

  it("single window when the range fits", () => {
    expect(planWindows(5n, 5n, 2000n)).toEqual([[5n, 5n]]);
    expect(planWindows(1n, 2000n, 2000n)).toEqual([[1n, 2000n]]);
  });

  it("empty when from > to", () => {
    expect(planWindows(10n, 9n, 100n)).toEqual([]);
  });
});

describe("getLogsBisect", () => {
  it("bisects on range errors until the provider accepts", async () => {
    const calls: Array<[bigint, bigint]> = [];
    const fetch = async (from: bigint, to: bigint): Promise<bigint[]> => {
      calls.push([from, to]);
      if (to - from + 1n > 100n) throw new Error("query exceeds max results");
      const out: bigint[] = [];
      for (let b = from; b <= to; b++) out.push(b);
      return out;
    };
    const logs = await getLogsBisect(fetch, 1n, 1000n);
    expect(logs).toHaveLength(1000);
    expect(logs[0]).toBe(1n);
    expect(logs[999]).toBe(1000n);
    // Every successful call was within the provider's limit, ordering kept.
    expect(calls.length).toBeGreaterThan(10);
    for (let i = 1; i < logs.length; i++) {
      expect(logs[i]! > logs[i - 1]!).toBe(true);
    }
  });

  it("propagates non-range errors without bisecting", async () => {
    let calls = 0;
    const fetch = async (): Promise<never> => {
      calls++;
      throw new Error("connection refused");
    };
    await expect(getLogsBisect(fetch, 1n, 1000n)).rejects.toThrow(
      "connection refused",
    );
    expect(calls).toBe(1);
  });

  it("propagates a single-block range error (cannot bisect further)", async () => {
    const fetch = async (from: bigint, to: bigint): Promise<never> => {
      void from;
      void to;
      throw new Error("response size limit exceeded");
    };
    await expect(getLogsBisect(fetch, 7n, 7n)).rejects.toThrow(
      "response size limit",
    );
  });

  it("isRangeError matches common provider phrasings", () => {
    expect(isRangeError(new Error("block range too large"))).toBe(true);
    expect(
      isRangeError(new Error("query returned more than 10000 results")),
    ).toBe(true);
    expect(isRangeError(new Error("Log response size exceeded"))).toBe(true);
    expect(isRangeError(new Error("ECONNREFUSED"))).toBe(false);
  });
});

describe("ChainListener.runOnce", () => {
  const chainId = 100;
  const familyId = ("0x" + "cd".repeat(32)) as Hex;
  const votingModule = "0x0000000000000000000000000000000000000011" as Address;
  let store: Store;

  const instance = {
    cycleModule: "0x000000000000000000000000000000000000000a",
    registry: "0x000000000000000000000000000000000000000b",
    token: "0x000000000000000000000000000000000000000c",
    votingPowerStrategy: "0x000000000000000000000000000000000000000d",
    distributionManager: "0x000000000000000000000000000000000000000e",
    distributionStrategy: "0x000000000000000000000000000000000000000f",
    secondaryDistributionStrategy: "0x0000000000000000000000000000000000000010",
    votingModule,
  } as const;

  const voteLog: VoteCastLog = {
    txHash: ("0x" + "44".repeat(32)) as Hex,
    logIndex: 3,
    votingModule,
    voter: "0x1111111111111111111111111111111111111111" as Address,
    points: [6000n, 4000n],
    recipients: [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ] as Address[],
    nonce: 1n,
    deadline: 99999999999n,
    signature: ("0x" + "55".repeat(65)) as Hex,
  };

  function makeRpc(overrides: Partial<ListenerRpc> = {}): ListenerRpc {
    return {
      getBlockNumber: async () => 1000n,
      getFamilyDeployedLogs: async () => [],
      getVoteCastLogs: async () => [],
      readFamilyId: async () => familyId,
      ...overrides,
    };
  }

  beforeEach(() => {
    store = new Store(":memory:");
  });

  it("starts at the confirmed head, then only advances by confirmed blocks", async () => {
    const listener = new ChainListener({
      chainId,
      chainName: "test",
      store,
      rpc: makeRpc(),
      confirmations: 12n,
      maxLogRange: 2000n,
      onFamilyDeployed: async () => {},
      onVotesIngested: () => {},
    });
    await listener.runOnce();
    expect(store.getCursor(chainId)).toBe(1000n - 12n - 1n);
    await listener.runOnce();
    expect(store.getCursor(chainId)).toBe(1000n - 12n);
  });

  it("ingests CrossChainVoteCast into the store, dedups replays, confirms the origin job", async () => {
    store.setFamilyChain(familyId, chainId, { ...instance });
    let kicked = 0;
    const windows: Array<[bigint, bigint]> = [];
    const rpc = makeRpc({
      getVoteCastLogs: async (addresses, from, to) => {
        expect(addresses).toEqual([votingModule.toLowerCase()]);
        windows.push([from, to]);
        return from <= 990n && 990n <= to ? [voteLog] : [];
      },
    });
    const listener = new ChainListener({
      chainId,
      chainName: "test",
      store,
      rpc,
      confirmations: 5n,
      maxLogRange: 100n,
      onFamilyDeployed: async () => {},
      onVotesIngested: () => kicked++,
    });
    store.setCursor(chainId, 900n);
    await listener.runOnce();

    // 900 -> 995 (head 1000 - 5 confirmations), windows of 100.
    expect(windows).toEqual([[901n, 995n]]);
    const vote = store.getVote(familyId, voteLog.voter, "1");
    expect(vote).toBeDefined();
    expect(vote?.points).toEqual(["6000", "4000"]);
    expect(vote?.signature).toBe(voteLog.signature);
    expect(store.getJob(vote!.id, chainId)?.state).toBe("confirmed");
    expect(store.getJob(vote!.id, chainId)?.txHash).toBe(voteLog.txHash);
    expect(kicked).toBe(1);

    // Replay of the same log (e.g. cursor reset) is a no-op.
    store.setCursor(chainId, 900n);
    await listener.runOnce();
    expect(kicked).toBe(1);
  });

  it("fans an ingested vote out to every sibling chain (not just the origin)", async () => {
    // A 3-chain family; the vote is emitted on chain 100 (origin).
    const siblingChains = [100, 10, 42161];
    store.setFamilyChain(familyId, chainId, { ...instance });
    const rpc = makeRpc({
      getVoteCastLogs: async (_addr, from, to) =>
        from <= 990n && 990n <= to ? [voteLog] : [],
    });
    // onVotesIngested mirrors index.ts#fanOutFamily: resolve siblings and
    // ensure a job on every found chain (the origin job is already created
    // and confirmed by the listener itself).
    const listener = new ChainListener({
      chainId,
      chainName: "test",
      store,
      rpc,
      confirmations: 5n,
      maxLogRange: 2000n,
      onFamilyDeployed: async () => {},
      onVotesIngested: async (familyIds) => {
        for (const fid of familyIds) {
          const v = store.getVote(fid, voteLog.voter, "1")!;
          for (const cid of siblingChains) store.ensureJob(v.id, cid);
        }
      },
    });
    store.setCursor(chainId, 900n);
    await listener.runOnce();

    const vote = store.getVote(familyId, voteLog.voter, "1");
    expect(vote).toBeDefined();
    // Jobs exist on ALL THREE chains, not just the origin.
    const jobs = store.jobsForVote(vote!.id);
    expect(jobs.map((j) => j.chainId).sort((a, b) => a - b)).toEqual(
      [...siblingChains].sort((a, b) => a - b),
    );
    // Origin is confirmed (already landed there); siblings are pending.
    expect(store.getJob(vote!.id, chainId)?.state).toBe("confirmed");
    expect(store.getJob(vote!.id, 10)?.state).toBe("pending");
    expect(store.getJob(vote!.id, 42161)?.state).toBe("pending");
  });

  it("FamilyDeployed triggers cache invalidation callback before vote scanning", async () => {
    const deployLog: FamilyDeployedLog = {
      txHash: ("0x" + "66".repeat(32)) as Hex,
      logIndex: 0,
      familyId,
    };
    const events: string[] = [];
    const rpc = makeRpc({
      getFamilyDeployedLogs: async () => [deployLog],
      getVoteCastLogs: async () => {
        events.push("votes-scanned");
        return [];
      },
    });
    const listener = new ChainListener({
      chainId,
      chainName: "test",
      store,
      rpc,
      confirmations: 0n,
      maxLogRange: 2000n,
      onFamilyDeployed: async (fid, cid) => {
        events.push(`family:${fid}:${cid}`);
        // Simulates the production callback resolving + caching the family.
        store.setFamilyChain(fid, cid, { ...instance });
      },
      onVotesIngested: () => {},
    });
    store.setCursor(chainId, 998n);
    await listener.runOnce();
    expect(events).toEqual([`family:${familyId}:${chainId}`, "votes-scanned"]);
  });

  it("does not mark a log seen until its ingestion commits (crash-safe replay)", async () => {
    store.setFamilyChain(familyId, chainId, { ...instance });
    let failNext = true;
    const rpc = makeRpc({
      getVoteCastLogs: async (_addr, from, to) =>
        from <= 990n && 990n <= to ? [voteLog] : [],
    });
    const listener = new ChainListener({
      chainId,
      chainName: "test",
      store,
      rpc,
      confirmations: 5n,
      maxLogRange: 2000n,
      onFamilyDeployed: async () => {},
      // Simulate a crash between ingestion and mark-seen: throw on the first
      // fan-out. The log must NOT be recorded as seen, or the replay drops it.
      onVotesIngested: async () => {
        if (failNext) {
          failNext = false;
          throw new Error("crash before fan-out commits");
        }
      },
    });

    store.setCursor(chainId, 900n);
    await expect(listener.runOnce()).rejects.toThrow("crash before fan-out");
    // The vote row was written, but the log is NOT marked seen (the crash
    // happened before mark-seen).
    expect(store.hasSeenLog(chainId, voteLog.txHash, voteLog.logIndex)).toBe(
      false,
    );

    // Replay from the same cursor re-processes the log (dedup did NOT hide it),
    // and this time fan-out succeeds and the log is finally marked seen.
    store.setCursor(chainId, 900n);
    await listener.runOnce();
    expect(store.hasSeenLog(chainId, voteLog.txHash, voteLog.logIndex)).toBe(
      true,
    );
    expect(store.getVote(familyId, voteLog.voter, "1")).toBeDefined();
  });
});
