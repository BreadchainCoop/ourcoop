"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { useAccount, useSignTypedData } from "wagmi";
import { recipientRegistryAbi } from "@/lib/abis";
import { publicClientFor } from "@/lib/instance";
import { parseTxError } from "@/hooks/use-tx";
import { useWalletActions } from "@/components/wallet/wallet-actions";
import {
  CROSS_CHAIN_REGISTRY_UPDATE_TYPES,
  buildRegistryUpdatePayload,
  chooseNonce,
  crossChainVoteDomain,
  sortRecipientsAscending,
  voteDeadline,
  type SignedRegistryUpdatePayload,
} from "@/lib/vote-signature";
import {
  CROSS_CHAIN_TERMINAL as TERMINAL,
  type ChainActionRow,
  type CrossChainActionPhase,
  type CrossChainActionState,
} from "@/lib/cross-chain-action";
import type { FamilyState } from "@/hooks/use-family";

interface SignedUpdate {
  familyId: Hex;
  admin: Address;
  recipients: Address[];
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
  chains: { chainId: number; registry: Address }[];
}

/**
 * Admin "sync recipients everywhere": sign ONE chainless desired-set signature
 * (the full recipient list, strictly ascending) and submit it to every sibling
 * chain — gaslessly from the browser via Privy gas sponsorship (or a self-paid
 * wallet tx). Each chain computes its own delta and applies it, so one signature
 * heals arbitrary drift. Settlement is confirmed by reading
 * `lastRegistryUpdateNonce(registry) >= nonce` ON-CHAIN. The signed payload is
 * also exposed as the "anyone can deliver" copy hatch.
 */
export function useCrossChainRegistryUpdate(family: FamilyState) {
  const { address } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const { sendSponsored } = useWalletActions();

  const [phase, setPhase] = useState<CrossChainActionPhase>("idle");
  const [rowsState, setRowsState] = useState<ChainActionRow[]>([]);
  const [payload, setPayload] = useState<SignedRegistryUpdatePayload | null>(
    null,
  );
  const [submitting, setSubmitting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rowsRef = useRef<ChainActionRow[]>([]);
  const updateRef = useRef<SignedUpdate | null>(null);

  const setRows = useCallback(
    (updater: (prev: ChainActionRow[]) => ChainActionRow[]) => {
      rowsRef.current = updater(rowsRef.current);
      setRowsState(rowsRef.current);
    },
    [],
  );

  const updateRow = useCallback(
    (rowChainId: number, patch: Partial<ChainActionRow>) => {
      setRows((prev) =>
        prev.map((r) => (r.chainId === rowChainId ? { ...r, ...patch } : r)),
      );
    },
    [setRows],
  );

  /** Deliver the signed update on one specific chain (sponsored or self-paid). */
  const submitOnChain = useCallback(
    async (targetChainId: number) => {
      const u = updateRef.current;
      const target = u?.chains.find((c) => c.chainId === targetChainId);
      if (!u || !target) return;
      setSubmitting(targetChainId);
      updateRow(targetChainId, { state: "relaying", error: undefined });
      try {
        const hash = await sendSponsored({
          chainId: targetChainId,
          address: target.registry,
          abi: recipientRegistryAbi,
          functionName: "applyCrossChainRegistryUpdate",
          args: [u.admin, u.recipients, u.nonce, u.deadline, u.signature],
        });
        updateRow(targetChainId, {
          state: "submitted",
          txHash: hash,
          error: undefined,
        });
        setPhase("settling");
      } catch (e) {
        updateRow(targetChainId, { state: "failed", error: parseTxError(e) });
      } finally {
        setSubmitting(null);
      }
    },
    [sendSponsored, updateRow],
  );

  /** Retry every chain whose submission failed (re-submit, sponsored or self-paid). */
  const retryFailed = useCallback(async () => {
    for (const r of rowsRef.current) {
      if (r.state === "failed") await submitOnChain(r.chainId);
    }
  }, [submitOnChain]);

  /**
   * Sign the desired recipient set and submit it to every reachable sibling.
   * `recipients` is the full desired set (any order — sorted ascending before
   * signing, the canonical form the contract verifies).
   */
  const sign = useCallback(
    async (recipients: readonly Address[]) => {
      const familyId = family.familyId;
      if (!address || !familyId) return;
      setError(null);
      setPayload(null);
      const participants = family.perChain.filter((c) => c.status !== "none");
      const found = participants.filter(
        (c) => c.status === "found" && c.instance,
      );
      if (found.length === 0) {
        setError("No chain could be reached — retry loading the family.");
        return;
      }
      const sorted = sortRecipientsAscending(recipients);
      const nonce = chooseNonce(
        found.map((c) => c.lastRegistryUpdateNonce ?? 0n),
      );
      const deadline = voteDeadline();
      setPhase("signing");
      setRows(() =>
        participants.map((c) => ({
          chainId: c.chainId,
          state: (c.status === "unreachable"
            ? "unreachable"
            : "signing") as CrossChainActionState,
        })),
      );
      let signature: Hex;
      try {
        signature = await signTypedDataAsync({
          domain: crossChainVoteDomain(familyId),
          types: CROSS_CHAIN_REGISTRY_UPDATE_TYPES,
          primaryType: "CrossChainRegistryUpdate",
          message: { admin: address, recipients: sorted, nonce, deadline },
        });
      } catch (e) {
        setPhase("idle");
        setRows(() => []);
        setError(parseTxError(e));
        return;
      }
      updateRef.current = {
        familyId,
        admin: address,
        recipients: sorted,
        nonce,
        deadline,
        signature,
        chains: found.map((c) => ({
          chainId: c.chainId,
          registry: c.instance!.recipientRegistry,
        })),
      };
      setPayload(
        buildRegistryUpdatePayload(
          familyId,
          address,
          sorted,
          nonce,
          deadline,
          signature,
        ),
      );
      setPhase("settling");
      // Submit to every reachable chain from the browser (gas-sponsored).
      for (const c of found) {
        await submitOnChain(c.chainId);
      }
    },
    [
      address,
      family.familyId,
      family.perChain,
      signTypedDataAsync,
      setRows,
      submitOnChain,
    ],
  );

  // Settle loop: authoritative per-chain nonce reads.
  useEffect(() => {
    if (phase !== "settling") return;
    let cancelled = false;
    const tick = async () => {
      const u = updateRef.current;
      if (!u || cancelled) return;
      await Promise.all(
        u.chains.map(async (c) => {
          const row = rowsRef.current.find((r) => r.chainId === c.chainId);
          if (!row || TERMINAL.has(row.state)) return;
          try {
            const last = await publicClientFor(c.chainId).readContract({
              address: c.registry,
              abi: recipientRegistryAbi,
              functionName: "lastRegistryUpdateNonce",
            });
            if (cancelled || last < u.nonce) return;
            updateRow(c.chainId, {
              state: last > u.nonce ? "superseded" : "confirmed",
            });
          } catch {
            /* transient read failure — next tick */
          }
        }),
      );
      if (cancelled) return;
      if (rowsRef.current.every((r) => TERMINAL.has(r.state))) {
        setPhase("done");
      } else if (BigInt(Math.floor(Date.now() / 1000)) > u.deadline) {
        setRows((prev) =>
          prev.map((r) =>
            TERMINAL.has(r.state)
              ? r
              : {
                  ...r,
                  state: "failed" as const,
                  error: "Signature expired before delivery",
                },
          ),
        );
        setPhase("done");
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [phase, updateRow, setRows]);

  const reset = useCallback(() => {
    updateRef.current = null;
    setRows(() => []);
    setPhase("idle");
    setPayload(null);
    setError(null);
  }, [setRows]);

  return {
    /** Sign + submit the full desired recipient set (any order) to every chain. */
    sign,
    /** Re-submit the signed update yourself on one chain (sponsored/self-paid). */
    submitOnChain,
    /** Retry every chain whose submission failed. */
    retryFailed,
    reset,
    phase,
    rows: rowsState,
    /** The signed update as JSON — the "anyone can deliver" copy hatch. */
    payload,
    submitting,
    error,
    isBusy: phase === "signing" || phase === "settling",
  };
}
