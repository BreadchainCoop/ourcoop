"use client";

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useAccount,
  useChainId,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import type { Abi, Address, Hex } from "viem";
import { COOP_CHAIN_ID, fetchCoopState } from "@/lib/coop";
import { parseTxError, type TxStatus } from "@/hooks/use-tx";

/**
 * The cooperative's full on-chain state (funds, projects, ballots,
 * withdrawals, cycle, activity). Reads go through the coop chain's public
 * client, so browsing works with no wallet at all; the connected account
 * only personalises membership + has-voted flags.
 */
export function useCoopState() {
  const { address } = useAccount();
  return useQuery({
    queryKey: ["coop-state", address ?? "anon"],
    queryFn: () => fetchCoopState(address),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

/**
 * A contract write on the cooperative's chain (Sepolia), regardless of the
 * dapp's active instance chain: switches the wallet if needed, submits, waits
 * for the receipt, then refreshes the coop state.
 */
export function useCoopTx() {
  const { isConnected } = useAccount();
  const walletChainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const queryClient = useQueryClient();
  const [hash, setHash] = useState<Hex | undefined>(undefined);
  const [isSigning, setIsSigning] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const { writeContractAsync } = useWriteContract();

  const {
    isLoading: isConfirming,
    isSuccess,
    error: receiptError,
  } = useWaitForTransactionReceipt({
    hash,
    chainId: COOP_CHAIN_ID,
    query: {
      enabled: Boolean(hash),
    },
  });

  const run = useCallback(
    async (request: {
      address: Address;
      abi: Abi;
      functionName: string;
      args?: readonly unknown[];
    }): Promise<Hex | undefined> => {
      setSubmitError(null);
      setHash(undefined);
      setIsSigning(true);
      try {
        if (walletChainId !== COOP_CHAIN_ID) {
          await switchChainAsync({ chainId: COOP_CHAIN_ID });
        }
        const txHash = await writeContractAsync({
          chainId: COOP_CHAIN_ID,
          ...request,
        });
        setHash(txHash);
        // Refresh once mined — useWaitForTransactionReceipt drives the UI; a
        // trailing invalidation catches the state change.
        void queryClient.invalidateQueries({ queryKey: ["coop-state"] });
        return txHash;
      } catch (e) {
        setSubmitError(parseTxError(e));
        return undefined;
      } finally {
        setIsSigning(false);
      }
    },
    [walletChainId, switchChainAsync, writeContractAsync, queryClient],
  );

  // Refresh again when the receipt lands (the submit-time invalidation can
  // race the block).
  const [refreshedFor, setRefreshedFor] = useState<Hex | null>(null);
  if (isSuccess && hash && refreshedFor !== hash) {
    setRefreshedFor(hash);
    void queryClient.invalidateQueries({ queryKey: ["coop-state"] });
  }

  const status: TxStatus =
    submitError || receiptError
      ? "error"
      : isSuccess
        ? "success"
        : isConfirming
          ? "confirming"
          : isSigning
            ? "signing"
            : "idle";

  const reset = useCallback(() => {
    setHash(undefined);
    setSubmitError(null);
    setRefreshedFor(null);
  }, []);

  return {
    run,
    hash,
    status,
    isBusy: isSigning || isConfirming,
    error: submitError ?? (receiptError ? parseTxError(receiptError) : null),
    reset,
    canAct: isConnected,
  };
}
