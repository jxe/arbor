/** A sidecar for measurement whose evaluations have no time budget: replay
 * on a shared cloud machine can take longer than a live question may (on the
 * 2026-10-28 copy, todos entries 6657 and 6658 replay in 23 s and 30 s,
 * against a 20 s budget). Only the budget changes; answers do not. */
export function unbudgeted<T>(sidecar: T): T {
  const s = sidecar as unknown as { rules(q: unknown): { config?: Record<string, unknown> } };
  const rules = s.rules.bind(s);
  s.rules = (q) => { const r = rules(q); return { ...r, config: { ...(r.config ?? {}), maxMillis: 3_600_000 } }; };
  return sidecar;
}
export const DEFAULT_RULES = { id: "tree-default", revision: 1, config: { contentChoices: "source", conflictProjection: "current", maxMillis: 3_600_000 } };
