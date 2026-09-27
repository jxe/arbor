import {
  canonicalNodePath,
  isPageID,
  markdownStableKey,
  parseMarkdown,
  decodeProtocolDirectory,
  hashObject,
  resolveProtocolLogicalNode,
  type CollectionFileDescriptor,
  type ObjectHash,
  type ResolvedProtocolLogicalNode,
  type ProtocolDirectory,
  type ProtocolDirectoryEntry,
} from "@overstory/protocol";
import {
  decodeProtocolCollectionFile,
  type DecodedProtocolCollectionFile,
  type ProtocolCollectionFileRow,
} from "@overstory/collection-schema";
import { ServerFaultError } from "./errors.ts";

export interface ProtocolProjectionOptions {
  root: ObjectHash;
  load(hash: ObjectHash): Promise<Uint8Array>;
}

export type ProtocolResolution =
  | { kind: "node"; path: string; node: ResolvedProtocolLogicalNode }
  | { kind: "collection-file-row"; path: string; row: ProtocolCollectionFileRow; descriptor: CollectionFileDescriptor }
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

export function protocolCollectionFileRowTitle(row: ProtocolCollectionFileRow): string {
  return typeof row.properties.title === "string" ? row.properties.title
    : typeof row.properties.name === "string" ? row.properties.name
    : typeof row.properties.slug === "string" ? row.properties.slug
    : row.path;
}

export function protocolCollectionFileRowMarkdown(row: ProtocolCollectionFileRow): string {
  const json = JSON.stringify(row.properties, null, 2);
  const longest = Math.max(2, ...[...json.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `# ${protocolCollectionFileRowTitle(row).replaceAll(/\r?\n/g, " ")}\n\n${fence}json\n${json}\n${fence}\n`;
}

/** Path and stable-key resolution over a content-addressed protocol tree. */
export class ProtocolProjection {
  constructor(private readonly options: ProtocolProjectionOptions) {}

  async collectionFile(directory: ProtocolDirectory): Promise<DecodedProtocolCollectionFile | null> {
    const descriptor = directory.childrenSource;
    if (!descriptor) return null;
    const sourceHash = directory.entries.find((entry) => entry.name === descriptor.source)?.file;
    const schemaHash = directory.entries.find((entry) => entry.name === descriptor.schemaSource)?.file;
    if (!sourceHash || !schemaHash) throw new ServerFaultError("Collection-file sources are missing");
    const [source, schema] = await Promise.all([
      this.options.load(sourceHash),
      this.options.load(schemaHash),
    ]);
    return decodeProtocolCollectionFile(descriptor, source, schema);
  }

  async resolve(requestedPath: string, stableKey: string | null = null): Promise<ProtocolResolution> {
    const path = canonicalNodePath(requestedPath);
    let node = await resolveProtocolLogicalNode(this.options.root, path, this.options.load);
    if (node && (!stableKey || protocolNodeStableKey(node) === stableKey)) return { kind: "node", path, node };

    const collectionFileRow = await this.findCollectionFileRow(path, stableKey);
    if (collectionFileRow) return collectionFileRow;
    if (!stableKey) return { kind: "missing", path };

    const healed = await this.findNodeByStableKey(stableKey);
    return healed ?? { kind: "missing", path };
  }

  private async findCollectionFileRow(path: string, stableKey: string | null): Promise<Extract<ProtocolResolution, { kind: "collection-file-row" }> | null> {
    if (path === "/") return null;
    const parentPath = path.slice(0, path.lastIndexOf("/")) || "/";
    const parent = await resolveProtocolLogicalNode(this.options.root, parentPath, this.options.load);
    if (parent?.kind !== "directory") return null;
    const descriptor = parent.directory.childrenSource;
    if (!descriptor) return null;
    const projection = await this.collectionFile(parent.directory);
    if (!projection) return null;
    const segment = path.split("/").at(-1)!;
    const row = projection.rows.find((candidate) => stableKey
      ? candidate.stableKey === stableKey
      : candidate.path === segment);
    return row ? {
      kind: "collection-file-row",
      path: canonicalNodePath(`${parentPath === "/" ? "" : parentPath}/${row.path}`),
      row,
      descriptor,
    } : null;
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
      if (index && !index.file) throw new Error("Directory _index.md body must be a file");
      if (sibling && !sibling.file) throw new Error("Sibling Markdown body must be a file");
      const node = { kind: "directory" as const, directory, objectName };
      if (index?.file) return { ...node, body: await load(index.file), bodyOrigin: "index", shadowedBody: !!sibling?.file };
      if (sibling?.file) return { ...node, body: await load(sibling.file), bodyOrigin: "sibling", shadowedBody: false };
      return { ...node, shadowedBody: false };
    };
    const root = await directoryNode(decodeProtocolDirectory(await load(this.options.root)), "");
    if (protocolNodeStableKey(root) === stableKey) return { kind: "node", path: "/", node: root };
    const pending: Array<{ path: string; directory: ProtocolDirectory }> = [{ path: "/", directory: root.directory }];
    const visited = new Set(["/"]);
    while (pending.length) {
      const { path, directory } = pending.shift()!;
      const directories = new Set(directory.entries
        .filter((entry) => !entry.tree && (entry.file ?? entry.directory) && entry.name !== "_index.md" && !isMarkdownName(entry.name))
        .map((entry) => entry.name));
      for (const entry of directory.entries) {
        if (entry.tree || !(entry.file ?? entry.directory) || entry.name === "_index.md") continue;
        const name = isMarkdownName(entry.name) ? entry.name.slice(0, -3) : entry.name;
        if (isMarkdownName(entry.name) && directories.has(name)) continue;
        const childPath = canonicalNodePath(`${path === "/" ? "" : path}/${name}`);
        if (visited.has(childPath)) continue;
        if (visited.size >= 10_000) throw new Error("Stable-key resolution exceeded the tree traversal limit");
        visited.add(childPath);
        // One step of resolveProtocolLogicalNode, from the loaded parent.
        if (name === directory.childrenSource?.source || name === directory.childrenSource?.schemaSource) continue;
        const exact = directory.entries.find((candidate) => candidate.name === name);
        const sibling = directory.entries.find((candidate) => candidate.name === `${name}.md`);
        if (exact?.tree) continue;
        if (exact?.directory) {
          const node = await directoryNode(decodeProtocolDirectory(await load(exact.directory)), exact.name, sibling);
          if (protocolNodeStableKey(node) === stableKey) return { kind: "node", path: childPath, node };
          pending.push({ path: childPath, directory: node.directory });
          continue;
        }
        const file = exact?.file ? exact : sibling?.file ? sibling : undefined;
        if (!file?.file || !isMarkdownName(file.name)) continue;
        const node: ResolvedProtocolLogicalNode = { kind: "file", bytes: await load(file.file), objectName: file.name, shadowedBody: false };
        if (protocolNodeStableKey(node) === stableKey) return { kind: "node", path: childPath, node };
      }
    }
    return null;
  }
}
