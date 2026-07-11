"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Body, Button, Caption } from "@breadcoop/ui";
import { OurCoopLogo } from "@/components/ourcoop-logo";
import {
  ArrowRight,
  ArrowSquareOut,
  ClockCounterClockwise,
  Coins,
  Eye,
  HandCoins,
  PaintBrush,
  Plugs,
  Scales,
  Sliders,
  Users,
} from "@phosphor-icons/react";
import { COOP, coopAddressUrl } from "@/lib/coop";

// Static export honours NEXT_PUBLIC_BASE_PATH (e.g. /ourcoop on Pages).
// Plain <img> tags don't get it prepended automatically, so do it here.
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";
const gif = (name: string) => `${BASE}/docs/${name}`;

type Flow = {
  id: string;
  n: number;
  icon: ReactNode;
  title: string;
  blurb: string;
  steps: string[];
  media: string;
};

/**
 * Every cooperative flow, recorded end to end against a fork of the live
 * Sepolia deployment with a member wallet — each click, transaction, and
 * state change in these GIFs is the real system reacting.
 */
const FLOWS: Flow[] = [
  {
    id: "browse",
    n: 1,
    icon: <Eye weight="duotone" />,
    title: "Browse the cooperative",
    blurb:
      "The whole cooperative is readable without a wallet: the four funds and the Art Fund, every project with its budgets and live ballot tallies, withdrawal proposals, and the on-chain activity log.",
    steps: [
      "Open /coop — the home view loads the live state straight from the chain.",
      "Funds shows the Reserve, Education, Solidarity, and Production balances plus the Art Fund pool.",
      "Projects & voting lists every project with full and minimum-viable budgets and current points.",
    ],
    media: "coop-browse.gif",
  },
  {
    id: "connect",
    n: 2,
    icon: <Plugs weight="duotone" />,
    title: "Connect as a member",
    blurb:
      "Acting requires a member wallet on Sepolia — one member, one vote, regardless of balance. The coordinator adds members on-chain; everyone else keeps read-only access.",
    steps: [
      "Click Connect wallet — the app switches your wallet to Sepolia if needed.",
      "The read-only banner disappears once a member wallet is connected.",
      "Non-member wallets can still browse everything live.",
    ],
    media: "coop-connect.gif",
  },
  {
    id: "deposit",
    n: 3,
    icon: <Coins weight="duotone" />,
    title: "Deposit & mint cUSD",
    blurb:
      "cUSD is the cooperative's unit of account, minted 1:1 against the underlying stablecoin and redeemable 1:1 anytime. The pooled principal sits in a yield vault — the interest it earns is what becomes the Art Fund.",
    steps: [
      "Mint yourself test USD from the open Sepolia faucet card.",
      "Approve, then mint — your deposit joins the pooled principal and you receive cUSD 1:1.",
      "Redeem burns cUSD back to the underlying 1:1 — the principal is never locked or spent.",
    ],
    media: "coop-deposit.gif",
  },
  {
    id: "project",
    n: 4,
    icon: <PaintBrush weight="duotone" />,
    title: "Register an art project",
    blurb:
      "Projects carry a payout address, a full budget, and a minimum-viable floor. The coordinator registers them on-chain; new proposals queue, then activate onto the ballot when the queue is processed.",
    steps: [
      "Fill in the title, summary, payout address, full budget, and minimum-viable floor.",
      "Register project queues the proposal on the registry (coordinator-signed).",
      "Process queue — anyone can call it — activates queued projects onto the ballot.",
    ],
    media: "coop-project.gif",
  },
  {
    id: "vote",
    n: 5,
    icon: <Sliders weight="duotone" />,
    title: "Cast a 100-point ballot",
    blurb:
      "Each member gets exactly 100 points per funding cycle to spread across projects — the total is capped, and recasting within a cycle replaces the previous ballot.",
    steps: [
      "Open Projects & voting and distribute points with the sliders or number fields.",
      "The counter enforces the 100-point cap across all projects.",
      "Cast ballot signs one transaction; the live tallies update as it lands.",
    ],
    media: "coop-vote.gif",
  },
  {
    id: "round",
    n: 6,
    icon: <HandCoins weight="duotone" />,
    title: "Run a funding round",
    blurb:
      "When the cycle completes with ballots cast and yield accrued, anyone can trigger the round: the Art Fund is shared among the top 5 projects by points, capped at full budgets, with minimum-viable floors — under-floor projects are dropped and their share redistributed.",
    steps: [
      "The cycle banner shows readiness: cycle complete, ballots cast, yield accrued.",
      "Run funding round executes claim-and-distribute in one transaction.",
      "Funded amounts are minted straight to each project's payout address and the cycle advances.",
    ],
    media: "coop-round.gif",
  },
  {
    id: "withdrawal",
    n: 7,
    icon: <Scales weight="duotone" />,
    title: "Propose & vote a withdrawal",
    blurb:
      "The four dedicated funds are governed by member votes: anyone can propose a draw with a recipient and purpose, members vote for or against, and a majority of cast votes approves.",
    steps: [
      "Fill in the source fund, amount, recipient, and purpose, then propose.",
      "Members vote For or Against — one vote each, tracked on-chain.",
      "Close & tally settles the proposal; approved draws move the funds.",
    ],
    media: "coop-withdrawal.gif",
  },
  {
    id: "members",
    n: 8,
    icon: <Users weight="duotone" />,
    title: "Manage the membership",
    blurb:
      "The roster is on-chain: every member holds exactly one vote, replayed from membership events. The coordinator adds and removes members; the list, the count, and each change are public.",
    steps: [
      "Members lists the live roster with the coordinator and your own wallet tagged.",
      "The coordinator adds a member by address — they get one vote, like everyone.",
      "Removals work the same way; every change lands in the activity log.",
    ],
    media: "coop-members.gif",
  },
  {
    id: "activity",
    n: 9,
    icon: <ClockCounterClockwise weight="duotone" />,
    title: "Audit the activity log",
    blurb:
      "Every token movement and governance event — ballots, funded projects, rounds, withdrawal proposals and votes, membership changes — is reconstructed from on-chain events, newest first.",
    steps: [
      "Token movements show fund-to-fund and fund-to-recipient transfers with amounts and notes.",
      "The governance log lists every ballot, round, withdrawal decision, and roster change.",
      "Everything links back to the chain — nothing here is off-chain bookkeeping.",
    ],
    media: "coop-activity.gif",
  },
];

const SYSTEM = [
  ["Cooperative token (cUSD)", COOP.token],
  ["Test USD (open faucet)", COOP.usd],
  ["Membership power (1p1v)", COOP.power],
  ["Project registry", COOP.registry],
  ["100-point voting module", COOP.voting],
  ["Art-fund strategy", COOP.strategy],
  ["Distribution manager", COOP.distributionManager],
  ["Cycle module", COOP.cycleModule],
  ["Fund withdrawals", COOP.withdrawals],
] as const;

export default function DocsPage() {
  return (
    <div className="bg-paper-main min-h-screen">
      <DocsNav />

      {/* Hero */}
      <header className="section-container pt-16 pb-10">
        <Caption className="text-core-orange font-semibold tracking-wide uppercase">
          ✳ Documentation
        </Caption>
        <h1 className="font-breadDisplay text-text-standard mt-3 text-5xl font-extrabold tracking-tight sm:text-6xl">
          Every flow, end to end
        </h1>
        <Body className="text-surface-grey-2 mt-4 max-w-2xl text-lg">
          A step-by-step walkthrough of governing O.U.R.COOP — depositing into
          the shared pool, registering art projects, casting 100-point ballots,
          running funding rounds, voting fund withdrawals, and managing the
          membership. Each section pairs a short recording with the exact steps.
        </Body>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button app="fund" variant="primary" as={Link} href="/coop">
            Open the app
          </Button>
          <Button app="fund" variant="secondary" as={Link} href="/">
            Back to home
          </Button>
        </div>
      </header>

      {/* Contents */}
      <nav className="section-container pb-8">
        <div className="border-paper-2 bg-paper-0 rounded-2xl border p-5">
          <Caption className="text-surface-grey-2">On this page</Caption>
          <ol className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {FLOWS.map((f) => (
              <li key={f.id}>
                <a
                  href={`#${f.id}`}
                  className="text-text-standard hover:text-core-orange flex items-center gap-2 text-sm font-medium transition-colors"
                >
                  <span className="bg-core-orange/10 text-core-orange inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold">
                    {f.n}
                  </span>
                  {f.title}
                </a>
              </li>
            ))}
          </ol>
        </div>
      </nav>

      {/* Walkthrough note */}
      <div className="section-container pb-12">
        <div className="border-primary-jade/30 bg-primary-jade/5 rounded-2xl border px-5 py-4">
          <Body className="text-surface-grey-2 text-sm">
            <span className="text-text-standard font-semibold">
              About these recordings.
            </span>{" "}
            Every clip was driven end to end against a fork of the live Sepolia
            deployment with a member wallet — the transactions execute for real
            and every state change shown is the actual system reacting. The live
            contracts are listed at the bottom of this page.
          </Body>
        </div>
      </div>

      {/* Flows */}
      <main className="section-container space-y-20 pb-24">
        {FLOWS.map((f, i) => (
          <FlowSection key={f.id} flow={f} eager={i === 0} />
        ))}

        {/* Live system */}
        <section id="system" className="scroll-mt-20">
          <div className="flex items-center gap-3">
            <span className="bg-core-orange/10 text-core-orange inline-flex h-9 w-9 items-center justify-center rounded-xl">
              <ArrowSquareOut weight="duotone" size={20} />
            </span>
            <h2 className="font-breadDisplay text-text-standard text-3xl font-extrabold tracking-tight">
              Live on Sepolia
            </h2>
          </div>
          <Body className="text-surface-grey-2 mt-3 max-w-2xl">
            The cooperative&apos;s modules — custom implementations of the
            crowdstake interfaces (
            <code className="text-text-standard">
              contracts/src/examples/cova
            </code>
            ) — are deployed and verifiable on Ethereum Sepolia. Every contract
            below is live — open it on Etherscan.
          </Body>
          <div className="border-paper-2 divide-paper-2 bg-paper-0 mt-6 divide-y overflow-hidden rounded-2xl border">
            {SYSTEM.map(([label, addr]) => (
              <a
                key={label}
                href={coopAddressUrl(addr)}
                target="_blank"
                rel="noreferrer"
                className="hover:bg-paper-1 flex items-center justify-between gap-4 px-5 py-3.5 transition-colors"
              >
                <span className="text-text-standard text-sm font-medium">
                  {label}
                </span>
                <span className="text-surface-grey-2 hover:text-core-orange flex items-center gap-2 font-mono text-xs sm:text-sm">
                  {addr}
                  <ArrowSquareOut size={14} />
                </span>
              </a>
            ))}
          </div>
        </section>

        {/* Custom-modules runbook */}
        <section id="runbook" className="scroll-mt-20">
          <a
            href={`${BASE}/docs/runbook.html`}
            className="border-paper-2 bg-paper-0 hover:bg-paper-1 flex items-center justify-between gap-4 rounded-2xl border p-5 transition-colors"
          >
            <div>
              <h2 className="font-breadDisplay text-text-standard text-xl font-extrabold tracking-tight">
                Custom-modules runbook
              </h2>
              <Body className="text-surface-grey-2 mt-1 text-sm">
                {
                  "Deploy the cooperative's own modules (cUSD token, project registry, 100-point voting, art-fund strategy) through the wizard — the complete click-by-click guide."
                }
              </Body>
            </div>
            <span className="bg-core-orange/10 text-core-orange inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl">
              <ArrowSquareOut weight="duotone" size={20} />
            </span>
          </a>
        </section>

        {/* Footer CTA */}
        <section className="border-paper-2 bg-paper-0 rounded-3xl border px-8 py-12 text-center">
          <h2 className="font-breadDisplay text-text-standard text-3xl font-extrabold tracking-tight">
            Ready to take part?
          </h2>
          <Body className="text-surface-grey-2 mx-auto mt-3 max-w-xl">
            Open the cooperative to browse the live state — and connect a member
            wallet to deposit, vote, and govern the funds.
          </Body>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button
              app="fund"
              variant="primary"
              as={Link}
              href="/coop"
              rightIcon={<ArrowRight weight="bold" />}
            >
              Open the app
            </Button>
            <Button
              app="fund"
              variant="secondary"
              as="a"
              href={`${BASE}/docs/runbook.html`}
            >
              Read the runbook
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}

function FlowSection({ flow, eager }: { flow: Flow; eager?: boolean }) {
  return (
    <section id={flow.id} className="scroll-mt-20">
      <div className="flex items-center gap-3">
        <span className="bg-core-orange/10 text-core-orange inline-flex h-9 w-9 items-center justify-center rounded-xl text-xl">
          {flow.icon}
        </span>
        <Caption className="text-surface-grey font-semibold">
          Step {flow.n}
        </Caption>
      </div>
      <h2 className="font-breadDisplay text-text-standard mt-2 text-3xl font-extrabold tracking-tight">
        {flow.title}
      </h2>
      <Body className="text-surface-grey-2 mt-3 max-w-2xl">{flow.blurb}</Body>

      <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_1.4fr] lg:items-start">
        <ol className="space-y-4">
          {flow.steps.map((s, i) => (
            <li key={i} className="flex gap-3">
              <span className="bg-core-orange mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white">
                {i + 1}
              </span>
              <Body className="text-text-standard">{s}</Body>
            </li>
          ))}
        </ol>

        <figure className="border-paper-2 bg-paper-0 overflow-hidden rounded-2xl border shadow-sm">
          <div className="border-paper-2 bg-paper-1 flex items-center gap-1.5 border-b px-4 py-2.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
            <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
            <Caption className="text-surface-grey ml-3 truncate">
              O.U.R.COOP — {flow.title}
            </Caption>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={gif(flow.media)}
            alt={`${flow.title} walkthrough`}
            width={900}
            height={563}
            className="block h-auto w-full"
            loading={eager ? "eager" : "lazy"}
          />
        </figure>
      </div>
    </section>
  );
}

function DocsNav() {
  return (
    <header className="border-paper-2 bg-paper-main/80 sticky top-0 z-50 border-b backdrop-blur">
      <nav className="section-container flex h-16 items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <OurCoopLogo size={28} wordmarkClassName="text-xl" />
        </Link>
        <div className="flex items-center gap-3">
          <Button app="fund" variant="secondary" size="sm" as={Link} href="/">
            Home
          </Button>
          <Button app="fund" variant="primary" size="sm" as={Link} href="/coop">
            Launch App
          </Button>
        </div>
      </nav>
    </header>
  );
}
