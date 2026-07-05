"use client";

import { CaretRight, CheckCircle } from "@phosphor-icons/react";
import { Body, Caption } from "@breadcoop/ui";
import { Card } from "@/components/dapp/ui";
import { InstanceShareCard } from "@/components/dapp/instance-share-card";
import { shortChainName, addressUrl } from "@/lib/chains";
import type { FamilyDeployRow } from "@/hooks/use-deploy-family";

/**
 * Family deploy result — ONE canonical link for the whole community (the
 * primary chain's ?i= page) plus every sibling's link tucked in a disclosure.
 * Partial success (K of N) is a normal outcome: the remaining chains can be
 * finished later from the Deploy page.
 */
export function FamilySuccessCard({
  deployedRows,
  chainCount,
  primaryChainId,
}: {
  deployedRows: FamilyDeployRow[];
  chainCount: number;
  primaryChainId: number;
}) {
  const primary =
    deployedRows.find((r) => r.chainId === primaryChainId) ?? deployedRows[0];
  const deployedCount = deployedRows.length;
  const partial = deployedCount < chainCount;

  return (
    <Card>
      <p className="text-system-green flex items-center gap-2">
        <CheckCircle size={22} weight="fill" />
        <span className="font-breadDisplay text-lg font-bold">
          {partial
            ? `Live on ${deployedCount} of ${chainCount} chains`
            : "Your community is live everywhere!"}
        </span>
      </p>
      <Body className="text-surface-grey-2 mt-1 text-sm">
        One link for your whole community — it opens the right chain for each
        member, the same ballot weighted by their stake on each chain.
      </Body>

      {primary?.instance && (
        <div className="mt-4">
          <InstanceShareCard
            distributionManager={primary.instance.distributionManager}
            chainId={primary.chainId}
          />
        </div>
      )}

      {partial && (
        <Caption className="text-system-warning mt-3 block">
          The remaining {chainCount - deployedCount} chain
          {chainCount - deployedCount === 1 ? "" : "s"} aren&apos;t deployed yet
          — finish anytime from the Deploy page.
        </Caption>
      )}

      <details className="group mt-6">
        <summary className="text-surface-grey-2 hover:text-text-standard flex cursor-pointer items-center gap-1 text-sm font-medium select-none">
          <CaretRight
            size={14}
            weight="bold"
            className="transition-transform group-open:rotate-90"
          />
          Per-chain instances
        </summary>
        <dl className="mt-3 space-y-2">
          {deployedRows.map((row) => (
            <div
              key={row.chainId}
              className="border-paper-2 flex items-center justify-between border-t pt-2"
            >
              <Caption className="text-surface-grey">
                {shortChainName(row.chainId)}
              </Caption>
              {row.instance ? (
                <a
                  href={addressUrl(
                    row.instance.distributionManager,
                    row.chainId,
                  )}
                  target="_blank"
                  rel="noreferrer"
                  className="text-core-orange font-mono text-sm hover:underline"
                >
                  {row.instance.distributionManager.slice(0, 8)}…
                </a>
              ) : (
                <span className="text-surface-grey font-mono text-sm">
                  deployed
                </span>
              )}
            </div>
          ))}
        </dl>
      </details>
    </Card>
  );
}
