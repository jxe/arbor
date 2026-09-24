import {
  canonicalNodePath,
  isPageID,
  pageIDStableKey,
  parseMarkdown,
  resolveWireLogicalNode,
  type CollectionFileDescriptor,
  type ObjectHash,
  type ResolvedWireLogicalNode,
  type WireDirectory,
} from "@overstory/protocol";
import { decodeWireCollectionFile, SchemaSandbox, type DecodedWireCollectionFile, type WireCollectionFileRow } from "@overstory/apps-runtime/collections";

export interface WireProjectionOptions {
  root: ObjectHash;
  load(hash: ObjectHash): Promise<Uint8Array>;
}

export type WireResolution =
  | { kind: "node"; path: string; node: ResolvedWireLogicalNode }
  | { kind: "collection-file-row"; path: string; row: WireCollectionFileRow; descriptor: CollectionFileDescriptor }
  | { kind: "missing"; path: string };

function wireNodeStableKey(node: ResolvedWireLogicalNode): string | null {
  const file = node.kind === "file" ? node.bytes : node.body;
  if (!file) return null;
  const id = parseMarkdown(new TextDecoder().decode(file)).frontmatter.id;
  return isPageID(id) ? pageIDStableKey(id) : null;
}

export function wireCollectionFileRowTitle(row: WireCollectionFileRow): string {
  return typeof row.properties.title === "string" ? row.properties.title
    : typeof row.properties.name === "string" ? row.properties.name
    : typeof row.properties.slug === "string" ? row.properties.slug
    : row.path;
}

export function wireCollectionFileRowMarkdown(row: WireCollectionFileRow): string {
  const json = JSON.stringify(row.properties, null, 2);
  const longest = Math.max(2, ...[...json.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `# ${wireCollectionFileRowTitle(row).replaceAll(/\r?\n/g, " ")}\n\n${fence}json\n${json}\n${fence}\n`;
}

/** Path and stable-key resolution over a content-addressed Wire tree. */
export class WireProjection {
  constructor(private readonly options: WireProjectionOptions) {}

  async collectionFile(directory: WireDirectory): Promise<DecodedWireCollectionFile | null> {
    const descriptor = directory.childrenSource;
    if (!descriptor) return null;
    const sourceHash = directory.entries.find((entry) => entry.name === descriptor.source)?.file;
    const schemaHash = directory.entries.find((entry) => entry.name === descriptor.schemaSource)?.file;
    if (!sourceHash || !schemaHash) throw new Error("Collection-file sources are missing");
    const [source, schema] = await Promise.all([
      this.options.load(sourceHash),
      this.options.load(schemaHash),
    ]);
    const sandbox = new SchemaSandbox();
    try { return await decodeWireCollectionFile(descriptor, source, schema, sandbox); }
    finally { await sandbox[Symbol.asyncDispose](); }
  }

  async resolve(requestedPath: string, stableKey: string | null = null): Promise<WireResolution> {
    const path = canonicalNodePath(requestedPath);
    let node = await resolveWireLogicalNode(this.options.root, path, this.options.load);
    if (node && (!stableKey || wireNodeStableKey(node) === stableKey)) return { kind: "node", path, node };

    const collectionFileRow = await this.findCollectionFileRow(path, stableKey);
    if (collectionFileRow) return collectionFileRow;
    if (!stableKey) return { kind: "missing", path };

    const healed = await this.findNodeByStableKey(stableKey);
    return healed ?? { kind: "missing", path };
  }

  private async findCollectionFileRow(path: string, stableKey: string | null): Promise<Extract<WireResolution, { kind: "collection-file-row" }> | null> {
    if (path === "/") return null;
    const parentPath = path.slice(0, path.lastIndexOf("/")) || "/";
    const parent = await resolveWireLogicalNode(this.options.root, parentPath, this.options.load);
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

  private async findNodeByStableKey(stableKey: string): Promise<Extract<WireResolution, { kind: "node" }> | null> {
    const pending = ["/"];
    const visited = new Set<string>();
    while (pending.length) {
      if (visited.size >= 10_000) throw new Error("Stable-key resolution exceeded the tree traversal limit");
      const path = pending.shift()!;
      if (visited.has(path)) continue;
      visited.add(path);
      const node = await resolveWireLogicalNode(this.options.root, path, this.options.load);
      if (!node) continue;
      if (wireNodeStableKey(node) === stableKey) return { kind: "node", path, node };
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
