"use client";

import type { ReactNode } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { Button } from "@breadcoop/ui";
import { useActiveChain } from "@/hooks/use-chain";
import { useWalletActions } from "@/components/wallet/wallet-actions";

type Variant = "primary" | "secondary" | "destructive";

/**
 * Primary action button that's connection-aware: prompts to connect when
 * disconnected and to switch to Gnosis on the wrong chain, otherwise runs the
 * action. Lets pages show their full form before a wallet is connected.
 *
 * `chainless` actions (e.g. signing a cross-chain ballot) skip the switch-chain
 * branch — the signature is valid on every chain, so no wallet chain matters —
 * while keeping the connect-first gating.
 */
export function ActionButton({
  children,
  onClick,
  isLoading,
  disabled,
  variant = "primary",
  className = "w-full",
  chainless = false,
}: {
  children: ReactNode;
  onClick: () => void;
  isLoading?: boolean;
  disabled?: boolean;
  variant?: Variant;
  className?: string;
  chainless?: boolean;
}) {
  const { isConnected, chainId } = useAccount();
  const { connect } = useWalletActions();
  const { switchChain, isPending } = useSwitchChain();
  const target = useActiveChain().chain;

  if (!isConnected) {
    return (
      <Button
        app="fund"
        variant="primary"
        className={className}
        onClick={connect}
      >
        Connect wallet
      </Button>
    );
  }

  if (!chainless && chainId !== target.id) {
    return (
      <Button
        app="fund"
        variant="primary"
        className={className}
        isLoading={isPending}
        onClick={() => switchChain({ chainId: target.id })}
      >
        Switch to {target.name}
      </Button>
    );
  }

  return (
    <Button
      app="fund"
      variant={variant}
      className={className}
      isLoading={isLoading}
      onClick={onClick}
      {...(disabled ? { disabled: true } : {})}
    >
      {children}
    </Button>
  );
}
