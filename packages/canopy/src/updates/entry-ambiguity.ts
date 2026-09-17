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
 * Ancestor choices keep the selected directory spine while descendant decisions
 * remain open. A resolution may discard that spine only when it explicitly
 * guards every descendant whose selected material would no longer be represented.
 */
export async function reconcileEntryAmbiguity(input: {
  base: ObjectHash; current: ObjectHash; currentID: string; request: CandidateUpdate;
  baseState: ConflictState | null; currentState: ConflictState | null;
  origins?: Map<string, EntryAlternative["contributions"]>;
  contributions?: Map<string, EntryAlternative["contributions"]>;
  explicitPaths?: Set<string>;
  /** Preserve successful format-rule results outside the reported overlaps. */
  merged?: { root: ObjectHash; conflicts: string[]; directories?: string[] };
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
  const related = (a: string, b: string) => a === "/" || b === "/" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  const contributionsAt = (map: typeof input.origins, path: string) => {
    const result = new Map<string, EntryAlternative["contributions"][number]>();
    for (const [at, values] of map ?? []) if (related(at, path)) for (const value of values) result.set(JSON.stringify(value), value);
    return [...result.values()];
  };
  const originsAt = (path: string) => [...(input.origins?.keys() ?? [])].some(at => related(at, path));
  const explicitAt = (path: string) => [...(input.explicitPaths ?? [])].some(at => related(at, path));
  const metadata = ({ entries: _entries, ...rest }: ReturnType<typeof decodeWireDirectory>) => JSON.stringify(rest);
  async function sameMetadata(...hashes: string[]) {
    const values = await Promise.all(hashes.map(async hash => metadata(decodeWireDirectory(await load(hash)))));
    return values.every(value => value === values[0]);
  }
  async function directory(baseHash: string, currentHash: string, candidateHash: string, parent: string[], mergedHash?: string): Promise<string | null> {
    const [base, current, candidate] = await Promise.all([baseHash, currentHash, candidateHash].map(async hash => decodeWireDirectory(await load(hash))));
    if (!base || !current || !candidate) throw new Error("Missing conflict basis");
    const merged = mergedHash ? decodeWireDirectory(await load(mergedHash)) : undefined;
    const names = new Set([...base.entries, ...current.entries, ...candidate.entries].map(e => e.name));
    for (const d of state.decisions) if (!d.root && JSON.stringify(d.parent ?? []) === JSON.stringify(parent)) names.add(d.name);
    const output: WireDirectoryEntry[] = [];
    for (const name of names) {
      const path = `/${[...parent, name].join("/")}`;
      const before = entryValue(base.entries.find(e => e.name === name));
      const remote = entryValue(current.entries.find(e => e.name === name));
      const authored = entryValue(candidate.entries.find(e => e.name === name));
      const prior = input.baseState?.decisions.find(d => decisionPath(d) === path);
      let decision = state.decisions.find(d => decisionPath(d) === path);
      const descendants = state.decisions.filter(d => decisionPath(d).startsWith(`${path}/`));
      const changed = !same(before, authored) || explicitAt(path);
      const contributions = request.operations === null ? [{ change: request.change, operation: null }] : contributionsAt(input.contributions, path);
      const selected = decision?.alternatives.find(a => a.id === decision!.selected);
      if (decision && (!selected || !same(selected.value, remote))) throw new Error("Stored conflict projection does not match accepted entry");
      const basisAlternative = prior?.alternatives.find(a => a.id === prior.selected);
      const attributable = basisAlternative && decision?.alternatives.find(a => a.id === basisAlternative.id && a.revision === basisAlternative.revision);
      let value = remote;

      // A guarded ancestor may choose a concrete subtree, but cannot silently
      // discard another open choice. Inspect against the authored result, not
      // merely entry kind or equality of enclosing directory hashes.
      async function preservesOpenDescendants() {
        for (const descendant of descendants) {
          if (guards.has(descendant.id)) continue;
          let actual = authored;
          for (const part of decisionPath(descendant).slice(path.length + 1).split("/")) {
            if (!("directory" in actual)) return false;
            const body = decodeWireDirectory(await load(actual.directory));
            actual = entryValue(body.entries.find(e => e.name === part));
          }
          if (!same(actual, descendant.alternatives.find(a => a.id === descendant.selected)!.value)) return false;
        }
        return true;
      }
      if (decision && guards.has(decision.id)) {
        if (!await preservesOpenDescendants()) return null;
        value = authored;
      } else if ("directory" in before && "directory" in remote && "directory" in authored &&
          (!decision && !prior || attributable?.id === decision?.selected && !!decision) &&
          !input.merged?.directories?.includes(path) && await sameMetadata(before.directory, remote.directory, authored.directory)) {
        // Edits within the selected ancestor continue its children. An authored
        // hidden ancestor instead remains a whole-subtree alternative below.
        const child = await directory(before.directory, remote.directory, authored.directory, [...parent, name], merged?.entries.find(e => e.name === name)?.directory);
        if (child === null) return null;
        value = { directory: child };
        if (selected && (!same(selected.value, value) || changed)) {
          selected.value = value; selected.revision = crypto.randomUUID();
          selected.contributions = [...selected.contributions, ...contributions];
        }
      } else if (descendants.some(d => guards.has(d.id))) {
        // Removing an ancestor that has no decision of its own can explicitly
        // resolve the affected children in this same update package. Once the
        // ancestor has alternatives, that choice needs its own guard too.
        if (decision || !await preservesOpenDescendants()) return null;
        value = authored;
      } else if (decision) {
        if (changed) {
          // Continuing a hidden subtree is safe. Replacing the selected spine
          // while children are unresolved must add a choice, not mutate it away.
          if (attributable && (attributable.id !== decision.selected || !descendants.length)) {
            attributable.value = authored; attributable.revision = crypto.randomUUID();
            attributable.contributions = [...attributable.contributions, ...contributions];
          } else decision.alternatives.push(alternative(authored, contributions));
        }
        value = decision.alternatives.find(a => a.id === decision!.selected)!.value;
      } else if (merged && !prior && !descendants.length && !input.merged!.conflicts.some(at => related(at, path))) {
        value = entryValue(merged.entries.find(e => e.name === name));
      } else if (changed) {
        if (same(remote, before) && !prior && !originsAt(path) && !descendants.length) value = authored;
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
    const bytes = encodeWireDirectory({ ...(merged ?? current), entries: output }), root = hashObject(bytes);
    generated.set(root, bytes);
    return root;
  }
  // Coupled choices at the root have no containing entry. Represent them as
  // whole-directory alternatives, without a fabricated filename.
  const rootDecision = state.decisions.find(d => d.root);
  const rootPrior = input.baseState?.decisions.find(d => d.root);
  const compatibleMetadata = await sameMetadata(input.base, input.current, request.candidate);
  let root: string | null;
  const coupledRoot = input.merged?.directories?.includes("/");
  if (rootDecision || !compatibleMetadata || coupledRoot) {
    const before = { directory: input.base }, remote = { directory: input.current }, authored = { directory: request.candidate };
    const changed = !same(before, authored) || !!input.explicitPaths?.size;
    const contributions = request.operations === null ? [{ change: request.change, operation: null }] : contributionsAt(input.contributions, "/");
    const selected = rootDecision?.alternatives.find(a => a.id === rootDecision.selected);
    if (rootDecision && (!selected || !same(selected.value, remote))) throw new Error("Stored root conflict projection does not match accepted root");
    const basis = rootPrior?.alternatives.find(a => a.id === rootPrior.selected);
    const attributable = basis && rootDecision?.alternatives.find(a => a.id === basis.id && a.revision === basis.revision);
    if (rootDecision && guards.has(rootDecision.id)) {
      // A root choice cannot implicitly resolve children. Every unguarded
      // child must still have its selected value in the reviewed projection.
      for (const child of state.decisions.filter(d => !d.root && !guards.has(d.id))) {
        let parent = decodeWireDirectory(await load(request.candidate));
        for (const name of child.parent ?? []) {
          const hash = parent.entries.find(e => e.name === name)?.directory;
          if (!hash) return null;
          parent = decodeWireDirectory(await load(hash));
        }
        if (!same(entryValue(parent.entries.find(e => e.name === child.name)), child.alternatives.find(a => a.id === child.selected)!.value)) return null;
      }
      root = request.candidate;
    } else if (rootDecision && attributable?.id === rootDecision.selected && compatibleMetadata && !coupledRoot) {
      root = await directory(input.base, input.current, request.candidate, [], input.merged?.root);
      if (root && (root !== input.current || changed)) {
        selected!.value = { directory: root }; selected!.revision = crypto.randomUUID();
        selected!.contributions.push(...contributions);
      }
    } else if (rootDecision) {
      if (state.decisions.some(d => !d.root && guards.has(d.id))) return null;
      if (changed) {
        if (attributable && (attributable.id !== rootDecision.selected || state.decisions.length === 1)) {
          attributable.value = authored; attributable.revision = crypto.randomUUID(); attributable.contributions.push(...contributions);
        } else rootDecision.alternatives.push(alternative(authored, contributions));
      }
      const value = rootDecision.alternatives.find(a => a.id === rootDecision.selected)!.value;
      if (!("directory" in value)) throw new Error("Invalid root alternative");
      root = value.directory;
    } else {
      const accepted = alternative(remote, contributionsAt(input.origins, "/"));
      state.decisions.push({ root: true, id: crypto.randomUUID(), selected: accepted.id,
        alternatives: [accepted, alternative(authored, contributions)] });
      root = input.current;
    }
  } else root = await directory(input.base, input.current, request.candidate, [], input.merged?.root);
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
  const { entries: _leftEntries, ...leftMetadata } = left;
  const { entries: _rightEntries, ...rightMetadata } = right;
  const paths: string[] = JSON.stringify(leftMetadata) === JSON.stringify(rightMetadata) ? [] : [parent || "/"];
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
