import { decodeWireDirectory, encodeWireDirectory, hashObject, type ObjectHash, type CandidateUpdate, type WireDirectoryEntry } from "@arbor/wire";
import type { ConflictState, EntryAlternative, EntryValue } from "./conflict-store.ts";

const same = (a: EntryValue, b: EntryValue) => JSON.stringify(a) === JSON.stringify(b);
export function entryValue(entry?: WireDirectoryEntry): EntryValue {
  return entry?.file ? { file: entry.file } : entry?.directory ? { directory: entry.directory } : entry?.tree ? { tree: entry.tree } : { absent: true };
}
function entry(name: string, value: EntryValue): WireDirectoryEntry | null {
  return "absent" in value ? null : { name, ...value };
}
function alternative(value: EntryValue, contributions: EntryAlternative["contributions"]): EntryAlternative {
  return { id: crypto.randomUUID(), revision: crypto.randomUUID(), value, contributions };
}

/** Root-entry attribution for continued editing. Hidden values are never inferred
 * from the projected graph or cleared by byte equality. Roots remain valid ordinary trees.
 */
export async function reconcileEntryAmbiguity(input: {
  base: ObjectHash; current: ObjectHash; currentID: string; request: CandidateUpdate;
  baseState: ConflictState | null; currentState: ConflictState | null;
  origins?: Map<string, EntryAlternative["contributions"]>;
  explicitNames?: Set<string>;
}, load: (hash: ObjectHash) => Promise<Uint8Array>) {
  const { request } = input;
  const [base, current, candidate] = await Promise.all(([input.base, input.current, request.candidate] as const).map(async root => decodeWireDirectory(await load(root))));
  if (!base || !current || !candidate) throw new Error("Missing conflict basis");
  const state: ConflictState = { decisions: structuredClone(input.currentState?.decisions ?? []), resolutions: [] };
  const guards = new Set<string>();
  for (const resolution of request.resolves) {
    const decision = state.decisions.find(d => d.id === resolution.conflict);
    if (resolution.state !== input.currentID || !decision ||
        JSON.stringify([...resolution.alternatives].sort()) !== JSON.stringify(decision.alternatives.map(a => a.id).sort())) return null;
    guards.add(decision.id); state.resolutions.push(resolution);
  }
  // Root metadata is outside this entry-attribution subset.
  const metadata = ({ entries: _entries, ...rest }: NonNullable<typeof base>) => JSON.stringify(rest);
  if (metadata(base) !== metadata(current) || metadata(base) !== metadata(candidate)) return null;
  const names = new Set([...base.entries, ...current.entries, ...candidate.entries].map(e => e.name));
  for (const d of state.decisions) names.add(d.name);
  const output: WireDirectoryEntry[] = [];
  for (const name of names) {
    const before = entryValue(base.entries.find(e => e.name === name));
    const remote = entryValue(current.entries.find(e => e.name === name));
    const authored = entryValue(candidate.entries.find(e => e.name === name));
    const prior = input.baseState?.decisions.find(d => d.name === name);
    let decision = state.decisions.find(d => d.name === name);
    const changed = !same(before, authored) || input.explicitNames?.has(name);
    const contributions = request.operations === null ? [{ change: request.change, operation: null }] : request.operations
      .filter(op => op.kind === "editSource" && op.source.material.kind === "basis" &&
        (op.source.material.path === `/${name}` || op.source.material.path.startsWith(`/${name}/`) || op.source.within?.[0] === name))
      .map(op => ({ change: request.change, operation: op.key }));
    let value = remote;
    if (decision) {
      const selected = decision.alternatives.find(a => a.id === decision!.selected)!;
      if (!same(selected.value, remote)) throw new Error("Stored conflict projection does not match accepted entry");
      if (changed) {
        const basisAlternative = prior?.alternatives.find(a => a.id === prior.selected);
        const attributable = basisAlternative && decision.alternatives.find(a => a.id === basisAlternative.id && a.revision === basisAlternative.revision);
        if (attributable) {
          attributable.value = authored; attributable.revision = crypto.randomUUID();
          attributable.contributions = [...attributable.contributions, ...contributions];
        } else decision.alternatives.push(alternative(authored, contributions));
      }
      value = decision.alternatives.find(a => a.id === decision!.selected)!.value;
      // A reviewed candidate explicitly supplies the chosen whole-entry result.
      if (guards.has(decision.id)) value = authored;
    } else if (changed) {
      if (same(remote, before) && !prior && !input.origins?.has(name)) value = authored;
      else if (same(remote, authored) && !prior && !input.explicitNames?.has(name)) value = remote;
      else {
        const accepted = alternative(remote, input.origins?.get(name) ?? []);
        decision = { id: crypto.randomUUID(), name, selected: accepted.id, alternatives: [accepted, alternative(authored, contributions)] };
        state.decisions.push(decision);
      }
    }
    const next = entry(name, value); if (next) output.push(next);
  }
  state.decisions = state.decisions.filter(d => !guards.has(d.id)).sort((a, b) => a.id.localeCompare(b.id));
  output.sort((a,b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const bytes = encodeWireDirectory({ ...current, entries: output }), root = hashObject(bytes);
  return { root, generated: new Map([[root, bytes]]), state };
}

/** A batch suffix is authored against the previous submitted candidate, which
 * may be a hidden alternative rather than the accepted projection. Keep that
 * attribution private to submission processing; never relabel it from equal roots.
 */
export function authoredConflictBasis(state: ConflictState | null, basis: ConflictState | null, request: CandidateUpdate): ConflictState {
  const decisions = structuredClone(basis?.decisions ?? []);
  for (const current of state?.decisions ?? []) {
    const ours = current.alternatives.filter(a => a.contributions.some(c => c.change === request.change));
    const prior = decisions.findIndex(d => d.name === current.name);
    if (ours.length === 1) {
      const selected = { ...structuredClone(current), selected: ours[0]!.id };
      if (prior >= 0) decisions[prior] = selected; else decisions.push(selected);
    }
    // Without a contribution, the author still means their old selected revision.
  }
  return { decisions: decisions.filter(d => !request.resolves.some(r => r.conflict === d.id)), resolutions: [] };
}
