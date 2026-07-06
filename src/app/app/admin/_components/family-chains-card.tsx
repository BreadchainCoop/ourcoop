"use client";

import Link from "next/link";
import type { Address } from "viem";
import { Body, Button, Caption } from "@breadcoop/ui";
import { ArrowRight, CheckCircle, Globe, Warning } from "@phosphor-icons/react";
import { Card } from "@/components/dapp/ui";
import { shortChainName } from "@/lib/chains";
import { useActiveChainId } from "@/components/instance-provider";
import { useFamily, type FamilyChainState } from "@/hooks/use-family";
import { useRegistryKind } from "@/hooks/use-recipient-voting";
import { useCrossChainRegistryUpdate } from "@/hooks/use-cross-chain-registry-update";
import { MultiChainActionStatus } from "@/components/dapp/multi-chain-action-status";
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
  const { kind } = useRegistryKind();

  if (!family.isFamily) return null;

  const reference = family.perChain.find(
    (c) => c.chainId === activeChainId,
  )?.recipients;

  // The sign-once "desired set" sync heals arbitrary drift on every sibling
  // from ONE admin signature — admin registries only (a democratic registry
  // converges through cross-chain proposals instead).
  const showSync = kind === "admin";
  const anyDrift = family.perChain.some((c) => c.drift);

  return (
    <Card>
      <Caption className="text-surface-grey-2">Chains</Caption>
      <Body className="text-surface-grey mt-1 text-sm">
        This community lives on{" "}
        {family.perChain.filter((c) => c.status === "found").length} chains.
        Votes won&apos;t sync to a chain while its recipient list differs — keep
        the memberships in sync below.
      </Body>

      {showSync && reference && (
        <SyncEverywhere
          family={family}
          reference={reference}
          drift={anyDrift}
        />
      )}

      <Caption className="text-surface-grey-2 mt-6 mb-2 block">
        {showSync ? "Per-chain mirror (fallback)" : "Per-chain recipients"}
      </Caption>
      <ul className="space-y-3">
        {family.perChain.map((c) => (
          <SiblingRow
            key={c.chainId}
            chain={c}
            isActive={c.chainId === activeChainId}
            reference={reference}
            busy={mirror.busyChain === c.chainId}
            // The manual mirror drives the classic queue functions, which
            // revert CrossChainOnly on democratic family registries — offer
            // it for admin registries only. Democratic families converge
            // through cross-chain proposals instead.
            onMirror={
              showSync
                ? (registry, diff) =>
                    void mirror.mirror(c.chainId, registry, diff)
                : undefined
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

/**
 * "Sync recipients everywhere" — the sign-once path above the per-chain Mirror
 * fallback. The admin signs ONE chain-agnostic desired-set signature (the full
 * recipient list from this chain, the reference); every sibling computes its own
 * delta and applies it, healing arbitrary drift. The relay delivers it (or the
 * admin self-submits per chain when no relay is reachable), and settlement is
 * confirmed on-chain via lastRegistryUpdateNonce.
 */
function SyncEverywhere({
  family,
  reference,
  drift,
}: {
  family: ReturnType<typeof useFamily>;
  reference: readonly Address[];
  drift: boolean;
}) {
  const sync = useCrossChainRegistryUpdate(family);

  return (
    <div className="border-paper-2 bg-paper-0 mt-4 rounded-xl border p-4">
      <Caption className="text-text-standard flex items-center gap-1.5 font-semibold">
        <Globe size={16} weight="fill" className="text-core-orange" />
        Sync recipients everywhere
      </Caption>
      <Body className="text-surface-grey-2 mt-1 text-sm">
        Sign once to push this chain&apos;s {reference.length} recipient
        {reference.length === 1 ? "" : "s"} to every sibling. Each chain applies
        its own delta, so one signature heals any drift — anyone can deliver it.
      </Body>
      <Button
        app="fund"
        variant="primary"
        className="mt-3"
        isLoading={sync.isBusy}
        onClick={() => sync.sign(reference)}
        {...(reference.length === 0 ? { disabled: true } : {})}
      >
        {drift ? "Sync recipients everywhere" : "Re-sync recipients"}
      </Button>
      {sync.error && (
        <Caption className="text-system-red mt-2 block">{sync.error}</Caption>
      )}
      <MultiChainActionStatus
        rows={sync.rows}
        phase={sync.phase}
        submitting={sync.submitting}
        payload={sync.payload}
        onSubmitOnChain={sync.submitOnChain}
        onRetryFailed={sync.retryFailed}
        copy={{
          stateLabel: (row) => {
            switch (row.state) {
              case "confirmed":
                return "Synced";
              case "superseded":
                return "Superseded by a newer sync";
              case "recipient_mismatch":
                return "Recipient list out of sync";
              case "unreachable":
                return "Couldn't reach chain";
              case "failed":
                return row.error ?? "Delivery failed";
              case "submitted":
                return "Submitted — confirming…";
              case "relaying":
                return "Submitting…";
              case "signing":
                return "Waiting for your signature…";
              default:
                return "Waiting…";
            }
          },
          aggregate: ({ counted, total, phase }) =>
            phase === "signing"
              ? "Confirm in your wallet…"
              : phase === "done"
                ? `Synced on ${counted} of ${total} chain${
                    total === 1 ? "" : "s"
                  }`
                : `Syncing ${total} chain${total === 1 ? "" : "s"}…`,
          copyLabel: "Copy signed sync",
          copyHint: "Anyone can deliver this — paste it to your community.",
        }}
      />
    </div>
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
  onMirror?: (
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

      {!isActive && chain.status === "found" && diff && !inSync && onMirror && (
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
