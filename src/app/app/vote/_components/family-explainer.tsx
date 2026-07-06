"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  X,
  Globe,
  Scales,
  ArrowsClockwise,
  ShieldCheck,
  ArrowLeft,
  ArrowRight,
} from "@phosphor-icons/react";
import { Body, Caption } from "@breadcoop/ui";

// Bumped to v2 so the richer, multi-slide explainer surfaces once more even for
// voters who dismissed the old single-paragraph primer.
const DISMISS_KEY = "crowdstake.familyVoteExplainer.dismissed.v2";

interface Slide {
  icon: ReactNode;
  title: string;
  body: ReactNode;
}

const SLIDES: Slide[] = [
  {
    icon: <Globe size={16} weight="fill" className="text-core-orange" />,
    title: "One vote, every chain",
    body: (
      <>
        This community lives on several chains at once. You sign a{" "}
        <strong>single ballot</strong> and it counts on all of them — no
        switching networks, no repeating yourself. Anyone can deliver your
        signed vote, so it still lands on chains where you hold no gas.
      </>
    ),
  },
  {
    icon: <Scales size={16} weight="fill" className="text-core-orange" />,
    title: "Same ballot, weighted by your stake on each chain",
    body: (
      <>
        Your allocation — the points you give each recipient — is{" "}
        <strong>identical</strong> on every chain. What changes is how much it
        counts: on each chain your ballot carries{" "}
        <strong>your voting power there</strong>, i.e. your stake on that chain.
        Big stake on Base and none on Gnosis? The same picks push hard on Base
        and are simply skipped on Gnosis. Because each chain tallies its own
        stakers, the <strong>outcome can differ per chain</strong> — that&apos;s
        by design, not a bug.
      </>
    ),
  },
  {
    icon: (
      <ArrowsClockwise size={16} weight="fill" className="text-core-orange" />
    ),
    title: "How the recipients stay in sync",
    body: (
      <>
        Your points line up with recipients by <strong>identity</strong>, not
        position — so recipient #2 on Base is the same address as recipient #2
        on Gnosis. That only holds if every chain agrees on the recipient list,
        so the roster itself is governed the same sign-once way: add/remove
        proposals are replayed on each chain and take effect independently. If a
        chain&apos;s list has <strong>drifted</strong> out of sync, we flag it
        and hold your vote there until an admin re-syncs it — the other chains
        still land.
      </>
    ),
  },
  {
    icon: <ShieldCheck size={16} weight="fill" className="text-core-orange" />,
    title: "This is not a bridge",
    body: (
      <>
        Nothing crosses chains — no tokens moved, no bridge messages, no wrapped
        assets, none of the bridge hack surface. Your <strong>signature</strong>{" "}
        is what travels: each chain independently verifies it and records the
        vote <strong>locally</strong>, using the stake you already hold there. A
        bridge would move value between chains and take on that risk; here your
        stake stays put and simply votes in place on every chain it already
        lives on.
      </>
    ),
  },
];

/**
 * First-family-vote primer, as a short slideshow: sign once and land
 * everywhere, why the same ballot weighs differently per chain, how the
 * recipient roster stays in sync, and how this differs from a bridge. Dismissed
 * permanently via localStorage so it never nags a returning voter.
 */
export function FamilyExplainer() {
  const [show, setShow] = useState(false);
  const [i, setI] = useState(0);
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

  const last = SLIDES.length - 1;
  const slide = SLIDES[i];
  const atEnd = i === last;

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

      <Caption className="text-text-standard flex items-center gap-1.5 pr-6 font-semibold">
        {slide.icon}
        {slide.title}
      </Caption>
      <Body className="text-surface-grey-2 mt-1.5 text-sm">{slide.body}</Body>

      <div className="mt-3 flex items-center justify-between">
        {/* Progress dots — click to jump. */}
        <div className="flex items-center gap-1.5">
          {SLIDES.map((_, idx) => (
            <button
              key={idx}
              type="button"
              aria-label={`Go to slide ${idx + 1}`}
              aria-current={idx === i}
              onClick={() => setI(idx)}
              className={`h-1.5 rounded-full transition-all ${
                idx === i
                  ? "bg-core-orange w-4"
                  : "bg-core-orange/30 hover:bg-core-orange/50 w-1.5"
              }`}
            />
          ))}
        </div>

        <div className="flex items-center gap-3">
          {i > 0 && (
            <button
              type="button"
              onClick={() => setI((n) => Math.max(0, n - 1))}
              className="text-surface-grey hover:text-text-standard inline-flex items-center gap-1 text-sm font-semibold"
            >
              <ArrowLeft size={14} weight="bold" /> Back
            </button>
          )}
          {atEnd ? (
            <button
              type="button"
              onClick={dismiss}
              className="text-core-orange inline-flex items-center gap-1 text-sm font-semibold hover:underline"
            >
              Got it
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setI((n) => Math.min(last, n + 1))}
              className="text-core-orange inline-flex items-center gap-1 text-sm font-semibold hover:underline"
            >
              Next <ArrowRight size={14} weight="bold" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
