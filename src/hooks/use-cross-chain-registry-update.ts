"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import {
  useAccount,
  useSignTypedData,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { recipientRegistryAbi } from "@/lib/abis";
import { useActiveChainId } from "@/components/instance-provider";
import { publicClientFor } from "@/lib/instance";
import { parseTxError } from "@/hooks/use-tx";
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
  getActionStatus,
  postAction,
  relayConfigured,
  type RelayVoteStatus,
} from "@/lib/relay";
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
 * (the full recipient list, strictly ascending) and hand it to the relay — or
 * self-submit from the wallet when no relay is reachable. Each chain computes
 * its own delta and applies it, so one signature heals arbitrary drift.
 * Settlement is confirmed by reading `lastRegistryUpdateNonce(registry) >= nonce`
 * ON-CHAIN; the relay is advisory. Delivery is NOT gated on a chain already
 * matching — the nonce burn kills older floating signatures everywhere.
 */
export function useCrossChainRegistryUpdate(family: FamilyState) {
  const chainId = useActiveChainId();
  const { address, chainId: walletChainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<CrossChainActionPhase>("idle");
  const [rowsState, setRowsState] = useState<ChainActionRow[]>([]);
  const [payload, setPayload] = useState<SignedRegistryUpdatePayload | null>(
    null,
  );
  const [relayDown, setRelayDown] = useState(false);
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

  // Fold the relay's advisory report in — never downgrade an on-chain confirm.
  const applyAdvisory = useCallback(
    (res: RelayVoteStatus) => {
      setRows((prev) =>
        prev.map((r) => {
          const adv = res.chains.find((c) => c.chainId === r.chainId);
          if (!adv) return r;
          if (r.state === "confirmed" || r.state === "superseded") {
            return { ...r, txHash: r.txHash ?? adv.txHash };
          }
          switch (adv.state) {
            case "pending":
              return r.state === "submitted"
                ? r
                : { ...r, state: "relaying" as const };
            case "submitted":
            case "confirmed":
            case "landed":
              return {
                ...r,
                state: "submitted" as const,
                txHash: adv.txHash ?? r.txHash,
              };
            case "superseded":
              return { ...r, state: "superseded" as const };
            case "recipient_mismatch":
              return { ...r, state: "recipient_mismatch" as const };
            case "skipped_no_power":
              // Not meaningful for registry updates; treat as still relaying.
              return r.state === "submitted"
                ? r
                : { ...r, state: "relaying" as const };
            case "expired":
              return {
                ...r,
                state: "failed" as const,
                error: "Signature expired before delivery",
              };
            case "failed":
              return {
                ...r,
                state: "failed" as const,
                error: adv.error ?? "Relay delivery failed",
              };
            default:
              return r;
          }
        }),
      );
    },
    [setRows],
  );

  /** Deliver the signed update from the wallet on one specific chain. */
  const submitOnChain = useCallback(
    async (targetChainId: number) => {
      const u = updateRef.current;
      const target = u?.chains.find((c) => c.chainId === targetChainId);
      if (!u || !target) return;
      setSubmitting(targetChainId);
      try {
        if (walletChainId !== targetChainId) {
          await switchChainAsync({ chainId: targetChainId });
        }
        const hash = await writeContractAsync({
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
    [walletChainId, switchChainAsync, writeContractAsync, updateRow],
  );

  /**
   * Sign the desired recipient set and start delivery. `recipients` is the full
   * desired set (any order — it is sorted ascending before signing, which is
   * the canonical form the contract verifies).
   */
  const sign = useCallback(
    async (recipients: readonly Address[]) => {
      const familyId = family.familyId;
      if (!address || !familyId) return;
      setError(null);
      setRelayDown(false);
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
      const body = buildRegistryUpdatePayload(
        familyId,
        address,
        sorted,
        nonce,
        deadline,
        signature,
      );
      setPayload(body);
      setRows((prev) =>
        prev.map((r) =>
          found.some((f) => f.chainId === r.chainId)
            ? { ...r, state: "relaying" as CrossChainActionState }
            : r,
        ),
      );
      setPhase("settling");
      if (relayConfigured()) {
        const res = await postAction(body);
        if (res) {
          applyAdvisory(res);
          return;
        }
      }
      // No relay reachable — deliver from the wallet on the active chain; the
      // other chains get per-row submit buttons + the copyable payload.
      setRelayDown(true);
      const self = found.find((c) => c.chainId === chainId) ?? found[0];
      setRows((prev) =>
        prev.map((r) =>
          r.state === "relaying" && r.chainId !== self?.chainId
            ? { ...r, state: "awaiting_submission" as CrossChainActionState }
            : r,
        ),
      );
      if (self) await submitOnChain(self.chainId);
    },
    [
      address,
      chainId,
      family.familyId,
      family.perChain,
      signTypedDataAsync,
      setRows,
      applyAdvisory,
      submitOnChain,
    ],
  );

  /** Re-POST the payload to the relays; failed rows go back to relaying. */
  const retryRelay = useCallback(async () => {
    if (!payload) return;
    const res = await postAction(payload);
    if (!res) {
      setRelayDown(true);
      return;
    }
    setRelayDown(false);
    setRows((prev) =>
      prev.map((r) =>
        r.state === "failed" || r.state === "recipient_mismatch"
          ? { ...r, state: "relaying" as const, error: undefined }
          : r,
      ),
    );
    applyAdvisory(res);
    setPhase("settling");
  }, [payload, setRows, applyAdvisory]);

  // Settle loop: advisory relay poll + authoritative per-chain nonce reads.
  useEffect(() => {
    if (phase !== "settling") return;
    let cancelled = false;
    const tick = async () => {
      const u = updateRef.current;
      if (!u || cancelled) return;
      if (relayConfigured() && !relayDown) {
        const adv = await getActionStatus(
          u.familyId,
          "registry-update",
          u.admin,
          u.nonce.toString(),
        ).catch(() => null);
        if (adv && !cancelled) applyAdvisory(adv);
      }
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
  }, [phase, relayDown, applyAdvisory, updateRow, setRows]);

  const reset = useCallback(() => {
    updateRef.current = null;
    setRows(() => []);
    setPhase("idle");
    setPayload(null);
    setRelayDown(false);
    setError(null);
  }, [setRows]);

  return {
    /** Sign + deliver the full desired recipient set (any order). */
    sign,
    /** Deliver the signed update yourself on one chain (wallet tx). */
    submitOnChain,
    /** Re-POST the signed update to the relays. */
    retryRelay,
    reset,
    phase,
    rows: rowsState,
    /** The signed update as relay-POST JSON — the "anyone can deliver" hatch. */
    payload,
    /** True when every configured relay is unreachable (fallback mode). */
    relayDown,
    submitting,
    error,
    isBusy: phase === "signing" || phase === "settling",
  };
}
