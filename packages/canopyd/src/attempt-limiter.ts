/** A sliding-window attempt limit per key. Keys carry caller-supplied text, so
 * memory is bounded: a key moves to the end of the map on each attempt, which
 * keeps the least recently used first; expired keys are dropped from the front
 * and the oldest key is evicted past `maxKeys`. Eviction can only forget a
 * limit a spoofed address could already escape. */
export class AttemptLimiter {
  private readonly attempts = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}
  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [oldest, times] of this.attempts) {
      if (times.at(-1)! > cutoff && this.attempts.size < this.maxKeys) break;
      this.attempts.delete(oldest);
    }
    const recent = (this.attempts.get(key) ?? []).filter((attempt) => attempt > cutoff);
    this.attempts.delete(key);
    const allowed = recent.length < this.limit;
    if (allowed) recent.push(now);
    if (recent.length) this.attempts.set(key, recent);
    return allowed;
  }
}
