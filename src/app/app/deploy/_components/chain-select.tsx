"use client";

import { Check } from "@phosphor-icons/react";
import { Caption } from "@breadcoop/ui";
import {
  CHAINS,
  deployableChainIds,
  shortChainName,
  yieldFlavorLabel,
} from "@/lib/chains";
import { cn } from "@/lib/utils";

/**
 * Deployable-chain chip selector. Each chip shows the chain's yield flavor and
 * native-gas symbol; picking more than one flips the deploy into a cross-chain
 * family. The wallet's current chain is preselected by the caller.
 */
export function ChainSelect({
  selected,
  onToggle,
}: {
  selected: number[];
  onToggle: (chainId: number) => void;
}) {
  const chainIds = deployableChainIds();
  return (
    <div className="flex flex-wrap gap-2">
      {chainIds.map((chainId) => {
        const cfg = CHAINS[chainId];
        const on = selected.includes(chainId);
        return (
          <button
            key={chainId}
            type="button"
            onClick={() => onToggle(chainId)}
            className={cn(
              "rounded-xl border px-3 py-2 text-left transition-colors",
              on
                ? "border-core-orange bg-core-orange/5"
                : "border-paper-2 hover:border-core-orange/50",
            )}
          >
            <span className="flex items-center gap-1.5">
              <span
                className={cn(
                  "flex h-4 w-4 items-center justify-center rounded border",
                  on
                    ? "bg-core-orange border-core-orange text-white"
                    : "border-paper-2",
                )}
              >
                {on && <Check size={11} weight="bold" />}
              </span>
              <span className="font-breadDisplay text-text-standard text-sm font-bold">
                {shortChainName(chainId)}
              </span>
            </span>
            <Caption className="text-surface-grey mt-0.5 block">
              {yieldFlavorLabel(chainId)} · gas in{" "}
              {cfg.chain.nativeCurrency.symbol}
            </Caption>
          </button>
        );
      })}
    </div>
  );
}
