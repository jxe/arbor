import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request phase accounting for update acceptance. Phases are wall-clock
 * milliseconds between consecutive marks; `add` records nested work (merge
 * worker phases) that also falls inside an enclosing phase. No request
 * content, subjects, or object identities are ever recorded here.
 */
export class PhaseTimer {
  readonly started = performance.now();
  private last = this.started;
  private readonly phases = new Map<string, number>();
  readonly counts = new Map<string, number>();

  /** Attribute the time since the previous mark (or start) to `phase`. */
  mark(phase: string): void {
    const now = performance.now();
    this.add(phase, now - this.last);
    this.last = now;
  }

  add(phase: string, milliseconds: number): void {
    this.phases.set(phase, (this.phases.get(phase) ?? 0) + milliseconds);
  }

  count(name: string, value: number): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + value);
  }

  total(): number {
    return performance.now() - this.started;
  }

  /** Rounded phase durations plus counters, for one structured log line. */
  summary(): Record<string, number> {
    const out: Record<string, number> = { total: round(this.total()) };
    for (const [phase, ms] of this.phases) out[phase] = round(ms);
    for (const [name, value] of this.counts) out[name] = value;
    return out;
  }

  /** `Server-Timing` header value; nested worker phases are included. */
  serverTiming(): string {
    const parts = [`total;dur=${round(this.total())}`];
    for (const [phase, ms] of this.phases) parts.push(`${phase.replace(/[^a-z0-9_-]/gi, "_")};dur=${round(ms)}`);
    return parts.join(", ");
  }
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

const storage = new AsyncLocalStorage<PhaseTimer>();

/** Run `work` with `timer` as the current request's timer. */
export function withPhaseTimer<T>(timer: PhaseTimer, work: () => Promise<T>): Promise<T> {
  return storage.run(timer, work);
}

/** The current request's timer, if one is active. */
export function phaseTimer(): PhaseTimer | undefined {
  return storage.getStore();
}

/** Mark a phase on the current request's timer, if any. */
export function markPhase(phase: string): void {
  storage.getStore()?.mark(phase);
}
