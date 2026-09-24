import { canonicalNodePath, type AccessOperation, type ObjectHash } from "@overstory/protocol";
import { treeReader, walkTreeDiff, type Load, type TreeReader } from "./updates/tree-diff.ts";
export interface ResourceEffect {
  path: string;
  operation: AccessOperation;
}
const BUDGET = 100000, MAX_DEPTH = 256;
/** Reserved formats can conceal row/property/schema effects. Never infer narrow authority. */
const opaque = (name: string) => name.startsWith("_") || name === "schema.cddl" || name === "schema.ts" || name === "schema.sql";
/** Conservative physical tree diff. Boundaries and opaque property stores require broad write. */
export async function resourceEffects(
  before: ObjectHash,
  after: ObjectHash,
  load: Load | TreeReader
): Promise<ResourceEffect[]> {
  const reader = treeReader(load);
  const result: ResourceEffect[] = [];
  let visited = 0;
  const spend = (depth: number) => {
    if (++visited > BUDGET || depth > MAX_DEPTH) throw new Error("Scoped update exceeds validation budget");
  };
  /** A new directory may contain independent tree boundaries; do not treat it as opaque creation. */
  const checkNew = (hash: ObjectHash, depth: number) => walkTreeDiff(null, hash, reader, {
    directory: ({ depth: nested, after: created }) => {
      spend(depth + nested);
      if (created!.directory.childrenSource) throw new Error("Scoped creation cannot introduce opaque stores");
    },
    entry: ({ name, after: entry }) => {
      spend(depth);
      if (entry!.tree || opaque(name)) throw new Error("Scoped creation cannot introduce boundaries or opaque stores");
      return true;
    },
  });
  await walkTreeDiff(before, after, reader, {
    directory: ({ path, depth, before: a, after: b }) => {
      spend(depth);
      if (JSON.stringify(a!.directory.childrenSource) !== JSON.stringify(b!.directory.childrenSource))
        result.push({ path, operation: "write" });
    },
    entry: async ({ path: child, parent: path, name, depth, before: x, after: y }) => {
      spend(0);
      if (opaque(name) || x?.tree || y?.tree) {
        result.push({ path: child, operation: "write" });
        return false;
      }
      if (!x) {
        if (y?.directory) await checkNew(y.directory, depth + 1);
        result.push({ path, operation: "create-child" });
      } else if (!y) {
        if (x.directory) result.push({ path: child, operation: "write" });
        else result.push({ path: child, operation: "delete" });
      } else if (x.directory && y.directory) return true;
      else if (x.file && y.file)
        result.push({
          path: child,
          operation: name.endsWith(".md") ? "write" : "update-content",
        });
      else result.push({ path: child, operation: "write" });
      return false;
    },
  });
  return result.map((effect) => ({
    ...effect,
    path: canonicalNodePath(effect.path),
  }));
}
