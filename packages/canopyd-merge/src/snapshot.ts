import { stableJSONString, type WireDirectoryEntry } from "@overstory/protocol";
import type { LogDecision } from "@overstory/merge-protocol";
import { entryAt, entryValue, withEntry, type TreeIO } from "./trees.ts";

type Contribution = { change: string; operation: null };

/** Checkpoint decisions for a conflicting snapshot, and the projection that
 * shows the current material for each. Each conflict is scoped to one entry
 * and the rest of the merge is accepted: a file (a file against its deletion
 * included) is a choice about that file; a conflict inside a folder the tree
 * merge could not reconcile, or at an entry that is not a file on both
 * sides, is a choice about the nearest folder that both sides hold. A choice
 * inside another choice's folder is part of that choice. Only a conflict at
 * the root, or one no folder below it contains, is a single whole-root
 * choice that keeps the current tree. The current alternative names the
 * concurrent changes that produced it; the candidate names this change. A
 * folder choice depends on the open choices already inside that folder.
 *
 * A candidate whose basis showed a hidden alternative of an open choice
 * about the same entry (a batch suffix after its prefix was withheld)
 * continues that alternative: the choice keeps its identity, that
 * alternative becomes the candidate's version, and `replaces` names the
 * choice so the checkpoint retires its old form. */
export async function snapshotDecisions(
  io: TreeIO,
  change: string,
  current: { root: string; decisions: readonly LogDecision[] },
  base: string,
  candidate: string,
  merged: string,
  conflicts: Array<{ path: string }>,
  folders: string[],
  concurrent: (path: string) => Contribution[],
): Promise<{ projection: string; decisions: LogDecision[]; replaces: string[] }> {
  const own = [{ change, operation: null }];
  const roots = [...new Set([current.root, candidate, merged])];
  const whole = {
    projection: current.root,
    replaces: [],
    decisions: [{
      key: `snapshot:${change}`,
      dependencies: [],
      selected: 0,
      alternatives: roots.map((object) => ({
        object,
        contributions: object === current.root ? concurrent("/") : object === candidate ? own : [...concurrent("/"), ...own],
      })),
    }],
  };
  if (!conflicts.length && !folders.length) return whole;
  const within = (path: string, scope: string) => scope === "/" || path === scope || path.startsWith(`${scope}/`);
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
  const namesOf = (path: string) => path.slice(1).split("/");
  // The entry each conflict is about.
  const scopes = new Set<string>();
  for (const conflict of [...folders, ...conflicts.map((c) => c.path)]) {
    // The outermost unreconciled folder containing the conflict owns it.
    let path = folders.filter((folder) => within(conflict, folder)).sort((a, b) => a.length - b.length)[0] ?? conflict;
    for (;;) {
      if (path === "/") return whole;
      const [mine, theirs] = await Promise.all([current.root, candidate].map((root) => entryAt(io, root, namesOf(path))));
      const file = (entry: WireDirectoryEntry | null | undefined) => !entry || !!entry.file;
      if ((mine || theirs) && file(mine) && file(theirs)) break;
      if (mine?.directory && theirs?.directory) break;
      path = parentOf(path);
    }
    scopes.add(path);
  }
  const open = current.decisions;
  // The path an open choice is about: its entry, or the file its range is in.
  const placed = (d: LogDecision) => (d.path ? `/${d.path.join("/")}` : null);
  const entryPath = (d: LogDecision) => (d.path && !d.range ? placed(d) : null);
  let projection = merged;
  const decisions: LogDecision[] = [], replaces: string[] = [];
  for (const path of [...scopes].filter((p) => ![...scopes].some((q) => q !== p && within(p, q))).sort()) {
    const names = namesOf(path);
    const [mine, theirs, before] = await Promise.all([current.root, candidate, base].map((root) => entryAt(io, root, names)));
    const shown = await withEntry(io, projection, names, mine ?? null);
    if (!shown) return whole;
    projection = shown;
    const folder = !!(mine?.directory && theirs?.directory);
    const dependencies = folder
      ? open.filter((d) => { const at = placed(d); return !!at && at !== path && within(at, path); }).map((d) => d.key)
      : [];
    const basis = entryValue(before);
    const prior = basis ? open.find((d) => !d.dependencies.length && entryPath(d) === path) : undefined;
    let continued = -1;
    const values = prior ? await Promise.all(prior.alternatives.map(async (a) => entryValue(await entryAt(io, a.object, names)))) : [];
    if (prior)
      continued = values.findIndex((value, index) => index !== prior.selected && stableJSONString(value) === stableJSONString(basis));
    if (prior && continued >= 0) {
      const alternatives = [];
      for (const [index, alternative] of prior.alternatives.entries()) {
        const value = values[index];
        const object = index === continued ? candidate
          : index === prior.selected ? current.root
          : await withEntry(io, current.root, names, value ? { name: names.at(-1)!, ...value } as WireDirectoryEntry : null);
        if (!object) break;
        alternatives.push({ object, contributions: index === continued ? [...alternative.contributions, ...own] : alternative.contributions });
      }
      if (alternatives.length === prior.alternatives.length) {
        replaces.push(prior.key);
        decisions.push({
          key: prior.key,
          path: names,
          selected: prior.selected,
          alternatives,
          dependencies,
        });
        continue;
      }
    }
    decisions.push({
      key: `snapshot:${change}:${path}`,
      path: names,
      selected: 0,
      alternatives: [
        { object: current.root, contributions: concurrent(path) },
        { object: candidate, contributions: own },
      ],
      dependencies,
    });
  }
  return { projection, decisions, replaces };
}
