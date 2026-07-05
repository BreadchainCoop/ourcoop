"use client";

import { createContext, useCallback, useContext, type ReactNode } from "react";
import type { Abi, Address, Hex } from "viem";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  useWriteContract,
} from "wagmi";

/** A single contract write, target-chain aware (submitted sponsored or self-paid). */
export interface SponsoredTxRequest {
  chainId: number;
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

export interface WalletActions {
  /** Open the connect/login flow. */
  connect: () => void;
  /** Disconnect / log out. */
  disconnect: () => void;
  /**
   * Submit a contract write on a specific chain. Gas-sponsored (no prompt, no
   * network switch) when the active wallet is a Privy embedded wallet; otherwise
   * a normal self-paid wallet tx (switching chain first). Returns the tx hash.
   */
  sendSponsored: (req: SponsoredTxRequest) => Promise<Hex>;
}

export const WalletActionsContext = createContext<WalletActions | null>(null);

export function useWalletActions(): WalletActions {
  const ctx = useContext(WalletActionsContext);
  if (!ctx) {
    throw new Error(
      "useWalletActions must be used within a WalletActionsProvider",
    );
  }
  return ctx;
}

/**
 * Shared self-paid path: switch the wallet to the target chain if needed, then
 * write. Used verbatim by the fallback provider and by the Privy provider when
 * the active wallet is an EXTERNAL wallet (which can't be gas-sponsored).
 */
export function useWalletWrite() {
  const { chainId: walletChainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  return useCallback(
    async (req: SponsoredTxRequest): Promise<Hex> => {
      if (walletChainId !== req.chainId) {
        await switchChainAsync({ chainId: req.chainId });
      }
      return writeContractAsync({
        chainId: req.chainId,
        address: req.address,
        abi: req.abi,
        functionName: req.functionName,
        args: req.args,
        ...(req.value !== undefined ? { value: req.value } : {}),
      } as Parameters<typeof writeContractAsync>[0]);
    },
    [walletChainId, switchChainAsync, writeContractAsync],
  );
}

/**
 * No-Privy fallback: connect an injected wallet, self-paid writes. Keeps the app
 * (and the e2e EIP-6963 shim) fully functional without a Privy app id.
 */
export function WagmiWalletActions({ children }: { children: ReactNode }) {
  const { connectors, connect } = useConnect();
  const { disconnect } = useDisconnect();
  const write = useWalletWrite();

  const actions: WalletActions = {
    connect: () => {
      const injected = connectors[0];
      if (injected) connect({ connector: injected });
    },
    disconnect: () => disconnect(),
    sendSponsored: write,
  };

  return (
    <WalletActionsContext.Provider value={actions}>
      {children}
    </WalletActionsContext.Provider>
  );
}
