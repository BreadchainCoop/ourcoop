import type { Hex } from "viem";

/**
 * Shared per-chain delivery model for every sign-once cross-chain action (votes,
 * admin registry updates, democratic proposals + proposal votes). One signature
 * is submitted to every sibling chain from the browser — gaslessly via Privy gas
 * sponsorship, or a self-paid wallet tx — and settlement is always confirmed by
 * an ON-CHAIN read (anyone can also deliver the copied payload). Partial success
 * is a first-class terminal state, remediable per row.
 */

/** Per-chain delivery state for one signed action. */
export type CrossChainActionState =
  | "idle"
  | "signing"
  // In flight: being submitted to this chain (sponsored or self-paid).
  | "relaying"
  | "submitted"
  | "confirmed"
  | "superseded"
  | "skipped_no_power"
  | "recipient_mismatch"
  | "unreachable"
  | "failed";

export interface ChainActionRow {
  chainId: number;
  state: CrossChainActionState;
  txHash?: Hex;
  error?: string;
}

export type CrossChainActionPhase = "idle" | "signing" | "settling" | "done";

/** States no settle tick or advisory update should move a row out of. */
export const CROSS_CHAIN_TERMINAL = new Set<CrossChainActionState>([
  "confirmed",
  "superseded",
  "skipped_no_power",
  "recipient_mismatch",
  "unreachable",
  "failed",
]);

/** A chain has recorded the action (or a newer one supersedes it). */
export const CROSS_CHAIN_SETTLED = new Set<CrossChainActionState>([
  "confirmed",
  "superseded",
]);

/** A row that still needs the user's help (retry from wallet). */
export function needsRemediation(state: CrossChainActionState): boolean {
  return (
    state === "failed" ||
    state === "recipient_mismatch" ||
    state === "unreachable"
  );
}
