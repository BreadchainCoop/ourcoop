import {
  createPublicClient,
  http,
  parseAbi,
  zeroAddress,
  type Address,
} from "viem";
import { sepolia } from "viem/chains";

/**
 * The O.U.R.COOP cooperative instance — a custom-module deployment of the
 * crowdstake stack (contracts/src/examples/cova) live on Ethereum Sepolia.
 * The /coop page reads it through this module; writes go through the
 * connected wallet on the same chain.
 */

export const COOP_CHAIN = sepolia;
export const COOP_CHAIN_ID = sepolia.id;
/**
 * Read RPC for the cooperative's chain (user-provisioned Alchemy endpoint).
 * NEXT_PUBLIC_COOP_RPC_URL overrides at build time (static literal so Next
 * inlines it) — used by the docs GIF pipeline to point at a local fork.
 */
export const COOP_RPC =
  process.env.NEXT_PUBLIC_COOP_RPC_URL ||
  "https://eth-sepolia.g.alchemy.com/v2/Rr57Q41YGfkxYkx0kZp3EOQs86HatGGE";
const COOP_EXPLORER = "https://sepolia.etherscan.io";
/** First block of the deployment — events are scanned from here. */
const DEPLOY_BLOCK = 10875043n;

export const COOP = {
  token: "0x4fFA26B6fBa8B36b4Dd0f7CF1bf57e0FD5d1D02a",
  /** MockUSD — the Sepolia test stablecoin cUSD wraps; open faucet mint. */
  usd: "0x3C0E80004a3699698D2037e728cf33B7D156781D",
  power: "0x73Ae31EfB48F3e0D29e7acdf309783B408D3dB4C",
  registry: "0xDa9B83Ac5c9C10154B3a632C92B13584b3CC4011",
  voting: "0xC4F9956b6Aa252d12F4478919E932e601EbF678F",
  strategy: "0x2DCBC2d7F7B4Fd0F06c52bA781748c49Adc54691",
  distributionManager: "0x6d0504B381A3A04Ff9457A9CB0E64e76EfB0c6bb",
  cycleModule: "0x30524E1A1FCcc8fF613d2f19443A10d878219Ff0",
  withdrawals: "0x74Eff5B39853b2eD4300a4abE7D544304f82d171",
} as const satisfies Record<string, Address>;

export const coopTokenAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function yieldAccrued() view returns (uint256)",
  "function mint(address receiver, uint256 amount)",
  "function burn(uint256 amount, address receiver)",
]);
export const coopUsdAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)",
]);
export const coopPowerAbi = parseAbi([
  "function isMember(address) view returns (bool)",
  "function memberCount() view returns (uint256)",
  "function owner() view returns (address)",
  "function addMember(address member)",
  "function removeMember(address member)",
  "event MemberAdded(address indexed member)",
  "event MemberRemoved(address indexed member)",
]);
export const coopRegistryAbi = parseAbi([
  "function getRecipients() view returns (address[])",
  "function getQueuedAdditions() view returns (address[])",
  "function project(address) view returns ((uint256 fullBudget, uint256 minViableBudget, string title, string summary, bool exists))",
  "function registerProject(address recipient, uint256 fullBudget, uint256 minViableBudget, string title, string summary)",
  "function processQueue()",
  "function owner() view returns (address)",
  "event ProjectRegistered(address indexed project, uint256 fullBudget, uint256 minViableBudget, string title)",
]);
export const coopVotingAbi = parseAbi([
  "function getCurrentVotingDistribution() view returns (uint256[])",
  "function castVote(uint256[] points)",
  "function hasVotedInCycle(uint256 cycle, address voter) view returns (bool)",
  "event BallotRecorded(address indexed voter, uint256 indexed cycle, uint256[] points)",
]);
export const coopCycleAbi = parseAbi([
  "function getCurrentCycle() view returns (uint256)",
  "function isCycleComplete() view returns (bool)",
  "function getBlocksUntilNextCycle() view returns (uint256)",
]);
export const coopDmAbi = parseAbi([
  "function isDistributionReady() view returns (bool)",
  "function claimAndDistribute()",
]);
export const coopStrategyAbi = parseAbi([
  "event ProjectFunded(address indexed project, uint256 amount)",
  "event RoundDistributed(uint256 indexed distributionId, uint256 pool, uint256 distributed)",
]);
export const coopWithdrawalsAbi = parseAbi([
  "function getFunds() view returns (uint256[4])",
  "function withdrawalsCount() view returns (uint256)",
  "function getWithdrawal(uint256 id) view returns ((address proposer, uint8 fund, uint256 amount, address recipient, string purpose, uint8 status, uint256 votesFor, uint256 votesAgainst))",
  "function hasVoted(uint256 id, address member) view returns (bool)",
  "function proposeWithdrawal(uint8 fund, uint256 amount, address recipient, string purpose) returns (uint256)",
  "function voteWithdrawal(uint256 id, bool support)",
  "function closeWithdrawal(uint256 id)",
  "event Movement(string from, string to, uint256 amount, string kind, string note)",
  "event WithdrawalProposed(uint256 indexed id, address indexed proposer, uint8 fund, uint256 amount, address recipient, string purpose)",
  "event WithdrawalVoted(uint256 indexed id, address indexed member, bool support)",
  "event WithdrawalClosed(uint256 indexed id, uint8 status)",
]);

/** Read-only client for the cooperative's chain (independent of the wallet). */
export const coopClient = createPublicClient({
  chain: COOP_CHAIN,
  transport: http(COOP_RPC),
});

export function coopTxUrl(hash: string): string {
  return `${COOP_EXPLORER}/tx/${hash}`;
}
export function coopAddressUrl(address: string): string {
  return `${COOP_EXPLORER}/address/${address}`;
}

/* ------------------------------- Fund model ------------------------------ */

export const FUND_KEYS = [
  "reserve",
  "education",
  "solidarity",
  "production",
  "artFund",
] as const;
export type FundKey = (typeof FUND_KEYS)[number];

/** Display metadata per fund — bar/badge colors sit on the brand palette. */
export const FUNDS: Record<FundKey, { label: string; color: string }> = {
  reserve: { label: "Reserve", color: "#4c42c9" },
  education: { label: "Education", color: "#2e9e5b" },
  solidarity: { label: "Solidarity", color: "#b58a2e" },
  production: { label: "Production", color: "#c2427f" },
  artFund: { label: "Art Fund", color: "#7845dc" },
};

const WITHDRAWAL_STATUS = ["voting", "approved", "rejected"] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUS)[number];

/* --------------------------------- State --------------------------------- */

export interface CoopProject {
  idx: number;
  addr: Address;
  title: string;
  summary: string;
  /** cUSD (1e18-scaled on-chain; plain numbers here — display only). */
  full: number;
  minViable: number;
  points: number;
  funded: number;
}

export interface CoopWithdrawal {
  id: number;
  proposer: Address;
  fund: FundKey;
  amount: number;
  recipient: Address;
  purpose: string;
  status: WithdrawalStatus;
  votesFor: number;
  votesAgainst: number;
  iVoted: boolean;
}

export interface CoopMovement {
  when: string;
  from: string;
  to: string;
  amount: number;
  kind: string;
  note: string;
}

export interface CoopLogEntry {
  when: string;
  actor: string;
  kind: string;
  text: string;
}

export interface CoopQueuedProject {
  addr: Address;
  title: string;
  summary: string;
  full: number;
  minViable: number;
}

export interface CoopState {
  funds: Record<FundKey, number>;
  projects: CoopProject[];
  queuedProjects: CoopQueuedProject[];
  withdrawals: CoopWithdrawal[];
  cycle: number;
  cycleComplete: boolean;
  blocksLeft: number;
  ready: boolean;
  memberCount: number;
  isMember: boolean;
  /** The coordinator (owner of the membership + registry contracts). */
  coordinator: Address;
  /** Current member addresses, replayed from MemberAdded/Removed events. */
  members: Address[];
  artYield: number;
  /** Connected account's balances (0 when browsing without a wallet). */
  myCusd: number;
  myUsd: number;
  usdAllowance: number;
  movements: CoopMovement[];
  log: CoopLogEntry[];
}

const toUsd = (v: bigint): number => Number(v) / 1e18;

/** cUSD display amount → 1e18-scaled bigint (µ-precision, avoids FP drift). */
export function toCoopWei(amount: number): bigint {
  return BigInt(Math.round(amount * 1e6)) * 10n ** 12n;
}

function shortAddr(a: string): string {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—";
}

/**
 * The full read-set the /coop page renders — mirrors what the on-chain
 * system exposes (funds, projects + current ballot tallies, withdrawals,
 * cycle/readiness, membership) plus an event-derived activity feed.
 */
export async function fetchCoopState(account?: Address): Promise<CoopState> {
  const who = account ?? zeroAddress;
  const [
    funds4,
    projAddrs,
    points,
    cycle,
    cycleComplete,
    blocksLeft,
    ready,
    memberCount,
    isMember,
    artEscrow,
    artYield,
    withdrawalsCount,
    queuedAddrs,
    coordinator,
    myCusdRaw,
    myUsdRaw,
    usdAllowanceRaw,
  ] = await Promise.all([
    coopClient.readContract({
      address: COOP.withdrawals,
      abi: coopWithdrawalsAbi,
      functionName: "getFunds",
    }),
    coopClient.readContract({
      address: COOP.registry,
      abi: coopRegistryAbi,
      functionName: "getRecipients",
    }),
    coopClient.readContract({
      address: COOP.voting,
      abi: coopVotingAbi,
      functionName: "getCurrentVotingDistribution",
    }),
    coopClient.readContract({
      address: COOP.cycleModule,
      abi: coopCycleAbi,
      functionName: "getCurrentCycle",
    }),
    coopClient.readContract({
      address: COOP.cycleModule,
      abi: coopCycleAbi,
      functionName: "isCycleComplete",
    }),
    coopClient.readContract({
      address: COOP.cycleModule,
      abi: coopCycleAbi,
      functionName: "getBlocksUntilNextCycle",
    }),
    coopClient.readContract({
      address: COOP.distributionManager,
      abi: coopDmAbi,
      functionName: "isDistributionReady",
    }),
    coopClient.readContract({
      address: COOP.power,
      abi: coopPowerAbi,
      functionName: "memberCount",
    }),
    coopClient.readContract({
      address: COOP.power,
      abi: coopPowerAbi,
      functionName: "isMember",
      args: [who],
    }),
    coopClient.readContract({
      address: COOP.token,
      abi: coopTokenAbi,
      functionName: "balanceOf",
      args: [COOP.strategy],
    }),
    coopClient.readContract({
      address: COOP.token,
      abi: coopTokenAbi,
      functionName: "yieldAccrued",
    }),
    coopClient.readContract({
      address: COOP.withdrawals,
      abi: coopWithdrawalsAbi,
      functionName: "withdrawalsCount",
    }),
    coopClient.readContract({
      address: COOP.registry,
      abi: coopRegistryAbi,
      functionName: "getQueuedAdditions",
    }),
    coopClient.readContract({
      address: COOP.power,
      abi: coopPowerAbi,
      functionName: "owner",
    }),
    coopClient.readContract({
      address: COOP.token,
      abi: coopTokenAbi,
      functionName: "balanceOf",
      args: [who],
    }),
    coopClient.readContract({
      address: COOP.usd,
      abi: coopUsdAbi,
      functionName: "balanceOf",
      args: [who],
    }),
    coopClient.readContract({
      address: COOP.usd,
      abi: coopUsdAbi,
      functionName: "allowance",
      args: [who, COOP.token],
    }),
  ]);

  const funds: Record<FundKey, number> = {
    reserve: toUsd(funds4[0]),
    education: toUsd(funds4[1]),
    solidarity: toUsd(funds4[2]),
    production: toUsd(funds4[3]),
    artFund: toUsd(artEscrow) + toUsd(artYield),
  };

  const projects: CoopProject[] = await Promise.all(
    projAddrs.map(async (addr, idx) => {
      const [p, bal] = await Promise.all([
        coopClient.readContract({
          address: COOP.registry,
          abi: coopRegistryAbi,
          functionName: "project",
          args: [addr],
        }),
        coopClient.readContract({
          address: COOP.token,
          abi: coopTokenAbi,
          functionName: "balanceOf",
          args: [addr],
        }),
      ]);
      return {
        idx,
        addr,
        title: p.title,
        summary: p.summary,
        full: toUsd(p.fullBudget),
        minViable: toUsd(p.minViableBudget),
        points: idx < points.length ? Number(points[idx]) : 0,
        funded: toUsd(bal),
      };
    }),
  );

  const withdrawals: CoopWithdrawal[] = await Promise.all(
    Array.from({ length: Number(withdrawalsCount) }, async (_, id) => {
      const [w, iVoted] = await Promise.all([
        coopClient.readContract({
          address: COOP.withdrawals,
          abi: coopWithdrawalsAbi,
          functionName: "getWithdrawal",
          args: [BigInt(id)],
        }),
        coopClient.readContract({
          address: COOP.withdrawals,
          abi: coopWithdrawalsAbi,
          functionName: "hasVoted",
          args: [BigInt(id), who],
        }),
      ]);
      return {
        id,
        proposer: w.proposer,
        fund: FUND_KEYS[Number(w.fund)] ?? "reserve",
        amount: toUsd(w.amount),
        recipient: w.recipient,
        purpose: w.purpose,
        status: WITHDRAWAL_STATUS[Number(w.status)] ?? "voting",
        votesFor: Number(w.votesFor),
        votesAgainst: Number(w.votesAgainst),
        iVoted,
      };
    }),
  );

  const queuedProjects: CoopQueuedProject[] = await Promise.all(
    queuedAddrs.map(async (addr) => {
      const p = await coopClient.readContract({
        address: COOP.registry,
        abi: coopRegistryAbi,
        functionName: "project",
        args: [addr],
      });
      return {
        addr,
        title: p.title,
        summary: p.summary,
        full: toUsd(p.fullBudget),
        minViable: toUsd(p.minViableBudget),
      };
    }),
  );

  const { movements, log, members } = await fetchActivity(projects);

  return {
    funds,
    projects,
    queuedProjects,
    withdrawals,
    cycle: Number(cycle),
    cycleComplete,
    blocksLeft: Number(blocksLeft),
    ready,
    memberCount: Number(memberCount),
    isMember,
    coordinator,
    members,
    artYield: toUsd(artYield),
    myCusd: toUsd(myCusdRaw),
    myUsd: toUsd(myUsdRaw),
    usdAllowance: toUsd(usdAllowanceRaw),
    movements,
    log,
  };
}

/** Event-derived movements + governance log (newest first). */
async function fetchActivity(projects: CoopProject[]): Promise<{
  movements: CoopMovement[];
  log: CoopLogEntry[];
  members: Address[];
}> {
  const [evW, evS, evV, evR, evP] = await Promise.all([
    coopClient
      .getLogs({
        address: COOP.withdrawals,
        events: coopWithdrawalsAbi.filter((f) => f.type === "event"),
        fromBlock: DEPLOY_BLOCK,
        toBlock: "latest",
      })
      .catch(() => []),
    coopClient
      .getLogs({
        address: COOP.strategy,
        events: coopStrategyAbi.filter((f) => f.type === "event"),
        fromBlock: DEPLOY_BLOCK,
        toBlock: "latest",
      })
      .catch(() => []),
    coopClient
      .getLogs({
        address: COOP.voting,
        events: coopVotingAbi.filter((f) => f.type === "event"),
        fromBlock: DEPLOY_BLOCK,
        toBlock: "latest",
      })
      .catch(() => []),
    coopClient
      .getLogs({
        address: COOP.registry,
        events: coopRegistryAbi.filter((f) => f.type === "event"),
        fromBlock: DEPLOY_BLOCK,
        toBlock: "latest",
      })
      .catch(() => []),
    coopClient
      .getLogs({
        address: COOP.power,
        events: coopPowerAbi.filter((f) => f.type === "event"),
        fromBlock: DEPLOY_BLOCK,
        toBlock: "latest",
      })
      .catch(() => []),
  ]);

  const all = [...evW, ...evS, ...evV, ...evR, ...evP];

  // Timestamp lookup, one getBlock per distinct block.
  const blockNumbers = [...new Set(all.map((l) => l.blockNumber))];
  const stamps = new Map<bigint, number>();
  await Promise.all(
    blockNumbers.map(async (bn) => {
      try {
        const b = await coopClient.getBlock({ blockNumber: bn });
        stamps.set(bn, Number(b.timestamp));
      } catch {
        stamps.set(bn, 0);
      }
    }),
  );
  const when = (bn: bigint) => {
    const t = stamps.get(bn);
    return t
      ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")
      : `#${bn}`;
  };
  const projectTitle = (a: string) =>
    projects.find((p) => p.addr.toLowerCase() === a.toLowerCase())?.title ??
    shortAddr(a);
  const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

  all.sort((a, b) =>
    a.blockNumber === b.blockNumber
      ? a.logIndex - b.logIndex
      : Number(a.blockNumber - b.blockNumber),
  );

  const movements: CoopMovement[] = [];
  const log: CoopLogEntry[] = [];
  const memberSet = new Set<Address>();
  for (const l of all) {
    const ev = l as unknown as {
      eventName: string;
      args: Record<string, unknown>;
    };
    const args = ev.args;
    const w = when(l.blockNumber);
    switch (ev.eventName) {
      case "Movement":
        movements.push({
          when: w,
          from: String(args.from),
          to: String(args.to),
          amount: toUsd(args.amount as bigint),
          kind: String(args.kind),
          note: String(args.note ?? ""),
        });
        break;
      case "ProjectFunded": {
        const title = projectTitle(String(args.project));
        const amount = toUsd(args.amount as bigint);
        movements.push({
          when: w,
          from: "artFund",
          to: "recipient",
          amount,
          kind: "project_funding",
          note: title,
        });
        log.push({
          when: w,
          actor: "strategy",
          kind: "funded",
          text: `Funded ${title} with ${usd(amount)}`,
        });
        break;
      }
      case "RoundDistributed":
        log.push({
          when: w,
          actor: "manager",
          kind: "round",
          text: `Round #${args.distributionId} distributed ${usd(toUsd(args.distributed as bigint))} of ${usd(toUsd(args.pool as bigint))} pool`,
        });
        break;
      case "ProjectRegistered":
        log.push({
          when: w,
          actor: "coordinator",
          kind: "proposal",
          text: `Registered "${args.title}" (full ${usd(toUsd(args.fullBudget as bigint))}, min ${usd(toUsd(args.minViableBudget as bigint))})`,
        });
        break;
      case "BallotRecorded":
        log.push({
          when: w,
          actor: shortAddr(String(args.voter)),
          kind: "vote",
          text: `Cast 100-point ballot in cycle ${args.cycle}`,
        });
        break;
      case "WithdrawalProposed":
        log.push({
          when: w,
          actor: shortAddr(String(args.proposer)),
          kind: "withdrawal_proposed",
          text: `Proposed ${usd(toUsd(args.amount as bigint))} from ${FUNDS[FUND_KEYS[Number(args.fund)] ?? "reserve"].label} — ${args.purpose}`,
        });
        break;
      case "WithdrawalVoted":
        log.push({
          when: w,
          actor: shortAddr(String(args.member)),
          kind: "withdrawal_vote",
          text: `Voted ${args.support ? "for" : "against"} withdrawal #${args.id}`,
        });
        break;
      case "WithdrawalClosed":
        log.push({
          when: w,
          actor: "system",
          kind: "withdrawal_closed",
          text: `Withdrawal #${args.id} ${WITHDRAWAL_STATUS[Number(args.status)] ?? "closed"}`,
        });
        break;
      case "MemberAdded":
        memberSet.add(String(args.member).toLowerCase() as Address);
        log.push({
          when: w,
          actor: "coordinator",
          kind: "member_added",
          text: `Added member ${shortAddr(String(args.member))}`,
        });
        break;
      case "MemberRemoved":
        memberSet.delete(String(args.member).toLowerCase() as Address);
        log.push({
          when: w,
          actor: "coordinator",
          kind: "member_removed",
          text: `Removed member ${shortAddr(String(args.member))}`,
        });
        break;
    }
  }
  movements.reverse();
  log.reverse();
  return { movements, log, members: [...memberSet] };
}
