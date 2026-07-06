import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { isAddress, type Address } from "viem";
import { log, warn } from "./log.js";

const addressSchema = z.string().refine((v) => isAddress(v), "not an address");

const chainSchema = z.object({
  chainId: z.number().int().positive(),
  name: z.string().min(1),
  rpcUrl: z.string().url(),
  deployer: addressSchema.nullable(),
  confirmations: z.number().int().nonnegative(),
  maxLogRange: z.number().int().positive().default(2000),
  dailyGasBudgetWei: z.string().regex(/^\d+$/).default("1000000000000000000"),
});

const fileSchema = z.object({
  note: z.string().optional(),
  port: z.number().int().positive().default(8787),
  dbPath: z.string().default("relay.db"),
  familyCacheTtlMs: z.number().int().positive().default(600_000),
  rateLimit: z
    .object({
      capacity: z.number().int().positive().default(30),
      refillPerMinute: z.number().positive().default(60),
    })
    .default({}),
  chains: z.array(chainSchema).min(1),
});

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  deployer: Address;
  confirmations: number;
  maxLogRange: number;
  dailyGasBudgetWei: bigint;
}

export interface RelayConfig {
  port: number;
  dbPath: string;
  familyCacheTtlMs: number;
  rateLimit: { capacity: number; refillPerMinute: number };
  /** Enabled chains only — chains without a deployer are excluded (fail closed). */
  chains: ChainConfig[];
}

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = join(here, "..", "relay.config.json");

/**
 * Committed relay.config.json → env overrides (RELAY_RPC_URL_<id>,
 * RELAY_DEPLOYER_<id>, RELAY_PORT, RELAY_DB_PATH). A chain whose deployer
 * resolves to null/empty is DISABLED and loudly logged — never guessed from
 * a mutable remote manifest.
 */
export function loadConfig(
  configPath: string = DEFAULT_CONFIG_PATH,
  env: NodeJS.ProcessEnv = process.env,
): RelayConfig {
  const raw: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  const parsed = fileSchema.parse(raw);

  const chains: ChainConfig[] = [];
  for (const chain of parsed.chains) {
    const rpcUrl =
      nonEmpty(env[`RELAY_RPC_URL_${chain.chainId}`]) ?? chain.rpcUrl;
    const deployerOverride = nonEmpty(env[`RELAY_DEPLOYER_${chain.chainId}`]);
    if (deployerOverride && !isAddress(deployerOverride)) {
      throw new Error(
        `RELAY_DEPLOYER_${chain.chainId} is not a valid address: ${deployerOverride}`,
      );
    }
    const deployer = (deployerOverride ?? chain.deployer) as Address | null;
    if (!deployer) {
      warn(
        "config",
        `chain ${chain.name} (${chain.chainId}) DISABLED: no deployer pinned ` +
          `(set RELAY_DEPLOYER_${chain.chainId} or relay.config.json)`,
      );
      continue;
    }
    chains.push({
      chainId: chain.chainId,
      name: chain.name,
      rpcUrl,
      deployer,
      confirmations: chain.confirmations,
      maxLogRange: chain.maxLogRange,
      dailyGasBudgetWei: BigInt(chain.dailyGasBudgetWei),
    });
    log("config", `chain ${chain.name} (${chain.chainId}) enabled`, {
      rpcUrl,
      deployer,
    });
  }
  if (chains.length === 0) {
    throw new Error("no chains enabled — refusing to start (fail closed)");
  }

  const port = nonEmpty(env.RELAY_PORT);
  const dbPath = nonEmpty(env.RELAY_DB_PATH) ?? parsed.dbPath;
  return {
    port: port ? Number(port) : parsed.port,
    // A relative dbPath is anchored to the package root, not the cwd.
    dbPath: dbPath === ":memory:" ? dbPath : resolve(here, "..", dbPath),
    familyCacheTtlMs: parsed.familyCacheTtlMs,
    rateLimit: parsed.rateLimit,
    chains,
  };
}

function nonEmpty(v: string | undefined): string | undefined {
  return v && v.length > 0 ? v : undefined;
}
