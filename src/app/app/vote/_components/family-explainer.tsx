"use client";

import { useEffect, useState } from "react";
import { X, Globe } from "@phosphor-icons/react";
import { Body, Caption } from "@breadcoop/ui";

const DISMISS_KEY = "crowdstake.familyVoteExplainer.dismissed.v1";

/**
 * First-family-vote primer: sign once, land everywhere, weighted per chain.
 * Dismissed permanently via localStorage so it never nags a returning voter.
 */
export function FamilyExplainer() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      setShow(window.localStorage.getItem(DISMISS_KEY) !== "1");
    } catch {
      setShow(true);
    }
  }, []);

  if (!show) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* private mode — just hide it for this session */
    }
    setShow(false);
  };

  return (
    <div className="border-core-orange/30 bg-core-orange/5 relative mb-6 rounded-xl border p-4">
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="text-surface-grey hover:text-text-standard absolute top-3 right-3"
      >
        <X size={16} weight="bold" />
      </button>
      <Caption className="text-text-standard flex items-center gap-1.5 font-semibold">
        <Globe size={16} weight="fill" className="text-core-orange" />
        One vote, every chain
      </Caption>
      <Body className="text-surface-grey-2 mt-1.5 text-sm">
        This is a multi-chain community. You sign a single ballot and it counts
        on every chain — the same ballot, weighted by your stake on each chain.
        Anyone can deliver your signed vote, so it lands even if you have no gas
        on some chains.
      </Body>
    </div>
  );
}
