"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { useAccount, useSignTypedData } from "wagmi";
import { votingModuleAbi } from "@/lib/abis";
import { publicClientFor } from "@/lib/instance";
import { parseTxError } from "@/hooks/use-tx";
import { useWalletActions } from "@/components/wallet/wallet-actions";
import {
  CROSS_CHAIN_VOTE_TYPES,
  buildVotePayload,
  chooseNonce,
  crossChainVoteDomain,
  voteDeadline,
  type SignedVotePayload,
} from "@/lib/vote-signature";
import {
  CROSS_CHAIN_TERMINAL as TERMINAL,
  type ChainActionRow,
  type CrossChainActionPhase,
  type CrossChainActionState,
} from "@/lib/cross-chain-action";
import type { FamilyState } from "@/hooks/use-family";

// The vote flow uses the shared cross-chain action model (see the generic
// MultiChainActionStatus); these aliases keep the vote page's imports stable.
/** Per-chain delivery state for one signed vote. */
export type CrossChainVoteState = CrossChainActionState;
export type ChainVoteRow = ChainActionRow;
export type CrossChainVotePhase = CrossChainActionPhase;

interface SignedVote {
  familyId: Hex;
  voter: Address;
  points: bigint[];
  recipients: Address[];
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
  chains: { chainId: number; votingModule: Address; votingPower?: bigint }[];
}

/**
 * The whole cross-chain vote flow: sign ONE chainless EIP-712 message, then
 * submit it to every reachable sibling chain — gaslessly from the browser via
 * Privy gas sponsorship (or a self-paid wallet tx). Each chain settles by
 * polling `lastCrossChainNonce(voter) >= nonce` ON-CHAIN — the nonce landing is
 * the vote being counted. Partial success is a normal terminal state,
 * remediable per row (re-submit from wallet / copy the signed payload for
 * anyone to deliver).
 */
export function useCrossChainVote(family: FamilyState) {
  const { address } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const { sendSponsored } = useWalletActions();

  const [phase, setPhase] = useState<CrossChainVotePhase>("idle");
  const [rowsState, setRowsState] = useState<ChainVoteRow[]>([]);
  const [payload, setPayload] = useState<SignedVotePayload | null>(null);
  const [submitting, setSubmitting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The settle poller reads rows outside React's render cycle — mirror them.
  const rowsRef = useRef<ChainVoteRow[]>([]);
  const voteRef = useRef<SignedVote | null>(null);

  const setRows = useCallback(
    (updater: (prev: ChainVoteRow[]) => ChainVoteRow[]) => {
      rowsRef.current = updater(rowsRef.current);
      setRowsState(rowsRef.current);
    },
    [],
  );

  const updateRow = useCallback(
    (rowChainId: number, patch: Partial<ChainVoteRow>) => {
      setRows((prev) =>
        prev.map((r) => (r.chainId === rowChainId ? { ...r, ...patch } : r)),
      );
    },
    [setRows],
  );

  /** Deliver the signed vote on one specific chain (sponsored or self-paid). */
  const submitOnChain = useCallback(
    async (targetChainId: number) => {
      const v = voteRef.current;
      const target = v?.chains.find((c) => c.chainId === targetChainId);
      if (!v || !target) return;
      setSubmitting(targetChainId);
      updateRow(targetChainId, { state: "relaying", error: undefined });
      try {
        const hash = await sendSponsored({
          chainId: targetChainId,
          address: target.votingModule,
          abi: votingModuleAbi,
          functionName: "castCrossChainVote",
          args: [
            v.voter,
            v.points,
            v.recipients,
            v.nonce,
            v.deadline,
            v.signature,
          ],
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
   * Sign the ballot and start delivery. `points[i]` pairs with `recipients[i]`
   * — pass the exact recipient list the allocations were built against (the
   * active chain's registry order); each sibling maps by identity on-chain.
   */
  const sign = useCallback(
    async (points: readonly bigint[], recipients: readonly Address[]) => {
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
      const nonce = chooseNonce(found.map((c) => c.lastNonce ?? 0n));
      const deadline = voteDeadline();
      setPhase("signing");
      setRows(() =>
        participants.map((c) => ({
          chainId: c.chainId,
          state: (c.status === "unreachable"
            ? "unreachable"
            : "signing") as CrossChainVoteState,
        })),
      );
      let signature: Hex;
      try {
        signature = await signTypedDataAsync({
          domain: crossChainVoteDomain(familyId),
          types: CROSS_CHAIN_VOTE_TYPES,
          primaryType: "CrossChainVote",
          message: {
            voter: address,
            points: [...points],
            recipients: [...recipients],
            nonce,
            deadline,
          },
        });
      } catch (e) {
        setPhase("idle");
        setRows(() => []);
        setError(parseTxError(e));
        return;
      }
      voteRef.current = {
        familyId,
        voter: address,
        points: [...points],
        recipients: [...recipients],
        nonce,
        deadline,
        signature,
        chains: found.map((c) => ({
          chainId: c.chainId,
          votingModule: c.instance!.votingModule,
          votingPower: c.votingPower,
        })),
      };
      setPayload(
        buildVotePayload(
          familyId,
          address,
          points,
          recipients,
          nonce,
          deadline,
          signature,
        ),
      );
      // A chain where the voter holds no stake can never count this vote.
      setRows((prev) =>
        prev.map((r) => {
          const c = found.find((f) => f.chainId === r.chainId);
          if (!c) return r;
          return {
            ...r,
            state: (c.votingPower === 0n
              ? "skipped_no_power"
              : "relaying") as CrossChainVoteState,
          };
        }),
      );
      setPhase("settling");
      // Submit to every powered chain from the browser (gas-sponsored).
      for (const c of found) {
        if ((c.votingPower ?? 0n) > 0n) await submitOnChain(c.chainId);
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
      const v = voteRef.current;
      if (!v || cancelled) return;
      await Promise.all(
        v.chains.map(async (c) => {
          const row = rowsRef.current.find((r) => r.chainId === c.chainId);
          if (!row || TERMINAL.has(row.state)) return;
          try {
            const last = await publicClientFor(c.chainId).readContract({
              address: c.votingModule,
              abi: votingModuleAbi,
              functionName: "lastCrossChainNonce",
              args: [v.voter],
            });
            if (cancelled || last < v.nonce) return;
            updateRow(c.chainId, {
              state: last > v.nonce ? "superseded" : "confirmed",
            });
          } catch {
            /* transient read failure — next tick */
          }
        }),
      );
      if (cancelled) return;
      if (rowsRef.current.every((r) => TERMINAL.has(r.state))) {
        setPhase("done");
      } else if (BigInt(Math.floor(Date.now() / 1000)) > v.deadline) {
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
    voteRef.current = null;
    setRows(() => []);
    setPhase("idle");
    setPayload(null);
    setError(null);
  }, [setRows]);

  return {
    /** Sign + deliver: pass the points and the recipient order they map to. */
    sign,
    /** Re-submit the signed vote yourself on one chain (sponsored/self-paid). */
    submitOnChain,
    /** Retry every chain whose submission failed. */
    retryFailed,
    reset,
    phase,
    rows: rowsState,
    /** The signed vote as JSON — the "anyone can deliver" escape hatch. */
    payload,
    /** Chain id currently being submitted, if any. */
    submitting,
    error,
    isBusy: phase === "signing" || phase === "settling",
  };
}
