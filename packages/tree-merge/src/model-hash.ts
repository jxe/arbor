import { collectionLogicalHash, decodeProtocolDirectory, encodeProtocolPage, hashObject, isPageName, parsePage, type ObjectHash, type ProtocolDirectoryEntry, canonicalCBORHash, type Hash } from "@ovst/protocol";

type Load = (hash: ObjectHash) => Promise<Uint8Array>;

/**
 * Per-node model hashes over a wire graph, as the data model defines them:
 * the canonical CBOR of a node's schema, properties, content, and the model
 * hashes of its children. A collection's rows count by its logical hash, so
 * every representation of the same rows hashes the same (spec 06 §2.1). A
 * page's object hash is its model hash, and a Markdown file's model hash is
 * that of the page it reads as, so converting a file to a page changes no
 * model (spec 01 §1.1); any other file, and Markdown whose frontmatter does
 * not parse, is content alone. Memoized by object hash, since a wire object's
 * model is a pure function of its subtree.
 */
export class ModelHashes {
  private readonly cache = new Map<string, Promise<Hash>>();

  constructor(private readonly load: Load) {}

  /** The model hash of one directory entry, or null for an absent entry. */
  entry(entry: ProtocolDirectoryEntry | undefined): Promise<Hash | null> {
    if (!entry) return Promise.resolve(null);
    if (entry.tree) return Promise.resolve(canonicalCBORHash({ tree: entry.tree }));
    if (entry.page) return Promise.resolve(entry.page as Hash);
    return this.object((entry.file ?? entry.directory)!, isPageName(entry.name), !!entry.directory);
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
        const page = parsePage(bytes);
        if (page) return hashObject(encodeProtocolPage(page)) as Hash;
      }
      return canonicalCBORHash({ content: bytes });
    }
    const object = decodeProtocolDirectory(bytes);
    const bodyEntry = object.entries.find((entry) => entry.name === "_index.md");
    const body = bodyEntry ? await this.entry(bodyEntry) : null;
    const children: Record<string, Hash> = {};
    for (const entry of object.entries) {
      if (entry.name === "_index.md") continue;
      children[entry.name] = (await this.entry(entry))!;
    }
    return canonicalCBORHash(object.collection
      ? { body, children, collection: collectionLogicalHash(object.collection) }
      : { body, children });
  }
}
