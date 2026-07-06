"use client";

import { useCallback, useEffect, useState } from "react";
import { erc20Abi, zeroAddress, type Address, type Hex } from "viem";
import { useAccount } from "wagmi";
import { tokenAbi } from "@/lib/abis";
import { chainConfig } from "@/lib/chains";
import { publicClientFor } from "@/lib/instance";
import { parseTxError } from "@/hooks/use-tx";
import { useWalletActions } from "@/components/wallet/wallet-actions";
import type { FamilyState } from "@/hooks/use-family";

/** Per-chain deposit metadata + the connected wallet's balances there. */
export interface FamilyDepositChain {
  chainId: number;
  yieldKind: "native" | "stable";
  /** The instance's yield token (what we mint). */
  token: Address;
  /** The ERC-20 deposit asset (WXDAI / USDC), or null on pure-native chains. */
  wrapped: Address | null;
  nativeSymbol: string;
  wrappedSymbol: string;
  /** Decimals of the wrapped/stable asset (native is always 18). */
  wrappedDecimals: number;
  nativeBalance: bigint;
  wrappedBalance: bigint;
  /** Wrapped → token allowance (0 when there's no wrapped asset). */
  allowance: bigint;
}

export type DepositRowState =
  "idle" | "approving" | "depositing" | "confirmed" | "failed";

export interface DepositRow {
  chainId: number;
  state: DepositRowState;
  txHash?: Hex;
  error?: string;
}

/** One chain's requested deposit: how much of which asset. */
export interface DepositAllocation {
  chainId: number;
  amount: bigint;
  mode: "native" | "wrapped";
}

async function loadChain(
  chainId: number,
  token: Address,
  owner: Address,
): Promise<FamilyDepositChain> {
  const cfg = chainConfig(chainId);
  const client = publicClientFor(chainId);
  const wrapped = cfg.wrappedToken;

  const [nativeBalance, wrappedBalance, allowance, wrappedDecimals] =
    await Promise.all([
      client.getBalance({ address: owner }).catch(() => 0n),
      wrapped
        ? client
            .readContract({
              address: wrapped,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [owner],
            })
            .catch(() => 0n)
        : Promise.resolve(0n),
      wrapped
        ? client
            .readContract({
              address: wrapped,
              abi: erc20Abi,
              functionName: "allowance",
              args: [owner, token],
            })
            .catch(() => 0n)
        : Promise.resolve(0n),
      wrapped
        ? client
            .readContract({
              address: wrapped,
              abi: erc20Abi,
              functionName: "decimals",
            })
            .catch(() => 18)
        : Promise.resolve(18),
    ]);

  return {
    chainId,
    yieldKind: cfg.yieldKind,
    token,
    wrapped,
    nativeSymbol: cfg.chain.nativeCurrency.symbol,
    wrappedSymbol: cfg.wrappedSymbol,
    wrappedDecimals: Number(wrappedDecimals),
    nativeBalance,
    wrappedBalance,
    allowance,
  };
}

/**
 * Multi-asset family mint: deposit into a community token on several chains at
 * once, in whatever asset you hold on each (native xDAI on Gnosis, USDC on the
 * L2s, …). Each chain mints its OWN local token to you from your local balance
 * — deposits move real funds, so this is a real per-chain transaction fan-out
 * (not a signature replay): gas-sponsored automatically on a Privy embedded
 * wallet, or one confirmation per chain (with gas needed on each) on a
 * self-paid wallet.
 */
export function useFamilyDeposit(family: FamilyState) {
  const { address } = useAccount();
  const { sendSponsored } = useWalletActions();

  const [chains, setChains] = useState<FamilyDepositChain[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [rows, setRows] = useState<DepositRow[]>([]);
  const [busyChain, setBusyChain] = useState<number | null>(null);
  const [seq, setSeq] = useState(0);

  const found = family.perChain.filter(
    (c) => c.status === "found" && c.instance,
  );
  const targetKey = found.map((c) => c.chainId).join(",");

  useEffect(() => {
    if (!address || found.length === 0) {
      setChains([]);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      const loaded = await Promise.all(
        found.map((c) => loadChain(c.chainId, c.instance!.token, address)),
      );
      if (!cancelled) {
        setChains(loaded);
        setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, targetKey, seq]);

  const refetch = useCallback(() => setSeq((s) => s + 1), []);

  const setRow = useCallback((chainId: number, patch: Partial<DepositRow>) => {
    setRows((prev) => {
      const i = prev.findIndex((r) => r.chainId === chainId);
      if (i === -1) return [...prev, { chainId, state: "idle", ...patch }];
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
  }, []);

  /** Deposit on one chain: (approve if needed) → mint → wait for receipt. */
  const depositOnChain = useCallback(
    async (alloc: DepositAllocation) => {
      const meta = chains.find((c) => c.chainId === alloc.chainId);
      if (!meta || !address || alloc.amount <= 0n) return;
      const client = publicClientFor(alloc.chainId);
      setBusyChain(alloc.chainId);
      try {
        // ERC-20 deposit needs an allowance to the token first.
        if (alloc.mode === "wrapped" && meta.wrapped) {
          if (meta.allowance < alloc.amount) {
            setRow(alloc.chainId, { state: "approving", error: undefined });
            const approveHash = await sendSponsored({
              chainId: alloc.chainId,
              address: meta.wrapped,
              abi: erc20Abi,
              functionName: "approve",
              args: [meta.token, alloc.amount],
            });
            await client.waitForTransactionReceipt({ hash: approveHash });
          }
        }

        setRow(alloc.chainId, { state: "depositing", error: undefined });
        const mintHash =
          alloc.mode === "native"
            ? await sendSponsored({
                chainId: alloc.chainId,
                address: meta.token,
                abi: tokenAbi,
                functionName: "mint",
                args: [address],
                value: alloc.amount,
              })
            : await sendSponsored({
                chainId: alloc.chainId,
                address: meta.token,
                abi: tokenAbi,
                functionName: "mint",
                args: [address, alloc.amount],
              });
        await client.waitForTransactionReceipt({ hash: mintHash });
        setRow(alloc.chainId, { state: "confirmed", txHash: mintHash });
      } catch (e) {
        setRow(alloc.chainId, { state: "failed", error: parseTxError(e) });
      } finally {
        setBusyChain(null);
      }
    },
    [chains, address, sendSponsored, setRow],
  );

  /** Deposit the requested mix across chains, sequentially. */
  const mint = useCallback(
    async (allocations: DepositAllocation[]) => {
      const live = allocations.filter((a) => a.amount > 0n);
      setRows(live.map((a) => ({ chainId: a.chainId, state: "idle" })));
      for (const a of live) {
        await depositOnChain(a);
      }
      refetch();
    },
    [depositOnChain, refetch],
  );

  /** Retry every chain whose deposit failed. */
  const retryFailed = useCallback(
    async (allocations: DepositAllocation[]) => {
      for (const r of rows) {
        if (r.state !== "failed") continue;
        const a = allocations.find((x) => x.chainId === r.chainId);
        if (a && a.amount > 0n) await depositOnChain(a);
      }
      refetch();
    },
    [rows, depositOnChain, refetch],
  );

  const reset = useCallback(() => setRows([]), []);

  return {
    chains,
    isLoading,
    rows,
    busyChain,
    mint,
    depositOnChain,
    retryFailed,
    reset,
    refetch,
    isBusy: busyChain !== null,
    receiver: address ?? zeroAddress,
  };
}
