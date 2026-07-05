"use client";

import { useCallback, useState } from "react";
import { useWaitForTransactionReceipt } from "wagmi";
import { BaseError, type Abi, type Address, type Hex } from "viem";
import { useActiveChainId } from "@/components/instance-provider";
import { useWalletActions } from "@/components/wallet/wallet-actions";

/** Pull the most useful human-readable message out of a viem/wagmi error. */
export function parseTxError(err: unknown): string {
  if (!err) return "Transaction failed";
  if (err instanceof BaseError) {
    const short = err.shortMessage || err.message;
    if (short?.toLowerCase().includes("user rejected"))
      return "Rejected in wallet";
    return short || "Transaction failed";
  }
  if (err instanceof Error) {
    if (err.message.toLowerCase().includes("user rejected"))
      return "Rejected in wallet";
    return err.message;
  }
  return "Transaction failed";
}

export type TxStatus = "idle" | "signing" | "confirming" | "success" | "error";

/** A contract write request (loosely typed; validated against the ABI at runtime by viem). */
export interface TxRequest {
  address: Address;
  abi: Abi | readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

/**
 * Standard write → wait-for-receipt flow used by every action in the dapp.
 * `run(request)` submits a contract write on the active instance's chain and
 * resolves with the tx hash; `status`, `hash`, and `error` drive the UI.
 *
 * Writes go through the wallet-actions layer: gas-sponsored (gasless, no prompt)
 * when the active wallet is a Privy embedded wallet, else a normal self-paid
 * wallet tx.
 */
export function useTx() {
  const chainId = useActiveChainId();
  const { sendSponsored } = useWalletActions();
  const [hash, setHash] = useState<Hex | undefined>(undefined);
  const [isSigning, setIsSigning] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    isLoading: isConfirming,
    isSuccess,
    error: receiptError,
  } = useWaitForTransactionReceipt({ hash, chainId });

  const run = useCallback(
    async (request: TxRequest): Promise<`0x${string}` | undefined> => {
      setSubmitError(null);
      setHash(undefined);
      setIsSigning(true);
      try {
        const h = await sendSponsored({
          chainId,
          address: request.address,
          abi: request.abi,
          functionName: request.functionName,
          args: request.args,
          value: request.value,
        });
        setHash(h);
        return h;
      } catch (e) {
        setSubmitError(parseTxError(e));
        return undefined;
      } finally {
        setIsSigning(false);
      }
    },
    [sendSponsored, chainId],
  );

  const reset = useCallback(() => {
    setSubmitError(null);
    setHash(undefined);
    setIsSigning(false);
  }, []);

  const status: TxStatus = submitError
    ? "error"
    : isSuccess
      ? "success"
      : isConfirming
        ? "confirming"
        : isSigning
          ? "signing"
          : "idle";

  return {
    run,
    reset,
    hash,
    status,
    isBusy: isSigning || isConfirming,
    isSuccess,
    error: submitError ?? (receiptError ? parseTxError(receiptError) : null),
  };
}
