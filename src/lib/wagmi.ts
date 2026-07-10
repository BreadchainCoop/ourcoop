import { http, createConfig as createWagmiConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { createConfig as createPrivyConfig } from "@privy-io/wagmi";
import { CHAINS, SUPPORTED_CHAINS } from "@/lib/chains";
import { COOP_CHAIN, COOP_RPC } from "@/lib/coop";

/**
 * wagmi config across every supported chain (Gnosis + Arbitrum, Optimism,
 * Ethereum).
 *
 * When Privy is configured, we use `@privy-io/wagmi`'s `createConfig` so Privy
 * embedded + external wallets flow through every wagmi hook (useAccount,
 * useReadContract, useWriteContract, …). Its connectors REQUIRE a PrivyProvider
 * ancestor, so when Privy is NOT configured (local dev, e2e) we fall back to a
 * plain wagmi config with an `injected()` connector.
 */
// The cooperative's chain (Sepolia) rides along for /coop writes only — it is
// NOT in the CHAINS registry, so the protocol dapp's UI ignores it entirely.
const chains = [...SUPPORTED_CHAINS, COOP_CHAIN] as const;
const transports = {
  ...Object.fromEntries(
    SUPPORTED_CHAINS.map((c) => [c.id, http(CHAINS[c.id].rpcUrl)]),
  ),
  [COOP_CHAIN.id]: http(COOP_RPC),
};

/** Privy-aware config (used only inside a PrivyProvider). */
export const privyWagmiConfig = createPrivyConfig({
  chains,
  transports,
});

/** Plain wagmi config for the no-Privy fallback (injected wallet). */
export const fallbackWagmiConfig = createWagmiConfig({
  chains,
  connectors: [injected()],
  transports,
  ssr: true,
});
