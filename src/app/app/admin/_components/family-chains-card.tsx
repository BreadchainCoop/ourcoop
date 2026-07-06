"use client";

import Link from "next/link";
import type { Address } from "viem";
import { Body, Button, Caption } from "@breadcoop/ui";
import { ArrowRight, CheckCircle, Warning } from "@phosphor-icons/react";
import { Card } from "@/components/dapp/ui";
import { shortChainName } from "@/lib/chains";
import { useActiveChainId } from "@/components/instance-provider";
import { useFamily, type FamilyChainState } from "@/hooks/use-family";
import {
  diffRecipients,
  useMirrorRecipients,
} from "@/hooks/use-mirror-recipients";

/**
 * The family's per-chain recipient sync panel. Cross-chain votes only land on a
 * chain whose recipient MEMBERSHIP matches, so drift is surfaced with one-click
 * "Mirror to <chain>" actions (queue additions/removals + processQueue on that
 * chain). "Add a chain" extends the family — creator-scoped, so it just links to
 * the Deploy page's resume/expand flow.
 */
export function FamilyChainsCard() {
  const family = useFamily();
  const activeChainId = useActiveChainId();
  const mirror = useMirrorRecipients();

  if (!family.isFamily) return null;

  const reference = family.perChain.find(
    (c) => c.chainId === activeChainId,
  )?.recipients;

  return (
    <Card>
      <Caption className="text-surface-grey-2">Chains</Caption>
      <Body className="text-surface-grey mt-1 text-sm">
        This community lives on{" "}
        {family.perChain.filter((c) => c.status === "found").length} chains.
        Votes won&apos;t sync to a chain while its recipient list differs — keep
        the memberships in sync below.
      </Body>

      <ul className="mt-4 space-y-3">
        {family.perChain.map((c) => (
          <SiblingRow
            key={c.chainId}
            chain={c}
            isActive={c.chainId === activeChainId}
            reference={reference}
            busy={mirror.busyChain === c.chainId}
            onMirror={(registry, diff) =>
              void mirror.mirror(c.chainId, registry, diff)
            }
          />
        ))}
      </ul>

      {mirror.error && (
        <Caption className="text-system-red mt-3 block">{mirror.error}</Caption>
      )}

      <div className="border-paper-2 mt-4 border-t pt-4">
        <Button
          app="fund"
          variant="secondary"
          as={Link}
          href={
            family.familyId
              ? `/app/deploy?family=${family.familyId}`
              : "/app/deploy"
          }
          rightIcon={<ArrowRight weight="bold" />}
        >
          Add a chain
        </Button>
        <Caption className="text-surface-grey mt-2 block">
          Extends the family to another chain with the exact same config. Cross-
          chain deploys are creator-scoped — use the wallet that created the
          community.
        </Caption>
      </div>
    </Card>
  );
}

function SiblingRow({
  chain,
  isActive,
  reference,
  busy,
  onMirror,
}: {
  chain: FamilyChainState;
  isActive: boolean;
  reference: readonly Address[] | undefined;
  busy: boolean;
  onMirror: (
    registry: Address,
    diff: ReturnType<typeof diffRecipients>,
  ) => void;
}) {
  const diff =
    reference && chain.recipients
      ? diffRecipients(reference, chain.recipients)
      : null;
  const inSync = diff && diff.toAdd.length === 0 && diff.toRemove.length === 0;

  return (
    <li className="border-paper-2 flex items-start justify-between gap-3 border-t pt-3 first:border-t-0 first:pt-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-breadDisplay text-text-standard font-bold">
            {shortChainName(chain.chainId)}
          </span>
          {isActive && (
            <Caption className="text-surface-grey">this chain</Caption>
          )}
        </div>
        {chain.status === "unreachable" ? (
          <Caption className="text-system-warning mt-0.5 block">
            couldn&apos;t reach chain
          </Caption>
        ) : isActive ? (
          <Caption className="text-surface-grey-2 mt-0.5 block">
            {chain.recipients?.length ?? 0} recipients — the reference list
          </Caption>
        ) : inSync ? (
          <Caption className="text-system-green mt-0.5 flex items-center gap-1">
            <CheckCircle size={13} weight="fill" /> in sync
          </Caption>
        ) : diff ? (
          <Caption className="text-system-warning mt-0.5 flex items-center gap-1">
            <Warning size={13} weight="fill" />
            {diff.toAdd.length} to add · {diff.toRemove.length} to remove
          </Caption>
        ) : (
          <Caption className="text-surface-grey mt-0.5 block">—</Caption>
        )}
      </div>

      {!isActive && chain.status === "found" && diff && !inSync && (
        <Button
          app="fund"
          variant="secondary"
          className="flex-none px-3 py-1 text-xs"
          isLoading={busy}
          onClick={() =>
            chain.instance && onMirror(chain.instance.recipientRegistry, diff)
          }
        >
          Mirror to {shortChainName(chain.chainId)}
        </Button>
      )}
    </li>
  );
}
