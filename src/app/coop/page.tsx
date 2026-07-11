"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { isAddress, type Address } from "viem";
import { Body, Button, Caption, Chip, Heading4 } from "@breadcoop/ui";
import {
  ArrowRight,
  ArrowsClockwise,
  CheckCircle,
  Circle,
  SpinnerGap,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { shortenAddress } from "@/lib/format";
import {
  COOP,
  FUNDS,
  FUND_KEYS,
  coopAddressUrl,
  coopDmAbi,
  coopPowerAbi,
  coopRegistryAbi,
  coopTokenAbi,
  coopTxUrl,
  coopUsdAbi,
  coopVotingAbi,
  coopWithdrawalsAbi,
  toCoopWei,
  type CoopState,
  type CoopWithdrawal,
  type FundKey,
} from "@/lib/coop";
import { useCoopState, useCoopTx } from "@/hooks/use-coop";
import { AsteriskMark, OurCoopLogo } from "@/components/ourcoop-logo";
import { Card, EmptyState, PageHeader, StatCard } from "@/components/dapp/ui";
import { WalletButton } from "@/components/dapp/wallet-button";

const VIEWS = [
  ["home", "Home"],
  ["deposit", "Deposit"],
  ["funds", "Funds"],
  ["projects", "Projects & voting"],
  ["withdrawals", "Withdrawals"],
  ["members", "Members"],
  ["activity", "Activity"],
] as const;
type ViewId = (typeof VIEWS)[number][0];

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export default function CoopPage() {
  const [view, setView] = useState<ViewId>("home");
  const { data, isLoading, isError, error, refetch, isRefetching } =
    useCoopState();

  return (
    <div className="bg-paper-main min-h-screen">
      <CoopNav view={view} setView={setView} />
      <main className="mx-auto w-full max-w-6xl px-4 pt-6 pb-20 sm:px-6">
        <MembershipBanner state={data} />
        {isLoading && (
          <Card className="mt-6 flex items-center gap-3">
            <SpinnerGap size={22} className="text-core-orange animate-spin" />
            <Body className="text-surface-grey-2">
              Reading the cooperative&apos;s live state from Sepolia…
            </Body>
          </Card>
        )}
        {isError && (
          <Card className="mt-6">
            <Body className="text-system-red">
              Couldn&apos;t read the chain: {String(error)}
            </Body>
            <Button
              app="fund"
              variant="secondary"
              className="mt-3"
              onClick={() => void refetch()}
            >
              Retry
            </Button>
          </Card>
        )}
        {data && (
          <>
            {view === "home" && <HomeView state={data} setView={setView} />}
            {view === "deposit" && <DepositView state={data} />}
            {view === "funds" && <FundsView state={data} />}
            {view === "projects" && <ProjectsView state={data} />}
            {view === "withdrawals" && <WithdrawalsView state={data} />}
            {view === "members" && <MembersView state={data} />}
            {view === "activity" && <ActivityView state={data} />}
            <div className="mt-10 flex items-center justify-between">
              <Caption className="text-surface-grey">
                Live on Ethereum Sepolia (testnet cUSD) · one member, one vote ·
                ✳ Shared Visions · Kulturni sklop · co-funded by the European
                Union
              </Caption>
              <button
                type="button"
                onClick={() => void refetch()}
                className="text-surface-grey-2 hover:text-core-orange flex items-center gap-1 text-sm font-medium"
              >
                <ArrowsClockwise
                  size={16}
                  weight="bold"
                  className={isRefetching ? "animate-spin" : undefined}
                />
                Refresh
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/* ---------------------------------- Nav ---------------------------------- */

function CoopNav({
  view,
  setView,
}: {
  view: ViewId;
  setView: (v: ViewId) => void;
}) {
  return (
    <header className="border-paper-2 bg-paper-main/85 sticky top-0 z-40 border-b backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-4 sm:px-6">
        <Link href="/" aria-label="O.U.R.COOP home">
          <OurCoopLogo size={24} wordmarkClassName="text-lg" />
        </Link>
        <Chip size="small" className="text-core-orange hidden sm:inline-flex">
          governance
        </Chip>
        <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
          {VIEWS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-sm font-semibold whitespace-nowrap transition-colors",
                view === id
                  ? "bg-core-orange text-white"
                  : "text-surface-grey-2 hover:text-text-standard",
              )}
            >
              {label}
            </button>
          ))}
        </nav>
        <WalletButton />
      </div>
    </header>
  );
}

/* ----------------------------- Shared elements ---------------------------- */

function MembershipBanner({ state }: { state?: CoopState }) {
  const { isConnected } = useAccount();
  if (!state) return null;
  if (!isConnected) {
    return (
      <Card className="border-core-orange/30 bg-core-orange/5 mt-6">
        <Body className="text-surface-grey-2 text-sm">
          You&apos;re browsing the cooperative&apos;s live state read-only.
          Connect a wallet (Sepolia) to cast ballots, run funding rounds, or
          vote on withdrawals — membership is one member, one vote.
        </Body>
      </Card>
    );
  }
  if (!state.isMember) {
    return (
      <Card className="border-system-warning/40 bg-system-warning/5 mt-6">
        <Body className="text-surface-grey-2 text-sm">
          This wallet isn&apos;t a cooperative member yet — ask the coordinator
          to add it. You can browse everything in the meantime.
        </Body>
      </Card>
    );
  }
  return null;
}

/** Section label in the poster style: ✳ + small bold caps. */
function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mt-8 mb-3 flex items-center gap-2">
      <AsteriskMark size={12} className="text-core-orange" />
      <Caption className="text-surface-grey-2 font-semibold tracking-wide uppercase">
        {children}
      </Caption>
    </div>
  );
}

function CycleBanner({ state }: { state: CoopState }) {
  return (
    <Card className="border-core-orange/25 mt-2 flex flex-wrap items-center gap-4">
      <span className="from-core-orange to-orange-0 grid h-12 w-12 shrink-0 place-items-center rounded-full bg-gradient-to-br text-white">
        <AsteriskMark size={22} className="text-white" />
      </span>
      <div className="min-w-0 flex-1">
        <Heading4 className="text-text-standard">
          Funding cycle {state.cycle}
        </Heading4>
        <Caption className="text-surface-grey-2 mt-0.5 block">
          {state.cycleComplete
            ? "Cycle complete — a funding round can run now"
            : `~${state.blocksLeft.toLocaleString()} blocks until the next round can run`}{" "}
          · round ready:{" "}
          <span
            className={
              state.ready
                ? "text-system-green font-semibold"
                : "text-surface-grey font-semibold"
            }
          >
            {state.ready ? "yes" : "no"}
          </span>
        </Caption>
      </div>
      <div className="text-right">
        <Caption className="text-surface-grey block">Art Fund pool</Caption>
        <Heading4 className="text-text-standard">
          {usd(state.funds.artFund)}
        </Heading4>
        <Caption className="text-surface-grey block">
          claimable yield {usd(state.artYield)}
        </Caption>
      </div>
    </Card>
  );
}

function FundsCard({ state }: { state: CoopState }) {
  const total = FUND_KEYS.reduce((a, k) => a + state.funds[k], 0);
  return (
    <Card>
      <Heading4 className="text-text-standard">Cooperative funds</Heading4>
      <Caption className="text-surface-grey-2 mt-1 block">
        Total <strong>{usd(total)}</strong> across all funds · the Art Fund is
        the project pool
      </Caption>
      <div className="mt-4 space-y-3">
        {FUND_KEYS.map((k) => {
          const pct = total
            ? Math.max(2, Math.round((state.funds[k] / total) * 100))
            : 0;
          return (
            <div key={k}>
              <div className="flex items-center gap-2.5">
                <span
                  className="h-3 w-3 rounded-sm"
                  style={{ background: FUNDS[k].color }}
                />
                <Caption className="text-text-standard flex-1 font-medium">
                  {FUNDS[k].label}
                </Caption>
                <Caption className="text-text-standard font-bold">
                  {usd(state.funds[k])}
                </Caption>
              </div>
              <div className="bg-paper-2 mt-1 h-2 overflow-hidden rounded-full">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${pct}%`, background: FUNDS[k].color }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function FundBadge({ fund }: { fund: string }) {
  const meta = FUNDS[fund as FundKey];
  const color = meta?.color ?? "#837d91";
  return (
    <span
      className="inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold"
      style={{
        color,
        borderColor: `${color}55`,
        background: `${color}14`,
      }}
    >
      {meta?.label ?? fund}
    </span>
  );
}

function TxLine({
  status,
  hash,
  error,
  successLabel,
}: {
  status: ReturnType<typeof useCoopTx>["status"];
  hash?: `0x${string}`;
  error?: string | null;
  successLabel: string;
}) {
  if (status === "idle") return null;
  if (status === "error")
    return (
      <Caption className="text-system-red mt-2 block">
        {error ?? "Transaction failed"}
      </Caption>
    );
  if (status === "success")
    return (
      <Caption className="text-system-green mt-2 block">
        {successLabel}{" "}
        {hash && (
          <a
            href={coopTxUrl(hash)}
            target="_blank"
            rel="noreferrer"
            className="text-core-orange hover:underline"
          >
            View on Etherscan ↗
          </a>
        )}
      </Caption>
    );
  return (
    <Caption className="text-surface-grey-2 mt-2 flex items-center gap-1.5">
      <SpinnerGap size={14} className="animate-spin" />
      {status === "signing" ? "Confirm in your wallet…" : "Confirming…"}
    </Caption>
  );
}

/* ---------------------------------- Home ---------------------------------- */

function HomeView({
  state,
  setView,
}: {
  state: CoopState;
  setView: (v: ViewId) => void;
}) {
  const fundedLastRound = state.projects.filter((p) => p.funded > 0).length;
  const openVotes = state.withdrawals.filter(
    (w) => w.status === "voting",
  ).length;
  return (
    <div>
      <div className="mt-6">
        <PageHeader
          title="O.U.R.COOP governance"
          subtitle="Fund balances, project proposals, 100-point member ballots, funding rounds, and withdrawal votes — live on-chain. One member, one vote."
        />
      </div>
      <CycleBanner state={state} />
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Projects" value={state.projects.length} />
        <StatCard label="Funded (last round)" value={fundedLastRound} />
        <StatCard label="Active withdrawal votes" value={openVotes} />
        <StatCard label="Members" value={state.memberCount} />
      </div>
      <SectionTitle>Quick actions</SectionTitle>
      <div className="grid gap-4 md:grid-cols-3">
        <QuickAction
          title="Cast your ballot"
          body="Distribute 100 points across the projects — one member, one vote."
          cta="Open voting"
          onClick={() => setView("projects")}
        />
        <QuickAction
          title="Run a funding round"
          body="When the cycle completes, the Art Fund is shared among the top projects with minimum-viable redistribution."
          cta="Open projects"
          onClick={() => setView("projects")}
        />
        <QuickAction
          title="Withdrawals"
          body="Propose and vote on draws from the four cooperative funds."
          cta="Open withdrawals"
          onClick={() => setView("withdrawals")}
        />
      </div>
      <SectionTitle>Funds at a glance</SectionTitle>
      <FundsCard state={state} />
    </div>
  );
}

function QuickAction({
  title,
  body,
  cta,
  onClick,
}: {
  title: string;
  body: string;
  cta: string;
  onClick: () => void;
}) {
  return (
    <Card className="flex flex-col">
      <div className="flex items-center gap-2">
        <AsteriskMark size={14} className="text-core-orange" />
        <Heading4 className="text-text-standard">{title}</Heading4>
      </div>
      <Body className="text-surface-grey-2 mt-2 flex-1 text-sm">{body}</Body>
      <div className="mt-4">
        <Button
          app="fund"
          variant="primary"
          size="sm"
          rightIcon={<ArrowRight weight="bold" />}
          onClick={onClick}
        >
          {cta}
        </Button>
      </div>
    </Card>
  );
}

/* ---------------------------------- Funds --------------------------------- */

function FundsView({ state }: { state: CoopState }) {
  return (
    <div>
      <div className="mt-6">
        <PageHeader
          title="Funds"
          subtitle="Four dedicated cooperative funds plus the Art Fund (the project pool), token-backed on-chain."
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <FundsCard state={state} />
        <Card>
          <Heading4 className="text-text-standard">How funding works</Heading4>
          <Body className="text-surface-grey-2 mt-2 text-sm">
            The cooperative&apos;s deposits earn yield that accrues to the Art
            Fund. Each funding cycle, members&apos; 100-point ballots decide the
            top projects; the Art Fund is shared among them, dropping any
            project below its minimum viable budget and redistributing. The four
            dedicated funds are governed by member withdrawal votes.
          </Body>
          <dl className="mt-4 space-y-2">
            <KvRow k="Unit of account" v="cUSD (1 cUSD = $1)" />
            <KvRow k="Funding cycle" v={`#${state.cycle}`} />
            <KvRow k="Governance" v="One member, one vote" />
            <KvRow k="Allocation" v="Top projects, minimum-viable floors" />
          </dl>
        </Card>
      </div>
      <SectionTitle>Recent movements</SectionTitle>
      <MovementsTable state={state} limit={8} />
    </div>
  );
}

function KvRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="border-paper-2 flex items-center justify-between border-t pt-2">
      <Caption className="text-surface-grey">{k}</Caption>
      <Caption className="text-text-standard font-semibold">{v}</Caption>
    </div>
  );
}

/* --------------------------------- Projects ------------------------------- */

function ProjectsView({ state }: { state: CoopState }) {
  return (
    <div>
      <div className="mt-6">
        <PageHeader
          title="Projects & voting"
          subtitle="Distribute your 100 points across projects. When the funding cycle completes, the round shares the Art Fund among the top 5 by points, dropping any project below its minimum viable budget and redistributing."
        />
      </div>
      <CycleBanner state={state} />
      <div className="mt-4">
        <BallotCard state={state} />
      </div>
      <SectionTitle>Register an art project</SectionTitle>
      <div className="grid gap-4 lg:grid-cols-2">
        <RegisterProjectCard state={state} />
        <QueuedProjectsCard state={state} />
      </div>
      <SectionTitle>Projects</SectionTitle>
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-paper-2 border-b text-left">
              <Th>Project</Th>
              <Th>Payout</Th>
              <Th>Full</Th>
              <Th>Min viable</Th>
              <Th>Points</Th>
              <Th>Funded (last round)</Th>
            </tr>
          </thead>
          <tbody>
            {state.projects.map((p) => (
              <tr
                key={p.addr}
                className="border-paper-2 border-b last:border-0"
              >
                <Td>
                  <span className="text-text-standard font-semibold">
                    {p.title}
                  </span>
                  <span className="text-surface-grey block text-xs">
                    {p.summary}
                  </span>
                </Td>
                <Td>
                  <a
                    href={coopAddressUrl(p.addr)}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:text-core-orange font-mono text-xs"
                  >
                    {shortenAddress(p.addr)}
                  </a>
                </Td>
                <Td>{usd(p.full)}</Td>
                <Td>{usd(p.minViable)}</Td>
                <Td>{p.points}</Td>
                <Td>
                  {p.funded > 0 ? (
                    <span className="bg-system-green/10 text-system-green rounded-full px-2 py-0.5 text-xs font-semibold">
                      {usd(p.funded)}
                    </span>
                  ) : (
                    <span className="text-surface-grey">—</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function Th({ children }: { children: ReactNode }) {
  return (
    <th className="text-surface-grey px-4 py-3 text-xs font-semibold tracking-wide uppercase">
      {children}
    </th>
  );
}
function Td({ children }: { children: ReactNode }) {
  return <td className="text-text-standard px-4 py-3 align-top">{children}</td>;
}

function BallotCard({ state }: { state: CoopState }) {
  const [points, setPoints] = useState<number[]>(() =>
    new Array(state.projects.length).fill(0),
  );
  const vote = useCoopTx();
  const round = useCoopTx();
  const { isConnected } = useAccount();
  const total = points.reduce((a, b) => a + b, 0);

  // Project list length can change between refetches — keep the ballot aligned.
  if (points.length !== state.projects.length) {
    setPoints(new Array(state.projects.length).fill(0));
  }

  const setPoint = (i: number, raw: number) => {
    setPoints((prev) => {
      const next = [...prev];
      const others = prev.reduce((a, b, j) => (j === i ? a : a + b), 0);
      next[i] = Math.max(0, Math.min(raw, 100 - others));
      return next;
    });
  };

  const disabledReason = !isConnected
    ? "Connect a wallet to act"
    : !state.isMember
      ? "Your wallet isn't a member"
      : null;

  if (state.projects.length === 0)
    return <EmptyState>No projects registered.</EmptyState>;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Heading4 className="text-text-standard">
            Distribute your 100 points
          </Heading4>
          <Caption className="text-surface-grey-2 mt-0.5 block">
            One member, one ballot — recasting within a cycle replaces your
            previous ballot.
          </Caption>
        </div>
        <div className="text-right">
          <Caption className="text-surface-grey block">Art Fund pool</Caption>
          <Heading4 className="text-text-standard">
            {usd(state.funds.artFund)}
          </Heading4>
        </div>
      </div>

      <div className="border-paper-2 mt-4 border-t">
        {state.projects.map((p, i) => (
          <div
            key={p.addr}
            className="border-paper-2 grid grid-cols-1 items-center gap-3 border-b py-3 sm:grid-cols-[1fr_5rem_10rem]"
          >
            <div>
              <span className="text-text-standard text-sm font-semibold">
                {p.title}
              </span>
              <span className="text-surface-grey block text-xs">
                {shortenAddress(p.addr)} · full {usd(p.full)} · min{" "}
                {usd(p.minViable)} · now {p.points} pts
              </span>
            </div>
            <input
              type="number"
              min={0}
              max={100}
              value={points[i] ?? 0}
              onChange={(e) => setPoint(i, Number(e.target.value || 0))}
              className="border-paper-2 bg-paper-main text-text-standard focus:border-core-orange w-20 rounded-lg border px-2 py-1.5 text-sm outline-none"
            />
            <input
              type="range"
              min={0}
              max={100}
              value={points[i] ?? 0}
              onChange={(e) => setPoint(i, Number(e.target.value))}
              className="accent-core-orange w-full"
            />
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Body className="text-surface-grey-2 text-sm">
          Points used:{" "}
          <span className="text-text-standard font-bold">{total}</span> / 100
        </Body>
        <div className="flex flex-wrap gap-2">
          <Button
            app="fund"
            variant="secondary"
            size="sm"
            onClick={() => setPoints(new Array(state.projects.length).fill(0))}
          >
            Reset
          </Button>
          <Button
            app="fund"
            variant="primary"
            size="sm"
            disabled={Boolean(disabledReason) || total < 1 || vote.isBusy}
            onClick={() =>
              void vote.run({
                address: COOP.voting,
                abi: coopVotingAbi,
                functionName: "castVote",
                args: [points.map((v) => BigInt(v))],
              })
            }
          >
            {vote.isBusy ? "Casting…" : "Cast ballot"}
          </Button>
          <Button
            app="fund"
            variant="secondary"
            size="sm"
            disabled={Boolean(disabledReason) || !state.ready || round.isBusy}
            onClick={() =>
              void round.run({
                address: COOP.distributionManager,
                abi: coopDmAbi,
                functionName: "claimAndDistribute",
              })
            }
          >
            {round.isBusy ? "Running…" : "Run funding round"}
          </Button>
        </div>
      </div>
      {disabledReason && (
        <Caption className="text-surface-grey mt-2 block">
          {disabledReason} — browsing stays live either way.
        </Caption>
      )}
      {!state.ready && !disabledReason && (
        <Caption className="text-surface-grey mt-2 block">
          The funding round unlocks when the cycle completes, at least one
          ballot is cast, and yield has accrued.
        </Caption>
      )}
      <TxLine
        status={vote.status}
        hash={vote.hash}
        error={vote.error}
        successLabel="Ballot recorded on-chain."
      />
      <TxLine
        status={round.status}
        hash={round.hash}
        error={round.error}
        successLabel="Funding round distributed — cycle advanced."
      />
    </Card>
  );
}

/* ------------------------------- Withdrawals ------------------------------ */

function WithdrawalsView({ state }: { state: CoopState }) {
  return (
    <div>
      <div className="mt-6">
        <PageHeader
          title="Fund withdrawals"
          subtitle="Propose drawing from one of the four funds and vote. One member, one vote — a majority of cast votes approves."
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <FundsCard state={state} />
        <ProposeWithdrawalCard state={state} />
      </div>
      <SectionTitle>Proposals</SectionTitle>
      {state.withdrawals.length === 0 ? (
        <EmptyState>No proposals yet.</EmptyState>
      ) : (
        <div className="space-y-4">
          {state.withdrawals
            .slice()
            .reverse()
            .map((w) => (
              <WithdrawalCard key={w.id} w={w} state={state} />
            ))}
        </div>
      )}
    </div>
  );
}

function ProposeWithdrawalCard({ state }: { state: CoopState }) {
  const [fund, setFund] = useState(1);
  const [amount, setAmount] = useState("300");
  const [recipient, setRecipient] = useState("");
  const [purpose, setPurpose] = useState("");
  const tx = useCoopTx();
  const { isConnected } = useAccount();

  const amountNum = Number(amount || 0);
  const valid =
    amountNum > 0 && isAddress(recipient.trim()) && purpose.trim().length > 0;
  const gated = !isConnected || !state.isMember;

  return (
    <Card>
      <Heading4 className="text-text-standard">Propose a withdrawal</Heading4>
      <div className="mt-4 space-y-3">
        <label className="block">
          <Caption className="text-surface-grey-2 mb-1 block">
            Source fund
          </Caption>
          <select
            value={fund}
            onChange={(e) => setFund(Number(e.target.value))}
            className="border-paper-2 bg-paper-main text-text-standard focus:border-core-orange w-full rounded-xl border px-3 py-2 text-sm outline-none"
          >
            {FUND_KEYS.slice(0, 4).map((k, i) => (
              <option key={k} value={i}>
                {FUNDS[k].label} — {usd(state.funds[k])}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <Caption className="text-surface-grey-2 mb-1 block">
            Amount (cUSD)
          </Caption>
          <input
            type="number"
            min={0}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="border-paper-2 bg-paper-main text-text-standard focus:border-core-orange w-full rounded-xl border px-3 py-2 text-sm outline-none"
          />
        </label>
        <label className="block">
          <Caption className="text-surface-grey-2 mb-1 block">
            Recipient (0x address)
          </Caption>
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="0x…"
            className="border-paper-2 bg-paper-main text-text-standard focus:border-core-orange w-full rounded-xl border px-3 py-2 font-mono text-sm outline-none"
          />
        </label>
        <label className="block">
          <Caption className="text-surface-grey-2 mb-1 block">Purpose</Caption>
          <textarea
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            rows={2}
            placeholder="What the funds will be used for"
            className="border-paper-2 bg-paper-main text-text-standard focus:border-core-orange w-full rounded-xl border px-3 py-2 text-sm outline-none"
          />
        </label>
      </div>
      <div className="mt-4">
        <Button
          app="fund"
          variant="primary"
          size="sm"
          disabled={gated || !valid || tx.isBusy}
          onClick={() =>
            void tx.run({
              address: COOP.withdrawals,
              abi: coopWithdrawalsAbi,
              functionName: "proposeWithdrawal",
              args: [
                fund,
                toCoopWei(amountNum),
                recipient.trim() as Address,
                purpose.trim(),
              ],
            })
          }
        >
          {tx.isBusy ? "Proposing…" : "Propose withdrawal"}
        </Button>
        {gated && (
          <Caption className="text-surface-grey mt-2 block">
            {!isConnected
              ? "Connect a member wallet to propose."
              : "Your wallet isn't a member — ask the coordinator."}
          </Caption>
        )}
        <TxLine
          status={tx.status}
          hash={tx.hash}
          error={tx.error}
          successLabel="Withdrawal proposed."
        />
      </div>
    </Card>
  );
}

function WithdrawalCard({ w, state }: { w: CoopWithdrawal; state: CoopState }) {
  const voteTx = useCoopTx();
  const closeTx = useCoopTx();
  const { isConnected } = useAccount();
  const cast = w.votesFor + w.votesAgainst;
  const pctFor = cast ? Math.round((w.votesFor / cast) * 100) : 0;
  const gated =
    !isConnected || !state.isMember || w.iVoted || w.status !== "voting";

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Heading4 className="text-text-standard">
            {usd(w.amount)} from <FundBadge fund={w.fund} />
          </Heading4>
          <Caption className="text-surface-grey mt-1 block">
            By {shortenAddress(w.proposer)} · to{" "}
            <a
              href={coopAddressUrl(w.recipient)}
              target="_blank"
              rel="noreferrer"
              className="hover:text-core-orange font-mono"
            >
              {shortenAddress(w.recipient)}
            </a>
          </Caption>
        </div>
        <Chip
          size="small"
          className={
            w.status === "voting"
              ? "text-system-warning"
              : w.status === "approved"
                ? "text-system-green"
                : "text-system-red"
          }
        >
          {w.status}
        </Chip>
      </div>
      <Body className="text-surface-grey-2 mt-3 text-sm">{w.purpose}</Body>
      <div className="border-paper-2 mt-3 flex h-3 overflow-hidden rounded-full border">
        {cast === 0 ? (
          <div className="bg-paper-2 w-full" />
        ) : (
          <>
            <div
              className="bg-system-green h-full"
              style={{ width: `${pctFor}%` }}
            />
            <div
              className="bg-system-red h-full"
              style={{ width: `${100 - pctFor}%` }}
            />
          </>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <Caption className="text-surface-grey-2">
          For <strong className="text-text-standard">{w.votesFor}</strong> ·
          Against{" "}
          <strong className="text-text-standard">{w.votesAgainst}</strong> · of{" "}
          {state.memberCount} members
          {w.iVoted && " · you voted"}
        </Caption>
        <div className="flex flex-wrap gap-2">
          <Button
            app="fund"
            variant="secondary"
            size="sm"
            disabled={gated || voteTx.isBusy}
            leftIcon={<CheckCircle weight="bold" />}
            onClick={() =>
              void voteTx.run({
                address: COOP.withdrawals,
                abi: coopWithdrawalsAbi,
                functionName: "voteWithdrawal",
                args: [BigInt(w.id), true],
              })
            }
          >
            For
          </Button>
          <Button
            app="fund"
            variant="secondary"
            size="sm"
            disabled={gated || voteTx.isBusy}
            leftIcon={<Circle weight="bold" />}
            onClick={() =>
              void voteTx.run({
                address: COOP.withdrawals,
                abi: coopWithdrawalsAbi,
                functionName: "voteWithdrawal",
                args: [BigInt(w.id), false],
              })
            }
          >
            Against
          </Button>
          {w.status === "voting" && (
            <Button
              app="fund"
              variant="secondary"
              size="sm"
              disabled={!isConnected || !state.isMember || closeTx.isBusy}
              onClick={() =>
                void closeTx.run({
                  address: COOP.withdrawals,
                  abi: coopWithdrawalsAbi,
                  functionName: "closeWithdrawal",
                  args: [BigInt(w.id)],
                })
              }
            >
              Close & tally
            </Button>
          )}
        </div>
      </div>
      <TxLine
        status={voteTx.status}
        hash={voteTx.hash}
        error={voteTx.error}
        successLabel="Vote recorded."
      />
      <TxLine
        status={closeTx.status}
        hash={closeTx.hash}
        error={closeTx.error}
        successLabel="Withdrawal closed."
      />
    </Card>
  );
}

/* --------------------------------- Activity ------------------------------- */

function ActivityView({ state }: { state: CoopState }) {
  return (
    <div>
      <div className="mt-6">
        <PageHeader
          title="Activity"
          subtitle="Every on-chain token movement and governance event for the cooperative, newest first."
        />
      </div>
      <SectionTitle>Token movements</SectionTitle>
      <MovementsTable state={state} />
      <SectionTitle>Governance log</SectionTitle>
      {state.log.length === 0 ? (
        <EmptyState>No governance activity yet.</EmptyState>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-paper-2 border-b text-left">
                <Th>When</Th>
                <Th>Actor</Th>
                <Th>Kind</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {state.log.map((t, i) => (
                <tr key={i} className="border-paper-2 border-b last:border-0">
                  <Td>
                    <span className="text-surface-grey text-xs">{t.when}</span>
                  </Td>
                  <Td>{t.actor}</Td>
                  <Td>
                    <span className="bg-primary-blue/10 text-primary-blue rounded-full px-2 py-0.5 text-xs font-semibold">
                      {t.kind}
                    </span>
                  </Td>
                  <Td>{t.text}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function MovementsTable({
  state,
  limit,
}: {
  state: CoopState;
  limit?: number;
}) {
  const rows = useMemo(
    () => (limit ? state.movements.slice(0, limit) : state.movements),
    [state.movements, limit],
  );
  if (rows.length === 0) return <EmptyState>No movements yet.</EmptyState>;
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-paper-2 border-b text-left">
            <Th>When</Th>
            <Th>From</Th>
            <Th>To</Th>
            <Th>Amount</Th>
            <Th>Kind</Th>
            <Th>Note</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m, i) => (
            <tr key={i} className="border-paper-2 border-b last:border-0">
              <Td>
                <span className="text-surface-grey text-xs">{m.when}</span>
              </Td>
              <Td>
                <FundBadge fund={m.from} />
              </Td>
              <Td>
                <FundBadge fund={m.to} />
              </Td>
              <Td>
                <span className="font-bold">{usd(m.amount)}</span>
              </Td>
              <Td>
                <span className="bg-primary-blue/10 text-primary-blue rounded-full px-2 py-0.5 text-xs font-semibold">
                  {m.kind}
                </span>
              </Td>
              <Td>{m.note}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/* --------------------------------- Deposit -------------------------------- */

function DepositView({ state }: { state: CoopState }) {
  const { isConnected, address } = useAccount();
  const [faucetAmt, setFaucetAmt] = useState("500");
  const [depositAmt, setDepositAmt] = useState("100");
  const [redeemAmt, setRedeemAmt] = useState("");
  const faucet = useCoopTx();
  const approve = useCoopTx();
  const mint = useCoopTx();
  const redeem = useCoopTx();

  const depositNum = Number(depositAmt || 0);
  const needsApproval = depositNum > 0 && state.usdAllowance < depositNum;

  return (
    <div>
      <div className="mt-6">
        <PageHeader
          title="Deposit"
          subtitle="cUSD is the cooperative's unit of account: deposit the underlying test USD 1:1 to mint it, redeem 1:1 anytime. The pooled principal earns the yield that becomes the Art Fund."
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard
          label="Your cUSD"
          value={usd(state.myCusd)}
          sub="redeemable 1:1"
          accent
        />
        <StatCard label="Your test USD" value={usd(state.myUsd)} />
      </div>
      {!isConnected && (
        <Card className="mt-4">
          <Body className="text-surface-grey-2 text-sm">
            Connect a wallet (Sepolia) to mint and redeem — balances above show
            once connected.
          </Body>
        </Card>
      )}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card>
          <Heading4 className="text-text-standard">1 · Get test USD</Heading4>
          <Body className="text-surface-grey-2 mt-2 text-sm">
            The Sepolia deployment wraps an open-faucet test stablecoin — mint
            yourself some to play with.
          </Body>
          <input
            type="number"
            min={0}
            value={faucetAmt}
            onChange={(e) => setFaucetAmt(e.target.value)}
            className="border-paper-2 bg-paper-main text-text-standard focus:border-core-orange mt-3 w-full rounded-xl border px-3 py-2 text-sm outline-none"
          />
          <Button
            app="fund"
            variant="secondary"
            size="sm"
            className="mt-3"
            disabled={
              !isConnected || Number(faucetAmt || 0) <= 0 || faucet.isBusy
            }
            onClick={() =>
              void faucet.run({
                address: COOP.usd,
                abi: coopUsdAbi,
                functionName: "mint",
                args: [address, toCoopWei(Number(faucetAmt))],
              })
            }
          >
            {faucet.isBusy ? "Minting…" : "Mint test USD"}
          </Button>
          <TxLine
            status={faucet.status}
            hash={faucet.hash}
            error={faucet.error}
            successLabel="Test USD minted."
          />
        </Card>
        <Card>
          <Heading4 className="text-text-standard">2 · Mint cUSD</Heading4>
          <Body className="text-surface-grey-2 mt-2 text-sm">
            Deposit test USD 1:1 — it joins the pooled principal (parked in the
            yield vault) and you receive cUSD.
          </Body>
          <input
            type="number"
            min={0}
            value={depositAmt}
            onChange={(e) => setDepositAmt(e.target.value)}
            className="border-paper-2 bg-paper-main text-text-standard focus:border-core-orange mt-3 w-full rounded-xl border px-3 py-2 text-sm outline-none"
          />
          {needsApproval ? (
            <Button
              app="fund"
              variant="secondary"
              size="sm"
              className="mt-3"
              disabled={!isConnected || approve.isBusy}
              onClick={() =>
                void approve.run({
                  address: COOP.usd,
                  abi: coopUsdAbi,
                  functionName: "approve",
                  args: [COOP.token, toCoopWei(depositNum)],
                })
              }
            >
              {approve.isBusy ? "Approving…" : "Approve test USD"}
            </Button>
          ) : (
            <Button
              app="fund"
              variant="primary"
              size="sm"
              className="mt-3"
              disabled={
                !isConnected ||
                depositNum <= 0 ||
                depositNum > state.myUsd ||
                mint.isBusy
              }
              onClick={() =>
                void mint.run({
                  address: COOP.token,
                  abi: coopTokenAbi,
                  functionName: "mint",
                  args: [address, toCoopWei(depositNum)],
                })
              }
            >
              {mint.isBusy ? "Minting…" : "Mint cUSD"}
            </Button>
          )}
          <TxLine
            status={approve.status}
            hash={approve.hash}
            error={approve.error}
            successLabel="Approved — now mint."
          />
          <TxLine
            status={mint.status}
            hash={mint.hash}
            error={mint.error}
            successLabel="cUSD minted 1:1."
          />
        </Card>
        <Card>
          <Heading4 className="text-text-standard">Redeem anytime</Heading4>
          <Body className="text-surface-grey-2 mt-2 text-sm">
            Burn cUSD to withdraw the underlying test USD 1:1 — the principal is
            never locked.
          </Body>
          <input
            type="number"
            min={0}
            value={redeemAmt}
            onChange={(e) => setRedeemAmt(e.target.value)}
            placeholder={String(Math.floor(state.myCusd))}
            className="border-paper-2 bg-paper-main text-text-standard focus:border-core-orange mt-3 w-full rounded-xl border px-3 py-2 text-sm outline-none"
          />
          <Button
            app="fund"
            variant="secondary"
            size="sm"
            className="mt-3"
            disabled={
              !isConnected ||
              Number(redeemAmt || 0) <= 0 ||
              Number(redeemAmt || 0) > state.myCusd ||
              redeem.isBusy
            }
            onClick={() =>
              void redeem.run({
                address: COOP.token,
                abi: coopTokenAbi,
                functionName: "burn",
                args: [toCoopWei(Number(redeemAmt)), address],
              })
            }
          >
            {redeem.isBusy ? "Redeeming…" : "Redeem"}
          </Button>
          <TxLine
            status={redeem.status}
            hash={redeem.hash}
            error={redeem.error}
            successLabel="Redeemed 1:1."
          />
        </Card>
      </div>
    </div>
  );
}

/* ---------------------------- Project registration ------------------------ */

function RegisterProjectCard({ state }: { state: CoopState }) {
  const { address, isConnected } = useAccount();
  const isCoordinator =
    isConnected && address?.toLowerCase() === state.coordinator.toLowerCase();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [recipient, setRecipient] = useState("");
  const [full, setFull] = useState("1000");
  const [minViable, setMinViable] = useState("400");
  const tx = useCoopTx();

  const fullNum = Number(full || 0);
  const minNum = Number(minViable || 0);
  const valid =
    title.trim().length > 0 &&
    isAddress(recipient.trim()) &&
    fullNum > 0 &&
    minNum > 0 &&
    minNum <= fullNum;

  return (
    <Card>
      <Heading4 className="text-text-standard">Register a project</Heading4>
      <Body className="text-surface-grey-2 mt-1 text-sm">
        The coordinator registers proposals with a full budget and a
        minimum-viable floor. New projects queue, then activate at the cycle
        boundary.
      </Body>
      <div className="mt-4 space-y-3">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Project title"
          className="border-paper-2 bg-paper-main text-text-standard focus:border-core-orange w-full rounded-xl border px-3 py-2 text-sm outline-none"
        />
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={2}
          placeholder="What the project is, who it benefits"
          className="border-paper-2 bg-paper-main text-text-standard focus:border-core-orange w-full rounded-xl border px-3 py-2 text-sm outline-none"
        />
        <input
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          placeholder="Payout address 0x…"
          className="border-paper-2 bg-paper-main text-text-standard focus:border-core-orange w-full rounded-xl border px-3 py-2 font-mono text-sm outline-none"
        />
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <Caption className="text-surface-grey-2 mb-1 block">
              Full budget (cUSD)
            </Caption>
            <input
              type="number"
              min={0}
              value={full}
              onChange={(e) => setFull(e.target.value)}
              className="border-paper-2 bg-paper-main text-text-standard focus:border-core-orange w-full rounded-xl border px-3 py-2 text-sm outline-none"
            />
          </label>
          <label className="block">
            <Caption className="text-surface-grey-2 mb-1 block">
              Min viable (cUSD)
            </Caption>
            <input
              type="number"
              min={0}
              value={minViable}
              onChange={(e) => setMinViable(e.target.value)}
              className="border-paper-2 bg-paper-main text-text-standard focus:border-core-orange w-full rounded-xl border px-3 py-2 text-sm outline-none"
            />
          </label>
        </div>
      </div>
      <Button
        app="fund"
        variant="primary"
        size="sm"
        className="mt-4"
        disabled={!isCoordinator || !valid || tx.isBusy}
        onClick={() =>
          void tx.run({
            address: COOP.registry,
            abi: coopRegistryAbi,
            functionName: "registerProject",
            args: [
              recipient.trim() as Address,
              toCoopWei(fullNum),
              toCoopWei(minNum),
              title.trim(),
              summary.trim(),
            ],
          })
        }
      >
        {tx.isBusy ? "Registering…" : "Register project"}
      </Button>
      {!isCoordinator && (
        <Caption className="text-surface-grey mt-2 block">
          Only the coordinator ({shortenAddress(state.coordinator)}) can
          register projects on-chain.
        </Caption>
      )}
      {minNum > fullNum && (
        <Caption className="text-system-red mt-2 block">
          The minimum-viable floor can&apos;t exceed the full budget.
        </Caption>
      )}
      <TxLine
        status={tx.status}
        hash={tx.hash}
        error={tx.error}
        successLabel="Project registered — it's in the queue."
      />
    </Card>
  );
}

function QueuedProjectsCard({ state }: { state: CoopState }) {
  const tx = useCoopTx();
  const { isConnected } = useAccount();
  return (
    <Card>
      <Heading4 className="text-text-standard">Queued projects</Heading4>
      <Body className="text-surface-grey-2 mt-1 text-sm">
        Registered proposals wait here until the queue is processed — then they
        join the ballot. Anyone can process the queue.
      </Body>
      {state.queuedProjects.length === 0 ? (
        <Caption className="text-surface-grey mt-4 block">
          Nothing queued right now.
        </Caption>
      ) : (
        <div className="border-paper-2 mt-4 border-t">
          {state.queuedProjects.map((q) => (
            <div key={q.addr} className="border-paper-2 border-b py-3">
              <span className="text-text-standard text-sm font-semibold">
                {q.title}
              </span>
              <span className="text-surface-grey block text-xs">
                {shortenAddress(q.addr)} · full {usd(q.full)} · min{" "}
                {usd(q.minViable)}
              </span>
            </div>
          ))}
        </div>
      )}
      <Button
        app="fund"
        variant="secondary"
        size="sm"
        className="mt-4"
        disabled={
          !isConnected || state.queuedProjects.length === 0 || tx.isBusy
        }
        onClick={() =>
          void tx.run({
            address: COOP.registry,
            abi: coopRegistryAbi,
            functionName: "processQueue",
          })
        }
      >
        {tx.isBusy ? "Processing…" : "Process queue"}
      </Button>
      <TxLine
        status={tx.status}
        hash={tx.hash}
        error={tx.error}
        successLabel="Queue processed — projects are live on the ballot."
      />
    </Card>
  );
}

/* --------------------------------- Members -------------------------------- */

function MembersView({ state }: { state: CoopState }) {
  const { address, isConnected } = useAccount();
  const isCoordinator =
    isConnected && address?.toLowerCase() === state.coordinator.toLowerCase();
  const [newMember, setNewMember] = useState("");
  const addTx = useCoopTx();
  const removeTx = useCoopTx();

  return (
    <div>
      <div className="mt-6">
        <PageHeader
          title="Members"
          subtitle="One member, one vote — voting power comes from membership, not balance. The coordinator manages the roster on-chain."
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <StatCard label="Members" value={state.memberCount} accent />
        <StatCard
          label="Coordinator"
          value={shortenAddress(state.coordinator)}
          sub="owns the membership & registry contracts"
        />
      </div>
      <SectionTitle>Roster</SectionTitle>
      <Card className="p-0">
        {state.members.map((m) => (
          <div
            key={m}
            className="border-paper-2 flex items-center justify-between gap-3 border-b px-5 py-3 last:border-0"
          >
            <a
              href={coopAddressUrl(m)}
              target="_blank"
              rel="noreferrer"
              className="text-text-standard hover:text-core-orange font-mono text-sm"
            >
              {m}
            </a>
            <div className="flex items-center gap-2">
              {m.toLowerCase() === state.coordinator.toLowerCase() && (
                <Chip size="small" className="text-core-orange">
                  coordinator
                </Chip>
              )}
              {isConnected && m.toLowerCase() === address?.toLowerCase() && (
                <Chip size="small" className="text-system-green">
                  you
                </Chip>
              )}
              {isCoordinator && (
                <Button
                  app="fund"
                  variant="secondary"
                  size="sm"
                  disabled={removeTx.isBusy}
                  onClick={() =>
                    void removeTx.run({
                      address: COOP.power,
                      abi: coopPowerAbi,
                      functionName: "removeMember",
                      args: [m],
                    })
                  }
                >
                  Remove
                </Button>
              )}
            </div>
          </div>
        ))}
      </Card>
      <TxLine
        status={removeTx.status}
        hash={removeTx.hash}
        error={removeTx.error}
        successLabel="Member removed."
      />
      <SectionTitle>Add a member</SectionTitle>
      <Card>
        <Body className="text-surface-grey-2 text-sm">
          New members get exactly one vote — the same as everyone else. Only the
          coordinator ({shortenAddress(state.coordinator)}) can add or remove
          members.
        </Body>
        <div className="mt-3 flex flex-wrap gap-3">
          <input
            value={newMember}
            onChange={(e) => setNewMember(e.target.value)}
            placeholder="0x…"
            className="border-paper-2 bg-paper-main text-text-standard focus:border-core-orange min-w-64 flex-1 rounded-xl border px-3 py-2 font-mono text-sm outline-none"
          />
          <Button
            app="fund"
            variant="primary"
            size="sm"
            disabled={
              !isCoordinator || !isAddress(newMember.trim()) || addTx.isBusy
            }
            onClick={() =>
              void addTx.run({
                address: COOP.power,
                abi: coopPowerAbi,
                functionName: "addMember",
                args: [newMember.trim() as Address],
              })
            }
          >
            {addTx.isBusy ? "Adding…" : "Add member"}
          </Button>
        </div>
        <TxLine
          status={addTx.status}
          hash={addTx.hash}
          error={addTx.error}
          successLabel="Member added — one vote, like everyone."
        />
      </Card>
    </div>
  );
}
