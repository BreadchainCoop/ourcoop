import type { Address, Hex } from "viem";
import type { ChainAccess } from "./chain-access.js";
import { errorMessage, warn } from "./log.js";
import type { FamilyInstance, Store } from "./store.js";

export type SiblingResolution =
  | { status: "found"; instance: FamilyInstance }
  | { status: "none" }
  | { status: "unreachable"; error: string };

export interface FamilyChainDeps {
  chainId: number;
  name: string;
  deployer: Address;
  access: Pick<ChainAccess, "familyInstances">;
}

/**
 * Sibling resolution (spec B.5): one familyInstances eth_call per chain's
 * PINNED deployer, cached in SQLite with TTL. Absence ('none') is cached with
 * the same TTL — never permanently (the creator can expand later) — and is
 * invalidated eagerly on listener-seen FamilyDeployed. 'unreachable' is never
 * cached.
 */
export class Families {
  private chains: Map<number, FamilyChainDeps>;

  constructor(
    private store: Store,
    chains: FamilyChainDeps[],
    private ttlMs: number,
  ) {
    this.chains = new Map(chains.map((c) => [c.chainId, c]));
  }

  chainIds(): number[] {
    return [...this.chains.keys()];
  }

  async resolveChain(
    familyId: Hex,
    chainId: number,
    opts: { force?: boolean } = {},
  ): Promise<SiblingResolution> {
    const chain = this.chains.get(chainId);
    if (!chain) return { status: "none" };
    if (!opts.force) {
      const cached = this.store.getFamilyChain(familyId, chainId);
      if (cached && Date.now() - cached.resolvedAt < this.ttlMs) {
        return cached.instance
          ? { status: "found", instance: cached.instance }
          : { status: "none" };
      }
    }
    try {
      const instance = await chain.access.familyInstances(
        chain.deployer,
        familyId,
      );
      this.store.setFamilyChain(familyId, chainId, instance);
      return instance ? { status: "found", instance } : { status: "none" };
    } catch (e) {
      const error = errorMessage(e);
      warn("families", `resolve ${familyId} on ${chain.name} unreachable`, {
        error,
      });
      // Serve a stale cache entry over nothing.
      const cached = this.store.getFamilyChain(familyId, chainId);
      if (cached) {
        return cached.instance
          ? { status: "found", instance: cached.instance }
          : { status: "none" };
      }
      return { status: "unreachable", error };
    }
  }

  /** All configured chains in parallel. Unreachable chains are reported, never dropped. */
  async resolve(
    familyId: Hex,
    opts: { force?: boolean } = {},
  ): Promise<Map<number, SiblingResolution>> {
    const entries = await Promise.all(
      [...this.chains.keys()].map(
        async (chainId) =>
          [chainId, await this.resolveChain(familyId, chainId, opts)] as const,
      ),
    );
    return new Map(entries);
  }

  invalidate(familyId: Hex, chainId?: number): void {
    this.store.invalidateFamily(familyId, chainId);
  }

  /** The voting module for a family on one chain, or null. */
  async votingModule(familyId: Hex, chainId: number): Promise<Address | null> {
    const res = await this.resolveChain(familyId, chainId);
    return res.status === "found" ? res.instance.votingModule : null;
  }

  /** The full resolved instance for a family on one chain, or null. The worker
   *  derives the per-kind target (votingModule vs registry) from it. */
  async instance(
    familyId: Hex,
    chainId: number,
  ): Promise<FamilyInstance | null> {
    const res = await this.resolveChain(familyId, chainId);
    return res.status === "found" ? res.instance : null;
  }
}
