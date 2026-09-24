import { stableJSONString } from "@overstory/protocol";
import type { LogDecision } from "@overstory/merge-protocol";
import type { IntentDecision, Node } from "./intent-model.ts";
import { entryAt, withEntry, type TreeIO } from "./trees.ts";

const names = (path: string) => (path === "/" ? [] : path.slice(1).split("/"));

/** The decisions of a retained state as a log entry records them, against the
 * accepted `root`, with the state's node identities resolved to paths. A
 * choice about one entry names whole alternative roots; a source choice names
 * its range and each alternative's bytes; anything else is a choice about the
 * whole root. */
export async function logDecisions(
  io: TreeIO,
  root: string,
  decisions: readonly IntentDecision[],
  nodeOf: (id: string) => Node | undefined,
): Promise<LogDecision[]> {
  /** A node's names from the root of the tree it is placed in. */
  const pathOf = (id: string): string[] => {
    const path: string[] = [];
    const seen = new Set<string>();
    let node = nodeOf(id);
    while (node?.parent !== null) {
      if (!node || seen.has(node.id)) throw new Error("Invalid decision path");
      seen.add(node.id);
      path.unshift(node.name);
      node = nodeOf(node.parent!);
    }
    return path;
  };
  const out: LogDecision[] = [];
  for (const d of decisions) {
    const contributions = (list: LogDecision["alternatives"][number]["contributions"]) =>
      [...new Map(list.map((c) => [stableJSONString(c), c])).values()];
    const base = { key: d.key, dependencies: d.dependencies, selected: d.selected };
    const subjectPath = d.subject?.material.kind === "basis" ? d.subject.material.path : undefined;
    const placed = d.placement ? nodeOf(d.placement.node) : undefined;
    const folder = d.kind === "directory" && subjectPath !== undefined && subjectPath !== "/";
    const entry = (d.kind === "content" && d.placement && !d.subject?.range) || d.kind === "existence" || folder;
    const logical = subjectPath !== undefined ? names(subjectPath) : placed ? pathOf(placed.id) : [];
    if (entry && logical.length) {
      const alternatives = [];
      for (const a of d.alternatives) {
        const value = d.kind === "existence" && a.node === undefined ? null
          : folder ? { name: logical.at(-1)!, directory: a.object } : { name: logical.at(-1)!, file: a.object };
        const object = await withEntry(io, root, logical, value);
        if (!object) throw new Error("Decision entry has no parent in the accepted root");
        alternatives.push({ object, contributions: contributions(a.contributions) });
      }
      out.push({ ...base, path: logical, alternatives });
      continue;
    }
    const fragments = d.alternatives.map((a) => ({ object: a.object, contributions: contributions(a.contributions) }));
    // A placed choice with no context of its own is a range of the file it is placed in.
    if (placed?.active && !d.context && d.placement) {
      const { anchor, pieces } = d.placement;
      const range: [number, number] = [anchor, anchor + pieces.reduce((n, p) => n + p.length, 0)];
      out.push({ ...base, path: pathOf(placed.id), range, alternatives: fragments });
      continue;
    }
    if (d.kind !== "directory" && subjectPath && subjectPath !== "/" && d.subject?.range) {
      const path = names(subjectPath);
      const shown = await entryAt(io, root, path);
      const at = d.subject.material.kind === "basis" ? d.subject.material.object : undefined;
      out.push({ ...base, path, range: d.subject.range, ...(at && shown?.file !== at ? { at } : {}), alternatives: fragments });
      continue;
    }
    out.push({ ...base, alternatives: fragments });
  }
  return out;
}
