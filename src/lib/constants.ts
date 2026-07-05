/** Treat empty-string env vars (e.g. an unset CI repo var) as absent. */
const envOr = (value: string | undefined, fallback: string): string =>
  value && value.length > 0 ? value : fallback;

/** WalletConnect project id (override via env for production). */
export const WALLETCONNECT_PROJECT_ID = envOr(
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID,
  "crowdstake_demo",
);

/**
 * Privy app id. When set, the app uses Privy embedded wallets + native
 * ("App pays", EIP-7702) gas sponsorship, so cross-chain governance actions are
 * submitted gaslessly from the browser — no relay server. Empty = fall back to
 * a plain wagmi/injected wallet (local dev + e2e), self-paid gas.
 *
 * NOTE: static literal — Next only inlines `process.env.NEXT_PUBLIC_X` literals
 * into the client bundle (see chains.ts).
 */
export const PRIVY_APP_ID = envOr(process.env.NEXT_PUBLIC_PRIVY_APP_ID, "");
export const PRIVY_CLIENT_ID = envOr(
  process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID,
  "",
);

/** Whether Privy (embedded wallets + gas sponsorship) is configured. */
export function privyConfigured(): boolean {
  return PRIVY_APP_ID.length > 0;
}

/** Optional ipfs:// gateway for resolving off-chain instance images. */
export const IPFS_GATEWAY = envOr(
  process.env.NEXT_PUBLIC_IPFS_GATEWAY,
  "https://ipfs.io/ipfs/",
);

/**
 * Fallback token symbol/decimals. The app reads the real symbol per instance
 * via `useInstanceToken`; these only seed labels before that resolves.
 */
export const TOKEN_SYMBOL = "CSTAKE";
export const TOKEN_DECIMALS = 18;

/** Voting is basis-points based; max per recipient. */
export const MAX_POINTS = 10_000n;
