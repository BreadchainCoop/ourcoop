"use client";

import { useAccount } from "wagmi";
import { Caption } from "@breadcoop/ui";
import { HandTap, Lightning } from "@phosphor-icons/react";
import { useWalletActions } from "@/components/wallet/wallet-actions";

/**
 * Tells the user how a cross-chain action will be delivered by their wallet:
 * gaslessly (Privy embedded — no prompts, no switching) or self-paid (one
 * confirmation per chain, gas needed on each). Renders nothing until a wallet is
 * connected — it just reflects the current wallet's capability.
 */
export function GasModeNote({ className = "" }: { className?: string }) {
  const { isConnected } = useAccount();
  const { sponsored } = useWalletActions();
  if (!isConnected) return null;
  return sponsored ? (
    <Caption
      className={`text-system-green inline-flex items-center gap-1 ${className}`}
    >
      <Lightning size={12} weight="fill" /> Gasless — submitted on every chain
      for you, no network switching.
    </Caption>
  ) : (
    <Caption
      className={`text-surface-grey inline-flex items-center gap-1 ${className}`}
    >
      <HandTap size={12} /> You&apos;ll confirm one transaction per chain and
      need a little gas on each.
    </Caption>
  );
}
