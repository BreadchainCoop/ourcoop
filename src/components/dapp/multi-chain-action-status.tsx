"use client";

import { useState } from "react";
import {
  CheckCircle,
  Warning,
  SpinnerGap,
  ArrowSquareOut,
  MinusCircle,
  ArrowClockwise,
  Copy,
  Check,
} from "@phosphor-icons/react";
import { Caption } from "@breadcoop/ui";
import { shortChainName, txUrl } from "@/lib/chains";
import { copyToClipboard } from "@/lib/utils";
import {
  CROSS_CHAIN_SETTLED,
  needsRemediation,
  type ChainActionRow,
  type CrossChainActionPhase,
  type CrossChainActionState,
} from "@/lib/cross-chain-action";

/** A row is "counted" once the chain has recorded the (or a newer) action. */
function isCounted(state: CrossChainActionState): boolean {
  return CROSS_CHAIN_SETTLED.has(state);
}

function RowIcon({ state }: { state: CrossChainActionState }) {
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
  if (
    state === "failed" ||
    state === "recipient_mismatch" ||
    state === "unreachable"
  )
    return <Warning size={18} weight="fill" className="text-system-red" />;
  return <SpinnerGap size={18} className="text-surface-grey-2 animate-spin" />;
}

function textClass(state: CrossChainActionState): string {
  if (state === "confirmed") return "text-system-green";
  if (
    state === "failed" ||
    state === "recipient_mismatch" ||
    state === "unreachable"
  )
    return "text-system-red";
  return "text-surface-grey-2";
}

/** How to phrase this action's shared per-chain / aggregate copy. */
export interface ActionStatusCopy {
  /** Per-chain interim/terminal label (falls back to a sensible default). */
  stateLabel: (row: ChainActionRow) => string;
  /** Aggregate line, e.g. "Vote counted on 2 of 3 chains". */
  aggregate: (args: {
    counted: number;
    total: number;
    phase: CrossChainActionPhase;
  }) => string;
  /** The "Copy signed …" button label. */
  copyLabel: string;
  /** Text under the copy button. */
  copyHint: string;
}

/**
 * Multi-chain delivery status in the TxStatus visual grammar, one stacked row
 * per chain. Generic across every sign-once cross-chain action — the vote page,
 * the democratic recipients flows, and the admin "Sync everywhere" panel all
 * render this. Delivery is gas-sponsored from the browser (or a self-paid
 * wallet tx); partial success ("… on K of N chains") is a first-class terminal
 * state; a chain that skipped (no power / already synced) is not a failure.
 * A chain whose submission failed shows a per-row Retry (plus a "Retry all"
 * when several failed), and the whole signed payload is copyable so anyone can
 * deliver it.
 */
export function MultiChainActionStatus({
  rows,
  phase,
  submitting,
  payload,
  copy,
  onSubmitOnChain,
  onRetryFailed,
}: {
  rows: ChainActionRow[];
  phase: CrossChainActionPhase;
  submitting: number | null;
  /** The signed payload as JSON — the "anyone can deliver" hatch. */
  payload: unknown;
  copy: ActionStatusCopy;
  onSubmitOnChain: (chainId: number) => void;
  /** Retry every chain whose submission failed. */
  onRetryFailed?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (phase === "idle" || rows.length === 0) return null;

  const active = rows.filter((r) => r.state !== "skipped_no_power");
  const counted = active.filter((r) => isCounted(r.state)).length;
  const total = active.length;

  const aggregate = copy.aggregate({ counted, total, phase });
  const anyFailed = rows.some((r) => needsRemediation(r.state));
  const failedCount = rows.filter((r) => r.state === "failed").length;
  // Nothing is still in flight → the auto-fan-out has settled; a failed row is
  // now safe to retry (no double-submit racing an in-flight send).
  const settled = !rows.some(
    (r) => r.state === "relaying" || r.state === "signing",
  );

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
                {copy.stateLabel(row)}
              </span>

              {/* Per-row retry for a chain that hasn't landed. */}
              {needsRemediation(row.state) && (
                <div className="mt-1 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => onSubmitOnChain(row.chainId)}
                    disabled={submitting === row.chainId}
                    className="text-core-orange inline-flex items-center gap-1 text-xs font-semibold hover:underline disabled:opacity-50"
                  >
                    {submitting === row.chainId ? (
                      <SpinnerGap size={12} className="animate-spin" />
                    ) : (
                      <ArrowClockwise size={12} weight="bold" />
                    )}
                    Retry {shortChainName(row.chainId)}
                  </button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>

      {/* Retry every failed chain at once (submission failed — e.g. a sponsored
          send didn't go through). Only once nothing is still in flight. */}
      {settled && failedCount > 1 && onRetryFailed && (
        <div className="border-paper-2 mt-3 border-t pt-3">
          <button
            type="button"
            onClick={onRetryFailed}
            disabled={submitting !== null}
            className="text-core-orange inline-flex items-center gap-1.5 text-sm font-semibold hover:underline disabled:opacity-50"
          >
            <ArrowClockwise size={14} weight="bold" />
            Retry {failedCount} failed chains
          </button>
        </div>
      )}

      {anyFailed && payload != null && (
        <div className="border-paper-2 mt-3 border-t pt-3">
          <button
            type="button"
            onClick={copyPayload}
            className={`inline-flex items-center gap-1.5 text-sm font-semibold ${
              copied ? "text-system-green" : "text-core-orange"
            } hover:underline`}
          >
            {copied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
            {copied ? "Copied" : copy.copyLabel}
          </button>
          <Caption className="text-surface-grey mt-1 block">
            {copy.copyHint}
          </Caption>
        </div>
      )}
    </div>
  );
}
