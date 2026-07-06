"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Hex } from "viem";
import { useAccount, useSignTypedData } from "wagmi";
import { votingRecipientRegistryAbi } from "@/lib/abis";
import { useActiveChainId } from "@/components/instance-provider";
import { publicClientFor } from "@/lib/instance";
import { parseTxError } from "@/hooks/use-tx";
import { useWalletActions } from "@/components/wallet/wallet-actions";
import {
  CROSS_CHAIN_PROPOSAL_TYPES,
  CROSS_CHAIN_PROPOSAL_VOTE_TYPES,
  buildProposalPayload,
  buildProposalVotePayload,
  computeProposalKey,
  crossChainVoteDomain,
  proposalNonce,
  voteDeadline,
  type CrossChainProposalMessage,
  type SignedProposalPayload,
  type SignedProposalVotePayload,
} from "@/lib/vote-signature";
import {
  CROSS_CHAIN_TERMINAL as TERMINAL,
  type ChainActionRow,
  type CrossChainActionPhase,
  type CrossChainActionState,
} from "@/lib/cross-chain-action";
import type { FamilyState } from "@/hooks/use-family";

/** One cross-chain proposal, content-addressed by its key (same on every chain). */
export interface CrossChainProposal {
  proposalKey: Hex;
  candidate: Address;
  isAddition: boolean;
  expiresAt: bigint;
  /** Aggregate max votes seen across chains (per-chain state in `perChain`). */
  voteCount: bigint;
  requiredVotes: bigint;
  /** Executed on at least one found chain. */
  executedAnywhere: boolean;
  /** The connected wallet has voted on at least one found chain. */
  votedHere: boolean;
  /** The connected wallet is in the signed electorate on the active chain. */
  eligibleHere: boolean;
  perChain: {
    chainId: number;
    exists: boolean;
    executed: boolean;
    voteCount: bigint;
    requiredVotes: bigint;
    hasVoted: boolean;
    /** In the proposal's signed electorate (per this chain's snapshot). */
    eligible: boolean;
  }[];
}

type Kind = "proposal" | "proposal-vote";

interface SignedProposalAction {
  kind: Kind;
  familyId: Hex;
  signer: Address;
  proposalKey: Hex;
  deadline: bigint;
  /** proposal creation only. */
  create?: {
    message: CrossChainProposalMessage;
    payload: SignedProposalPayload;
  };
  /** proposal vote only. */
  vote?: { payload: SignedProposalVotePayload };
  chains: { chainId: number; registry: Address }[];
}

/**
 * The min proposalExpiry ceiling across every found sibling registry. A signed
 * proposal's absolute expiresAt is bounded on-chain by
 * `block.timestamp + proposalExpiry` on EACH chain, so the frontend picks
 * `now + min(sibling proposalExpiry)` — delivery latency then can't exceed any
 * sibling's window (undefined until every found chain has answered).
 */
export function useSiblingProposalExpiry(
  family: FamilyState,
): bigint | undefined {
  const [minExpiry, setMinExpiry] = useState<bigint | undefined>(undefined);
  const found = family.perChain.filter(
    (c) => c.status === "found" && c.instance,
  );
  const key = found.map((c) => c.chainId).join(",");
  useEffect(() => {
    if (found.length === 0) {
      setMinExpiry(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      const expiries = await Promise.all(
        found.map((c) =>
          publicClientFor(c.chainId)
            .readContract({
              address: c.instance!.recipientRegistry,
              abi: votingRecipientRegistryAbi,
              functionName: "proposalExpiry",
            })
            .catch(() => undefined),
        ),
      );
      const valid = expiries.filter((e): e is bigint => e !== undefined);
      if (cancelled) return;
      // Only trust a min once every found chain answered (a missing read could
      // hide a smaller ceiling and produce an ExpiryTooFar revert there).
      setMinExpiry(
        valid.length === found.length
          ? valid.reduce((m, e) => (e < m ? e : m))
          : undefined,
      );
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return minExpiry;
}

/**
 * Democratic recipient governance for a family: proposals and votes are signed
 * ONCE and replayed on every sibling. The proposalKey is the EIP-712 struct
 * hash (content-addressed), so the same proposal exists under the same key
 * everywhere. Settlement is confirmed by ON-CHAIN reads — proposal existence
 * (create) / `hasVotedCrossChain` or execution (vote) — never the relay, which
 * is advisory.
 */
export function useCrossChainProposals(family: FamilyState) {
  const chainId = useActiveChainId();
  const { address } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const { sendSponsored } = useWalletActions();

  const [proposals, setProposals] = useState<CrossChainProposal[]>([]);
  const [loading, setLoading] = useState(false);
  const [seq, setSeq] = useState(0);

  const [phase, setPhase] = useState<CrossChainActionPhase>("idle");
  const [actionKind, setActionKind] = useState<Kind | null>(null);
  const [rowsState, setRowsState] = useState<ChainActionRow[]>([]);
  const [payload, setPayload] = useState<
    SignedProposalPayload | SignedProposalVotePayload | null
  >(null);
  const [submitting, setSubmitting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rowsRef = useRef<ChainActionRow[]>([]);
  const actionRef = useRef<SignedProposalAction | null>(null);

  const found = family.perChain.filter(
    (c) => c.status === "found" && c.instance,
  );

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

  const refetch = useCallback(() => setSeq((s) => s + 1), []);

  // ── Load cross-chain proposals across the family (content-addressed) ──
  useEffect(() => {
    if (!family.familyId || found.length === 0) {
      setProposals([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      // Enumerate keys per chain; the same key on any chain is one proposal.
      const keyToChains = new Map<Hex, Set<number>>();
      const meta = new Map<
        Hex,
        { candidate: Address; isAddition: boolean; expiresAt: bigint }
      >();
      await Promise.all(
        found.map(async (c) => {
          const registry = c.instance!.recipientRegistry;
          const client = publicClientFor(c.chainId);
          try {
            const count = await client.readContract({
              address: registry,
              abi: votingRecipientRegistryAbi,
              functionName: "crossChainProposalCount",
            });
            const n = Number(count);
            const keys = await Promise.all(
              Array.from({ length: n }, (_, i) =>
                client.readContract({
                  address: registry,
                  abi: votingRecipientRegistryAbi,
                  functionName: "crossChainProposalKeyAt",
                  args: [BigInt(i)],
                }),
              ),
            );
            for (const k of keys) {
              if (!keyToChains.has(k)) keyToChains.set(k, new Set());
              keyToChains.get(k)!.add(c.chainId);
            }
          } catch {
            /* voting registry may not exist here / transient — skip */
          }
        }),
      );

      // For each key, read its per-chain state on every found chain.
      const out: CrossChainProposal[] = [];
      await Promise.all(
        [...keyToChains.keys()].map(async (key) => {
          const perChain = await Promise.all(
            found.map(async (c) => {
              const registry = c.instance!.recipientRegistry;
              const client = publicClientFor(c.chainId);
              try {
                const p = await client.readContract({
                  address: registry,
                  abi: votingRecipientRegistryAbi,
                  functionName: "getCrossChainProposal",
                  args: [key],
                });
                const [
                  candidate,
                  isAddition,
                  executed,
                  expiresAt,
                  voteCount,
                  requiredVotes,
                ] = p;
                if (!meta.has(key))
                  meta.set(key, { candidate, isAddition, expiresAt });
                const [hasVoted, eligible] =
                  address !== undefined
                    ? await Promise.all([
                        client.readContract({
                          address: registry,
                          abi: votingRecipientRegistryAbi,
                          functionName: "hasVotedCrossChain",
                          args: [key, address],
                        }),
                        client.readContract({
                          address: registry,
                          abi: votingRecipientRegistryAbi,
                          functionName: "isEligibleCrossChainVoter",
                          args: [key, address],
                        }),
                      ])
                    : [false, false];
                return {
                  chainId: c.chainId,
                  exists: true,
                  executed,
                  voteCount,
                  requiredVotes,
                  hasVoted,
                  eligible,
                };
              } catch {
                // ProposalNotFound (not delivered here yet) or transient.
                return {
                  chainId: c.chainId,
                  exists: false,
                  executed: false,
                  voteCount: 0n,
                  requiredVotes: 0n,
                  hasVoted: false,
                  eligible: false,
                };
              }
            }),
          );
          const m = meta.get(key);
          if (!m) return;
          const active = perChain.find((c) => c.chainId === chainId);
          out.push({
            proposalKey: key,
            candidate: m.candidate,
            isAddition: m.isAddition,
            expiresAt: m.expiresAt,
            voteCount: perChain.reduce(
              (mx, c) => (c.voteCount > mx ? c.voteCount : mx),
              0n,
            ),
            requiredVotes: perChain.reduce(
              (mx, c) => (c.requiredVotes > mx ? c.requiredVotes : mx),
              0n,
            ),
            executedAnywhere: perChain.some((c) => c.executed),
            votedHere: perChain.some((c) => c.hasVoted),
            eligibleHere: active?.eligible ?? false,
            perChain,
          });
        }),
      );
      if (!cancelled) {
        setProposals(out);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family.familyId, address, chainId, seq, found.length]);

  /** Deliver the signed proposal/vote on one chain (sponsored or self-paid). */
  const submitOnChain = useCallback(
    async (targetChainId: number) => {
      const a = actionRef.current;
      const target = a?.chains.find((c) => c.chainId === targetChainId);
      if (!a || !target) return;
      setSubmitting(targetChainId);
      updateRow(targetChainId, { state: "relaying", error: undefined });
      try {
        let hash: Hex;
        if (a.kind === "proposal" && a.create) {
          const m = a.create.message;
          hash = await sendSponsored({
            chainId: targetChainId,
            address: target.registry,
            abi: votingRecipientRegistryAbi,
            functionName: "createCrossChainProposal",
            args: [
              m.proposer,
              m.candidate,
              m.isAddition,
              [...m.electorate],
              m.expiresAt,
              m.nonce,
              a.create.payload.signature,
            ],
          });
        } else {
          const v = a.vote!;
          hash = await sendSponsored({
            chainId: targetChainId,
            address: target.registry,
            abi: votingRecipientRegistryAbi,
            functionName: "castCrossChainProposalVote",
            args: [a.signer, a.proposalKey, a.deadline, v.payload.signature],
          });
        }
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

  /** Sign once, then submit to every reachable sibling (gas-sponsored). */
  const startDelivery = useCallback(
    async (
      action: SignedProposalAction,
      body: SignedProposalPayload | SignedProposalVotePayload,
    ) => {
      setPayload(body);
      setPhase("settling");
      for (const c of action.chains) {
        await submitOnChain(c.chainId);
      }
    },
    [submitOnChain],
  );

  /**
   * Create a cross-chain proposal. `electorate` MUST equal every chain's local
   * recipient set (pass the active chain's recipients). `expiresAt` is bounded
   * on-chain by each chain's proposalExpiry ceiling — the caller passes
   * `now + min(sibling proposalExpiry)` so delivery latency can't exceed any
   * sibling's window.
   */
  const propose = useCallback(
    async (
      candidate: Address,
      isAddition: boolean,
      electorate: readonly Address[],
      expiresAt: bigint,
    ) => {
      const familyId = family.familyId;
      if (!address || !familyId) return;
      setError(null);
      setPayload(null);
      setActionKind("proposal");
      const participants = family.perChain.filter((c) => c.status !== "none");
      const targets = found;
      if (targets.length === 0) {
        setError("No chain could be reached — retry loading the family.");
        return;
      }
      const message: CrossChainProposalMessage = {
        proposer: address,
        candidate,
        isAddition,
        electorate: [...electorate],
        expiresAt,
        nonce: proposalNonce(),
      };
      const proposalKey = computeProposalKey(message);
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
          types: CROSS_CHAIN_PROPOSAL_TYPES,
          primaryType: "CrossChainProposal",
          message: {
            proposer: message.proposer,
            candidate: message.candidate,
            isAddition: message.isAddition,
            electorate: [...message.electorate],
            expiresAt: message.expiresAt,
            nonce: message.nonce,
          },
        });
      } catch (e) {
        setPhase("idle");
        setRows(() => []);
        setError(parseTxError(e));
        return;
      }
      const body = buildProposalPayload(familyId, message, signature);
      const action: SignedProposalAction = {
        kind: "proposal",
        familyId,
        signer: address,
        proposalKey,
        deadline: expiresAt,
        create: { message, payload: body },
        chains: targets.map((c) => ({
          chainId: c.chainId,
          registry: c.instance!.recipientRegistry,
        })),
      };
      actionRef.current = action;
      await startDelivery(action, body);
    },
    [
      address,
      family.familyId,
      family.perChain,
      found,
      signTypedDataAsync,
      setRows,
      startDelivery,
    ],
  );

  /** Vote on an existing cross-chain proposal (sign once, land everywhere). */
  const voteOnProposal = useCallback(
    async (proposalKey: Hex) => {
      const familyId = family.familyId;
      if (!address || !familyId) return;
      setError(null);
      setPayload(null);
      setActionKind("proposal-vote");
      const participants = family.perChain.filter((c) => c.status !== "none");
      const targets = found;
      if (targets.length === 0) {
        setError("No chain could be reached — retry loading the family.");
        return;
      }
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
          types: CROSS_CHAIN_PROPOSAL_VOTE_TYPES,
          primaryType: "CrossChainProposalVote",
          message: { voter: address, proposalKey, deadline },
        });
      } catch (e) {
        setPhase("idle");
        setRows(() => []);
        setError(parseTxError(e));
        return;
      }
      const body = buildProposalVotePayload(
        familyId,
        address,
        proposalKey,
        deadline,
        signature,
      );
      const action: SignedProposalAction = {
        kind: "proposal-vote",
        familyId,
        signer: address,
        proposalKey,
        deadline,
        vote: { payload: body },
        chains: targets.map((c) => ({
          chainId: c.chainId,
          registry: c.instance!.recipientRegistry,
        })),
      };
      actionRef.current = action;
      await startDelivery(action, body);
    },
    [
      address,
      family.familyId,
      family.perChain,
      found,
      signTypedDataAsync,
      setRows,
      startDelivery,
    ],
  );

  // Settle loop: authoritative per-chain on-chain reads.
  useEffect(() => {
    if (phase !== "settling") return;
    let cancelled = false;
    const tick = async () => {
      const a = actionRef.current;
      if (!a || cancelled) return;
      await Promise.all(
        a.chains.map(async (c) => {
          const row = rowsRef.current.find((r) => r.chainId === c.chainId);
          if (!row || TERMINAL.has(row.state)) return;
          try {
            const client = publicClientFor(c.chainId);
            // Existence gates both kinds; the vote is confirmed once it's
            // recorded on-chain (or the proposal has executed).
            const p = await client
              .readContract({
                address: c.registry,
                abi: votingRecipientRegistryAbi,
                functionName: "getCrossChainProposal",
                args: [a.proposalKey],
              })
              .catch(() => null);
            if (cancelled) return;
            if (a.kind === "proposal") {
              if (p) updateRow(c.chainId, { state: "confirmed" });
              return;
            }
            // proposal-vote: executed proposal counts, else check hasVoted.
            if (p && p[2]) {
              updateRow(c.chainId, { state: "confirmed" });
              return;
            }
            const voted = await client.readContract({
              address: c.registry,
              abi: votingRecipientRegistryAbi,
              functionName: "hasVotedCrossChain",
              args: [a.proposalKey, a.signer],
            });
            if (!cancelled && voted)
              updateRow(c.chainId, { state: "confirmed" });
          } catch {
            /* transient read failure — next tick */
          }
        }),
      );
      if (cancelled) return;
      if (rowsRef.current.every((r) => TERMINAL.has(r.state))) {
        setPhase("done");
      } else if (BigInt(Math.floor(Date.now() / 1000)) > a.deadline) {
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
    actionRef.current = null;
    setRows(() => []);
    setPhase("idle");
    setActionKind(null);
    setPayload(null);
    setError(null);
  }, [setRows]);

  return {
    /** The family's cross-chain proposals (content-addressed, per-chain state). */
    proposals,
    proposalsLoading: loading,
    refetch,
    /** Create a proposal: candidate, add/remove, electorate, absolute expiresAt. */
    propose,
    /** Vote on a proposal by its key (sign once). */
    voteOnProposal,
    submitOnChain,
    /** Retry every chain whose submission failed. */
    retryFailed,
    reset,
    /** Which action the current delivery is for ("proposal" | "proposal-vote"). */
    actionKind,
    phase,
    rows: rowsState,
    payload,
    submitting,
    error,
    isBusy: phase === "signing" || phase === "settling",
  };
}
