import { serve } from "@hono/node-server";
import {
  createPublicClient,
  getAddress,
  http,
  parseEventLogs,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  crossChainProposalCreatedEvent,
  crossChainProposalVoteCastEvent,
  crossChainRegistryUpdatedEvent,
  crossChainVoteCastEvent,
  familyDeployedEvent,
} from "./abi.js";
import { createChainAccess, viemChain } from "./chain-access.js";
import { loadConfig, type ChainConfig } from "./config.js";
import { Families } from "./families.js";
import { GasBudget } from "./gas-budget.js";
import {
  ChainListener,
  type FamilyDeployedLog,
  type ListenerRpc,
  type RegistryLog,
  type VoteCastLog,
} from "./listener.js";
import { log, warn } from "./log.js";
import { NonceManager } from "./nonce-manager.js";
import { TokenBucket } from "./rate-limit.js";
import { createApp, type ServerChain } from "./server.js";
import { Store } from "./store.js";
import { ChainWorker } from "./worker.js";

function makeListenerRpc(chain: ChainConfig): ListenerRpc {
  const client = createPublicClient({
    chain: viemChain(chain.chainId, chain.name, chain.rpcUrl),
    transport: http(chain.rpcUrl, { timeout: 15_000 }),
  });
  return {
    getBlockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    async getFamilyDeployedLogs(from, to): Promise<FamilyDeployedLog[]> {
      const logs = await client.getLogs({
        address: chain.deployer,
        event: familyDeployedEvent,
        fromBlock: from,
        toBlock: to,
      });
      return parseEventLogs({
        abi: [familyDeployedEvent],
        logs,
      }).map((l) => ({
        txHash: l.transactionHash,
        logIndex: l.logIndex,
        familyId: l.args.familyId,
      }));
    },
    async getVoteCastLogs(addresses, from, to): Promise<VoteCastLog[]> {
      const logs = await client.getLogs({
        address: addresses,
        event: crossChainVoteCastEvent,
        fromBlock: from,
        toBlock: to,
      });
      return parseEventLogs({
        abi: [crossChainVoteCastEvent],
        logs,
      }).map((l) => ({
        txHash: l.transactionHash,
        logIndex: l.logIndex,
        votingModule: getAddress(l.address),
        voter: l.args.voter,
        points: [...l.args.points],
        recipients: [...l.args.recipients],
        nonce: l.args.nonce,
        deadline: l.args.deadline,
        signature: l.args.signature,
      }));
    },
    async getRegistryLogs(addresses, from, to): Promise<RegistryLog[]> {
      // One getLogs per registry event type (viem filters on a single event's
      // topic0); all bounded by the caller's window + bisect.
      const [updated, created, voted] = await Promise.all([
        client.getLogs({
          address: addresses,
          event: crossChainRegistryUpdatedEvent,
          fromBlock: from,
          toBlock: to,
        }),
        client.getLogs({
          address: addresses,
          event: crossChainProposalCreatedEvent,
          fromBlock: from,
          toBlock: to,
        }),
        client.getLogs({
          address: addresses,
          event: crossChainProposalVoteCastEvent,
          fromBlock: from,
          toBlock: to,
        }),
      ]);
      const out: RegistryLog[] = [];
      for (const l of parseEventLogs({
        abi: [crossChainRegistryUpdatedEvent],
        logs: updated,
      })) {
        out.push({
          kind: "registry-update",
          txHash: l.transactionHash,
          logIndex: l.logIndex,
          registry: getAddress(l.address),
          admin: l.args.admin,
          recipients: [...l.args.recipients],
          nonce: l.args.nonce,
          deadline: l.args.deadline,
          signature: l.args.signature,
        });
      }
      for (const l of parseEventLogs({
        abi: [crossChainProposalCreatedEvent],
        logs: created,
      })) {
        out.push({
          kind: "proposal",
          txHash: l.transactionHash,
          logIndex: l.logIndex,
          registry: getAddress(l.address),
          proposalKey: l.args.proposalKey,
          proposer: l.args.proposer,
          candidate: l.args.candidate,
          isAddition: l.args.isAddition,
          electorate: [...l.args.electorate],
          expiresAt: l.args.expiresAt,
          nonce: l.args.nonce,
          signature: l.args.signature,
        });
      }
      for (const l of parseEventLogs({
        abi: [crossChainProposalVoteCastEvent],
        logs: voted,
      })) {
        out.push({
          kind: "proposal-vote",
          txHash: l.transactionHash,
          logIndex: l.logIndex,
          registry: getAddress(l.address),
          proposalKey: l.args.proposalKey,
          voter: l.args.voter,
          deadline: l.args.deadline,
          signature: l.args.signature,
        });
      }
      return out;
    },
    readFamilyId(target: Address): Promise<Hex> {
      return client.readContract({
        address: target,
        abi: [
          {
            type: "function",
            name: "familyId",
            stateMutability: "view",
            inputs: [],
            outputs: [{ name: "", type: "bytes32" }],
          },
        ] as const,
        functionName: "familyId",
      });
    },
  };
}

async function main(): Promise<void> {
  const watch = process.argv.includes("--watch");
  const config = loadConfig();

  const pk = process.env.RELAY_PRIVATE_KEY;
  if (!pk) {
    throw new Error(
      "RELAY_PRIVATE_KEY is required (a low-value hot key that only pays gas)",
    );
  }
  const account = privateKeyToAccount(pk as Hex);
  log("relay", `relay account ${account.address}`);

  const store = new Store(config.dbPath);
  const gasBudget = new GasBudget(
    store,
    new Map(config.chains.map((c) => [c.chainId, c.dailyGasBudgetWei])),
  );

  const accessByChain = new Map(
    config.chains.map((c) => [
      c.chainId,
      createChainAccess({
        chainId: c.chainId,
        name: c.name,
        rpcUrl: c.rpcUrl,
        account,
      }),
    ]),
  );

  const families = new Families(
    store,
    config.chains.map((c) => ({
      chainId: c.chainId,
      name: c.name,
      deployer: c.deployer,
      access: accessByChain.get(c.chainId)!,
    })),
    config.familyCacheTtlMs,
  );

  const workers = new Map<number, ChainWorker>();
  for (const chain of config.chains) {
    const access = accessByChain.get(chain.chainId)!;
    const worker = new ChainWorker({
      chainId: chain.chainId,
      chainName: chain.name,
      store,
      access,
      nonces: new NonceManager(() =>
        access.getPendingTransactionCount(account.address),
      ),
      gasBudget,
      resolveInstance: (familyId) => families.instance(familyId, chain.chainId),
    });
    workers.set(chain.chainId, worker);
    worker.start();
  }

  /** Fan a family's unexpired actions (all kinds) out as jobs on every found chain. */
  async function fanOutFamily(familyId: Hex): Promise<void> {
    const siblings = await families.resolve(familyId);
    const nowSec = Math.floor(Date.now() / 1000);
    const actions = store.unexpiredActions(familyId, nowSec);
    for (const action of actions) {
      for (const [chainId, res] of siblings) {
        if (res.status !== "found") continue;
        if (store.ensureJob(action.id, chainId)) {
          workers.get(chainId)?.kick();
        }
      }
    }
  }

  const listeners: ChainListener[] = [];
  if (watch) {
    for (const chain of config.chains) {
      const listener = new ChainListener({
        chainId: chain.chainId,
        chainName: chain.name,
        store,
        rpc: makeListenerRpc(chain),
        confirmations: BigInt(chain.confirmations),
        maxLogRange: BigInt(chain.maxLogRange),
        onFamilyDeployed: async (familyId, chainId) => {
          // Listener-seen FamilyDeployed invalidates the cache (spec B.5),
          // then backfills jobs so still-valid ballots reach the new sibling.
          families.invalidate(familyId, chainId);
          await families.resolveChain(familyId, chainId, { force: true });
          await fanOutFamily(familyId);
        },
        onActionsIngested: async (familyIds) => {
          // A listener-ingested action landed on its origin chain; fan the
          // family's unexpired actions out as jobs on every sibling and kick
          // them (mirrors the API's fanOutFamily — kicking alone does nothing
          // until sibling jobs exist).
          for (const familyId of familyIds) await fanOutFamily(familyId);
        },
      });
      listeners.push(listener);
      listener.start();
    }
    log("relay", `listener mode ON (${listeners.length} chains)`);
  }

  const app = createApp({
    store,
    families,
    chains: config.chains.map((c): ServerChain => ({
      chainId: c.chainId,
      name: c.name,
      access: accessByChain.get(c.chainId)!,
      worker: workers.get(c.chainId)!,
    })),
    rateLimiter: new TokenBucket(
      config.rateLimit.capacity,
      config.rateLimit.refillPerMinute,
    ),
    relayAccount: account.address,
  });

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    log("relay", `HTTP API listening on :${info.port}`, {
      chains: config.chains.map((c) => c.name),
      watch,
    });
  });

  const shutdown = async () => {
    log("relay", "shutting down");
    server.close();
    await Promise.all([...workers.values()].map((w) => w.stop()));
    await Promise.all(listeners.map((l) => l.stop()));
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  warn("relay", `fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
