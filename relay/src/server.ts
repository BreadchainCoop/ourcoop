import { Hono } from "hono";
import { cors } from "hono/cors";
import { isAddress, isHex, type Address, type Hex } from "viem";
import { z } from "zod";
import type { ChainAccess } from "./chain-access.js";
import type { Families } from "./families.js";
import { errorMessage } from "./log.js";
import type { TokenBucket } from "./rate-limit.js";
import type { JobRow, Store, VoteRow } from "./store.js";
import { verifyCrossChainVote } from "./typed-data.js";
import type { ChainWorker } from "./worker.js";

const hex32 = z
  .string()
  .refine((v): v is Hex => isHex(v) && v.length === 66, "expected bytes32 hex");
const addressSchema = z
  .string()
  .refine((v): v is Address => isAddress(v), "expected address");
const uintString = z.string().regex(/^\d{1,78}$/, "expected decimal uint256");

/** POST body — numbers as decimal strings, sizes bounded (spec B.3). */
const voteBodySchema = z
  .object({
    familyId: hex32,
    voter: addressSchema,
    points: z.array(uintString).min(1).max(64),
    recipients: z.array(addressSchema).min(1).max(64),
    nonce: uintString,
    deadline: uintString,
    signature: z
      .string()
      .refine((v): v is Hex => isHex(v), "expected hex signature")
      .refine((v) => v.length <= 2 + 2 * 512, "signature too large"),
  })
  .refine((v) => v.points.length === v.recipients.length, {
    message: "points/recipients length mismatch",
  });

export interface ServerChain {
  chainId: number;
  name: string;
  access: ChainAccess;
  worker: ChainWorker;
}

export interface ServerDeps {
  store: Store;
  families: Families;
  chains: ServerChain[];
  rateLimiter: TokenBucket;
  relayAccount: Address;
  now?: () => number;
}

interface ChainStatus {
  chainId: number;
  votingModule?: Address;
  state: string;
  txHash?: Hex;
  error?: string;
  detail?: string;
}

export function createApp(deps: ServerDeps) {
  const { store, families, chains, rateLimiter } = deps;
  const now = deps.now ?? Date.now;
  const byId = new Map(chains.map((c) => [c.chainId, c]));
  const app = new Hono();

  app.use("*", cors({ origin: "*" }));
  app.use("/v1/*", async (c, next) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    if (!rateLimiter.take(ip)) {
      return c.json({ error: "rate limited" }, 429);
    }
    await next();
  });

  // ── POST /v1/vote — persist intent; workers own delivery ────────────────
  app.post("/v1/vote", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = voteBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid vote", issues: parsed.error.issues },
        400,
      );
    }
    const vote = parsed.data;

    if (BigInt(vote.deadline) < BigInt(Math.floor(now() / 1000))) {
      return c.json({ error: "deadline in the past" }, 400);
    }

    // Local EIP-712 pre-check (pure ECDSA; the chain is the authority).
    const valid = await verifyCrossChainVote(
      vote.familyId,
      {
        voter: vote.voter,
        points: vote.points.map(BigInt),
        recipients: vote.recipients,
        nonce: BigInt(vote.nonce),
        deadline: BigInt(vote.deadline),
      },
      vote.signature,
    );
    if (!valid) return c.json({ error: "invalid signature" }, 400);

    const siblings = await families.resolve(vote.familyId);
    const foundChains = [...siblings.entries()].filter(
      ([, r]) => r.status === "found",
    );
    if (foundChains.length === 0) {
      return c.json(
        {
          error: "family not found on any enabled chain",
          chains: [...siblings.entries()].map(([chainId, r]) => ({
            chainId,
            state: r.status === "unreachable" ? "unreachable" : "no_instance",
            ...(r.status === "unreachable" ? { error: r.error } : {}),
          })),
        },
        404,
      );
    }

    // Durable intent BEFORE any submission; re-POST is a no-op upsert.
    const { id } = store.upsertVote({
      familyId: vote.familyId,
      voter: vote.voter,
      nonce: vote.nonce,
      deadline: vote.deadline,
      points: vote.points,
      recipients: vote.recipients,
      signature: vote.signature,
    });
    for (const [chainId] of foundChains) {
      store.ensureJob(id, chainId);
      byId.get(chainId)?.worker.kick();
    }

    return c.json(
      {
        familyId: vote.familyId,
        voter: vote.voter,
        nonce: vote.nonce,
        chains: chainStatuses(store, store.getVoteById(id), siblings),
      },
      202,
    );
  });

  // ── GET /v1/vote-status ──────────────────────────────────────────────────
  app.get("/v1/vote-status", async (c) => {
    const familyId = c.req.query("familyId");
    const voter = c.req.query("voter");
    const nonce = c.req.query("nonce");
    if (
      !familyId ||
      !hex32.safeParse(familyId).success ||
      !voter ||
      !addressSchema.safeParse(voter).success ||
      !nonce ||
      !uintString.safeParse(nonce).success
    ) {
      return c.json(
        { error: "familyId, voter, nonce query params required" },
        400,
      );
    }
    const fid = familyId as Hex;
    const addr = voter as Address;

    const vote = store.getVote(fid, addr, nonce);
    const siblings = await families.resolve(fid);
    if (vote) {
      return c.json({
        familyId: fid,
        voter: addr,
        nonce,
        chains: chainStatuses(store, vote, siblings),
      });
    }

    // Store miss: reconstruct from chain truth — never a UI dead-end.
    const statuses: ChainStatus[] = [];
    for (const [chainId, res] of siblings) {
      if (res.status !== "found") {
        statuses.push({
          chainId,
          state: res.status === "unreachable" ? "unreachable" : "no_instance",
          ...(res.status === "unreachable" ? { error: res.error } : {}),
        });
        continue;
      }
      const chain = byId.get(chainId);
      let state = "unknown";
      let error: string | undefined;
      if (chain) {
        try {
          const last = await chain.access.lastCrossChainNonce(
            res.instance.votingModule,
            addr,
          );
          // Landed on-chain (this nonce or a newer one) without our store
          // seeing it — confirmed-or-superseded; no txHash to report.
          state = last >= BigInt(nonce) ? "landed" : "unknown";
        } catch (e) {
          state = "unreachable";
          error = errorMessage(e);
        }
      }
      statuses.push({
        chainId,
        votingModule: res.instance.votingModule,
        state,
        ...(error ? { error } : {}),
      });
    }
    return c.json({ familyId: fid, voter: addr, nonce, chains: statuses });
  });

  // ── GET /v1/family/:familyId ─────────────────────────────────────────────
  app.get("/v1/family/:familyId", async (c) => {
    const familyId = c.req.param("familyId");
    if (!hex32.safeParse(familyId).success) {
      return c.json({ error: "invalid familyId" }, 400);
    }
    const siblings = await families.resolve(familyId as Hex);
    return c.json({
      familyId,
      siblings: [...siblings.entries()]
        .filter(([, r]) => r.status === "found")
        .map(([chainId, r]) => ({
          chainId,
          instance: r.status === "found" ? r.instance : undefined,
        })),
      chains: [...siblings.entries()].map(([chainId, r]) => ({
        chainId,
        status: r.status,
        ...(r.status === "unreachable" ? { error: r.error } : {}),
      })),
    });
  });

  // ── GET /healthz ─────────────────────────────────────────────────────────
  app.get("/healthz", async (c) => {
    const results = await Promise.all(
      chains.map(async (chain) => {
        let rpcOk = false;
        let headBlock: string | null = null;
        let balanceWei: string | null = null;
        try {
          const head = await chain.access.getBlockNumber();
          headBlock = head.toString();
          balanceWei = (
            await chain.access.getBalance(deps.relayAccount)
          ).toString();
          rpcOk = true;
        } catch {
          rpcOk = false;
        }
        const cursor = store.getCursor(chain.chainId);
        return {
          chainId: chain.chainId,
          name: chain.name,
          rpcOk,
          balanceWei,
          queueDepth: store.queueDepth(chain.chainId),
          listenerBlock: cursor === undefined ? null : cursor.toString(),
          headBlock,
        };
      }),
    );
    const ok = results.every((r) => r.rpcOk);
    return c.json({ ok, chains: results }, ok ? 200 : 503);
  });

  return app;
}

/** Response rows for a vote across chains: job states + sibling context. */
function chainStatuses(
  store: Store,
  vote: VoteRow | undefined,
  siblings: Map<
    number,
    { status: string; instance?: { votingModule: Address } }
  >,
): ChainStatus[] {
  const jobs: JobRow[] = vote ? store.jobsForVote(vote.id) : [];
  const jobByChain = new Map(jobs.map((j) => [j.chainId, j]));
  const rows: ChainStatus[] = [];
  for (const [chainId, res] of siblings) {
    const job = jobByChain.get(chainId);
    if (job) {
      rows.push({
        chainId,
        ...(res.instance ? { votingModule: res.instance.votingModule } : {}),
        state: job.state,
        ...(job.txHash ? { txHash: job.txHash } : {}),
        ...(job.lastError ? { detail: job.lastError } : {}),
      });
    } else {
      rows.push({
        chainId,
        state: res.status === "unreachable" ? "unreachable" : "no_instance",
      });
    }
    jobByChain.delete(chainId);
  }
  // Jobs on chains no longer in the sibling map (e.g. chain disabled later).
  for (const job of jobByChain.values()) {
    rows.push({
      chainId: job.chainId,
      state: job.state,
      ...(job.txHash ? { txHash: job.txHash } : {}),
    });
  }
  return rows.sort((a, b) => a.chainId - b.chainId);
}
