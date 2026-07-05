import { keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  type ChainAccess,
  type CrossChainProposalView,
  type DeliveryArgs,
  type FeeEstimate,
  type Receipt,
} from "../src/chain-access.js";
import { Families } from "../src/families.js";
import { TokenBucket } from "../src/rate-limit.js";
import { createApp, type ServerChain } from "../src/server.js";
import { Store, type FamilyInstance } from "../src/store.js";
import {
  computeProposalKey,
  crossChainProposalTypedData,
  crossChainProposalVoteTypedData,
  crossChainRegistryUpdateTypedData,
  crossChainVoteTypedData,
} from "../src/typed-data.js";
import { ChainWorker } from "../src/worker.js";
import { GasBudget } from "../src/gas-budget.js";
import { NonceManager } from "../src/nonce-manager.js";

const CHAIN = 100;
const familyId = keccak256(stringToHex("server.family"));
const account = privateKeyToAccount(("0x" + "beef".repeat(16)) as Hex);
const signer = account.address;
const votingModule = "0x0000000000000000000000000000000000000011" as Address;
const registry = "0x0000000000000000000000000000000000000012" as Address;
const FAR = "4102444800";
const NOW = 1_700_000_000_000;

const INSTANCE: FamilyInstance = {
  cycleModule: "0x000000000000000000000000000000000000000a" as Address,
  registry,
  token: "0x000000000000000000000000000000000000000c" as Address,
  votingPowerStrategy: "0x000000000000000000000000000000000000000d" as Address,
  distributionManager: "0x000000000000000000000000000000000000000e" as Address,
  distributionStrategy: "0x000000000000000000000000000000000000000f" as Address,
  secondaryDistributionStrategy:
    "0x0000000000000000000000000000000000000010" as Address,
  votingModule,
};

class FakeAccess implements ChainAccess {
  lastNonce = 0n;
  registryNonce = 0n;
  proposal: CrossChainProposalView | undefined = undefined;
  voted = false;
  getBlockNumber = async () => 1000n;
  getBalance = async () => 10n ** 18n;
  getPendingTransactionCount = async () => 0;
  familyInstances = async () => null;
  readFamilyId = async () => familyId;
  lastCrossChainNonce = async () => this.lastNonce;
  getVotingPower = async () => 100n;
  lastRegistryUpdateNonce = async () => this.registryNonce;
  getRecipients = async () => [] as Address[];
  getCrossChainProposal = async () => this.proposal;
  hasVotedCrossChain = async () => this.voted;
  simulate = async () => 21_000n;
  send = async (
    _t: Address,
    _d: DeliveryArgs,
    _o: { nonce: number; gas: bigint } & FeeEstimate,
  ) => ("0x" + "aa".repeat(32)) as Hex;
  getReceipt = async (): Promise<Receipt | null> => null;
  estimateFees = async (): Promise<FeeEstimate> => ({
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  });
}

function makeApp(seedFamily = true, access = new FakeAccess()) {
  const store = new Store(":memory:");
  if (seedFamily) store.setFamilyChain(familyId, CHAIN, { ...INSTANCE });
  const families = new Families(
    store,
    [
      {
        chainId: CHAIN,
        name: "test",
        deployer: "0x00000000000000000000000000000000000000de" as Address,
        access,
      },
    ],
    600_000,
  );
  const worker = new ChainWorker({
    chainId: CHAIN,
    chainName: "test",
    store,
    access,
    nonces: new NonceManager(() => access.getPendingTransactionCount()),
    gasBudget: new GasBudget(store, new Map([[CHAIN, 10n ** 20n]])),
    resolveInstance: () => families.instance(familyId, CHAIN),
    now: () => NOW,
  });
  const chains: ServerChain[] = [
    { chainId: CHAIN, name: "test", access, worker },
  ];
  const app = createApp({
    store,
    families,
    chains,
    rateLimiter: new TokenBucket(1000, 1000),
    relayAccount: account.address,
    now: () => NOW,
  });
  return { app, store, access };
}

async function postJson(
  app: ReturnType<typeof makeApp>["app"],
  path: string,
  body: unknown,
) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

describe("server POST /v1/vote (+ alias) validation & flow", () => {
  it("accepts a valid vote, persists it, and reports chain rows", async () => {
    const { app, store } = makeApp();
    const sig = await account.signTypedData(
      crossChainVoteTypedData(familyId, {
        voter: signer,
        points: [6000n, 4000n],
        recipients: [
          "0x1111111111111111111111111111111111111111",
          "0x2222222222222222222222222222222222222222",
        ] as Address[],
        nonce: 1n,
        deadline: BigInt(FAR),
      }),
    );
    const body = {
      familyId,
      voter: signer,
      points: ["6000", "4000"],
      recipients: [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
      ],
      nonce: "1",
      deadline: FAR,
      signature: sig,
    };
    const res = await postJson(app, "/v1/vote", body);
    expect(res.status).toBe(202);
    expect(store.getVote(familyId, signer, "1")).toBeDefined();
    // The same body posted to /v1/action (kind omitted) is idempotent.
    const alias = await postJson(app, "/v1/action", body);
    expect(alias.status).toBe(202);
  });

  it("rejects a bad signature (400)", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/v1/vote", {
      familyId,
      voter: signer,
      points: ["6000", "4000"],
      recipients: [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
      ],
      nonce: "1",
      deadline: FAR,
      signature: "0x" + "00".repeat(65),
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("invalid signature");
  });

  it("rejects points/recipients length mismatch (400)", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/v1/vote", {
      familyId,
      voter: signer,
      points: ["10000"],
      recipients: [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
      ],
      nonce: "1",
      deadline: FAR,
      signature: "0x" + "00".repeat(65),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a past deadline (400)", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/v1/vote", {
      familyId,
      voter: signer,
      points: ["10000"],
      recipients: ["0x1111111111111111111111111111111111111111"],
      nonce: "1",
      deadline: String(Math.floor(NOW / 1000) - 10),
      signature: "0x" + "00".repeat(65),
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("deadline in the past");
  });
});

describe("server POST /v1/action per-kind validation", () => {
  it("accepts a registry-update signed by the admin", async () => {
    const { app, store } = makeApp();
    const recipients = [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ] as Address[];
    const sig = await account.signTypedData(
      crossChainRegistryUpdateTypedData(familyId, {
        admin: signer,
        recipients,
        nonce: 2n,
        deadline: BigInt(FAR),
      }),
    );
    const res = await postJson(app, "/v1/action", {
      kind: "registry-update",
      familyId,
      admin: signer,
      recipients,
      nonce: "2",
      deadline: FAR,
      signature: sig,
    });
    expect(res.status).toBe(202);
    expect(res.json.kind).toBe("registry-update");
    expect(
      store.getAction(familyId, "registry-update", signer, "2"),
    ).toBeDefined();
  });

  it("accepts a proposal, computes proposalKey as the dedup key", async () => {
    const { app, store } = makeApp();
    const msg = {
      proposer: signer,
      candidate: "0x3333333333333333333333333333333333333333" as Address,
      isAddition: true,
      electorate: ["0x1111111111111111111111111111111111111111"] as Address[],
      expiresAt: BigInt(FAR),
      nonce: 1n,
    };
    const sig = await account.signTypedData(
      crossChainProposalTypedData(familyId, msg),
    );
    const key = computeProposalKey(msg);
    const res = await postJson(app, "/v1/action", {
      kind: "proposal",
      familyId,
      proposer: signer,
      candidate: msg.candidate,
      isAddition: true,
      electorate: msg.electorate,
      expiresAt: FAR,
      nonce: "1",
      signature: sig,
    });
    expect(res.status).toBe(202);
    expect(res.json.dedupKey).toBe(key);
    expect(store.getAction(familyId, "proposal", signer, key)).toBeDefined();
  });

  it("accepts a proposal-vote (no nonce; keyed by proposalKey)", async () => {
    const { app, store } = makeApp();
    const proposalKey = ("0x" + "cd".repeat(32)) as Hex;
    const sig = await account.signTypedData(
      crossChainProposalVoteTypedData(familyId, {
        voter: signer,
        proposalKey,
        deadline: BigInt(FAR),
      }),
    );
    const res = await postJson(app, "/v1/action", {
      kind: "proposal-vote",
      familyId,
      voter: signer,
      proposalKey,
      deadline: FAR,
      signature: sig,
    });
    expect(res.status).toBe(202);
    expect(
      store.getAction(familyId, "proposal-vote", signer, proposalKey),
    ).toBeDefined();
  });

  it("rejects a registry-update with a mismatched signature (400)", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/v1/action", {
      kind: "registry-update",
      familyId,
      admin: signer,
      recipients: ["0x1111111111111111111111111111111111111111"],
      nonce: "2",
      deadline: FAR,
      signature: "0x" + "00".repeat(65),
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("invalid signature");
  });

  it("rejects an unknown kind (400)", async () => {
    const { app } = makeApp();
    const res = await postJson(app, "/v1/action", {
      kind: "nonsense",
      familyId,
    });
    expect(res.status).toBe(400);
  });

  it("rejects too many recipients on a registry-update (400)", async () => {
    const { app } = makeApp();
    const recipients = Array.from(
      { length: 101 },
      (_, i) => ("0x" + (i + 1).toString(16).padStart(40, "0")) as Address,
    );
    const res = await postJson(app, "/v1/action", {
      kind: "registry-update",
      familyId,
      admin: signer,
      recipients,
      nonce: "2",
      deadline: FAR,
      signature: "0x" + "00".repeat(65),
    });
    expect(res.status).toBe(400);
  });
});

describe("server GET /v1/action-status (+ vote alias) store-miss reconstruction", () => {
  it("vote-status reconstructs 'landed' from lastCrossChainNonce on a store miss", async () => {
    const access = new FakeAccess();
    access.lastNonce = 5n; // nonce 3 <= 5 -> landed
    const { app } = makeApp(true, access);
    const res = await app.request(
      `/v1/vote-status?familyId=${familyId}&voter=${signer}&nonce=3`,
    );
    const json = (await res.json()) as {
      chains: Array<{ chainId: number; state: string }>;
    };
    expect(res.status).toBe(200);
    expect(json.chains.find((c) => c.chainId === CHAIN)?.state).toBe("landed");
  });

  it("action-status reconstructs a proposal-vote from hasVotedCrossChain", async () => {
    const access = new FakeAccess();
    access.proposal = {
      candidate: "0x3333333333333333333333333333333333333333" as Address,
      isAddition: true,
      executed: false,
      expiresAt: BigInt(FAR),
      voteCount: 1n,
      requiredVotes: 3n,
    };
    access.voted = true;
    const { app } = makeApp(true, access);
    const key = ("0x" + "cd".repeat(32)) as Hex;
    const res = await app.request(
      `/v1/action-status?familyId=${familyId}&kind=proposal-vote&signer=${signer}&dedupKey=${key}`,
    );
    const json = (await res.json()) as {
      chains: Array<{ chainId: number; state: string }>;
    };
    expect(res.status).toBe(200);
    expect(json.chains.find((c) => c.chainId === CHAIN)?.state).toBe("landed");
  });

  it("action-status reconstructs a registry-update from lastRegistryUpdateNonce", async () => {
    const access = new FakeAccess();
    access.registryNonce = 7n; // dedupKey nonce 5 <= 7 -> landed
    const { app } = makeApp(true, access);
    const res = await app.request(
      `/v1/action-status?familyId=${familyId}&kind=registry-update&signer=${signer}&dedupKey=5`,
    );
    const json = (await res.json()) as {
      chains: Array<{ chainId: number; state: string }>;
    };
    expect(res.status).toBe(200);
    expect(json.chains.find((c) => c.chainId === CHAIN)?.state).toBe("landed");
  });

  it("action-status rejects a decimal dedupKey for a proposal kind (400)", async () => {
    const { app } = makeApp();
    const res = await app.request(
      `/v1/action-status?familyId=${familyId}&kind=proposal&signer=${signer}&dedupKey=5`,
    );
    expect(res.status).toBe(400);
  });

  it("action-status rejects a bytes32 dedupKey for a vote kind (400)", async () => {
    const { app } = makeApp();
    const key = "0x" + "cd".repeat(32);
    const res = await app.request(
      `/v1/action-status?familyId=${familyId}&kind=vote&signer=${signer}&dedupKey=${key}`,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when the family is on no enabled chain", async () => {
    const { app } = makeApp(false); // no family cached
    const sig = await account.signTypedData(
      crossChainVoteTypedData(familyId, {
        voter: signer,
        points: [10000n],
        recipients: ["0x1111111111111111111111111111111111111111"] as Address[],
        nonce: 1n,
        deadline: BigInt(FAR),
      }),
    );
    const res = await postJson(app, "/v1/vote", {
      familyId,
      voter: signer,
      points: ["10000"],
      recipients: ["0x1111111111111111111111111111111111111111"],
      nonce: "1",
      deadline: FAR,
      signature: sig,
    });
    expect(res.status).toBe(404);
  });
});
