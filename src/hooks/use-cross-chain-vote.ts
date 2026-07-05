"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import {
  useAccount,
  useSignTypedData,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { votingModuleAbi } from "@/lib/abis";
import { useActiveChainId } from "@/components/instance-provider";
import { publicClientFor } from "@/lib/instance";
import { parseTxError } from "@/hooks/use-tx";
import {
  CROSS_CHAIN_VOTE_TYPES,
  buildVotePayload,
  chooseNonce,
  crossChainVoteDomain,
  voteDeadline,
  type SignedVotePayload,
} from "@/lib/vote-signature";
import {
  getVoteStatus,
  postVote,
  relayConfigured,
  type RelayVoteStatus,
} from "@/lib/relay";
import type { FamilyState } from "@/hooks/use-family";

/** Per-chain delivery state for one signed vote. */
export type CrossChainVoteState =
  | "idle"
  | "signing"
  | "relaying"
  | "submitted"
  | "confirmed"
  | "superseded"
  | "skipped_no_power"
  | "recipient_mismatch"
  | "unreachable"
  // Relay down: this chain needs a wallet submission (or anyone can deliver the
  // copied payload). Not terminal — the settle poll still flips it if it lands.
  | "awaiting_submission"
  | "failed";

export interface ChainVoteRow {
  chainId: number;
  state: CrossChainVoteState;
  txHash?: Hex;
  error?: string;
}

export type CrossChainVotePhase = "idle" | "signing" | "settling" | "done";

const TERMINAL = new Set<CrossChainVoteState>([
  "confirmed",
  "superseded",
  "skipped_no_power",
  "recipient_mismatch",
  "unreachable",
  "failed",
]);

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
 * The whole cross-chain vote flow: sign ONE chainless EIP-712 message, hand it
 * to the relay (or self-submit from the wallet when no relay is reachable),
 * then settle each chain by polling `lastCrossChainNonce(voter) >= nonce`
 * ON-CHAIN — the relay's status is advisory detail (txHash, skip reasons);
 * the nonce landing is the vote being counted. Partial success is a normal
 * terminal state, remediable per row (retry relay / submit from wallet /
 * copy the signed payload for anyone to deliver).
 */
export function useCrossChainVote(family: FamilyState) {
  const chainId = useActiveChainId();
  const { address, chainId: walletChainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const [phase, setPhase] = useState<CrossChainVotePhase>("idle");
  const [rowsState, setRowsState] = useState<ChainVoteRow[]>([]);
  const [payload, setPayload] = useState<SignedVotePayload | null>(null);
  const [relayDown, setRelayDown] = useState(false);
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

  // Fold the relay's advisory report in — but never downgrade a state the
  // chain itself has confirmed.
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
              // The authoritative nonce read flips this to confirmed.
              return {
                ...r,
                state: "submitted" as const,
                txHash: adv.txHash ?? r.txHash,
              };
            case "superseded":
              return { ...r, state: "superseded" as const };
            case "skipped_no_power":
              return { ...r, state: "skipped_no_power" as const };
            case "recipient_mismatch":
              return { ...r, state: "recipient_mismatch" as const };
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
          }
        }),
      );
    },
    [setRows],
  );

  /** Deliver the signed vote from the user's wallet on one specific chain. */
  const submitOnChain = useCallback(
    async (targetChainId: number) => {
      const v = voteRef.current;
      const target = v?.chains.find((c) => c.chainId === targetChainId);
      if (!v || !target) return;
      setSubmitting(targetChainId);
      try {
        if (walletChainId !== targetChainId) {
          await switchChainAsync({ chainId: targetChainId });
        }
        const hash = await writeContractAsync({
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
    [walletChainId, switchChainAsync, writeContractAsync, updateRow],
  );

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
      const body = buildVotePayload(
        familyId,
        address,
        points,
        recipients,
        nonce,
        deadline,
        signature,
      );
      setPayload(body);
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
      if (relayConfigured()) {
        const res = await postVote(body);
        if (res) {
          applyAdvisory(res);
          return;
        }
      }
      // No relay reachable — deliver from the wallet on the active chain; the
      // other chains get per-row submit buttons + the copyable payload.
      setRelayDown(true);
      const self =
        found.find(
          (c) => c.chainId === chainId && (c.votingPower ?? 0n) > 0n,
        ) ?? found.find((c) => (c.votingPower ?? 0n) > 0n);
      // Every other powered chain now awaits a wallet submission (or anyone can
      // deliver the copied payload) — surface a Submit button rather than a
      // spinner that would never resolve without a relay.
      setRows((prev) =>
        prev.map((r) =>
          r.state === "relaying" && r.chainId !== self?.chainId
            ? { ...r, state: "awaiting_submission" as CrossChainVoteState }
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
    const res = await postVote(payload);
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
      const v = voteRef.current;
      if (!v || cancelled) return;
      if (relayConfigured() && !relayDown) {
        const adv = await getVoteStatus(v.familyId, v.voter, v.nonce).catch(
          () => null,
        );
        if (adv && !cancelled) applyAdvisory(adv);
      }
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
  }, [phase, relayDown, applyAdvisory, updateRow, setRows]);

  const reset = useCallback(() => {
    voteRef.current = null;
    setRows(() => []);
    setPhase("idle");
    setPayload(null);
    setRelayDown(false);
    setError(null);
  }, [setRows]);

  return {
    /** Sign + deliver: pass the points and the recipient order they map to. */
    sign,
    /** Deliver the signed vote yourself on one chain (wallet tx). */
    submitOnChain,
    /** Re-POST the signed vote to the relays. */
    retryRelay,
    reset,
    phase,
    rows: rowsState,
    /** The signed vote as relay-POST JSON — the "anyone can deliver" escape hatch. */
    payload,
    /** True when every configured relay is unreachable (fallback mode). */
    relayDown,
    /** Chain id currently being submitted from the wallet, if any. */
    submitting,
    error,
    isBusy: phase === "signing" || phase === "settling",
  };
}
