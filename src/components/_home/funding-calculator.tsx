"use client";

import { useEffect, useMemo, useState } from "react";
import { Body, Button, Caption, Heading3 } from "@breadcoop/ui";
import {
  ArrowCounterClockwise,
  ArrowsClockwise,
  CheckCircle,
  HandCoins,
  LinkSimple,
  LockSimple,
  PiggyBank,
  Target,
  UsersThree,
  Warning,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

/**
 * Art Fund Calculator
 * -------------------
 * A two-lens planner over one canonical scenario {members, stake, apy, …}:
 * "Your cooperative" projects what a cooperative of a given size can fund;
 * "Hit a target" goal-seeks the members or stake needed for a monthly amount.
 * Both lenses read and write the same state, so they can never disagree.
 *
 * Honesty rules (deliberate, don't "fix" them):
 * - Simple interest only (pool × APY ÷ 12) — yield is paid out each cycle,
 *   principal never compounds. Cycle payouts use 30/365.
 * - Every model output is a low/expected/high band (APY ±3pt, clamped 1–15%)
 *   and passes through `approxUsd` so we never show false precision.
 * - Goal-seek rounds UP (ceil members, stake to the next nice step) and then
 *   recomputes the actual monthly from the rounded values — the displayed
 *   numbers always multiply out. No silent clamps; infeasible plans get a
 *   warning with suggestions instead of being rounded into "achievable".
 *
 * Scenarios serialize into a shareable #calc= URL hash (static-export safe;
 * written only when the user copies a link, parsed once on mount).
 */

/* --------------------------------- Model ---------------------------------- */

const MEMBER_STOPS = [
  5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 120, 150, 200, 250, 300, 400, 500,
  750, 1000,
];
const STAKE_STOPS = [
  25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000,
  5000,
];
const TARGET_STOPS = [
  50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000,
  7500, 10000,
];
const HORIZONS = [
  { label: "6 mo", months: 6 },
  { label: "1 yr", months: 12 },
  { label: "2 yr", months: 24 },
  { label: "5 yr", months: 60 },
] as const;
const APY_PRESETS = [
  { label: "Cautious 4%", value: 4 },
  { label: "Historical ~7%", value: 7 },
  { label: "Strong 10%", value: 10 },
] as const;
const MILESTONES = [250, 500, 1000, 5000] as const;
const PRESETS = [
  { key: "print", label: "Print studio", members: 25, stake: 200, target: 100 },
  { key: "zine", label: "Zine press", members: 60, stake: 150, target: 150 },
  {
    key: "mural",
    label: "Community mural",
    members: 75,
    stake: 400,
    target: 200,
  },
  {
    key: "residency",
    label: "Artist residency",
    members: 300,
    stake: 1000,
    target: 1500,
  },
] as const;

const CYCLE_DAYS = 30;
const DONATION = 25; // "a typical small recurring donation"
const MEMBER_CAP = 10_000; // projection sanity cap
const BAND_PT = 3; // APY band half-width, percentage points
const APY_MIN = 1;
const APY_MAX = 15;

type Mode = "community" | "target";
type SolveFor = "members" | "stake";

type State = {
  mode: Mode;
  solveFor: SolveFor;
  mIdx: number; // index into MEMBER_STOPS
  sIdx: number; // index into STAKE_STOPS
  tIdx: number; // index into TARGET_STOPS
  hIdx: number; // index into HORIZONS
  apy: number; // percent, 1–15 step 0.5
  growth: number; // new members / month, 0–20
  msIdx: number; // index into MILESTONES
};

const DEFAULTS: State = {
  mode: "community",
  solveFor: "members",
  mIdx: MEMBER_STOPS.indexOf(50),
  sIdx: STAKE_STOPS.indexOf(250),
  tIdx: TARGET_STOPS.indexOf(500),
  hIdx: 1,
  apy: 7,
  growth: 0,
  msIdx: 1,
};

const usd = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 0 });

/** Round a model-derived dollar figure to an honest display value. */
function approxUsd(x: number): string {
  if (x < 1 && x > 0) return "<$1";
  const step =
    x < 100 ? 1 : x < 1000 ? 10 : x < 10_000 ? 50 : x < 100_000 ? 100 : 1000;
  return `$${usd(Math.round(x / step) * step)}`;
}

/** Per-member money reads better with cents when it's small. */
function perMemberUsd(x: number): string {
  if (x >= 10) return `$${usd(x)}`;
  if (x < 0.01) return "<$0.01";
  return `$${x.toFixed(2)}`;
}

/** Goal-seek stakes round UP to the next "nice" step so the plan always meets the target. */
function roundUpNice(x: number): number {
  const step = x <= 20 ? 1 : x <= 100 ? 5 : x <= 1000 ? 25 : 100;
  return Math.ceil(x / step) * step;
}

const nearestIdx = (stops: readonly number[], value: number) =>
  stops.reduce(
    (best, s, i) =>
      Math.abs(s - value) < Math.abs(stops[best] - value) ? i : best,
    0,
  );

const clampInt = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : lo;

/* ------------------------------ URL scenario ------------------------------ */

const HASH_PREFIX = "#calc=v1.";

function encodeState(s: State): string {
  const mode = s.mode === "community" ? 0 : 1;
  const sf = s.solveFor === "members" ? 0 : 1;
  return (
    HASH_PREFIX +
    [
      mode,
      sf,
      s.mIdx,
      s.sIdx,
      s.tIdx,
      s.hIdx,
      s.apy * 10,
      s.growth,
      s.msIdx,
    ].join(".")
  );
}

function decodeState(hash: string): State | null {
  if (!hash.startsWith(HASH_PREFIX)) return null;
  const parts = hash.slice(HASH_PREFIX.length).split(".").map(Number);
  if (parts.length !== 9 || parts.some((n) => !Number.isFinite(n))) return null;
  const [mode, sf, mIdx, sIdx, tIdx, hIdx, apy10, growth, msIdx] = parts;
  return {
    mode: mode === 1 ? "target" : "community",
    solveFor: sf === 1 ? "stake" : "members",
    mIdx: clampInt(mIdx, 0, MEMBER_STOPS.length - 1),
    sIdx: clampInt(sIdx, 0, STAKE_STOPS.length - 1),
    tIdx: clampInt(tIdx, 0, TARGET_STOPS.length - 1),
    hIdx: clampInt(hIdx, 0, HORIZONS.length - 1),
    apy: clampInt(apy10, APY_MIN * 10, APY_MAX * 10) / 10,
    growth: clampInt(growth, 0, 20),
    msIdx: clampInt(msIdx, 0, MILESTONES.length - 1),
  };
}

/* -------------------------------- Component ------------------------------- */

export function FundingCalculator() {
  const [state, setState] = useState<State>(DEFAULTS);
  const [copied, setCopied] = useState(false);

  // Hydrate a shared scenario from the URL hash — on mount, and again if a
  // second scenario link is opened while the page is already up (hash-only
  // navigation doesn't remount the component).
  useEffect(() => {
    const hydrate = () => {
      const decoded = decodeState(window.location.hash);
      if (decoded) setState(decoded);
    };
    hydrate();
    window.addEventListener("hashchange", hydrate);
    return () => window.removeEventListener("hashchange", hydrate);
  }, []);

  const set = (patch: Partial<State>) => setState((s) => ({ ...s, ...patch }));

  const d = useMemo(() => derive(state), [state]);

  const activePreset = PRESETS.find(
    (p) =>
      MEMBER_STOPS[state.mIdx] === p.members &&
      STAKE_STOPS[state.sIdx] === p.stake &&
      TARGET_STOPS[state.tIdx] === p.target,
  )?.key;

  const applyPreset = (p: (typeof PRESETS)[number]) =>
    set({
      mIdx: nearestIdx(MEMBER_STOPS, p.members),
      sIdx: nearestIdx(STAKE_STOPS, p.stake),
      tIdx: nearestIdx(TARGET_STOPS, p.target),
    });

  const copyLink = async () => {
    const url = `${window.location.origin}${window.location.pathname}${encodeState(state)}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      window.prompt("Copy your scenario link:", url);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const isDefault = JSON.stringify(state) === JSON.stringify(DEFAULTS);
  const horizon = HORIZONS[state.hIdx];

  return (
    <div className="border-primary-jade bg-paper-0 w-full rounded-2xl border-2 p-6 shadow-2xl sm:p-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <Heading3 className="text-text-standard">Art Fund Calculator</Heading3>
        <button
          type="button"
          onClick={() => setState(DEFAULTS)}
          disabled={isDefault}
          className={cn(
            "flex items-center gap-1 text-xs font-semibold transition-colors",
            isDefault
              ? "text-paper-2 cursor-default"
              : "text-surface-grey-2 hover:text-core-orange",
          )}
        >
          <ArrowCounterClockwise size={14} weight="bold" /> Reset
        </button>
      </div>
      <Body className="text-surface-grey-2 mt-1">
        Real math, adjustable assumptions — deposits stay yours.
      </Body>

      {/* Mode tabs */}
      <div
        role="tablist"
        aria-label="Calculator mode"
        className="bg-paper-2 mt-5 grid grid-cols-2 gap-1 rounded-xl p-1"
      >
        {(
          [
            ["community", "Your cooperative"],
            ["target", "Hit a target"],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={state.mode === mode}
            onClick={() => set({ mode })}
            className={cn(
              "rounded-lg px-3 py-2 text-sm font-semibold transition-colors",
              state.mode === mode
                ? "bg-paper-0 text-core-orange shadow-sm"
                : "text-surface-grey-2 hover:text-text-standard",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Presets */}
      <div className="mt-4">
        <Caption className="text-surface-grey-2">
          Start from a project like yours
        </Caption>
        <div className="mt-2 flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <PillButton
              key={p.key}
              active={activePreset === p.key}
              onClick={() => applyPreset(p)}
            >
              {p.label}
            </PillButton>
          ))}
          <PillButton active={!activePreset} onClick={() => undefined} subtle>
            Custom
          </PillButton>
        </div>
      </div>

      {/* Inputs */}
      <div className="mt-5 space-y-5">
        {state.mode === "community" ? (
          <>
            <StopSlider
              label="Members"
              stops={MEMBER_STOPS}
              idx={state.mIdx}
              format={(v) => `${v}`}
              valueText={(v) => `${v} members`}
              onChange={(mIdx) => set({ mIdx })}
            />
            <StopSlider
              label="Average stake per member"
              hint="Always theirs — withdrawable anytime"
              stops={STAKE_STOPS}
              idx={state.sIdx}
              format={(v) => `$${usd(v)}`}
              valueText={(v) => `$${v} per member`}
              onChange={(sIdx) => set({ sIdx })}
            />
          </>
        ) : (
          <>
            <StopSlider
              label="Monthly funding target"
              stops={TARGET_STOPS}
              idx={state.tIdx}
              format={(v) => `$${usd(v)}/mo`}
              valueText={(v) => `$${v} per month`}
              onChange={(tIdx) => set({ tIdx })}
            />
            <div>
              <Caption className="text-surface-grey-2">Solve for</Caption>
              <div className="mt-2 flex gap-2">
                {(
                  [
                    ["members", "Members needed"],
                    ["stake", "Stake per member"],
                  ] as const
                ).map(([sf, label]) => (
                  <PillButton
                    key={sf}
                    active={state.solveFor === sf}
                    onClick={() => set({ solveFor: sf })}
                  >
                    {label}
                  </PillButton>
                ))}
              </div>
            </div>
            {state.solveFor === "members" ? (
              <StopSlider
                label="Average stake per member"
                hint="Always theirs — withdrawable anytime"
                stops={STAKE_STOPS}
                idx={state.sIdx}
                format={(v) => `$${usd(v)}`}
                valueText={(v) => `$${v} per member`}
                onChange={(sIdx) => set({ sIdx })}
              />
            ) : (
              <StopSlider
                label="Members"
                stops={MEMBER_STOPS}
                idx={state.mIdx}
                format={(v) => `${v}`}
                valueText={(v) => `${v} members`}
                onChange={(mIdx) => set({ mIdx })}
              />
            )}
          </>
        )}

        {/* Horizon */}
        <div>
          <Caption className="text-surface-grey-2">Projection horizon</Caption>
          <div className="mt-2 flex gap-2">
            {HORIZONS.map((h, i) => (
              <PillButton
                key={h.label}
                active={state.hIdx === i}
                onClick={() => set({ hIdx: i })}
              >
                {h.label}
              </PillButton>
            ))}
          </div>
        </div>
      </div>

      {/* Scenario sentence — one line, both lenses agree on it */}
      <Body className="text-text-standard border-paper-2 mt-5 border-t pt-4">
        <span className="font-bold">{usd(d.members)} members</span> ×{" "}
        <span className="font-bold">${usd(d.stake)}</span> each at{" "}
        <span className="font-bold">{fmtApy(state.apy)}% APY</span>
        {state.mode === "target" && (
          <span className="text-surface-grey-2">
            {" "}
            — solved from your target
          </span>
        )}
      </Body>

      {/* Target lens: solved card + rate table + feasibility */}
      {state.mode === "target" && (
        <div className="mt-3 space-y-3">
          <div className="border-core-orange bg-paper-1 rounded-xl border-l-4 p-4">
            <div className="text-core-orange flex items-center gap-1.5 text-xs font-bold tracking-wide uppercase">
              <LockSimple size={13} weight="bold" /> Solved for you
            </div>
            <p className="font-breadDisplay text-text-standard mt-1 text-2xl font-bold">
              {state.solveFor === "members"
                ? `${usd(d.members)} members`
                : `$${usd(d.stake)} per member`}
            </p>
            <Caption className="text-surface-grey-2">
              actual ≈ {approxUsd(d.monthly)}/mo against your ${usd(d.target)}
              /mo target
            </Caption>
            <div className="border-paper-2 mt-3 grid grid-cols-3 gap-2 border-t pt-3 text-center">
              {d.solvedAtRates.map((r) => (
                <div key={r.apy}>
                  <Caption className="text-surface-grey">
                    at {fmtApy(r.apy)}%
                  </Caption>
                  <p
                    className={cn(
                      "font-breadDisplay text-sm font-bold",
                      r.apy === state.apy
                        ? "text-core-orange"
                        : "text-text-standard",
                    )}
                  >
                    {state.solveFor === "members"
                      ? `${usd(r.value)}`
                      : `$${usd(r.value)}`}
                  </p>
                </div>
              ))}
            </div>
            <Caption className="text-surface-grey mt-2 block">
              Plan for the {fmtApy(d.apyLo)}% column; celebrate the{" "}
              {fmtApy(d.apyHi)}% one.
            </Caption>
          </div>

          <div
            className={cn(
              "flex items-start gap-2 rounded-lg px-4 py-3 text-sm font-semibold",
              d.feasibility.tone === "green" &&
                "bg-system-green/10 text-system-green",
              d.feasibility.tone === "jade" &&
                "bg-primary-jade/10 text-primary-jade",
              d.feasibility.tone === "warning" &&
                "bg-system-warning/10 text-system-warning",
            )}
          >
            {d.feasibility.tone === "warning" ? (
              <Warning size={18} weight="fill" className="mt-0.5 shrink-0" />
            ) : (
              <CheckCircle
                size={18}
                weight="fill"
                className="mt-0.5 shrink-0"
              />
            )}
            {d.feasibility.text}
          </div>
        </div>
      )}

      {/* Hero result */}
      <div className="mt-5 text-center" aria-live="polite" aria-atomic="true">
        <Caption className="text-surface-grey-2">
          Monthly Art Fund for your cooperative
        </Caption>
        <p className="font-breadDisplay text-core-orange mt-1 text-5xl font-extrabold tracking-tight">
          ≈ {approxUsd(d.monthly)}
          <span className="text-surface-grey text-xl font-normal"> /mo</span>
        </p>
        <Body className="text-surface-grey-2 mt-1 text-sm">
          likely {approxUsd(d.monthlyLo)} at {fmtApy(d.apyLo)}% —{" "}
          {approxUsd(d.monthlyHi)} at {fmtApy(d.apyHi)}%
        </Body>
      </div>

      {/* Projection chart */}
      <div className="mt-5">
        <Caption className="text-surface-grey-2">
          Cumulative funding over {horizon.label}
          {d.capped ? " (members capped at 10,000)" : ""}
        </Caption>
        <ProjectionChart d={d} />
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
          <LegendSwatch className="bg-core-orange" label="Expected" />
          <LegendSwatch
            className="bg-core-orange/25"
            label={`Range at ${fmtApy(d.apyLo)}–${fmtApy(d.apyHi)}% APY`}
          />
        </div>
        <p className="sr-only">
          Over {horizon.months} months, cumulative funding reaches approximately{" "}
          {approxUsd(d.cumMid[d.cumMid.length - 1])}, likely between{" "}
          {approxUsd(d.cumLo[d.cumLo.length - 1])} and{" "}
          {approxUsd(d.cumHi[d.cumHi.length - 1])}. Member deposits of{" "}
          {approxUsd(d.pool)} stay withdrawable throughout.
        </p>
      </div>

      {/* Stat row */}
      <div className="bg-paper-1 mt-4 grid grid-cols-3 gap-3 rounded-xl p-4 text-center">
        <Stat
          icon={<PiggyBank size={16} weight="bold" />}
          label="Total pooled"
          value={`$${usd(d.pool)}`}
        />
        <Stat
          icon={<ArrowsClockwise size={16} weight="bold" />}
          label={`Per ${CYCLE_DAYS}-day cycle`}
          value={`≈ ${approxUsd(d.cycle)}`}
        />
        <Stat
          icon={<UsersThree size={16} weight="bold" />}
          label="Per member /mo"
          value={`≈ ${perMemberUsd(d.perMemberMonthly)}`}
        />
      </div>

      {/* Story lines */}
      <div className="mt-4 space-y-2.5">
        <StoryLine icon={<UsersThree size={16} weight="bold" />}>
          Each member effectively gives {perMemberUsd(d.perMemberMonthly)}
          /mo — without spending a cent. Their ${usd(d.stake)} stays
          withdrawable, 1:1.
        </StoryLine>
        <StoryLine icon={<HandCoins size={16} weight="bold" />}>
          Raising this with donations would take ≈ {usd(d.donorsNeeded)}{" "}
          {d.donorsNeeded === 1 ? "person" : "people"} giving ${DONATION} every
          month — money that&apos;s gone.
        </StoryLine>
      </div>

      {/* Milestones */}
      <div className="border-paper-2 mt-4 rounded-xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Caption className="text-surface-grey-2">
            Put it toward something
          </Caption>
          <div className="flex gap-1.5">
            {MILESTONES.map((m, i) => (
              <PillButton
                key={m}
                small
                active={state.msIdx === i}
                onClick={() => set({ msIdx: i })}
              >
                ${usd(m)}
              </PillButton>
            ))}
          </div>
        </div>
        <div className="mt-2.5 flex items-start gap-2">
          <Target
            size={16}
            weight="bold"
            className="text-core-orange mt-0.5 shrink-0"
          />
          <Body className="text-text-standard text-sm">{d.milestoneText}</Body>
        </div>
      </div>

      {/* Assumptions */}
      <details className="border-paper-2 group mt-4 rounded-xl border">
        <summary className="text-surface-grey-2 hover:text-text-standard flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold transition-colors [&::-webkit-details-marker]:hidden">
          Assumptions — {fmtApy(state.apy)}% APY · +{state.growth} members/mo ·{" "}
          {CYCLE_DAYS}-day cycles
          <span className="transition-transform group-open:rotate-180">▾</span>
        </summary>
        <div className="border-paper-2 space-y-4 border-t px-4 py-4">
          <div>
            <div className="flex items-baseline justify-between">
              <Caption className="text-surface-grey-2">
                Assumed lending rate (APY)
              </Caption>
              <span className="font-breadDisplay text-text-standard font-bold">
                {fmtApy(state.apy)}%
              </span>
            </div>
            <div className="mt-2 flex gap-2">
              {APY_PRESETS.map((p) => (
                <PillButton
                  key={p.value}
                  small
                  active={state.apy === p.value}
                  onClick={() => set({ apy: p.value })}
                >
                  {p.label}
                </PillButton>
              ))}
            </div>
            <input
              type="range"
              min={APY_MIN}
              max={APY_MAX}
              step={0.5}
              value={state.apy}
              onChange={(e) => set({ apy: Number(e.target.value) })}
              aria-label="Assumed lending rate, percent APY"
              aria-valuetext={`${fmtApy(state.apy)} percent APY`}
              className="bg-paper-2 accent-core-orange mt-3 h-2 w-full cursor-pointer appearance-none rounded-full"
            />
            <Caption className="text-surface-grey mt-1 block">
              Variable rate from over-collateralized lending. 7% is a historical
              average, not a promise.
            </Caption>
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <Caption className="text-surface-grey-2">
                New members per month
              </Caption>
              <span className="font-breadDisplay text-text-standard font-bold">
                +{state.growth}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={20}
              step={1}
              value={state.growth}
              onChange={(e) => set({ growth: Number(e.target.value) })}
              aria-label="New members per month"
              aria-valuetext={`${state.growth} new members per month`}
              className="bg-paper-2 accent-core-orange mt-2 h-2 w-full cursor-pointer appearance-none rounded-full"
            />
            <Caption className="text-surface-grey mt-1 block">
              Each new member stakes the average. Affects the projection only.
            </Caption>
          </div>

          <Caption className="text-surface-grey block">
            How we calculate: monthly funding = pool × APY ÷ 12, simple interest
            — yield is paid out each cycle, so nothing compounds and principal
            never shrinks. The range shows {fmtApy(d.apyLo)}%–
            {fmtApy(d.apyHi)}% around your rate because lending rates move.
          </Caption>
        </div>
      </details>

      {/* Share + fine print */}
      <div className="mt-5">
        <Button
          app="fund"
          variant="secondary"
          size="sm"
          onClick={copyLink}
          leftIcon={
            copied ? (
              <CheckCircle size={16} weight="fill" />
            ) : (
              <LinkSimple size={16} weight="bold" />
            )
          }
        >
          {copied ? "Copied!" : "Copy scenario link"}
        </Button>
      </div>
      <Caption className="text-surface-grey mt-3 block">
        Illustration, not a promise — rates vary with lending markets. Deposits
        are always withdrawable 1:1.
      </Caption>
    </div>
  );
}

/* ------------------------------- Derivation ------------------------------- */

function derive(s: State) {
  const apyLo = Math.max(APY_MIN, s.apy - BAND_PT);
  const apyHi = Math.min(APY_MAX, s.apy + BAND_PT);
  const target = TARGET_STOPS[s.tIdx];

  // Resolve the canonical scenario. In target mode the solved lever is
  // written back so both lenses always describe the same community.
  let members: number;
  let stake: number;
  let solvedAtRates: { apy: number; value: number }[] = [];
  if (s.mode === "community") {
    members = MEMBER_STOPS[s.mIdx];
    stake = STAKE_STOPS[s.sIdx];
  } else if (s.solveFor === "members") {
    stake = STAKE_STOPS[s.sIdx];
    const solve = (a: number) =>
      Math.max(2, Math.ceil((target * 12) / ((a / 100) * stake)));
    solvedAtRates = [apyLo, s.apy, apyHi].map((a) => ({
      apy: a,
      value: solve(a),
    }));
    members = solve(s.apy);
  } else {
    members = MEMBER_STOPS[s.mIdx];
    const solve = (a: number) =>
      roundUpNice((target * 12) / ((a / 100) * members));
    solvedAtRates = [apyLo, s.apy, apyHi].map((a) => ({
      apy: a,
      value: solve(a),
    }));
    stake = solve(s.apy);
  }

  const pool = members * stake;
  const monthly = (pool * s.apy) / 100 / 12;
  const monthlyLo = (pool * apyLo) / 100 / 12;
  const monthlyHi = (pool * apyHi) / 100 / 12;
  const cycle = ((pool * s.apy) / 100) * (CYCLE_DAYS / 365);

  // Projection: yield accrues on the pool as it stood at the start of each
  // month (conservative for mid-horizon joiners). Loop, not closed form, so
  // the member cap stays on one code path.
  const months = HORIZONS[s.hIdx].months;
  const membersAt = (m: number) => Math.min(members + s.growth * m, MEMBER_CAP);
  const capped = members + s.growth * months > MEMBER_CAP;
  const series = (a: number) => {
    const out = [0];
    let acc = 0;
    for (let m = 1; m <= months; m++) {
      acc += (membersAt(m - 1) * stake * a) / 100 / 12;
      out.push(acc);
    }
    return out;
  };
  const cumLo = series(apyLo);
  const cumMid = series(s.apy);
  const cumHi = series(apyHi);

  // Per-member figure uses average membership so growth doesn't inflate it.
  let memberMonths = 0;
  for (let m = 1; m <= months; m++) memberMonths += membersAt(m - 1);
  const perMemberMonthly = memberMonths > 0 ? cumMid[months] / memberMonths : 0;

  const donorsNeeded = Math.max(1, Math.ceil(monthly / DONATION));

  // Milestone cadence from real cycle payouts, honestly capped.
  const ms = MILESTONES[s.msIdx];
  let milestoneText: string;
  if (cycle >= ms) {
    const n = Math.floor(cycle / ms);
    milestoneText =
      n > 1
        ? `Fund ${n} × $${usd(ms)} every ${CYCLE_DAYS}-day cycle.`
        : `Fund a $${usd(ms)} milestone every ${CYCLE_DAYS}-day cycle.`;
  } else {
    const k = Math.ceil(ms / cycle);
    milestoneText =
      k > 120
        ? `A $${usd(ms)} milestone is out of reach at this size — grow the pool to bring it closer.`
        : `Fund a $${usd(ms)} milestone every ${k} cycles (~${Math.round((k * CYCLE_DAYS) / 30)} months).`;
  }

  // Graded feasibility for the target lens — suggestions, never clamps.
  let feasibility: { tone: "green" | "jade" | "warning"; text: string };
  if (members <= 200 && stake <= 1000) {
    feasibility = {
      tone: "green",
      text: `Very reachable — ${usd(members)} people staking $${usd(stake)}.`,
    };
  } else if (members <= 1000 && stake <= 5000) {
    feasibility = {
      tone: "jade",
      text: `Ambitious but real — ${usd(members)} people staking $${usd(stake)}.`,
    };
  } else {
    feasibility = {
      tone: "warning",
      text: `This target needs a big pool. Try a lower monthly target, more members, or a longer runway.`,
    };
  }

  return {
    members,
    stake,
    target,
    pool,
    monthly,
    monthlyLo,
    monthlyHi,
    cycle,
    apyLo,
    apyHi,
    cumLo,
    cumMid,
    cumHi,
    capped,
    perMemberMonthly,
    donorsNeeded,
    milestoneText,
    solvedAtRates,
    feasibility,
  };
}

type Derived = ReturnType<typeof derive>;

const fmtApy = (a: number) =>
  a.toLocaleString("en-US", { maximumFractionDigits: 1 });

/* --------------------------------- Chart ---------------------------------- */

const CHART_W = 340;
const CHART_H = 150;
const PAD = { top: 12, right: 10, bottom: 20, left: 10 };

function ProjectionChart({ d }: { d: Derived }) {
  const n = d.cumMid.length - 1;
  const maxY = Math.max(d.cumHi[n], 1);
  const x = (i: number) =>
    PAD.left + (i / n) * (CHART_W - PAD.left - PAD.right);
  const y = (v: number) =>
    CHART_H - PAD.bottom - (v / maxY) * (CHART_H - PAD.top - PAD.bottom);

  const line = (serie: number[]) =>
    serie.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ");
  const band =
    line(d.cumHi) +
    " " +
    d.cumLo.map((v, i) => `L${x(n - i)},${y(d.cumLo[n - i])}`).join(" ") +
    " Z";

  const midIdx = Math.round(n / 2);
  const horizon = HORIZONS.find((h) => h.months === n)?.label ?? `${n} mo`;

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      className="mt-2 h-auto w-full"
      aria-hidden
    >
      {/* gridlines */}
      {[0.5, 1].map((f) => (
        <g key={f}>
          <line
            x1={PAD.left}
            x2={CHART_W - PAD.right}
            y1={y(maxY * f)}
            y2={y(maxY * f)}
            className="stroke-paper-2"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <text
            x={PAD.left}
            y={y(maxY * f) - 3}
            className="fill-surface-grey"
            fontSize={8.5}
          >
            {approxUsd(maxY * f)}
          </text>
        </g>
      ))}
      {/* band + expected */}
      <path d={band} className="fill-core-orange" opacity={0.14} />
      <path
        d={line(d.cumMid)}
        className="stroke-core-orange"
        strokeWidth={2}
        fill="none"
        strokeLinejoin="round"
      />
      {/* midpoint marker on the expected line */}
      <circle
        cx={x(midIdx)}
        cy={y(d.cumMid[midIdx])}
        r={2.5}
        className="fill-core-orange"
      />
      {/* x-axis labels */}
      <text
        x={PAD.left}
        y={CHART_H - 6}
        className="fill-surface-grey"
        fontSize={8.5}
      >
        now
      </text>
      <text
        x={CHART_W - PAD.right}
        y={CHART_H - 6}
        textAnchor="end"
        className="fill-surface-grey"
        fontSize={8.5}
      >
        {horizon}
      </text>
    </svg>
  );
}

/* ------------------------------ Small pieces ------------------------------ */

function StopSlider({
  label,
  hint,
  stops,
  idx,
  format,
  valueText,
  onChange,
}: {
  label: string;
  hint?: string;
  stops: readonly number[];
  idx: number;
  format: (v: number) => string;
  valueText: (v: number) => string;
  onChange: (idx: number) => void;
}) {
  const v = stops[idx];
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <Caption className="text-surface-grey-2">{label}</Caption>
        <span className="font-breadDisplay text-text-standard text-xl font-bold">
          {format(v)}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={stops.length - 1}
        step={1}
        value={idx}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        aria-valuetext={valueText(v)}
        className="bg-paper-2 accent-core-orange mt-2 h-2 w-full cursor-pointer appearance-none rounded-full"
      />
      {hint && (
        <Caption className="text-surface-grey mt-1 block">{hint}</Caption>
      )}
    </div>
  );
}

function PillButton({
  active,
  onClick,
  children,
  small,
  subtle,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  small?: boolean;
  subtle?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border font-semibold transition-colors",
        small ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
        active
          ? "border-core-orange bg-core-orange/10 text-core-orange"
          : "border-paper-2 text-surface-grey-2 hover:border-core-orange/40 hover:text-text-standard",
        subtle && !active && "opacity-60",
      )}
    >
      {children}
    </button>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div>
      <div className="text-primary-jade flex items-center justify-center gap-1">
        {icon}
      </div>
      <p className="font-breadDisplay text-text-standard mt-1 text-lg font-bold">
        {value}
      </p>
      <Caption className="text-surface-grey-2">{label}</Caption>
    </div>
  );
}

function StoryLine({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-primary-jade mt-0.5 shrink-0">{icon}</span>
      <Body className="text-surface-grey-2 text-sm">{children}</Body>
    </div>
  );
}

function LegendSwatch({
  className,
  label,
}: {
  className: string;
  label: string;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("h-2 w-4 rounded-sm", className)} />
      <Caption className="text-surface-grey">{label}</Caption>
    </span>
  );
}
