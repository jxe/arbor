/** A small least-recently-used cache of immutable values by key. */
export class Recent<T> {
  private readonly values = new Map<string, T>();
  constructor(private readonly limit: number) {}
  get(key: string): T | undefined {
    const value = this.values.get(key);
    if (value !== undefined) { this.values.delete(key); this.values.set(key, value); }
    return value;
  }
  set(key: string, value: T): void {
    this.values.set(key, value);
    for (const oldest of this.values.keys()) {
      if (this.values.size <= this.limit) break;
      this.values.delete(oldest);
    }
  }
}
