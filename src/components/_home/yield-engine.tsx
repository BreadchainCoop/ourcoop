import type { ReactNode } from "react";
import { Body, Chip, Heading2, Heading4 } from "@breadcoop/ui";
import {
  Bank,
  CurrencyDollar,
  Lock,
  Percent,
  ShieldCheck,
  TrendUp,
  User,
} from "@phosphor-icons/react/dist/ssr";
import { cn } from "@/lib/utils";

/**
 * YieldEngine
 * -----------
 * A zoom-in on "Automated interest generation" (step 2 of HowItWorks): where
 * the yield actually comes from. It breaks over-collateralized lending into
 * five animated beats — lend it out → why borrowers want it → they
 * over-collateralize → the collateral protects the principal → borrower
 * interest becomes the yield.
 *
 * Kept deliberately protocol-agnostic: no product or venue names, just
 * "stablecoins"/"dollars" and "an asset", so the mechanism reads on its own.
 *
 * Same visual language as HowItWorks: alternating text/visual rows with
 * purely-CSS `.hiw-*` animations that stop under `prefers-reduced-motion` and
 * still read correctly at rest.
 */

type Step = {
  title: string;
  body: string;
  caption: string;
  Visual: () => ReactNode;
};

const STEPS: Step[] = [
  {
    title: "Your deposit is lent out",
    body: "The pool's stablecoins don't sit idle. They're lent out to borrowers — your community's dollars become the lending capital that the whole system runs on.",
    caption: "Pool dollars → lent to borrowers",
    Visual: LendVisual,
  },
  {
    title: "Why borrowers want the loan",
    body: "A borrower is betting an asset will rise. Rather than sell it, they lock it up and borrow dollars against it — often to buy even more of it. It's leverage: they hold a bigger position and plan to repay the loan later, keeping the upside if the price climbs.",
    caption: "Bullish on an asset → borrow dollars against it",
    Visual: BorrowerVisual,
  },
  {
    title: "They lock up more than they borrow",
    body: "Nobody borrows on trust. To take a $100 loan, a borrower must first lock roughly $150 of their asset as collateral. The loan is always backed by more value than it lends out — that's over-collateralization.",
    caption: "$150 locked to borrow $100",
    Visual: CollateralVisual,
  },
  {
    title: "The collateral protects your principal",
    body: "That extra collateral is the safety margin. If the asset's price falls, the buffer absorbs the dip; if it ever runs thin, the collateral is automatically sold to repay the loan in full. Losing that collateral is the risk the borrower knowingly takes — and it's exactly what keeps the pool's principal backed 1:1, never at risk.",
    caption: "Collateral stays above the loan — or it's auto-liquidated",
    Visual: BufferVisual,
  },
  {
    title: "Borrowers pay interest — that's your yield",
    body: "For borrowing, they pay interest the whole time the loan is open. That interest flows back into the pool and settles on top of everyone's principal. It's the yield your community distributes — earned without anyone spending their savings.",
    caption: "Borrower interest → stacks on top as yield",
    Visual: InterestVisual,
  },
];

export function YieldEngine() {
  return (
    <section id="yield-engine" className="bg-paper-1 py-20">
      <div className="section-container">
        <div className="mx-auto max-w-3xl text-center">
          <div className="flex justify-center">
            <Chip size="small" className="text-primary-jade">
              Over-collateralized lending
            </Chip>
          </div>
          <Heading2 className="text-text-standard mt-4">
            How the interest is actually generated
          </Heading2>
          <Body className="text-surface-grey-2 mx-auto mt-4 text-lg">
            A closer look at step 2. The yield isn&apos;t magic — it&apos;s the
            interest borrowers pay to take over-collateralized loans against your
            pool. Here&apos;s the full chain, and why your principal is never at
            risk.
          </Body>
        </div>

        <ol className="mx-auto mt-14 max-w-5xl space-y-12 sm:space-y-16">
          {STEPS.map((step, i) => {
            const flip = i % 2 === 1;
            return (
              <li
                key={step.title}
                className="grid items-center gap-6 sm:gap-10 lg:grid-cols-2"
              >
                <div className={cn("flex gap-5", flip && "lg:order-2")}>
                  <span className="bg-primary-jade font-breadDisplay flex h-10 w-10 flex-none items-center justify-center rounded-full font-bold text-white">
                    {i + 1}
                  </span>
                  <div>
                    <Heading4 className="text-text-standard">
                      {step.title}
                    </Heading4>
                    <Body className="text-surface-grey-2 mt-2">{step.body}</Body>
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

function FlowDots({ width }: { width: string }) {
  return (
    <div className={cn("relative h-8 flex-none", width)}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="hiw-flow bg-core-orange absolute top-1/2 h-2 w-2 -translate-y-1/2 rounded-full"
          style={{ animationDelay: `${i * 0.5}s` }}
        />
      ))}
    </div>
  );
}

/* --------------------------- 1 · Deposit lent out ------------------------- */

function LendVisual() {
  return (
    <div className="flex w-full max-w-[18rem] items-center justify-between gap-2 px-4 pb-4">
      <div className="border-primary-jade/40 bg-primary-jade/5 flex h-20 w-20 flex-none flex-col items-center justify-center rounded-xl border-2 text-center">
        <Bank size={22} weight="duotone" className="text-primary-jade" />
        <span className="text-primary-jade mt-1 px-1 text-[10px] leading-tight font-semibold">
          Stablecoin pool
        </span>
      </div>

      <FlowDots width="w-16" />

      <div className="border-paper-2 bg-paper-0 flex h-20 w-20 flex-none flex-col items-center justify-center rounded-xl border-2">
        <User size={22} weight="bold" className="text-surface-grey-2" />
        <span className="text-surface-grey-2 mt-1 text-[10px] font-semibold">
          Borrower
        </span>
        <span className="text-core-orange text-[10px] font-bold">
          borrows $100
        </span>
      </div>
    </div>
  );
}

/* --------------------------- 2 · Why borrowers borrow --------------------- */

function BorrowerVisual() {
  return (
    <div className="flex w-full max-w-[18rem] items-center justify-between gap-2 px-4 pb-4">
      {/* An asset they believe will rise — kept, not sold. */}
      <div className="flex flex-none flex-col items-center gap-1.5">
        <div className="border-primary-jade/40 bg-primary-jade/5 flex h-16 w-16 items-center justify-center rounded-xl border-2">
          <TrendUp size={22} weight="bold" className="text-primary-jade" />
        </div>
        <span className="hiw-rise border-primary-jade/30 bg-primary-jade/10 text-primary-jade inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold">
          <TrendUp size={11} weight="bold" /> expects ↑
        </span>
      </div>

      {/* Locked as collateral, dollars flow out. */}
      <div className="flex flex-none flex-col items-center gap-1.5">
        <Lock size={15} weight="bold" className="text-surface-grey-2" />
        <FlowDots width="w-14" />
      </div>

      {/* Dollars to put to work — leverage. */}
      <div className="border-core-orange/40 bg-core-orange/5 flex h-16 w-16 flex-none flex-col items-center justify-center rounded-xl border-2">
        <CurrencyDollar size={22} weight="bold" className="text-core-orange" />
        <span className="text-core-orange mt-0.5 text-[10px] font-semibold">
          borrows $
        </span>
      </div>
    </div>
  );
}

/* --------------------------- 2 · Over-collateralize ----------------------- */

function CollateralVisual() {
  return (
    <div className="flex w-full max-w-[16rem] flex-col items-center gap-2.5 px-4 pb-5">
      <div className="text-primary-jade flex items-center gap-1.5 text-[11px] font-semibold">
        <Lock size={13} weight="bold" /> Collateral locked · $150
      </div>
      <div className="border-primary-jade/50 flex h-36 w-24 flex-col justify-end rounded-xl border-2 p-1.5">
        <div className="hiw-grow-y bg-primary-jade/25 flex h-[34%] origin-bottom items-center justify-center rounded-md">
          <span className="text-primary-jade text-[10px] font-bold">
            +50% buffer
          </span>
        </div>
        <div className="bg-core-orange mt-1 flex h-[57%] items-center justify-center rounded-md">
          <span className="text-[10px] font-bold text-white">Borrowed $100</span>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- 3 · Safety buffer -------------------------- */

function BufferVisual() {
  return (
    <div className="flex w-full max-w-[17rem] items-center justify-center gap-5 px-4 pb-6">
      <div className="border-paper-2 bg-paper-0 relative h-40 w-20 flex-none rounded-xl border-2">
        {/* Collateral value — fluctuates but stays above the loan floor. */}
        <div className="hiw-dip bg-primary-jade/70 absolute inset-x-1 bottom-1 h-[78%] rounded-lg" />
        {/* Loan floor. */}
        <div className="border-core-orange absolute inset-x-0 bottom-[42%] border-t-2 border-dashed" />
        <ShieldCheck
          size={20}
          weight="fill"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 text-white"
        />
      </div>

      <ul className="flex flex-col gap-2.5 text-[11px] font-medium">
        <li className="text-primary-jade flex items-center gap-1.5">
          <span className="bg-primary-jade/70 h-2.5 w-2.5 rounded-full" />
          Collateral value
        </li>
        <li className="text-core-orange flex items-center gap-1.5">
          <span className="border-core-orange w-3 border-t-2 border-dashed" />
          Loan floor
        </li>
        <li className="text-surface-grey-2 flex items-center gap-1.5">
          <ShieldCheck size={13} weight="bold" className="text-primary-jade" />
          Auto-liquidates if breached
        </li>
      </ul>
    </div>
  );
}

/* --------------------------- 4 · Interest = yield ------------------------- */

function InterestVisual() {
  return (
    <div className="flex w-full max-w-[18rem] items-center justify-between gap-2 px-4 pb-4">
      <div className="flex flex-none flex-col items-center gap-1.5">
        <div className="border-paper-2 bg-paper-0 flex h-14 w-14 items-center justify-center rounded-xl border-2">
          <User size={20} weight="bold" className="text-surface-grey-2" />
        </div>
        <span className="hiw-rise border-core-orange/30 bg-core-orange/10 text-core-orange inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold">
          <Percent size={11} weight="bold" /> interest
        </span>
      </div>

      <FlowDots width="w-14" />

      <div className="border-paper-2 bg-paper-1 relative flex h-36 w-20 flex-none flex-col justify-end rounded-xl border-2 p-1.5">
        <div className="hiw-yield-grow bg-core-orange flex h-[34%] items-center justify-center rounded-md">
          <TrendUp size={14} weight="bold" className="text-white" />
        </div>
        <div className="bg-primary-jade mt-1 flex h-[52%] items-center justify-center rounded-md">
          <span className="text-[10px] font-bold text-white">Principal</span>
        </div>
      </div>
    </div>
  );
}
