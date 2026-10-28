import {
  canonicalNodePath,
  isPageID,
  markdownStableKey,
  parseMarkdown,
  decodeProtocolDirectory,
  loadProtocolContent,
  protocolContentObject,
  hashObject,
  resolveProtocolLogicalNode,
  type JSONValue,
  type ObjectHash,
  type ResolvedProtocolLogicalNode,
  type ProtocolDirectory,
  type ProtocolDirectoryEntry,
} from "@ovst/protocol";
import { collectionRowProperties, loadDirectoryCollection, type CollectionSchemaCache } from "@ovst/collection-schema";

export interface ProtocolProjectionOptions {
  root: ObjectHash;
  load(hash: ObjectHash): Promise<Uint8Array>;
  schemas?: CollectionSchemaCache;
}

/** One row of a logical collection, as a page. */
export interface ProtocolCollectionRow {
  model: string;
  stableKey: string;
  /** Its logical name. */
  path: string;
  /** Its key fields, fields and times. */
  properties: Record<string, JSONValue>;
}

/** A model's rows: the folder's own children for the main model (`table: null`), else a child named after the model. */
export interface ProtocolCollectionTable {
  table: string | null;
  rows: ProtocolCollectionRow[];
}

export type ProtocolResolution =
  | { kind: "node"; path: string; node: ResolvedProtocolLogicalNode }
  | { kind: "collection-row"; path: string; row: ProtocolCollectionRow }
  /** A model other than the main one: its rows are its children. */
  | { kind: "collection-table"; path: string; table: ProtocolCollectionTable }
  | { kind: "missing"; path: string };

/** A Markdown document's frontmatter `id` is its stable key; a directory's is
 * its body's. Other files carry none. */
function protocolNodeStableKey(node: ResolvedProtocolLogicalNode): string | null {
  const file = node.kind === "file" ? isMarkdownName(node.objectName) ? node.bytes : undefined : node.body;
  if (!file) return null;
  const id = parseMarkdown(new TextDecoder().decode(file)).frontmatter.id;
  return isPageID(id) ? markdownStableKey(id) : null;
}

function isMarkdownName(name: string): boolean {
  return name.endsWith(".md");
}

export function protocolCollectionRowTitle(row: ProtocolCollectionRow): string {
  return typeof row.properties.title === "string" ? row.properties.title
    : typeof row.properties.name === "string" ? row.properties.name
    : typeof row.properties.slug === "string" ? row.properties.slug
    : row.path;
}

export function protocolCollectionRowMarkdown(row: ProtocolCollectionRow): string {
  const json = JSON.stringify(row.properties, null, 2);
  const longest = Math.max(2, ...[...json.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `# ${protocolCollectionRowTitle(row).replaceAll(/\r?\n/g, " ")}\n\n${fence}json\n${json}\n${fence}\n`;
}

/** Path and stable-key resolution over a content-addressed protocol tree. */
export class ProtocolProjection {
  constructor(private readonly options: ProtocolProjectionOptions) {}

  /** The validated tables of a collection directory, one per model with
   * data rows: the main model's are the directory's children (`table: null`),
   * each other's a child named after its model. */
  async collectionTables(directory: ProtocolDirectory): Promise<ProtocolCollectionTable[] | null> {
    const collection = await loadDirectoryCollection(directory, this.options.load, this.options.schemas);
    if (!collection) return null;
    return [...collection.rows].map(([model, rows]) => ({
      table: model === collection.main ? null : model,
      rows: rows.map((row) => ({ model, stableKey: row.stableKey, path: row.name, properties: collectionRowProperties(row.row) })),
    }));
  }

  async resolve(requestedPath: string, stableKey: string | null = null): Promise<ProtocolResolution> {
    const path = canonicalNodePath(requestedPath);
    let node = await resolveProtocolLogicalNode(this.options.root, path, this.options.load);
    if (node && (!stableKey || protocolNodeStableKey(node) === stableKey)) return { kind: "node", path, node };

    const collectionRow = await this.findCollectionRow(path, stableKey);
    if (collectionRow) return collectionRow;
    if (!stableKey) return { kind: "missing", path };

    const healed = await this.findNodeByStableKey(stableKey);
    return healed ?? { kind: "missing", path };
  }

  private async findCollectionRow(path: string, stableKey: string | null): Promise<Extract<ProtocolResolution, { kind: "collection-row" | "collection-table" }> | null> {
    if (path === "/") return null;
    const segments = path.split("/").filter(Boolean);
    const within = async (folder: string[], table: string | null, segment: string) => {
      const folderPath = `/${folder.join("/")}`;
      const parent = await resolveProtocolLogicalNode(this.options.root, folderPath, this.options.load);
      if (parent?.kind !== "directory" || !parent.directory.collection) return null;
      const tables = await this.collectionTables(parent.directory);
      if (!tables) return null;
      if (table === null) {
        const found = tables.find((t) => t.table === segment);
        if (found) return stableKey ? null : { kind: "collection-table" as const, path: canonicalNodePath(`/${[...folder, segment].join("/")}`), table: found };
      }
      const decoded = tables.find((t) => t.table === table);
      const row = decoded?.rows.find((candidate) => stableKey ? candidate.stableKey === stableKey : candidate.path === segment);
      const names = [...folder, ...(table === null ? [] : [table]), row?.path];
      return row ? { kind: "collection-row" as const, path: canonicalNodePath(`/${names.join("/")}`), row } : null;
    };
    const segment = segments.at(-1)!;
    return await within(segments.slice(0, -1), null, segment)
      ?? (segments.length >= 2 ? await within(segments.slice(0, -2), segments.at(-2)!, segment) : null);
  }

  /** Breadth-first search of the tree for a node with this stable key. Each
   * child resolves from its parent's loaded directory exactly as
   * resolveProtocolLogicalNode would, and a file is read only when it is
   * Markdown, the only kind that can carry a key. */
  private async findNodeByStableKey(stableKey: string): Promise<Extract<ProtocolResolution, { kind: "node" }> | null> {
    const load = async (hash: ObjectHash) => {
      const bytes = await this.options.load(hash);
      if (hashObject(bytes) !== hash) throw new Error(`Object hash mismatch: ${hash}`);
      return bytes;
    };
    const directoryNode = async (directory: ProtocolDirectory, objectName: string, sibling?: ProtocolDirectoryEntry): Promise<Extract<ResolvedProtocolLogicalNode, { kind: "directory" }>> => {
      const index = directory.entries.find((entry) => entry.name === "_index.md");
      if (index && !protocolContentObject(index)) throw new Error("Directory _index.md body must be a file or page");
      if (sibling && !protocolContentObject(sibling)) throw new Error("Sibling Markdown body must be a file or page");
      const node = { kind: "directory" as const, directory, objectName };
      if (index) return { ...node, body: await loadProtocolContent(index, load), bodyOrigin: "index", shadowedBody: !!sibling };
      if (sibling) return { ...node, body: await loadProtocolContent(sibling, load), bodyOrigin: "sibling", shadowedBody: false };
      return { ...node, shadowedBody: false };
    };
    const root = await directoryNode(decodeProtocolDirectory(await load(this.options.root)), "");
    if (protocolNodeStableKey(root) === stableKey) return { kind: "node", path: "/", node: root };
    const pending: Array<{ path: string; directory: ProtocolDirectory }> = [{ path: "/", directory: root.directory }];
    const visited = new Set(["/"]);
    while (pending.length) {
      const { path, directory } = pending.shift()!;
      const directories = new Set(directory.entries
        .filter((entry) => !entry.tree && (entry.file ?? entry.page ?? entry.directory) && entry.name !== "_index.md" && !isMarkdownName(entry.name))
        .map((entry) => entry.name));
      for (const entry of directory.entries) {
        if (entry.tree || !(entry.file ?? entry.page ?? entry.directory) || entry.name === "_index.md") continue;
        const name = isMarkdownName(entry.name) ? entry.name.slice(0, -3) : entry.name;
        if (isMarkdownName(entry.name) && directories.has(name)) continue;
        const childPath = canonicalNodePath(`${path === "/" ? "" : path}/${name}`);
        if (visited.has(childPath)) continue;
        if (visited.size >= 10_000) throw new Error("Stable-key resolution exceeded the tree traversal limit");
        visited.add(childPath);
        // One step of resolveProtocolLogicalNode, from the loaded parent.
        const exact = directory.entries.find((candidate) => candidate.name === name);
        const sibling = directory.entries.find((candidate) => candidate.name === `${name}.md`);
        if (exact?.tree) continue;
        if (exact?.directory) {
          const node = await directoryNode(decodeProtocolDirectory(await load(exact.directory)), exact.name, sibling);
          if (protocolNodeStableKey(node) === stableKey) return { kind: "node", path: childPath, node };
          pending.push({ path: childPath, directory: node.directory });
          continue;
        }
        const file = protocolContentObject(exact) ? exact : protocolContentObject(sibling) ? sibling : undefined;
        if (!file || !isMarkdownName(file.name)) continue;
        const node: ResolvedProtocolLogicalNode = { kind: "file", bytes: await loadProtocolContent(file, load), objectName: file.name, shadowedBody: false };
        if (protocolNodeStableKey(node) === stableKey) return { kind: "node", path: childPath, node };
      }
    }
    return null;
  }
}
