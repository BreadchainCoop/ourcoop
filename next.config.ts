import type { NextConfig } from "next";

// Optional base path for project-subpath hosting (e.g. GitHub Pages at
// /crowdstake.fun). Empty for a root domain (Netlify / custom domain / IPFS).
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  // Pure static export — no server runtime. The dapp talks to Gnosis directly
  // from the browser, so it can be hosted on any static host or IPFS.
  output: "export",
  trailingSlash: true, // each route → directory/index.html (portable on any static host)
  images: { unoptimized: true },
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  webpack: (config) => {
    // Silence optional-dep resolution warnings from the wallet/web3 tree.
    // Privy pulls optional Solana / Farcaster / Stripe integrations we don't
    // use; stub them so the static export builds.
    config.resolve.fallback = {
      ...config.resolve.fallback,
      "pino-pretty": false,
      "@react-native-async-storage/async-storage": false,
      "@stripe/crypto": false,
      "@stripe/stripe-js": false,
      "@farcaster/mini-app-solana": false,
    };
    return config;
  },
};

export default nextConfig;
