"use client";

import { useState } from "react";
import {
  CheckCircle,
  Warning,
  SpinnerGap,
  ArrowSquareOut,
  MinusCircle,
  ArrowsClockwise,
  Copy,
  Check,
} from "@phosphor-icons/react";
import { Caption } from "@breadcoop/ui";
import { shortChainName, txUrl } from "@/lib/chains";
import { copyToClipboard } from "@/lib/utils";
import type {
  ChainVoteRow,
  CrossChainVotePhase,
  CrossChainVoteState,
} from "@/hooks/use-cross-chain-vote";
import type { SignedVotePayload } from "@/lib/vote-signature";

const SETTLED = new Set<CrossChainVoteState>(["confirmed", "superseded"]);

/** A row is "counted" once the chain has recorded the (or a newer) vote. */
function isCounted(state: CrossChainVoteState): boolean {
  return SETTLED.has(state);
}

/** Human copy for each per-chain terminal/interim state. */
function stateLabel(row: ChainVoteRow): string {
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

function RowIcon({ state }: { state: CrossChainVoteState }) {
  if (state === "confirmed")
    return (
      <CheckCircle size={18} weight="fill" className="text-system-green" />
    );
  if (state === "superseded")
    return (
      <CheckCircle size={18} weight="fill" className="text-surface-grey" />
    );
  if (state === "skipped_no_power")
    return <MinusCircle size={18} className="text-surface-grey" />;
  if (state === "awaiting_submission")
    return <Warning size={18} weight="fill" className="text-system-warning" />;
  if (
    state === "failed" ||
    state === "recipient_mismatch" ||
    state === "unreachable"
  )
    return <Warning size={18} weight="fill" className="text-system-red" />;
  return <SpinnerGap size={18} className="text-surface-grey-2 animate-spin" />;
}

function textClass(state: CrossChainVoteState): string {
  if (state === "confirmed") return "text-system-green";
  if (state === "awaiting_submission") return "text-system-warning";
  if (
    state === "failed" ||
    state === "recipient_mismatch" ||
    state === "unreachable"
  )
    return "text-system-red";
  return "text-surface-grey-2";
}

/**
 * Multi-chain delivery status in the TxStatus visual grammar, one stacked row
 * per chain. Partial success ("Vote counted on K of N chains") is a first-class
 * terminal state: a chain that skipped for no-power or drift is not a failure.
 * Failed rows carry remediation (Retry via relay / Submit from wallet), and the
 * whole signed vote is copyable so anyone can deliver it.
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
  const [copied, setCopied] = useState(false);
  if (phase === "idle" || rows.length === 0) return null;

  const active = rows.filter((r) => r.state !== "skipped_no_power");
  const counted = active.filter((r) => isCounted(r.state)).length;
  const total = active.length;

  const aggregate =
    phase === "signing"
      ? "Confirm in your wallet…"
      : phase === "done"
        ? `Vote counted on ${counted} of ${total} chain${total === 1 ? "" : "s"}`
        : relayDown
          ? `Vote counted on ${counted} of ${total} chain${total === 1 ? "" : "s"}`
          : `Relaying to ${total} chain${total === 1 ? "" : "s"}…`;

  const needsRemediation = (state: CrossChainVoteState) =>
    state === "failed" ||
    state === "recipient_mismatch" ||
    state === "unreachable" ||
    state === "awaiting_submission";

  const anyFailed = rows.some((r) => needsRemediation(r.state));

  const copyPayload = async () => {
    if (!payload) return;
    if (await copyToClipboard(JSON.stringify(payload, null, 2))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <div className="border-paper-2 bg-paper-0 mt-4 rounded-xl border p-4">
      <p className="text-text-standard flex items-center gap-2 text-sm font-semibold">
        {phase !== "done" && (
          <SpinnerGap size={16} className="text-surface-grey-2 animate-spin" />
        )}
        {aggregate}
      </p>

      <ul className="mt-3 space-y-2">
        {rows.map((row) => (
          <li key={row.chainId} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5 flex-none">
              <RowIcon state={row.state} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-text-standard font-medium">
                  {shortChainName(row.chainId)}
                </span>
                {isCounted(row.state) && row.txHash && (
                  <a
                    href={txUrl(row.txHash, row.chainId)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-core-orange inline-flex flex-none items-center gap-1 text-xs hover:underline"
                  >
                    View <ArrowSquareOut size={12} />
                  </a>
                )}
              </div>
              <span className={`block text-xs ${textClass(row.state)}`}>
                {stateLabel(row)}
              </span>

              {/* Per-row remediation for a chain that hasn't landed. */}
              {needsRemediation(row.state) && (
                <div className="mt-1 flex flex-wrap gap-3">
                  {!relayDown && (
                    <button
                      type="button"
                      onClick={onRetryRelay}
                      className="text-core-orange inline-flex items-center gap-1 text-xs font-semibold hover:underline"
                    >
                      <ArrowsClockwise size={12} weight="bold" /> Retry via
                      relay
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onSubmitOnChain(row.chainId)}
                    disabled={submitting === row.chainId}
                    className="text-core-orange inline-flex items-center gap-1 text-xs font-semibold hover:underline disabled:opacity-50"
                  >
                    {submitting === row.chainId ? (
                      <SpinnerGap size={12} className="animate-spin" />
                    ) : null}
                    Submit on {shortChainName(row.chainId)}
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>

      {(relayDown || anyFailed) && payload && (
        <div className="border-paper-2 mt-3 border-t pt-3">
          <button
            type="button"
            onClick={copyPayload}
            className={`inline-flex items-center gap-1.5 text-sm font-semibold ${
              copied ? "text-system-green" : "text-core-orange"
            } hover:underline`}
          >
            {copied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy signed vote"}
          </button>
          <Caption className="text-surface-grey mt-1 block">
            Anyone can deliver this — paste it to your community.
          </Caption>
        </div>
      )}
    </div>
  );
}
