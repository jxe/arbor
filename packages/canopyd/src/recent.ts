/**
 * A small least-recently-used cache of immutable values by key: at most
 * `limit` entries and, when `weight` is given, at most `maxWeight` in total.
 */
export class Recent<T> {
  private readonly values = new Map<string, T>();
  private total = 0;
  constructor(
    private readonly limit: number,
    private readonly bound: { weight: (value: T) => number; maxWeight: number } | null = null,
  ) {}
  get(key: string): T | undefined {
    const value = this.values.get(key);
    if (value !== undefined) { this.values.delete(key); this.values.set(key, value); }
    return value;
  }
  set(key: string, value: T): void {
    this.delete(key);
    this.values.set(key, value);
    this.total += this.bound?.weight(value) ?? 0;
    for (const oldest of this.values.keys()) {
      if (this.values.size <= this.limit && (!this.bound || this.total <= this.bound.maxWeight)) break;
      this.delete(oldest);
    }
  }
  private delete(key: string): void {
    const value = this.values.get(key);
    if (value === undefined) return;
    this.values.delete(key);
    this.total -= this.bound?.weight(value) ?? 0;
  }
}
