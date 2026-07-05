import type { Store } from "./store.js";

/** UTC day key, e.g. "2026-07-04". */
export function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Per-chain daily gas budget circuit breaker. Spend is reserved at send time
 * from the fee-cap estimate (gas * maxFeePerGas) — conservative, durable.
 */
export class GasBudget {
  constructor(
    private store: Store,
    private budgets: Map<number, bigint>,
  ) {}

  /** Reserve `wei` against today's budget; false = breaker open. */
  tryReserve(chainId: number, wei: bigint, now = Date.now()): boolean {
    const budget = this.budgets.get(chainId);
    if (budget === undefined) return true;
    const day = dayKey(now);
    if (this.store.gasSpend(chainId, day) + wei > budget) return false;
    this.store.addGasSpend(chainId, day, wei);
    return true;
  }

  /**
   * Give back a prior reservation (clamped at zero) — used when a send fails
   * before it could spend gas, or to reconcile the conservative fee-cap
   * reservation down to the actual receipt cost. Without this, failed sends
   * leave phantom spend that eventually trips the breaker for the whole day.
   */
  release(chainId: number, wei: bigint, now = Date.now()): void {
    if (wei <= 0n) return;
    if (this.budgets.get(chainId) === undefined) return;
    const day = dayKey(now);
    const spent = this.store.gasSpend(chainId, day);
    const refund = wei > spent ? spent : wei;
    if (refund > 0n) this.store.addGasSpend(chainId, day, -refund);
  }
}
