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
    case "awaiting_submission":
      return "Relay unavailable — submit from your wallet";
    case "failed":
      return row.error ?? "Delivery failed";
    case "submitted":
      return "Submitted — confirming…";
    case "relaying":
      return "Relaying…";
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
  relayDown,
  submitting,
  payload,
  onSubmitOnChain,
  onRetryRelay,
}: {
  rows: ChainVoteRow[];
  phase: CrossChainVotePhase;
  relayDown: boolean;
  submitting: number | null;
  payload: SignedVotePayload | null;
  onSubmitOnChain: (chainId: number) => void;
  onRetryRelay: () => void;
}) {
  return (
    <MultiChainActionStatus
      rows={rows}
      phase={phase}
      relayDown={relayDown}
      submitting={submitting}
      payload={payload}
      onSubmitOnChain={onSubmitOnChain}
      onRetryRelay={onRetryRelay}
      copy={{
        stateLabel,
        aggregate: ({ counted, total, phase, relayDown }) =>
          phase === "signing"
            ? "Confirm in your wallet…"
            : phase === "done" || relayDown
              ? `Vote counted on ${counted} of ${total} chain${
                  total === 1 ? "" : "s"
                }`
              : `Relaying to ${total} chain${total === 1 ? "" : "s"}…`,
        copyLabel: "Copy signed vote",
        copyHint: "Anyone can deliver this — paste it to your community.",
      }}
    />
  );
}
