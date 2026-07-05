import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { isAddress, isHex, type Address, type Hex } from "viem";
import { z } from "zod";
import { resolveTarget, type ChainAccess } from "./chain-access.js";
import type { Families, SiblingResolution } from "./families.js";
import { errorMessage } from "./log.js";
import type { TokenBucket } from "./rate-limit.js";
import type {
  ActionKind,
  ActionRow,
  JobRow,
  NewAction,
  Store,
} from "./store.js";
import {
  computeProposalKey,
  verifyCrossChainProposal,
  verifyCrossChainProposalVote,
  verifyCrossChainRegistryUpdate,
  verifyCrossChainVote,
} from "./typed-data.js";
import type { ChainWorker } from "./worker.js";

const hex32 = z
  .string()
  .refine((v): v is Hex => isHex(v) && v.length === 66, "expected bytes32 hex");
const addressSchema = z
  .string()
  .refine((v): v is Address => isAddress(v), "expected address");
const uintString = z.string().regex(/^\d{1,78}$/, "expected decimal uint256");
const signatureSchema = z
  .string()
  .refine((v): v is Hex => isHex(v), "expected hex signature")
  .refine((v) => v.length <= 2 + 2 * 512, "signature too large");

/** Vote body — numbers as decimal strings, sizes bounded (spec B.3). */
const voteBodySchema = z
  .object({
    kind: z.literal("vote").optional(),
    familyId: hex32,
    voter: addressSchema,
    points: z.array(uintString).min(1).max(64),
    recipients: z.array(addressSchema).min(1).max(64),
    nonce: uintString,
    deadline: uintString,
    signature: signatureSchema,
  })
  .refine((v) => v.points.length === v.recipients.length, {
    message: "points/recipients length mismatch",
  });

/** Admin desired-set registry update — recipients bounded to MAX_QUEUE_SIZE. */
const registryUpdateBodySchema = z.object({
  kind: z.literal("registry-update"),
  familyId: hex32,
  admin: addressSchema,
  recipients: z.array(addressSchema).min(1).max(100),
  nonce: uintString,
  deadline: uintString,
  signature: signatureSchema,
});

/** Democratic cross-chain proposal — electorate bounded like recipients. */
const proposalBodySchema = z.object({
  kind: z.literal("proposal"),
  familyId: hex32,
  proposer: addressSchema,
  candidate: addressSchema,
  isAddition: z.boolean(),
  electorate: z.array(addressSchema).min(1).max(64),
  expiresAt: uintString,
  nonce: uintString,
  signature: signatureSchema,
});

/** Vote on a democratic cross-chain proposal (no nonce; keyed by proposalKey). */
const proposalVoteBodySchema = z.object({
  kind: z.literal("proposal-vote"),
  familyId: hex32,
  voter: addressSchema,
  proposalKey: hex32,
  deadline: uintString,
  signature: signatureSchema,
});

/** Non-vote body union (POST /v1/action accepts these plus the vote shape). */
const registryActionSchema = z.discriminatedUnion("kind", [
  registryUpdateBodySchema,
  proposalBodySchema,
  proposalVoteBodySchema,
]);

type VoteBody = z.infer<typeof voteBodySchema>;
type RegistryUpdateBody = z.infer<typeof registryUpdateBodySchema>;
type ProposalBody = z.infer<typeof proposalBodySchema>;
type ProposalVoteBody = z.infer<typeof proposalVoteBodySchema>;

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
  target?: Address;
  state: string;
  txHash?: Hex;
  error?: string;
  detail?: string;
}

/** A validated action ready to persist + verify (post-schema, pre-signature). */
interface PreparedAction {
  kind: ActionKind;
  familyId: Hex;
  signer: Address;
  dedupKey: string;
  new: NewAction;
  verify: () => Promise<boolean>;
  /** Latest time bound in seconds for the "deadline in the past" gate. */
  timeBound: bigint;
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

  // ── POST /v1/vote — vote-shaped alias for POST /v1/action ────────────────
  app.post("/v1/vote", (c) => handlePost(c, "vote"));

  // ── POST /v1/action — any kind (zod discriminated union) ─────────────────
  app.post("/v1/action", (c) => handlePost(c, "any"));

  /** Shared POST handler: `mode` gates whether a plain vote body is accepted. */
  async function handlePost(c: Context, mode: "vote" | "any") {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    const prepared = prepareAction(body, mode);
    if ("error" in prepared) {
      return c.json({ error: prepared.error, issues: prepared.issues }, 400);
    }
    const action = prepared.value;

    if (action.timeBound < BigInt(Math.floor(now() / 1000))) {
      return c.json({ error: "deadline in the past" }, 400);
    }

    // Local EIP-712 pre-check (pure ECDSA; the chain is the authority).
    if (!(await action.verify())) {
      return c.json({ error: "invalid signature" }, 400);
    }

    const siblings = await families.resolve(action.familyId);
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
    const { id } = store.upsertAction(action.new);
    for (const [chainId] of foundChains) {
      store.ensureJob(id, chainId);
      byId.get(chainId)?.worker.kick();
    }

    const stored = store.getActionById(id);
    return c.json(
      {
        kind: action.kind,
        familyId: action.familyId,
        signer: action.signer,
        dedupKey: action.dedupKey,
        chains: chainStatuses(store, stored, siblings),
      },
      202,
    );
  }

  // ── GET /v1/vote-status — vote-shaped alias for /v1/action-status ────────
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
    return actionStatus(c, {
      familyId: familyId as Hex,
      kind: "vote",
      signer: voter as Address,
      dedupKey: nonce,
    });
  });

  // ── GET /v1/action-status — any kind ─────────────────────────────────────
  app.get("/v1/action-status", async (c) => {
    const familyId = c.req.query("familyId");
    const kind = c.req.query("kind");
    const signer = c.req.query("signer");
    const dedupKey = c.req.query("dedupKey");
    if (
      !familyId ||
      !hex32.safeParse(familyId).success ||
      !kind ||
      !isActionKind(kind) ||
      !signer ||
      !addressSchema.safeParse(signer).success ||
      !dedupKey
    ) {
      return c.json(
        { error: "familyId, kind, signer, dedupKey query params required" },
        400,
      );
    }
    // vote/registry-update dedupKey is a decimal nonce; proposal(-vote) a bytes32.
    const dedupOk =
      kind === "proposal" || kind === "proposal-vote"
        ? hex32.safeParse(dedupKey).success
        : uintString.safeParse(dedupKey).success;
    if (!dedupOk) {
      return c.json({ error: "invalid dedupKey for kind" }, 400);
    }
    return actionStatus(c, {
      familyId: familyId as Hex,
      kind,
      signer: signer as Address,
      dedupKey,
    });
  });

  /** Shared status: store hit → job states; store miss → chain reconstruction. */
  async function actionStatus(
    c: Context,
    q: { familyId: Hex; kind: ActionKind; signer: Address; dedupKey: string },
  ) {
    const stored = store.getAction(q.familyId, q.kind, q.signer, q.dedupKey);
    const siblings = await families.resolve(q.familyId);
    if (stored) {
      return c.json({
        ...q,
        chains: chainStatuses(store, stored, siblings),
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
      const target = resolveTarget(q.kind, res.instance);
      let state = "unknown";
      let error: string | undefined;
      if (chain) {
        try {
          const landed = await reconstructLanded(chain.access, q, target);
          state = landed ? "landed" : "unknown";
        } catch (e) {
          state = "unreachable";
          error = errorMessage(e);
        }
      }
      statuses.push({
        chainId,
        target,
        state,
        ...(error ? { error } : {}),
      });
    }
    return c.json({ ...q, chains: statuses });
  }

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

function isActionKind(k: string): k is ActionKind {
  return (
    k === "vote" ||
    k === "registry-update" ||
    k === "proposal" ||
    k === "proposal-vote"
  );
}

/**
 * Validate + normalize a POST body into a PreparedAction. In "vote" mode only a
 * vote body is accepted; in "any" mode a vote body (kind absent or "vote") or a
 * registry-action union member is accepted.
 */
function prepareAction(
  body: unknown,
  mode: "vote" | "any",
): { value: PreparedAction } | { error: string; issues?: z.ZodIssue[] } {
  const kind =
    body && typeof body === "object" && "kind" in body
      ? (body as { kind?: unknown }).kind
      : undefined;

  if (mode === "vote" || kind === undefined || kind === "vote") {
    const parsed = voteBodySchema.safeParse(body);
    if (!parsed.success)
      return { error: "invalid vote", issues: parsed.error.issues };
    return { value: fromVote(parsed.data) };
  }

  const parsed = registryActionSchema.safeParse(body);
  if (!parsed.success)
    return { error: "invalid action", issues: parsed.error.issues };
  switch (parsed.data.kind) {
    case "registry-update":
      return { value: fromRegistryUpdate(parsed.data) };
    case "proposal":
      return { value: fromProposal(parsed.data) };
    case "proposal-vote":
      return { value: fromProposalVote(parsed.data) };
  }
}

function fromVote(v: VoteBody): PreparedAction {
  const msg = {
    voter: v.voter,
    points: v.points.map(BigInt),
    recipients: v.recipients,
    nonce: BigInt(v.nonce),
    deadline: BigInt(v.deadline),
  };
  return {
    kind: "vote",
    familyId: v.familyId,
    signer: v.voter,
    dedupKey: v.nonce,
    timeBound: BigInt(v.deadline),
    verify: () => verifyCrossChainVote(v.familyId, msg, v.signature),
    new: {
      kind: "vote",
      familyId: v.familyId,
      voter: v.voter,
      nonce: v.nonce,
      deadline: v.deadline,
      points: v.points,
      recipients: v.recipients,
      signature: v.signature,
    },
  };
}

function fromRegistryUpdate(v: RegistryUpdateBody): PreparedAction {
  const msg = {
    admin: v.admin,
    recipients: v.recipients,
    nonce: BigInt(v.nonce),
    deadline: BigInt(v.deadline),
  };
  return {
    kind: "registry-update",
    familyId: v.familyId,
    signer: v.admin,
    dedupKey: v.nonce,
    timeBound: BigInt(v.deadline),
    verify: () => verifyCrossChainRegistryUpdate(v.familyId, msg, v.signature),
    new: {
      kind: "registry-update",
      familyId: v.familyId,
      admin: v.admin,
      recipients: v.recipients,
      nonce: v.nonce,
      deadline: v.deadline,
      signature: v.signature,
    },
  };
}

function fromProposal(v: ProposalBody): PreparedAction {
  const msg = {
    proposer: v.proposer,
    candidate: v.candidate,
    isAddition: v.isAddition,
    electorate: v.electorate,
    expiresAt: BigInt(v.expiresAt),
    nonce: BigInt(v.nonce),
  };
  const proposalKey = computeProposalKey(msg);
  return {
    kind: "proposal",
    familyId: v.familyId,
    signer: v.proposer,
    dedupKey: proposalKey,
    // A proposal is bounded by its absolute expiresAt, not a deadline.
    timeBound: BigInt(v.expiresAt),
    verify: () => verifyCrossChainProposal(v.familyId, msg, v.signature),
    new: {
      kind: "proposal",
      familyId: v.familyId,
      proposer: v.proposer,
      candidate: v.candidate,
      isAddition: v.isAddition,
      electorate: v.electorate,
      expiresAt: v.expiresAt,
      nonce: v.nonce,
      proposalKey,
      signature: v.signature,
    },
  };
}

function fromProposalVote(v: ProposalVoteBody): PreparedAction {
  const msg = {
    voter: v.voter,
    proposalKey: v.proposalKey,
    deadline: BigInt(v.deadline),
  };
  return {
    kind: "proposal-vote",
    familyId: v.familyId,
    signer: v.voter,
    dedupKey: v.proposalKey,
    timeBound: BigInt(v.deadline),
    verify: () => verifyCrossChainProposalVote(v.familyId, msg, v.signature),
    new: {
      kind: "proposal-vote",
      familyId: v.familyId,
      voter: v.voter,
      proposalKey: v.proposalKey,
      deadline: v.deadline,
      signature: v.signature,
    },
  };
}

/** Per-kind "did the intended effect land on this chain?" reconstruction read. */
async function reconstructLanded(
  access: ChainAccess,
  q: { kind: ActionKind; signer: Address; dedupKey: string },
  target: Address,
): Promise<boolean> {
  switch (q.kind) {
    case "vote": {
      const last = await access.lastCrossChainNonce(target, q.signer);
      return last >= BigInt(q.dedupKey);
    }
    case "registry-update": {
      const last = await access.lastRegistryUpdateNonce(target);
      return last >= BigInt(q.dedupKey);
    }
    case "proposal": {
      const p = await access.getCrossChainProposal(target, q.dedupKey as Hex);
      return p !== undefined;
    }
    case "proposal-vote": {
      const p = await access.getCrossChainProposal(target, q.dedupKey as Hex);
      if (p?.executed) return true;
      return access.hasVotedCrossChain(target, q.dedupKey as Hex, q.signer);
    }
  }
}

/** Response rows for an action across chains: job states + sibling context. */
function chainStatuses(
  store: Store,
  action: ActionRow | undefined,
  siblings: Map<number, SiblingResolution>,
): ChainStatus[] {
  const jobs: JobRow[] = action ? store.jobsForAction(action.id) : [];
  const jobByChain = new Map(jobs.map((j) => [j.chainId, j]));
  const rows: ChainStatus[] = [];
  for (const [chainId, res] of siblings) {
    const job = jobByChain.get(chainId);
    const target =
      res.status === "found" && action
        ? resolveTarget(action.kind, res.instance)
        : undefined;
    if (job) {
      rows.push({
        chainId,
        ...(target ? { target } : {}),
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
