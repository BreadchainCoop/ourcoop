import type { Address, Hex } from "viem";
import type { SignedVotePayload } from "@/lib/vote-signature";

/**
 * Thin client for the vote relay's HTTP API. Multiple relays can be
 * configured; every call fans out to all of them and merges per chain, so one
 * healthy relay is enough. The relay is ADVISORY only — vote settlement is
 * always confirmed by reading lastCrossChainNonce on-chain (the relay can
 * censor, never forge; anyone can deliver a signed vote themselves).
 */

// NOTE: static literal — Next only inlines `process.env.NEXT_PUBLIC_X`
// literals into the client bundle (see chains.ts).
const RELAY_URLS_RAW = process.env.NEXT_PUBLIC_RELAY_URLS;

/** Configured relay base URLs (comma-separated env list). */
export const RELAY_URLS: string[] = (RELAY_URLS_RAW ?? "")
  .split(",")
  .map((u) => u.trim().replace(/\/+$/, ""))
  .filter(Boolean);

export function relayConfigured(): boolean {
  return RELAY_URLS.length > 0;
}

/** Per-chain delivery states reported by the relay (jobs table). */
export type RelayJobState =
  | "pending"
  | "submitted"
  | "confirmed"
  | "landed"
  | "superseded"
  | "skipped_no_power"
  | "recipient_mismatch"
  | "expired"
  | "failed";

export interface RelayChainStatus {
  chainId: number;
  votingModule?: Address;
  state: RelayJobState;
  txHash?: Hex;
  error?: string;
}

export interface RelayVoteStatus {
  chains: RelayChainStatus[];
}

const FETCH_TIMEOUT_MS = 8_000;

async function relayFetch(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<RelayVoteStatus> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 202) {
    throw new Error(`relay ${base} → HTTP ${res.status}`);
  }
  return (await res.json()) as RelayVoteStatus;
}

// How "settled" a relay-reported state is — merging keeps the strongest per
// chain across relays (any relay having delivered is enough).
const STATE_RANK: Record<RelayJobState, number> = {
  confirmed: 7,
  landed: 6,
  superseded: 5,
  submitted: 4,
  recipient_mismatch: 3,
  skipped_no_power: 2,
  pending: 1,
  expired: 0,
  failed: 0,
};

function mergeStatuses(results: RelayVoteStatus[]): RelayVoteStatus | null {
  if (results.length === 0) return null;
  const byChain = new Map<number, RelayChainStatus>();
  for (const result of results) {
    for (const chain of result.chains ?? []) {
      const prev = byChain.get(chain.chainId);
      if (!prev || STATE_RANK[chain.state] > STATE_RANK[prev.state]) {
        byChain.set(chain.chainId, chain);
      }
    }
  }
  return { chains: [...byChain.values()] };
}

async function fanOut(
  path: string,
  init?: RequestInit,
): Promise<RelayVoteStatus | null> {
  const settled = await Promise.allSettled(
    RELAY_URLS.map((base) => relayFetch(base, path, init)),
  );
  const ok = settled
    .filter((r): r is PromiseFulfilledResult<RelayVoteStatus> =>
      Boolean(r.status === "fulfilled" && r.value?.chains),
    )
    .map((r) => r.value);
  // null = every relay failed → callers fall back to wallet self-submission.
  return mergeStatuses(ok);
}

/** POST the signed vote to every relay. null → no relay reachable. */
export function postVote(
  payload: SignedVotePayload,
): Promise<RelayVoteStatus | null> {
  if (!relayConfigured()) return Promise.resolve(null);
  return fanOut("/v1/vote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** Advisory delivery status (txHash, skip reasons). null → no relay reachable. */
export function getVoteStatus(
  familyId: Hex,
  voter: Address,
  nonce: bigint,
): Promise<RelayVoteStatus | null> {
  if (!relayConfigured()) return Promise.resolve(null);
  const q = new URLSearchParams({
    familyId,
    voter,
    nonce: nonce.toString(),
  });
  return fanOut(`/v1/vote-status?${q}`);
}

export interface RelayHealth {
  ok: boolean;
  chains: {
    chainId: number;
    rpcOk: boolean;
    balanceWei: string;
    queueDepth: number;
  }[];
}

/** First healthy relay's /healthz, or null when none respond. */
export async function getHealth(): Promise<RelayHealth | null> {
  for (const base of RELAY_URLS) {
    try {
      const res = await fetch(`${base}/healthz`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) return (await res.json()) as RelayHealth;
    } catch {
      /* try the next relay */
    }
  }
  return null;
}
