import { stableJSONString } from "@overstory/protocol";
import type { LogDecision } from "@overstory/merge-protocol";
import type { DecisionReport } from "./engine-contract.ts";
import { entryAt, withEntry, type TreeIO } from "./trees.ts";

const names = (path: string) => path.slice(1).split("/");

/** The decisions of a retained state as a log entry records them, against the
 * accepted `root`. A choice about one entry names whole alternative roots; a
 * source choice names its range and each alternative's bytes; anything else
 * is a choice about the whole root. */
export async function logDecisions(io: TreeIO, root: string, reports: readonly DecisionReport[]): Promise<LogDecision[]> {
  const out: LogDecision[] = [];
  for (const d of reports) {
    const contributions = (list: DecisionReport["alternatives"][number]["contributions"]) =>
      [...new Map(list.map((c) => [stableJSONString(c), c])).values()];
    const base = { key: d.key, dependencies: d.dependencies, selected: d.selected };
    const subjectPath = d.subject?.material.kind === "basis" ? d.subject.material.path : undefined;
    const folder = d.kind === "directory" && subjectPath !== undefined && subjectPath !== "/";
    const entry = (d.kind === "content" && d.placement && !d.subject?.range) || d.kind === "existence" || folder;
    const logical = subjectPath ?? d.placement?.path ?? "/";
    if (entry && logical !== "/") {
      const path = names(logical);
      const alternatives = [];
      for (const a of d.alternatives) {
        const value = d.kind === "existence" && !a.present ? null
          : folder ? { name: path.at(-1)!, directory: a.object } : { name: path.at(-1)!, file: a.object };
        const object = await withEntry(io, root, path, value);
        if (!object) throw new Error("Decision entry has no parent in the accepted root");
        alternatives.push({ object, contributions: contributions(a.contributions) });
      }
      out.push({ ...base, path, alternatives });
      continue;
    }
    const fragments = d.alternatives.map((a) => ({ object: a.object, contributions: contributions(a.contributions) }));
    if (d.placement?.path && d.placement.range) {
      out.push({ ...base, path: names(d.placement.path), range: d.placement.range, alternatives: fragments });
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
