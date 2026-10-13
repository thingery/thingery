// Minimal in-memory token bucket, keyed by API key or IP.
// Scaffold-grade: fine for a single instance; swap for Redis when federating.

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if the request is allowed. */
  allow(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.max, lastRefill: now };

    const elapsed = now - bucket.lastRefill;
    const refill = (elapsed / this.windowMs) * this.max;
    bucket.tokens = Math.min(this.max, bucket.tokens + refill);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }

  /** Clears all buckets (test isolation). */
  reset(): void {
    this.buckets.clear();
  }
}
