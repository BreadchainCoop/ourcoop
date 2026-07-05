import type { ReactNode } from "react";
import { Body, Heading2, Heading4 } from "@breadcoop/ui";
import {
  Buildings,
  Coins,
  Confetti,
  HandCoins,
  Heart,
  ShieldCheck,
  Sliders,
  TrendUp,
  User,
} from "@phosphor-icons/react/dist/ssr";
import { cn } from "@/lib/utils";

/**
 * HowItWorks
 * ----------
 * The four-beat story of Crowdstaking — pool → earn → vote → fund — with a
 * bespoke, purely-CSS-animated illustration paired with every step instead of
 * plain text. The animations loop gently and are disabled automatically under
 * `prefers-reduced-motion` (see the `.hiw-*` rules in globals.css); each visual
 * still reads correctly in its resting state.
 */

type Step = {
  title: string;
  body: string;
  caption: string;
  Visual: () => ReactNode;
};

const STEPS: Step[] = [
  {
    title: "Community pools assets",
    body: "Members deposit funds to the shared community pool in your own branded interface.",
    caption: "Members → community pool",
    Visual: PoolVisual,
  },
  {
    title: "Automated interest generation",
    body: "Funds are automatically generating yield through overcollateralized loans.",
    caption: "Only the yield grows — principal stays whole",
    Visual: YieldVisual,
  },
  {
    title: "Community decides on funding",
    body: "Interest is allocated to your community's shared goal.",
    caption: "Weighted votes split the yield",
    Visual: VoteVisual,
  },
  {
    title: "Projects get funded",
    body: "Projects receive funding while members retain their original principal amount.",
    caption: "Yield → recipients · principal returns 1:1",
    Visual: FundVisual,
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="py-20">
      <div className="section-container">
        <Heading2 className="text-text-standard text-center">
          Fundraising for free: from shared funds to shared futures
        </Heading2>

        <ol className="mx-auto mt-14 max-w-5xl space-y-12 sm:space-y-16">
          {STEPS.map((step, i) => {
            const flip = i % 2 === 1; // alternate the visual left/right on desktop
            return (
              <li
                key={step.title}
                className="grid items-center gap-6 sm:gap-10 lg:grid-cols-2"
              >
                <div className={cn("flex gap-5", flip && "lg:order-2")}>
                  <span className="bg-core-orange font-breadDisplay flex h-10 w-10 flex-none items-center justify-center rounded-full font-bold text-white">
                    {i + 1}
                  </span>
                  <div>
                    <Heading4 className="text-text-standard">
                      {step.title}
                    </Heading4>
                    <Body className="text-surface-grey-2 mt-2">
                      {step.body}
                    </Body>
                  </div>
                </div>

                <VisualFrame
                  caption={step.caption}
                  className={cn(flip && "lg:order-1")}
                >
                  <step.Visual />
                </VisualFrame>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

/* ------------------------------- Visual frame ----------------------------- */

function VisualFrame({
  children,
  caption,
  className,
}: {
  children: ReactNode;
  caption: string;
  className?: string;
}) {
  return (
    <figure
      className={cn(
        "border-paper-2 from-paper-0 to-paper-1 relative flex h-60 items-center justify-center overflow-hidden rounded-2xl border bg-linear-to-b shadow-sm",
        className,
      )}
    >
      {children}
      <figcaption className="text-surface-grey absolute right-4 bottom-3 left-4 truncate text-right text-xs font-medium">
        {caption}
      </figcaption>
    </figure>
  );
}

/* ----------------------------- 1 · Pool assets ---------------------------- */

function PoolVisual() {
  const coins = [
    { left: "12%", delay: "0s" },
    { left: "32%", delay: "0.55s" },
    { left: "50%", delay: "1.1s" },
    { left: "68%", delay: "1.65s" },
    { left: "86%", delay: "2.2s" },
  ];
  return (
    <div className="flex w-full max-w-[15rem] flex-col items-center gap-2 px-4 pb-4">
      <div className="flex justify-center gap-2.5">
        {[0, 1, 2, 3].map((m) => (
          <span
            key={m}
            className="bg-core-orange/10 flex h-9 w-9 items-center justify-center rounded-full"
          >
            <User size={18} weight="bold" className="text-core-orange" />
          </span>
        ))}
      </div>

      <div className="relative h-9 w-full">
        {coins.map((c, i) => (
          <span
            key={i}
            className="hiw-coin bg-core-orange absolute top-0 h-2.5 w-2.5 rounded-full"
            style={{ left: c.left, animationDelay: c.delay }}
          />
        ))}
      </div>

      <div className="border-primary-jade/40 relative h-20 w-full overflow-hidden rounded-xl border-2">
        <div className="hiw-pool-fill bg-primary-jade/25 absolute inset-x-0 bottom-0 h-[60%]" />
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <Coins size={22} weight="duotone" className="text-primary-jade" />
          <span className="text-primary-jade mt-1 text-xs font-semibold">
            Community pool
          </span>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- 2 · Yield growth ---------------------------- */

function YieldVisual() {
  return (
    <div className="flex w-full max-w-[16rem] items-end justify-center gap-4 px-4 pb-6">
      <div className="border-paper-2 bg-paper-1 relative flex h-40 w-20 flex-col justify-end rounded-xl border-2 p-1.5">
        <div className="hiw-yield-grow bg-core-orange flex h-[36%] items-center justify-center rounded-md">
          <TrendUp size={16} weight="bold" className="text-white" />
        </div>
        <div className="bg-primary-jade mt-1 flex h-[52%] items-center justify-center rounded-md">
          <span className="text-[10px] font-bold text-white">Principal</span>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="hiw-rise border-core-orange/30 bg-core-orange/10 text-core-orange inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-bold">
          <TrendUp size={13} weight="bold" /> + yield
        </span>
        <span className="border-primary-jade/30 bg-primary-jade/10 text-primary-jade inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold">
          <ShieldCheck size={13} weight="bold" /> Over-collateralized
        </span>
      </div>
    </div>
  );
}

/* ------------------------------- 3 · Voting ------------------------------- */

function VoteVisual() {
  const rows = [
    { label: "Recipient A", w: "82%", delay: "0s" },
    { label: "Recipient B", w: "56%", delay: "0.35s" },
    { label: "Recipient C", w: "38%", delay: "0.7s" },
  ];
  return (
    <div className="flex w-full max-w-[16rem] flex-col gap-3 px-5 pb-4">
      <div className="text-surface-grey-2 flex items-center gap-1.5 text-xs font-semibold">
        <Sliders size={15} weight="bold" className="text-core-orange" />
        Allocate the yield
      </div>
      {rows.map((r) => (
        <div key={r.label}>
          <div className="text-surface-grey mb-1 text-[11px] font-medium">
            {r.label}
          </div>
          <div className="bg-paper-1 h-2.5 w-full overflow-hidden rounded-full">
            <div
              className="hiw-bar bg-core-orange h-full origin-left rounded-full"
              style={{ width: r.w, animationDelay: r.delay }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ 4 · Funding ------------------------------- */

function FundVisual() {
  const recipients = [Heart, Buildings, Confetti];
  return (
    <div className="flex w-full max-w-[17rem] items-center justify-between gap-2 px-4 pb-4">
      <div className="border-primary-jade/40 bg-primary-jade/5 flex h-16 w-16 flex-none flex-col items-center justify-center rounded-xl border-2">
        <HandCoins size={20} weight="duotone" className="text-primary-jade" />
        <span className="text-primary-jade mt-0.5 text-[9px] font-semibold">
          Yield
        </span>
      </div>

      <div className="relative h-8 w-16 flex-none">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="hiw-flow bg-core-orange absolute top-1/2 h-2 w-2 -translate-y-1/2 rounded-full"
            style={{ animationDelay: `${i * 0.5}s` }}
          />
        ))}
      </div>

      <div className="flex flex-none flex-col gap-2">
        {recipients.map((Icon, i) => (
          <span
            key={i}
            className="hiw-pulse border-core-orange/30 bg-core-orange/10 flex h-8 w-8 items-center justify-center rounded-lg border"
            style={{ animationDelay: `${i * 0.5}s` }}
          >
            <Icon size={16} weight="bold" className="text-core-orange" />
          </span>
        ))}
      </div>
    </div>
  );
}
