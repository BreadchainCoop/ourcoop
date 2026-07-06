import { http, createConfig as createWagmiConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { createConfig as createPrivyConfig } from "@privy-io/wagmi";
import { CHAINS, SUPPORTED_CHAINS } from "@/lib/chains";

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
const transports = Object.fromEntries(
  SUPPORTED_CHAINS.map((c) => [c.id, http(CHAINS[c.id].rpcUrl)]),
);

/** Privy-aware config (used only inside a PrivyProvider). */
export const privyWagmiConfig = createPrivyConfig({
  chains: SUPPORTED_CHAINS,
  transports,
});

/** Plain wagmi config for the no-Privy fallback (injected wallet). */
export const fallbackWagmiConfig = createWagmiConfig({
  chains: SUPPORTED_CHAINS,
  connectors: [injected()],
  transports,
  ssr: true,
});
