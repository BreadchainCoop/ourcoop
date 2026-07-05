"use client";

import { useState } from "react";
import Link from "next/link";
import { useChainId } from "wagmi";
import { isAddress, type Address } from "viem";
import {
  CaretDown,
  Check,
  Copy,
  Plus,
  PlusCircle,
  SpinnerGap,
  X,
} from "@phosphor-icons/react";
import { useInstanceContext } from "@/components/instance-provider";
import { InstanceTokenBadge } from "@/components/dapp/instance-branding";
import {
  DEFAULT_INSTANCE,
  instanceShareUrl,
  resolveInstance,
} from "@/lib/instance";
import {
  DEFAULT_CHAIN_ID,
  isSupportedChain,
  shortChainName,
} from "@/lib/chains";
import { shortenAddress } from "@/lib/format";
import { cn, copyToClipboard } from "@/lib/utils";
import type { KnownInstance } from "@/lib/instance";

/** A family group (siblings sharing a familyId) or a standalone instance. */
type SwitcherRow =
  | { kind: "instance"; instance: KnownInstance }
  | {
      kind: "family";
      familyId: string;
      label: string;
      /** The canonical share-link sibling (primaryChainId, else the first). */
      primary: KnownInstance;
      siblings: KnownInstance[];
    };

/** Group known instances by familyId; classic instances pass through as-is. */
function groupInstances(known: KnownInstance[]): SwitcherRow[] {
  const families = new Map<string, KnownInstance[]>();
  const rows: SwitcherRow[] = [];
  for (const inst of known) {
    if (inst.familyId) {
      const list = families.get(inst.familyId) ?? [];
      list.push(inst);
      families.set(inst.familyId, list);
    } else {
      rows.push({ kind: "instance", instance: inst });
    }
  }
  for (const [familyId, siblings] of families) {
    const primary =
      siblings.find((s) => s.chainId === s.primaryChainId) ?? siblings[0];
    rows.push({
      kind: "family",
      familyId,
      label: primary.label,
      primary,
      siblings,
    });
  }
  return rows;
}

/** A small colored disc showing an instance label's initial (list rows). */
function InitialDisc({ label }: { label: string }) {
  return (
    <div className="bg-core-orange/15 text-core-orange flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold">
      {label.slice(0, 1).toUpperCase()}
    </div>
  );
}

/**
 * The active-instance selector — the app's "which community am I in" control.
 * Switch between known instances, add one by address, copy a shareable link for
 * any instance, or deploy a new one.
 */
export function InstanceSwitcher() {
  const {
    label,
    known,
    addresses,
    setActive,
    addInstance,
    removeInstance,
    resolving,
  } = useInstanceContext();
  const defaultDm =
    DEFAULT_INSTANCE.addresses.distributionManager.toLowerCase();
  // Add "by address" resolves on the wallet's connected chain (else home chain).
  const walletChainId = useChainId();
  const addChainId = isSupportedChain(walletChainId)
    ? walletChainId
    : DEFAULT_CHAIN_ID;
  const [open, setOpen] = useState(false);
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const onAdd = async () => {
    if (!isAddress(addr)) {
      setErr("Not a valid address");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const resolved = await resolveInstance(addr as Address, addChainId);
      addInstance({
        label: shortenAddress(addr, 4),
        chainId: addChainId,
        addresses: resolved,
      });
      setAddr("");
      setOpen(false);
    } catch {
      setErr("Could not resolve — is this a distribution manager?");
    } finally {
      setBusy(false);
    }
  };

  const onCopy = async (dm: Address, chainId: number) => {
    if (await copyToClipboard(instanceShareUrl(dm, chainId))) {
      setCopied(dm.toLowerCase());
      setTimeout(() => setCopied(null), 1600);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="border-paper-2 text-text-standard hover:border-core-orange flex max-w-[13rem] items-center gap-2 rounded-lg border py-1 pr-2 pl-1 text-sm font-medium"
      >
        {resolving ? (
          <SpinnerGap size={22} className="text-core-orange animate-spin" />
        ) : (
          <InstanceTokenBadge className="h-7 w-7" />
        )}
        <span className="min-w-0 truncate">
          {resolving ? "Loading…" : label}
        </span>
        <CaretDown size={14} className="text-surface-grey flex-none" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="border-paper-2 bg-paper-0 absolute left-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border p-2 shadow-xl">
            <p className="text-surface-grey px-2 py-1 text-xs font-semibold">
              Your instances
            </p>
            {groupInstances(known).map((row) => {
              const onActivate = (dm: Address) => {
                setActive(dm);
                setOpen(false);
              };
              if (row.kind === "family") {
                return (
                  <FamilyGroupRow
                    key={`family-${row.familyId}`}
                    row={row}
                    activeDm={addresses.distributionManager}
                    copied={copied}
                    onActivate={onActivate}
                    onCopy={onCopy}
                    onRemove={removeInstance}
                  />
                );
              }
              const inst = row.instance;
              const dm = inst.addresses.distributionManager;
              return (
                <InstanceRow
                  key={dm}
                  inst={inst}
                  isActive={
                    dm.toLowerCase() ===
                    addresses.distributionManager.toLowerCase()
                  }
                  isDefault={dm.toLowerCase() === defaultDm}
                  isCopied={copied === dm.toLowerCase()}
                  onActivate={onActivate}
                  onCopy={onCopy}
                  onRemove={removeInstance}
                />
              );
            })}

            <Link
              href="/app/deploy"
              onClick={() => setOpen(false)}
              className="text-core-orange hover:bg-paper-1 mt-1 flex items-center gap-2 rounded-lg px-2 py-2 text-sm font-semibold"
            >
              <PlusCircle size={18} weight="bold" />
              Deploy a new instance
            </Link>

            <div className="border-paper-2 mt-2 border-t pt-2">
              <p className="text-surface-grey px-2 pb-1 text-xs font-semibold">
                Add by distribution manager
              </p>
              <div className="flex gap-1.5 px-1">
                <input
                  value={addr}
                  onChange={(e) => setAddr(e.target.value)}
                  placeholder="0x…"
                  className="border-paper-2 bg-paper-main text-text-standard focus:border-core-orange w-full rounded-lg border px-2 py-1.5 font-mono text-xs outline-none"
                />
                <button
                  onClick={onAdd}
                  disabled={busy}
                  className="bg-core-orange flex flex-none items-center rounded-lg px-2 text-white disabled:opacity-50"
                >
                  {busy ? (
                    <SpinnerGap size={16} className="animate-spin" />
                  ) : (
                    <Plus size={16} weight="bold" />
                  )}
                </button>
              </div>
              {err && (
                <p className="text-system-red px-2 pt-1 text-xs">{err}</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Copy-link + remove buttons shared by instance and family rows. */
function RowActions({
  dm,
  chainId,
  removable,
  isCopied,
  copyLabel = "Copy shareable link",
  removeLabel = "Remove instance",
  onCopy,
  onRemove,
}: {
  dm: Address;
  chainId: number;
  removable: boolean;
  isCopied: boolean;
  copyLabel?: string;
  removeLabel?: string;
  onCopy: (dm: Address, chainId: number) => void;
  onRemove: (dm: Address) => void;
}) {
  return (
    <>
      <button
        onClick={() => onCopy(dm, chainId)}
        aria-label={copyLabel}
        title={copyLabel}
        className={cn(
          "flex-none rounded p-1.5",
          isCopied
            ? "text-system-green"
            : "text-surface-grey hover:text-text-standard",
        )}
      >
        {isCopied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
      </button>
      {removable && (
        <button
          onClick={() => onRemove(dm)}
          aria-label={removeLabel}
          className="text-surface-grey hover:text-system-red flex-none rounded p-1.5"
        >
          <X size={14} weight="bold" />
        </button>
      )}
    </>
  );
}

/** A standalone (non-family) instance row. */
function InstanceRow({
  inst,
  isActive,
  isDefault,
  isCopied,
  onActivate,
  onCopy,
  onRemove,
}: {
  inst: KnownInstance;
  isActive: boolean;
  isDefault: boolean;
  isCopied: boolean;
  onActivate: (dm: Address) => void;
  onCopy: (dm: Address, chainId: number) => void;
  onRemove: (dm: Address) => void;
}) {
  const dm = inst.addresses.distributionManager;
  return (
    <div
      className={cn(
        "group hover:bg-paper-1 flex items-center gap-1 rounded-lg px-1.5 py-1.5",
        isActive && "bg-paper-1",
      )}
    >
      <button
        onClick={() => onActivate(dm)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <InitialDisc label={inst.label} />
        <span className="min-w-0">
          <span
            className={cn(
              "block truncate text-sm",
              isActive
                ? "text-core-orange font-semibold"
                : "text-text-standard",
            )}
          >
            {inst.label}
          </span>
          <span className="text-surface-grey block truncate font-mono text-[11px]">
            {shortenAddress(dm, 4)}
          </span>
        </span>
        {isActive && (
          <Check
            size={16}
            weight="bold"
            className="text-core-orange flex-none"
          />
        )}
      </button>
      <RowActions
        dm={dm}
        chainId={inst.chainId}
        removable={!isDefault}
        isCopied={isCopied}
        onCopy={onCopy}
        onRemove={onRemove}
      />
    </div>
  );
}

/**
 * A family group: one row for the whole cross-chain community, with a chain chip
 * per sibling (active chip highlighted). Copy shares the canonical (primary
 * chain) link; remove drops the whole family group at once.
 */
function FamilyGroupRow({
  row,
  activeDm,
  copied,
  onActivate,
  onCopy,
  onRemove,
}: {
  row: Extract<SwitcherRow, { kind: "family" }>;
  activeDm: Address;
  copied: string | null;
  onActivate: (dm: Address) => void;
  onCopy: (dm: Address, chainId: number) => void;
  onRemove: (dm: Address) => void;
}) {
  const primaryDm = row.primary.addresses.distributionManager;
  const familyActive = row.siblings.some(
    (s) =>
      s.addresses.distributionManager.toLowerCase() === activeDm.toLowerCase(),
  );
  return (
    <div
      className={cn(
        "hover:bg-paper-1 rounded-lg px-1.5 py-1.5",
        familyActive && "bg-paper-1",
      )}
    >
      <div className="flex items-center gap-1">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <InitialDisc label={row.label} />
          <span className="min-w-0">
            <span
              className={cn(
                "block truncate text-sm",
                familyActive
                  ? "text-core-orange font-semibold"
                  : "text-text-standard",
              )}
            >
              {row.label}
            </span>
            <span className="text-surface-grey block truncate text-[11px]">
              on {row.siblings.length} chains
            </span>
          </span>
        </span>
        <RowActions
          dm={primaryDm}
          chainId={row.primary.chainId}
          removable
          isCopied={copied === primaryDm.toLowerCase()}
          copyLabel="Copy family link"
          removeLabel="Remove family"
          onCopy={onCopy}
          onRemove={() =>
            row.siblings.forEach((s) =>
              onRemove(s.addresses.distributionManager),
            )
          }
        />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1 pl-9">
        {row.siblings.map((s) => {
          const dm = s.addresses.distributionManager;
          const chipActive = dm.toLowerCase() === activeDm.toLowerCase();
          return (
            <button
              key={dm}
              onClick={() => onActivate(dm)}
              className={cn(
                "rounded-md border px-2 py-0.5 text-[11px] font-medium",
                chipActive
                  ? "border-core-orange text-core-orange bg-core-orange/5"
                  : "border-paper-2 text-surface-grey-2 hover:border-core-orange/50",
              )}
            >
              {shortChainName(s.chainId)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
