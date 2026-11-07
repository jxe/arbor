import { decodeProtocolDirectory, normalizeTreePath, pathReadObjects, type ObjectHash, type ProtocolDirectory, type ProtocolDirectoryEntry } from "@ovst/protocol";
import type { ObjectSource } from "@ovst/object-store/sources";

/**
 * The lazy node index (Clients 003 module 3): a tree at one accepted root,
 * whose directories load from an object source the first time a path below
 * them is asked for. Directory objects are immutable, so decoded ones are
 * kept by hash and survive a move to another root (`rebase`): only the
 * directories that changed load again. The Swift twin is `WorkingTree`'s
 * index half.
 *
 * Every directory the index answers from came from its source, which checks
 * each object against its hash, so a path it resolves is the accepted
 * root's: an edit computed from it is checked against that root.
 */
export type Prefetch = "opened-pages" | "directories-and-pages" | "everything";

export interface IndexedEntry {
  path: string;
  entry: ProtocolDirectoryEntry;
}

export class NodeIndex {
  private rootHash: ObjectHash;

  constructor(root: ObjectHash, private readonly source: ObjectSource, private readonly directories = new Map<string, ProtocolDirectory>()) {
    this.rootHash = root;
  }

  /** The same tree at another root, sharing the directories decoded so far. */
  at(root: ObjectHash): NodeIndex {
    return root === this.rootHash ? this : new NodeIndex(root, this.source, this.directories);
  }

  get root(): ObjectHash {
    return this.rootHash;
  }

  /** How many decoded directories the index holds; for tests and diagnostics. */
  get heldDirectories(): number {
    return this.directories.size;
  }

  /** Move to another accepted root; directories already decoded are reused. */
  rebase(root: ObjectHash): void {
    this.rootHash = root;
  }

  private async load(hash: ObjectHash): Promise<ProtocolDirectory | undefined> {
    const known = this.directories.get(hash);
    if (known) return known;
    const bytes = await this.source.object(hash);
    if (!bytes) return undefined;
    const directory = decodeProtocolDirectory(bytes);
    this.directories.set(hash, directory);
    return directory;
  }

  /** The directory object at `path`, or undefined when no directory is there. */
  async directory(path: string): Promise<ProtocolDirectory | undefined> {
    let directory = await this.load(this.rootHash);
    for (const name of normalizeTreePath(path).split("/").filter(Boolean)) {
      const entry = directory?.entries.find((candidate) => candidate.name === name);
      if (!entry?.directory) return undefined;
      directory = await this.load(entry.directory as ObjectHash);
    }
    return directory;
  }

  /** The entry at `path`; `/` has none. */
  async entry(path: string): Promise<ProtocolDirectoryEntry | undefined> {
    const parts = normalizeTreePath(path).split("/").filter(Boolean);
    const name = parts.pop();
    if (name === undefined) return undefined;
    const parent = await this.directory(`/${parts.join("/")}`);
    return parent?.entries.find((candidate) => candidate.name === name);
  }

  /** The entries of the directory at `path`, each with its own path. */
  async children(path: string): Promise<IndexedEntry[]> {
    const normalized = normalizeTreePath(path);
    const directory = await this.directory(normalized);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    return (directory?.entries ?? []).map((entry) => ({ path: `${prefix}${entry.name}`, entry }));
  }

  /**
   * What a path read of `path` holds at the current root (tree operations
   * §1.2.4): the directories down to it and the objects of the entries it
   * names. The directories it reads are kept.
   */
  async pathRead(path: string): Promise<Map<ObjectHash, Uint8Array>> {
    const objects = await pathReadObjects(this.rootHash, path, (hash) => this.source.object(hash));
    for (const [hash, bytes] of objects) {
      if (this.directories.has(hash)) continue;
      try { this.directories.set(hash, decodeProtocolDirectory(bytes)); } catch { /* a page or file, not a directory */ }
    }
    return objects;
  }

  /**
   * Run a prefetch policy over the index: `opened-pages` loads nothing ahead;
   * `directories-and-pages` loads every directory and Markdown body;
   * `everything` every object. `fetch` receives each object it needs, for a
   * caller that keeps them (a disk cache, a replica).
   */
  async prefetch(policy: Prefetch, fetch: (hash: ObjectHash) => Promise<unknown> = (hash) => this.source.object(hash)): Promise<void> {
    if (policy === "opened-pages") return;
    const visit = async (hash: ObjectHash): Promise<void> => {
      const directory = await this.load(hash);
      await fetch(hash);
      await Promise.all((directory?.entries ?? []).map(async (entry) => {
        if (entry.directory) return visit(entry.directory as ObjectHash);
        const object = (entry.page ?? entry.file) as ObjectHash | undefined;
        if (!object) return;
        if (policy === "everything" || entry.page || /\.mdx?$/.test(entry.name)) await fetch(object);
      }));
    };
    await visit(this.rootHash);
  }
}
