import { decodeWireDirectory, encodeWireDirectory, hashObject, type ObjectHash, type CandidateUpdate, type WireDirectoryEntry } from "@arbor/wire";
import { decisionPath } from "./conflict-store.ts";
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

/** Entry attribution follows physical paths without crossing nested tree mounts.
 * A directory with decisions below it must keep its parent spine; destructive
 * ancestor changes need coupled decisions and are deliberately not inferred here.
 */
export async function reconcileEntryAmbiguity(input: {
  base: ObjectHash; current: ObjectHash; currentID: string; request: CandidateUpdate;
  baseState: ConflictState | null; currentState: ConflictState | null;
  origins?: Map<string, EntryAlternative["contributions"]>;
  contributions?: Map<string, EntryAlternative["contributions"]>;
  explicitPaths?: Set<string>;
}, load: (hash: ObjectHash) => Promise<Uint8Array>) {
  const { request } = input;
  const state: ConflictState = { decisions: structuredClone(input.currentState?.decisions ?? []), resolutions: [] };
  const guards = new Set<string>();
  for (const resolution of request.resolves) {
    const decision = state.decisions.find(d => d.id === resolution.conflict);
    if (resolution.state !== input.currentID || !decision ||
        JSON.stringify([...resolution.alternatives].sort()) !== JSON.stringify(decision.alternatives.map(a => a.id).sort())) return null;
    guards.add(decision.id); state.resolutions.push(resolution);
  }
  const generated = new Map<ObjectHash, Uint8Array>();
  const related = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  const contributionsAt = (map: typeof input.origins, path: string) => {
    const result = new Map<string, EntryAlternative["contributions"][number]>();
    for (const [at, values] of map ?? []) if (related(at, path)) for (const value of values) result.set(JSON.stringify(value), value);
    return [...result.values()];
  };
  const originsAt = (path: string) => [...(input.origins?.keys() ?? [])].some(at => related(at, path));
  const explicitAt = (path: string) => [...(input.explicitPaths ?? [])].some(at => related(at, path));
  async function directory(baseHash: string, currentHash: string, candidateHash: string, parent: string[]): Promise<string | null> {
    const [base, current, candidate] = await Promise.all([baseHash, currentHash, candidateHash].map(async hash => decodeWireDirectory(await load(hash))));
    if (!base || !current || !candidate) throw new Error("Missing conflict basis");
    const metadata = ({ entries: _entries, ...rest }: NonNullable<typeof base>) => JSON.stringify(rest);
    if (metadata(base) !== metadata(current) || metadata(base) !== metadata(candidate)) return null;
    const names = new Set([...base.entries, ...current.entries, ...candidate.entries].map(e => e.name));
    for (const d of state.decisions) if (JSON.stringify(d.parent ?? []) === JSON.stringify(parent)) names.add(d.name);
    const output: WireDirectoryEntry[] = [];
    for (const name of names) {
      const path = `/${[...parent, name].join("/")}`;
      const before = entryValue(base.entries.find(e => e.name === name));
      const remote = entryValue(current.entries.find(e => e.name === name));
      const authored = entryValue(candidate.entries.find(e => e.name === name));
      const prior = input.baseState?.decisions.find(d => decisionPath(d) === path);
      let decision = state.decisions.find(d => decisionPath(d) === path);
      const descendants = [...state.decisions, ...(input.baseState?.decisions ?? [])].some(d => decisionPath(d).startsWith(`${path}/`));
      // Recurse even when parent hashes match: equal-byte operations and nested
      // resolution declarations still have meaning at the leaf.
      if (!decision && !prior && "directory" in before && "directory" in remote && "directory" in authored) {
        const child = await directory(before.directory, remote.directory, authored.directory, [...parent, name]);
        if (child === null) return null;
        output.push({ name, directory: child });
        continue;
      }
      if (descendants) return null;
      const changed = !same(before, authored) || explicitAt(path);
      const contributions = request.operations === null ? [{ change: request.change, operation: null }] : contributionsAt(input.contributions, path);
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
        if (guards.has(decision.id)) value = authored;
      } else if (changed) {
        if (same(remote, before) && !prior && !originsAt(path)) value = authored;
        else if (same(remote, authored) && !prior && !explicitAt(path)) value = remote;
        else {
          const accepted = alternative(remote, contributionsAt(input.origins, path));
          decision = { id: crypto.randomUUID(), name, ...(parent.length ? { parent } : {}), selected: accepted.id,
            alternatives: [accepted, alternative(authored, contributions)] };
          state.decisions.push(decision);
        }
      }
      const next = entry(name, value); if (next) output.push(next);
    }
    output.sort((a,b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    const bytes = encodeWireDirectory({ ...current, entries: output }), root = hashObject(bytes);
    generated.set(root, bytes);
    return root;
  }
  const root = await directory(input.base, input.current, request.candidate, []);
  if (root === null) return null;
  state.decisions = state.decisions.filter(d => !guards.has(d.id)).sort((a,b) => a.id.localeCompare(b.id));
  return { root, generated, state };
}

/** Physical changes in accepted snapshots are evidence of a change, never of an
 * editor operation. Directory/tree kind changes stay at the enclosing entry. */
export async function changedEntryPaths(before: string, after: string, load: (hash: string) => Promise<Uint8Array>, parent = ""): Promise<string[]> {
  if (before === after) return [];
  const [left, right] = await Promise.all([before, after].map(async hash => decodeWireDirectory(await load(hash))));
  if (!left || !right) throw new Error("Missing accepted directory");
  const paths: string[] = [];
  for (const name of new Set([...left.entries, ...right.entries].map(e => e.name))) {
    const a = left.entries.find(e => e.name === name), b = right.entries.find(e => e.name === name), path = `${parent}/${name}`;
    if (a?.directory && b?.directory) paths.push(...await changedEntryPaths(a.directory, b.directory, load, path));
    else if (!same(entryValue(a), entryValue(b))) paths.push(path);
  }
  return paths;
}

/** A batch suffix is authored against the previous submitted candidate, which
 * may be a hidden alternative rather than the accepted projection. Keep that
 * attribution private to submission processing; never relabel it from equal roots.
 */
export function authoredConflictBasis(state: ConflictState | null, basis: ConflictState | null, request: CandidateUpdate): ConflictState {
  const decisions = structuredClone(basis?.decisions ?? []);
  for (const current of state?.decisions ?? []) {
    const ours = current.alternatives.filter(a => a.contributions.some(c => c.change === request.change));
    const prior = decisions.findIndex(d => decisionPath(d) === decisionPath(current));
    if (ours.length === 1) {
      const selected = { ...structuredClone(current), selected: ours[0]!.id };
      if (prior >= 0) decisions[prior] = selected; else decisions.push(selected);
    }
    // Without a contribution, the author still means their old selected revision.
  }
  return { decisions: decisions.filter(d => !request.resolves.some(r => r.conflict === d.id)), resolutions: [] };
}
