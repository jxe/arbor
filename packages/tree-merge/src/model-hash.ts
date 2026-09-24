import { decodeWireDirectory, type ObjectHash, type WireDirectoryEntry, canonicalCBORHash, type Hash } from "@overstory/protocol";
import { frontmatter } from "./merge-rules.ts";

type Load = (hash: ObjectHash) => Promise<Uint8Array>;

/**
 * Per-node model hashes over a wire graph, as the data model defines them:
 * the canonical CBOR of a node's schema, properties, content, and the model
 * hashes of its children. A Markdown file's frontmatter is its properties and
 * the rest is its content, so reordering frontmatter keys does not change the
 * hash; any other file is content alone. Memoized by object hash, since a
 * wire object's model is a pure function of its subtree.
 */
export class ModelHashes {
  private readonly cache = new Map<string, Promise<Hash>>();

  constructor(private readonly load: Load) {}

  /** The model hash of one directory entry, or null for an absent entry. */
  entry(entry: WireDirectoryEntry | undefined): Promise<Hash | null> {
    if (!entry) return Promise.resolve(null);
    if (entry.tree) return Promise.resolve(canonicalCBORHash({ tree: entry.tree }));
    return this.object((entry.file ?? entry.directory)!, entry.name.endsWith(".md"), !!entry.directory);
  }

  object(hash: ObjectHash, markdown: boolean, directory = true): Promise<Hash> {
    const key = `${hash}:${directory ? "directory" : markdown ? "md" : "raw"}`;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.compute(hash, markdown, directory);
      this.cache.set(key, pending);
    }
    return pending;
  }

  private async compute(hash: ObjectHash, markdown: boolean, directory: boolean): Promise<Hash> {
    const bytes = await this.load(hash);
    if (!directory) {
      if (markdown) {
        const source = new TextDecoder().decode(bytes);
        const properties = frontmatter(source);
        if (properties) {
          const body = source.replaceAll("\r\n", "\n").split("\n");
          const end = body[0] === "---" ? body.indexOf("---", 1) : -1;
          const content = end >= 0 ? body.slice(end + 1).join("\n") : source;
          return canonicalCBORHash({ properties: Object.fromEntries([...properties].sort()), content });
        }
      }
      return canonicalCBORHash({ content: bytes });
    }
    const object = decodeWireDirectory(bytes);
    const bodyEntry = object.entries.find((entry) => entry.name === "_index.md");
    const body = bodyEntry ? await this.entry(bodyEntry) : null;
    if (object.childrenSource) {
      return canonicalCBORHash({
        body,
        childSchema: object.childrenSource.schemaFingerprint,
        childSet: object.childrenSource.childSetHash,
      });
    }
    const children: Record<string, Hash> = {};
    for (const entry of object.entries) {
      if (entry.name === "_index.md") continue;
      children[entry.name] = (await this.entry(entry))!;
    }
    return canonicalCBORHash({ body, children });
  }
}
