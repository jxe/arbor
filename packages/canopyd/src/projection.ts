import {
  canonicalNodePath,
  isPageID,
  pageIDStableKey,
  parseMarkdown,
  resolveProtocolLogicalNode,
  type CollectionFileDescriptor,
  type ObjectHash,
  type ResolvedProtocolLogicalNode,
  type ProtocolDirectory,
} from "@overstory/protocol";
import {
  decodeProtocolCollectionFile,
  unsupportedLegacyCollection,
  type DecodedProtocolCollectionFile,
  type ProtocolCollectionFileRow,
} from "@overstory/collection-schema";

export interface ProtocolProjectionOptions {
  root: ObjectHash;
  load(hash: ObjectHash): Promise<Uint8Array>;
}

export type ProtocolResolution =
  | { kind: "node"; path: string; node: ResolvedProtocolLogicalNode }
  | { kind: "collection-file-row"; path: string; row: ProtocolCollectionFileRow; descriptor: CollectionFileDescriptor }
  | { kind: "missing"; path: string };

function protocolNodeStableKey(node: ResolvedProtocolLogicalNode): string | null {
  const file = node.kind === "file" ? node.bytes : node.body;
  if (!file) return null;
  const id = parseMarkdown(new TextDecoder().decode(file)).frontmatter.id;
  return isPageID(id) ? pageIDStableKey(id) : null;
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
    // Retired version-1 collections are an explicit unsupported read, never ordinary files.
    if (descriptor.version !== 2) throw unsupportedLegacyCollection();
    const sourceHash = directory.entries.find((entry) => entry.name === descriptor.source)?.file;
    const schemaHash = directory.entries.find((entry) => entry.name === descriptor.schemaSource)?.file;
    if (!sourceHash || !schemaHash) throw new Error("Collection-file sources are missing");
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

  private async findNodeByStableKey(stableKey: string): Promise<Extract<ProtocolResolution, { kind: "node" }> | null> {
    const pending = ["/"];
    const visited = new Set<string>();
    while (pending.length) {
      if (visited.size >= 10_000) throw new Error("Stable-key resolution exceeded the tree traversal limit");
      const path = pending.shift()!;
      if (visited.has(path)) continue;
      visited.add(path);
      const node = await resolveProtocolLogicalNode(this.options.root, path, this.options.load);
      if (!node) continue;
      if (protocolNodeStableKey(node) === stableKey) return { kind: "node", path, node };
      if (node.kind !== "directory") continue;
      const directories = new Set(node.directory.entries
        .filter((entry) => !entry.tree && (entry.file ?? entry.directory) && entry.name !== "_index.md" && !entry.name.endsWith(".md"))
        .map((entry) => entry.name));
      for (const entry of node.directory.entries) {
        if (entry.tree || !(entry.file ?? entry.directory) || entry.name === "_index.md") continue;
        const name = entry.name.endsWith(".md") ? entry.name.slice(0, -3) : entry.name;
        if (entry.name.endsWith(".md") && directories.has(name)) continue;
        pending.push(canonicalNodePath(`${path === "/" ? "" : path}/${name}`));
      }
    }
    return null;
  }
}
