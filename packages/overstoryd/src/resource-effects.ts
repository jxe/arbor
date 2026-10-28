import { canonicalNodePath, decodeProtocolPage, encodeProtocolPage, isPageName, parsePage, treeReader, walkTreeDiff, type AccessOperation, type LoadObject, type ObjectHash, type ProtocolPage, type TreeReader } from "@ovst/protocol";
export interface ResourceEffect {
  path: string;
  operation: AccessOperation;
}
const BUDGET = 100000, MAX_DEPTH = 256;
/** Reserved formats can conceal row/property/schema effects. Never infer narrow authority. */
const opaque = (name: string) => name.startsWith("_") || name === "schema.usl";
/** Conservative physical tree diff. Boundaries and opaque property stores require broad write. */
export async function resourceEffects(
  before: ObjectHash,
  after: ObjectHash,
  load: LoadObject | TreeReader
): Promise<ResourceEffect[]> {
  const reader = treeReader(load);
  /** An entry's page: its own, or the one a Markdown file reads as. */
  const pageOf = async (name: string, entry: { file?: ObjectHash; page?: ObjectHash }): Promise<ProtocolPage | null> =>
    entry.page ? decodeProtocolPage(await reader.bytes(entry.page))
      : entry.file && isPageName(name) ? parsePage(await reader.bytes(entry.file)) : null;
  const result: ResourceEffect[] = [];
  let visited = 0;
  const spend = (depth: number) => {
    if (++visited > BUDGET || depth > MAX_DEPTH) throw new Error("Scoped update exceeds validation budget");
  };
  /** A new directory may contain independent tree boundaries; do not treat it as opaque creation. */
  const checkNew = (hash: ObjectHash, depth: number) => walkTreeDiff(null, hash, reader, {
    directory: ({ depth: nested, after: created }) => {
      spend(depth + nested);
      if (created!.directory.collection) throw new Error("Scoped creation cannot introduce opaque stores");
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
      if (JSON.stringify(a!.directory.collection) !== JSON.stringify(b!.directory.collection))
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
      else if (x.file && y.file && !isPageName(name))
        result.push({ path: child, operation: "update-content" });
      else if (y.page) {
        // A page is judged by its property and body differences (spec 05
        // §1); converting a file to the page it reads as changes neither.
        const [a, b] = [await pageOf(name, x), await pageOf(name, y)];
        if (!a || !b || a.id !== b.id) result.push({ path: child, operation: "write" });
        else {
          const properties = (page: ProtocolPage) => Buffer.from(encodeProtocolPage({ ...page, body: new Uint8Array() }));
          if (!properties(a).equals(properties(b))) result.push({ path: child, operation: "update-properties" });
          if (!Buffer.from(a.body).equals(Buffer.from(b.body))) result.push({ path: child, operation: "update-content" });
        }
      }
      else result.push({ path: child, operation: "write" });
      return false;
    },
  });
  return result.map((effect) => ({
    ...effect,
    path: canonicalNodePath(effect.path),
  }));
}
