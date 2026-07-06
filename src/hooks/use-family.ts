"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { zeroHash, type Address, type Hex } from "viem";
import { useAccount, useReadContract } from "wagmi";
import {
  cycleModuleAbi,
  recipientRegistryAbi,
  votingModuleAbi,
} from "@/lib/abis";
import { useActiveChainId, useInstance } from "@/components/instance-provider";
import { publicClientFor, type InstanceAddresses } from "@/lib/instance";
import {
  resolveFamily,
  type FamilySibling,
  type FamilySiblingStatus,
} from "@/lib/families";

/** One family chain's live voting state (as seen from the connected wallet). */
export interface FamilyChainState {
  chainId: number;
  status: FamilySiblingStatus;
  instance?: InstanceAddresses;
  votingPower?: bigint;
  lastNonce?: bigint;
  hasVoted?: boolean;
  cycleNumber?: bigint;
  recipients?: readonly Address[];
  /** Admin registries: highest cross-chain registry-update nonce landed here. */
  lastRegistryUpdateNonce?: bigint;
  /** Recipient MEMBERSHIP differs from the active chain (order is irrelevant). */
  drift: boolean;
}

export interface FamilyState {
  /** Non-null once the module reports a familyId != 0. */
  familyId: Hex | null;
  isFamily: boolean;
  siblings: FamilySibling[];
  perChain: FamilyChainState[];
  /** True until the familyId read resolves (and, in family mode, siblings load). */
  isLoading: boolean;
  /** Re-resolve siblings + per-chain state; force bypasses the sibling cache. */
  refetch: (opts?: { force?: boolean }) => void;
}

async function loadChainState(
  sibling: FamilySibling,
  voter: Address | undefined,
): Promise<FamilyChainState> {
  const base: FamilyChainState = { ...sibling, drift: false };
  if (sibling.status !== "found" || !sibling.instance) return base;
  const client = publicClientFor(sibling.chainId);
  const a = sibling.instance;
  try {
    const [cycleNumber, recipients, votingPower, lastNonce, hasVoted] =
      await Promise.all([
        client.readContract({
          address: a.cycleModule,
          abi: cycleModuleAbi,
          functionName: "getCurrentCycle",
        }),
        client.readContract({
          address: a.recipientRegistry,
          abi: recipientRegistryAbi,
          functionName: "getRecipients",
        }),
        voter
          ? client.readContract({
              address: a.votingModule,
              abi: votingModuleAbi,
              functionName: "getVotingPower",
              args: [voter],
            })
          : Promise.resolve(undefined),
        voter
          ? client.readContract({
              address: a.votingModule,
              abi: votingModuleAbi,
              functionName: "lastCrossChainNonce",
              args: [voter],
            })
          : Promise.resolve(undefined),
        voter
          ? client.readContract({
              address: a.votingModule,
              abi: votingModuleAbi,
              functionName: "hasVotedInCurrentCycle",
              args: [voter],
            })
          : Promise.resolve(undefined),
      ]);
    // Admin registries expose lastRegistryUpdateNonce; on voting registries the
    // call reverts — a separate tolerant read so it never fails the whole chain.
    const lastRegistryUpdateNonce = await client
      .readContract({
        address: a.recipientRegistry,
        abi: recipientRegistryAbi,
        functionName: "lastRegistryUpdateNonce",
      })
      .catch(() => undefined);
    return {
      ...base,
      cycleNumber,
      recipients,
      votingPower,
      lastNonce,
      hasVoted,
      lastRegistryUpdateNonce,
    };
  } catch {
    return { ...base, status: "unreachable" };
  }
}

const sameMembership = (
  a: readonly Address[] | undefined,
  b: readonly Address[] | undefined,
): boolean => {
  if (!a || !b) return true; // can't compare — don't cry wolf
  if (a.length !== b.length) return false;
  const set = new Set(a.map((x) => x.toLowerCase()));
  return b.every((x) => set.has(x.toLowerCase()));
};

/**
 * Family state for the active instance: reads `familyId()` (ONE fast eth_call
 * that gates the vote page's mode), resolves siblings from every chain's
 * pinned deployer, and loads each found sibling's voting state for the
 * connected wallet. Classic (pre-family / familyId==0) instances report
 * `isFamily: false` — including old modules where the call reverts.
 */
export function useFamily(): FamilyState {
  const a = useInstance();
  const chainId = useActiveChainId();
  const { address } = useAccount();

  const familyIdRead = useReadContract({
    address: a.votingModule,
    abi: votingModuleAbi,
    functionName: "familyId",
    chainId,
    // Classic v1 modules don't have familyId() — the revert IS the answer.
    query: { retry: 1, refetchOnWindowFocus: false },
  });
  const familyKnown = familyIdRead.isSuccess || familyIdRead.isError;
  const familyId =
    familyIdRead.data && familyIdRead.data !== zeroHash
      ? familyIdRead.data
      : null;

  const [perChain, setPerChain] = useState<FamilyChainState[] | null>(null);
  const [seq, setSeq] = useState(0);
  const forceRef = useRef(false);

  useEffect(() => {
    if (!familyId) {
      setPerChain(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const siblings = await resolveFamily(familyId, {
        force: forceRef.current,
      });
      forceRef.current = false;
      const states = await Promise.all(
        siblings.map((s) => loadChainState(s, address)),
      );
      // Drift is measured against the ACTIVE chain's recipient membership.
      const reference = states.find((s) => s.chainId === chainId)?.recipients;
      for (const s of states) {
        if (s.chainId !== chainId && s.status === "found") {
          s.drift = !sameMembership(reference, s.recipients);
        }
      }
      if (!cancelled) setPerChain(states);
    })();
    return () => {
      cancelled = true;
    };
  }, [familyId, address, chainId, seq]);

  const refetch = useCallback((opts?: { force?: boolean }) => {
    forceRef.current = opts?.force ?? false;
    setSeq((s) => s + 1);
  }, []);

  return {
    familyId,
    isFamily: familyId !== null,
    siblings: perChain ?? [],
    perChain: perChain ?? [],
    isLoading: !familyKnown || (familyId !== null && perChain === null),
    refetch,
  };
}
