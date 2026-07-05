"use client";

import { CheckCircle, Warning, ArrowsClockwise } from "@phosphor-icons/react";
import { Caption } from "@breadcoop/ui";
import { Card } from "@/components/dapp/ui";
import { shortChainName } from "@/lib/chains";
import { useAmountFormatter } from "@/components/demo-mode-provider";
import type { FamilyChainState } from "@/hooks/use-family";

/**
 * The family's per-chain voting state — one row per chain, replacing the single
 * cycle/power card. "Same ballot, weighted by your stake on each chain": each
 * row shows this wallet's local voting power (0 → skipped), whether it has voted
 * this cycle, the cycle number, and any recipient-membership drift that would
 * stop the vote from syncing there.
 */
export function FamilyVoteCard({
  perChain,
  onRetry,
}: {
  perChain: FamilyChainState[];
  onRetry: () => void;
}) {
  const fmt = useAmountFormatter();
  return (
    <Card className="mb-6">
      <Caption className="text-surface-grey-2 mb-3 block">
        Your community across chains — same ballot, weighted by your stake on
        each chain
      </Caption>
      <ul className="space-y-3">
        {perChain.map((c) => (
          <li
            key={c.chainId}
            className="border-paper-2 flex items-start justify-between gap-3 border-t pt-3 first:border-t-0 first:pt-0"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-breadDisplay text-text-standard font-bold">
                  {shortChainName(c.chainId)}
                </span>
                {c.status === "found" && c.hasVoted && (
                  <span className="text-system-green inline-flex items-center gap-1 text-xs font-medium">
                    <CheckCircle size={14} weight="fill" /> voted
                  </span>
                )}
                {c.status === "found" &&
                  c.cycleNumber !== undefined &&
                  !c.hasVoted && (
                    <Caption className="text-surface-grey">
                      cycle #{c.cycleNumber.toString()}
                    </Caption>
                  )}
              </div>

              {c.status === "unreachable" ? (
                <Caption className="text-system-warning mt-0.5 block">
                  couldn&apos;t reach chain
                </Caption>
              ) : c.status === "none" ? (
                <Caption className="text-surface-grey mt-0.5 block">
                  not part of this family
                </Caption>
              ) : c.votingPower === 0n ? (
                <Caption className="text-surface-grey mt-0.5 block">
                  no voting power here — will be skipped
                </Caption>
              ) : (
                <Caption className="text-surface-grey-2 mt-0.5 block">
                  voting power {fmt(c.votingPower)} · cycle #
                  {c.cycleNumber?.toString() ?? "—"}
                </Caption>
              )}

              {c.drift && (
                <Caption className="text-system-warning mt-1 flex items-center gap-1">
                  <Warning size={13} weight="fill" />
                  recipient list out of sync — won&apos;t sync until fixed
                </Caption>
              )}
            </div>

            {c.status === "unreachable" && (
              <button
                type="button"
                onClick={onRetry}
                className="text-core-orange inline-flex flex-none items-center gap-1 text-sm font-semibold hover:underline"
              >
                <ArrowsClockwise size={14} weight="bold" /> Retry
              </button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
