/**
 * Local account-nonce manager, one per chain. Initialized lazily from
 * getTransactionCount('pending'), then incremented locally so concurrent
 * submits never race the relay key's nonce. reset() forces a refetch after
 * a gap/error.
 */
export class NonceManager {
  private next: number | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private fetchPendingCount: () => Promise<number>) {}

  /** Serialized: every caller gets a unique, increasing nonce. */
  allocate(): Promise<number> {
    const p = this.chain.then(async () => {
      if (this.next === null) this.next = await this.fetchPendingCount();
      return this.next++;
    });
    // Keep the chain alive even when an allocation fails.
    this.chain = p.catch(() => {});
    return p;
  }

  /** Drop local state; the next allocate() refetches from the chain. */
  reset(): void {
    this.chain = this.chain.then(() => {
      this.next = null;
    });
  }
}
