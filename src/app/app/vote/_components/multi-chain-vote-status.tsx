"use client";

import { MultiChainActionStatus } from "@/components/dapp/multi-chain-action-status";
import type { ChainActionRow } from "@/lib/cross-chain-action";
import type {
  ChainVoteRow,
  CrossChainVotePhase,
} from "@/hooks/use-cross-chain-vote";
import type { SignedVotePayload } from "@/lib/vote-signature";

/** Human copy for each per-chain vote state (delegates to the shared component). */
function stateLabel(row: ChainActionRow): string {
  switch (row.state) {
    case "confirmed":
      return "Vote counted";
    case "superseded":
      return "Superseded by a newer vote";
    case "skipped_no_power":
      return "Skipped — no voting power here";
    case "recipient_mismatch":
      return "Recipient list out of sync";
    case "unreachable":
      return "Couldn't reach chain";
    case "failed":
      return row.error ?? "Delivery failed";
    case "submitted":
      return "Submitted — confirming…";
    case "relaying":
      return "Submitting…";
    case "signing":
      return "Waiting for your signature…";
    default:
      return "Waiting…";
  }
}

/**
 * Multi-chain vote delivery status — a thin adapter over the generic
 * MultiChainActionStatus so the vote page renders identically to before.
 */
export function MultiChainVoteStatus({
  rows,
  phase,
  submitting,
  payload,
  onSubmitOnChain,
  onRetryFailed,
}: {
  rows: ChainVoteRow[];
  phase: CrossChainVotePhase;
  submitting: number | null;
  payload: SignedVotePayload | null;
  onSubmitOnChain: (chainId: number) => void;
  onRetryFailed?: () => void;
}) {
  return (
    <MultiChainActionStatus
      rows={rows}
      phase={phase}
      submitting={submitting}
      payload={payload}
      onSubmitOnChain={onSubmitOnChain}
      onRetryFailed={onRetryFailed}
      copy={{
        stateLabel,
        aggregate: ({ counted, total, phase }) =>
          phase === "signing"
            ? "Confirm in your wallet…"
            : phase === "done"
              ? `Vote counted on ${counted} of ${total} chain${
                  total === 1 ? "" : "s"
                }`
              : `Submitting to ${total} chain${total === 1 ? "" : "s"}…`,
        copyLabel: "Copy signed vote",
        copyHint: "Anyone can deliver this — paste it to your community.",
      }}
    />
  );
}
