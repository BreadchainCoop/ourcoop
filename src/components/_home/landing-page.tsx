import type { ReactNode } from "react";
import Link from "next/link";
import {
  Body,
  Button,
  Caption,
  Chip,
  Heading2,
  Heading3,
  Heading4,
} from "@breadcoop/ui";
import {
  ArrowRight,
  ArrowsClockwise,
  Coins,
  PaintBrush,
  Wrench,
} from "@phosphor-icons/react/dist/ssr";
import { AsteriskMark, OurCoopLogo } from "@/components/ourcoop-logo";
import { FundingCalculator } from "@/components/_home/funding-calculator";
import { HowItWorks } from "@/components/_home/how-it-works";
import { YieldEngine } from "@/components/_home/yield-engine";
import { YieldSliceExplainer } from "@/components/_home/yield-slice-explainer";

/** Static-export base path — public assets and static pages live under it. */
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";

const DOCS_URL = "/docs"; // in-app documentation & walkthroughs
const COOP_URL = `${BASE}/coop/`; // the cooperative governance app (live on-chain, static page)
const RUNBOOK_URL = `${BASE}/docs/runbook.html`; // static operator runbook
const GITHUB_URL = "https://github.com/BreadchainCoop/crowdstake.fun";

export function LandingPage() {
  return (
    <div className="bg-paper-main min-h-screen">
      <SiteNav />
      <main>
        <Hero />
        <PosterStrip />
        <KeyConcepts />
        <Features />
        <CalculatorSection />
        <UnderTheHood />
        <YieldSliceExplainer />
        <HowItWorks />
        <YieldEngine />
        <GetStarted />
        <CtaBand />
      </main>
      <SiteFooter />
    </div>
  );
}

/* ---------------------------------- Nav ---------------------------------- */

function SiteNav() {
  return (
    <header className="border-paper-2 bg-paper-main/80 sticky top-0 z-50 border-b backdrop-blur">
      <nav className="section-container flex h-16 items-center justify-between">
        <a href="#top" aria-label="O.U.R.COOP — back to top">
          <OurCoopLogo size={26} wordmarkClassName="text-xl" />
        </a>
        <div className="hidden items-center gap-8 md:flex">
          <NavLink href="#concepts">How we decide</NavLink>
          <NavLink href="#how-it-works">How it works</NavLink>
          <NavLink href="#get-started">Get started</NavLink>
        </div>
        <div className="flex items-center gap-3">
          <Button
            app="fund"
            variant="secondary"
            size="sm"
            as={Link}
            href={DOCS_URL}
          >
            Documentation
          </Button>
          <Button app="fund" variant="primary" size="sm" as="a" href={COOP_URL}>
            Launch App
          </Button>
        </div>
      </nav>
    </header>
  );
}

function NavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="text-surface-grey-2 hover:text-core-orange text-sm font-medium transition-colors"
    >
      {children}
    </a>
  );
}

/* --------------------------------- Hero ---------------------------------- */

/**
 * Poster hero — the "Launching Shared Visions" panel: near-black-to-violet
 * gradient with a purple glow, lilac kicker + giant wordmark, arrow-prefixed
 * meta line. Gradient hexes are the poster's own; everything else is tokens.
 */
function Hero() {
  return (
    <section
      id="top"
      className="relative overflow-hidden"
      style={{
        background: "linear-gradient(150deg, #1A1026 0%, #2A1745 100%)",
      }}
    >
      {/* Purple glow, bottom-right — the grainy gradient of the posters. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 -bottom-40 h-[34rem] w-[34rem] rounded-full blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, rgba(120,69,220,0.55), transparent 72%)",
        }}
      />
      {/* Oversized background asterisk, poster-mark style. */}
      <AsteriskMark
        size={420}
        className="text-orange-1 pointer-events-none absolute -top-24 -right-16 rotate-12 opacity-25"
      />

      <div className="section-container relative py-24 lg:py-32">
        {/* Kicker */}
        <div className="flex items-center gap-2.5">
          <AsteriskMark size={14} className="text-orange-0" />
          <span className="text-orange-0 text-sm font-semibold tracking-wide">
            Artists · Activists · Researchers
          </span>
        </div>

        {/* Wordmark */}
        <h1 className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
          <AsteriskMark
            size={64}
            className="text-orange-0 shrink-0 sm:h-20 sm:w-20"
          />
          <span className="font-breadDisplay text-6xl leading-[0.95] font-black tracking-tight break-words text-white sm:text-8xl">
            O.U.R.COOP
          </span>
        </h1>

        <Heading2 className="text-orange-0 mt-6 max-w-3xl">
          An international artists&apos; cooperative — funding art with shared
          yield. One member, one vote.
        </Heading2>

        <Body className="mt-6 max-w-2xl text-lg text-white/80">
          Members stake together. The principal stays theirs. The interest
          becomes the Art Fund, and 100-point ballots decide which projects it
          funds.
        </Body>

        <div className="mt-9 flex flex-wrap items-center gap-4">
          <Button
            app="fund"
            variant="primary"
            as="a"
            href={COOP_URL}
            rightIcon={<ArrowRight weight="bold" />}
          >
            Enter the app
          </Button>
          <a
            href={RUNBOOK_URL}
            className="text-sm font-medium text-white/70 underline underline-offset-4 transition-colors hover:text-white"
          >
            Read the runbook
          </a>
        </div>

        {/* Poster meta line */}
        <div className="mt-12 flex items-center gap-2.5">
          <ArrowRight size={18} weight="bold" className="text-orange-0" />
          <span className="text-sm font-semibold text-white/80">
            Cooperative governance live on-chain · funds · 100-point ballots ·
            withdrawals
          </span>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ Poster strip ------------------------------ */

const POSTERS = [
  {
    src: `${BASE}/brand/poster-workshop.jpg`,
    alt: "Purple duotone poster of cooperative members gathered on the floor at Workshop #1 in Belgrade",
    rotate: "-rotate-2",
  },
  {
    src: `${BASE}/brand/poster-talk.jpg`,
    alt: "Shared Visions poster for a cooperative talk, asterisk marks framing the speakers",
    rotate: "rotate-1",
  },
  {
    src: `${BASE}/brand/poster-print.jpg`,
    alt: "Halftone poster from the cooperative's print studio session",
    rotate: "-rotate-1",
  },
  {
    src: `${BASE}/brand/poster-reading.jpg`,
    alt: "Poster for a collective reading, big grotesque type on purple",
    rotate: "rotate-2",
  },
];

function PosterStrip() {
  return (
    <section className="overflow-hidden py-16">
      <div className="section-container">
        <div className="flex items-center justify-center gap-2">
          {[0, 1, 2, 3].map((i) => (
            <AsteriskMark key={i} size={12} className="text-core-orange" />
          ))}
          <Caption className="text-surface-grey-2 ml-2 font-semibold tracking-wide">
            Shared Visions · Belgrade
          </Caption>
        </div>
        <div className="mt-8 grid grid-cols-2 gap-5 sm:grid-cols-4">
          {POSTERS.map((p) => (
            // eslint-disable-next-line @next/next/no-img-element -- static export, images.unoptimized
            <img
              key={p.src}
              src={p.src}
              alt={p.alt}
              loading="lazy"
              className={`aspect-square w-full rounded-2xl object-cover shadow-lg transition-transform duration-300 hover:rotate-0 ${p.rotate}`}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

/* ----------------------------- Key concepts ------------------------------- */

const CONCEPTS = [
  {
    title: "One member, one vote",
    body: "Voting power comes from membership, not from the size of your stake. Every member's ballot weighs exactly the same.",
  },
  {
    title: "100-point ballots",
    body: "Each round you get 100 points to spread across project proposals however you like — all on one project, or a little everywhere. The sum is capped at 100.",
  },
  {
    title: "Art Fund rounds",
    body: "Each cycle's yield becomes that round's Art Fund. Top-voted projects fund up to their full-budget caps; proposals that can't reach their minimum-viable floor pass their share down the list.",
  },
  {
    title: "Principal stays yours",
    body: "Deposits are redeemable 1:1 at any time. Only the yield is ever spent — leaving the cooperative never costs you your stake.",
  },
];

function KeyConcepts() {
  return (
    <section id="concepts" className="bg-paper-1 py-20">
      <div className="section-container">
        <div className="flex items-center justify-center gap-3">
          <AsteriskMark size={22} className="text-core-orange" />
          <Heading2 className="text-text-standard text-center">
            How the cooperative decides
          </Heading2>
        </div>
        <Body className="text-surface-grey-2 mx-auto mt-4 max-w-2xl text-center text-lg">
          No boards, no whales. Membership carries the vote, ballots carry the
          points, and the yield carries the money.
        </Body>
        <div className="mt-12 grid gap-6 md:grid-cols-2">
          {CONCEPTS.map((c) => (
            <div
              key={c.title}
              className="border-paper-2 bg-paper-0 rounded-2xl border p-6 transition-shadow hover:shadow-lg"
            >
              <AsteriskMark size={20} className="text-core-orange" />
              <Heading4 className="text-text-standard mt-4">{c.title}</Heading4>
              <Body className="text-surface-grey-2 mt-2">{c.body}</Body>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------- Features -------------------------------- */

const FEATURES = [
  {
    icon: Coins,
    title: "A pool that pays for art",
    body: "Members stake into a shared sDAI vault. The principal is never spent — only the interest it earns, cycle after cycle.",
  },
  {
    icon: PaintBrush,
    title: "Project proposals",
    body: "Members put forward work — prints, residencies, murals, research — each with a full budget and a minimum-viable floor.",
  },
  {
    icon: ArrowsClockwise,
    title: "Cycle-based rounds",
    body: "Fixed-length cycles keep funding predictable: ballots close, the round's yield is split, and a fresh Art Fund starts accruing.",
  },
  {
    icon: Wrench,
    title: "Open source, your modules",
    body: "Built on the crowdstake protocol. Any collective can deploy its own instance and swap in custom voting or yield modules.",
  },
];

function Features() {
  return (
    <section id="features" className="py-20">
      <div className="section-container">
        <div className="flex items-center justify-center gap-3">
          <AsteriskMark size={22} className="text-core-orange" />
          <Heading2 className="text-text-standard text-center">
            What the cooperative runs on
          </Heading2>
        </div>
        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="border-paper-2 bg-paper-0 rounded-2xl border p-6 transition-shadow hover:shadow-lg"
            >
              <div className="bg-core-orange/10 flex h-12 w-12 items-center justify-center rounded-xl">
                <Icon size={24} weight="bold" className="text-core-orange" />
              </div>
              <Heading4 className="text-text-standard mt-4">{title}</Heading4>
              <Body className="text-surface-grey-2 mt-2">{body}</Body>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------ Calculator -------------------------------- */

function CalculatorSection() {
  return (
    <section id="calculator" className="bg-paper-1 py-20">
      <div className="section-container grid items-center gap-12 lg:grid-cols-2">
        <div>
          <div className="flex items-center gap-3">
            <AsteriskMark size={22} className="text-core-orange" />
            <Heading2 className="text-text-standard">
              What a cooperative this size can fund
            </Heading2>
          </div>
          <Body className="text-surface-grey-2 mt-6 max-w-xl text-lg">
            Real math with adjustable assumptions. Slide the membership and the
            stake to see the Art Fund a cooperative like ours can sustain —
            without anyone spending their savings.
          </Body>
          <div className="mt-8 flex items-center gap-2.5">
            <ArrowRight size={18} weight="bold" className="text-core-orange" />
            <Caption className="text-surface-grey-2 font-semibold">
              Presets sized like real cooperative projects
            </Caption>
          </div>
          <div className="mt-10 flex gap-2">
            {[0, 1, 2, 3].map((i) => (
              <AsteriskMark key={i} size={12} className="text-orange-0" />
            ))}
          </div>
        </div>
        <FundingCalculator />
      </div>
    </section>
  );
}

/* ----------------------------- Under the Hood ---------------------------- */

function UnderTheHood() {
  return (
    <section className="py-20">
      <div className="section-container text-center">
        <div className="flex items-center justify-center gap-3">
          <AsteriskMark size={22} className="text-core-orange" />
          <Heading2 className="text-text-standard">Under the hood</Heading2>
        </div>
        <Body className="text-surface-grey-2 mx-auto mt-6 max-w-4xl text-lg">
          O.U.R.COOP is a smart-contract system on Gnosis Chain. Members&apos;
          deposits are converted into sDAI (yield-bearing stablecoins), and in
          exchange members receive cUSD minted 1:1 against their deposit. All
          interest earned on the sDAI becomes the cooperative&apos;s Art Fund —
          the principal itself is never touched.
        </Body>
      </div>
    </section>
  );
}

/* ------------------------------ Get Started ------------------------------ */

function GetStarted() {
  return (
    <section id="get-started" className="bg-paper-1 py-20">
      <div className="section-container">
        <div className="flex items-center justify-center gap-3">
          <AsteriskMark size={22} className="text-core-orange" />
          <Heading2 className="text-text-standard text-center">
            Start a cooperative fund of your own
          </Heading2>
        </div>
        <Body className="text-surface-grey-2 mt-3 text-center text-lg">
          O.U.R.COOP runs on the open-source crowdstake protocol — any
          collective can deploy its own instance, free.
        </Body>

        <div className="mx-auto mt-12 grid max-w-4xl gap-6 md:grid-cols-2">
          <DeployCard
            badge="Recommended"
            badgeClassName="text-core-orange"
            title="Deploy with the wizard"
            body="Launch an instance from the in-app deploy wizard — pick your chain, name your token, and wire up custom voting or yield modules without writing code."
            timeline="Minutes"
            technical="None — wizard-guided"
          >
            <Button app="fund" variant="primary" as={Link} href="/app/deploy">
              Open the deploy wizard
            </Button>
          </DeployCard>

          <DeployCard
            badge="Advanced"
            badgeClassName="text-primary-jade"
            title="Self-host"
            body="Fork the protocol and run everything yourself, with full control over the smart contracts, custom modules, and governance parameters."
            timeline="A weekend"
            technical="Solidity & Web3"
          >
            <Button app="fund" variant="secondary" as={Link} href={DOCS_URL}>
              View Documentation
            </Button>
            <Button app="fund" variant="secondary" as="a" href={GITHUB_URL}>
              Upstream repository
            </Button>
          </DeployCard>
        </div>

        <div className="mt-10 text-center">
          <Body className="text-surface-grey-2">
            The runbook covers operating an instance end to end — cycles,
            ballots, and payouts.
          </Body>
          <div className="mt-3 flex justify-center">
            <Button app="fund" variant="secondary" as="a" href={RUNBOOK_URL}>
              Read the runbook
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function DeployCard({
  badge,
  badgeClassName,
  title,
  body,
  timeline,
  technical,
  children,
}: {
  badge: string;
  badgeClassName?: string;
  title: string;
  body: string;
  timeline: string;
  technical: string;
  children: ReactNode;
}) {
  return (
    <div className="border-paper-2 bg-paper-0 flex flex-col rounded-2xl border-2 p-6 transition-shadow hover:shadow-xl">
      <div className="flex items-center justify-between">
        <Heading3 className="text-text-standard">{title}</Heading3>
        <Chip size="small" className={badgeClassName}>
          {badge}
        </Chip>
      </div>
      <Body className="text-surface-grey-2 mt-3">{body}</Body>
      <dl className="mt-6 space-y-2">
        <StatRow label="Timeline" value={timeline} />
        <StatRow label="Technical knowledge" value={technical} />
      </dl>
      <div className="mt-6 flex flex-wrap gap-3">{children}</div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-paper-2 flex items-center justify-between border-t pt-2">
      <Caption className="text-surface-grey">{label}</Caption>
      <Caption className="text-text-standard font-semibold">{value}</Caption>
    </div>
  );
}

/* ------------------------------- CTA band -------------------------------- */

function CtaBand() {
  return (
    <section className="bg-core-orange py-20 text-white">
      <div className="section-container text-center">
        <div className="flex justify-center">
          <AsteriskMark size={26} className="text-white" />
        </div>
        <Heading2 className="mt-4 text-white">
          Art, funded by all of us.
        </Heading2>
        <Body className="mx-auto mt-4 max-w-3xl text-lg text-white/90">
          Join O.U.R.COOP — or launch a cooperative fund of your own. The
          protocol is free, open source, and the deploy wizard supports custom
          modules.
        </Body>
        <div className="mt-8 flex flex-wrap justify-center gap-4">
          <Button app="fund" variant="light" as="a" href={COOP_URL}>
            Enter the app
          </Button>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------- Footer --------------------------------- */

const FOOTER_LINKS: { label: string; href: string; internal?: boolean }[] = [
  { label: "Cooperative app", href: `${BASE}/coop/` },
  { label: "Protocol dapp", href: "/app", internal: true },
  { label: "Documentation", href: DOCS_URL, internal: true },
  { label: "Runbook", href: RUNBOOK_URL },
  { label: "Upstream protocol", href: GITHUB_URL },
];

function SiteFooter() {
  return (
    <footer className="border-paper-2 bg-paper-main border-t py-14">
      <div className="section-container flex flex-col gap-10 md:flex-row md:justify-between">
        <div className="max-w-sm">
          <OurCoopLogo size={24} wordmarkClassName="text-lg" />
          <Body className="text-surface-grey-2 mt-3">
            An international artists&apos; cooperative headquartered in former
            Yugoslavia — funding art with shared yield. One member, one vote.
          </Body>
        </div>
        <div>
          <Caption className="text-text-standard font-semibold">
            Cooperative
          </Caption>
          <ul className="mt-4 space-y-2">
            {FOOTER_LINKS.map((link) => (
              <li key={link.label}>
                {link.internal ? (
                  <Link
                    href={link.href}
                    className="text-surface-grey-2 hover:text-core-orange text-sm transition-colors"
                  >
                    {link.label}
                  </Link>
                ) : (
                  <a
                    href={link.href}
                    className="text-surface-grey-2 hover:text-core-orange text-sm transition-colors"
                  >
                    {link.label}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="section-container border-paper-2 mt-10 flex flex-col gap-3 border-t pt-6 sm:flex-row sm:items-center sm:justify-between">
        <Caption className="text-surface-grey">
          © 2026 O.U.R.COOP · built on the open-source crowdstake protocol
        </Caption>
        <span className="flex items-center gap-2">
          <AsteriskMark size={12} className="text-core-orange" />
          <Caption className="text-surface-grey">
            Shared Visions · Kulturni sklop · Co-funded by the European Union
          </Caption>
        </span>
      </div>
    </footer>
  );
}
