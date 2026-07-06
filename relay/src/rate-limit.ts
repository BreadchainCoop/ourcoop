/**
 * Light per-IP token bucket. In-memory by design (documented limitation:
 * resets on restart, per-process only — front with a real limiter if you run
 * multiple replicas).
 */
export class TokenBucket {
  private buckets = new Map<string, { tokens: number; last: number }>();

  constructor(
    private capacity: number,
    private refillPerMinute: number,
    private now: () => number = Date.now,
  ) {}

  /** Take one token for `key`; false = rate limited. */
  take(key: string): boolean {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, last: now };
      this.buckets.set(key, bucket);
    }
    const refill = ((now - bucket.last) / 60_000) * this.refillPerMinute;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + refill);
    bucket.last = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    // Opportunistic sweep so the map can't grow unbounded.
    if (this.buckets.size > 10_000) {
      for (const [k, b] of this.buckets) {
        if (now - b.last > 10 * 60_000) this.buckets.delete(k);
      }
    }
    return true;
  }
}
