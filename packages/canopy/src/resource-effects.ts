import { decodeWireDirectory, type ObjectHash } from "@arbor/wire";
import { canonicalNodePath, type AccessOperation } from "@arbor/core";
export interface ResourceEffect {
  path: string;
  operation: AccessOperation;
}
/** Conservative physical tree diff. Boundaries and opaque property stores require broad write. */
export async function resourceEffects(
  before: ObjectHash,
  after: ObjectHash,
  load: (hash: ObjectHash) => Promise<Uint8Array>
): Promise<ResourceEffect[]> {
  const result: ResourceEffect[] = [];
  let visited = 0;
  async function walk(
    left: string,
    right: string,
    path: string,
    depth: number
  ): Promise<void> {
    if (left === right) return;
    if (++visited > 100000 || depth > 256)
      throw new Error("Scoped update exceeds validation budget");
    const a = decodeWireDirectory(await load(left));
    const b = decodeWireDirectory(await load(right));
    if (a.type !== "directory" || b.type !== "directory")
      throw new Error("Scoped update requires directory representation");
    if (JSON.stringify(a.childrenSource) !== JSON.stringify(b.childrenSource))
      result.push({ path, operation: "write" });
    const old = new Map(a.entries.map((e) => [e.name, e]));
    const next = new Map(b.entries.map((e) => [e.name, e]));
    for (const name of new Set([...old.keys(), ...next.keys()])) {
      if (++visited > 100000) throw new Error("Scoped update exceeds validation budget");
      const x = old.get(name),
        y = next.get(name),
        child = path === "/" ? `/${name}` : `${path}/${name}`;
      if (JSON.stringify(x) === JSON.stringify(y)) continue;
      // Reserved formats can conceal row/property/schema effects. Never infer narrow authority.
      if (
        name.startsWith("_") ||
        name === "schema.ts" ||
        name === "schema.sql" ||
        x?.tree ||
        y?.tree
      ) {
        result.push({ path: child, operation: "write" });
        continue;
      }
      if (!x) {
        // A new directory may contain independent tree boundaries; do not treat it as opaque creation.
        if (y?.directory) await checkNew(y.directory, child, depth + 1);
        result.push({ path, operation: "create-child" });
      } else if (!y) {
        if (x.directory) result.push({ path: child, operation: "write" });
        else result.push({ path: child, operation: "delete" });
      } else if (x.directory && y.directory)
        await walk(x.directory, y.directory, child, depth + 1);
      else if (x.file && y.file)
        result.push({
          path: child,
          operation: name.endsWith(".md") ? "write" : "update-content",
        });
      else result.push({ path: child, operation: "write" });
    }
  }
  async function checkNew(
    hash: string,
    path: string,
    depth: number
  ): Promise<void> {
    if (++visited > 100000 || depth > 256)
      throw new Error("Scoped update exceeds validation budget");
    const dir = decodeWireDirectory(await load(hash));
    if (dir.type !== "directory")
      throw new Error("Unsupported scoped creation");
    if (dir.childrenSource)
      throw new Error("Scoped creation cannot introduce opaque stores");
    for (const e of dir.entries) {
      if (++visited > 100000) throw new Error("Scoped update exceeds validation budget");
      if (
        e.tree ||
        e.name.startsWith("_") ||
        e.name === "schema.ts" ||
        e.name === "schema.sql"
      )
        throw new Error(
          "Scoped creation cannot introduce boundaries or opaque stores"
        );
      if (e.directory)
        await checkNew(e.directory, `${path}/${e.name}`, depth + 1);
    }
  }
  await walk(before, after, "/", 0);
  return result.map((effect) => ({
    ...effect,
    path: canonicalNodePath(effect.path),
  }));
}
