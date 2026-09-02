import type {
  Diagnostic,
  Hash,
  JSONValue,
  LocalTreeDescriptor,
  NodeResponse,
  NodeSummary,
  RollupDescriptor,
  TreeRef,
} from "@arbor/core";
import {
  stableJSONString,
  canonicalNodePath,
  mediaTypeForPath,
  toJSONValue,
  isPageID,
  pageIDStableKey,
  revisionOf,
} from "@arbor/core";
import { directoryPlacementDiagnostics, parseMarkdown } from "@arbor/editor";
import {
  decodeWireFileRollup,
  SchemaSandbox,
  type DecodedWireFileRollup,
  type WireFileRollupRow,
} from "@arbor/stores";
import {
  decodeWireObject,
  resolveWireLogicalNode,
  type ObjectHash,
  type ResolvedWireLogicalNode,
} from "@arbor/wire";

export interface WireProjectionOptions {
  tree: TreeRef;
  root: ObjectHash;
  load(hash: ObjectHash): Promise<Uint8Array>;
  rootName: string;
  observedThrough: string;
  enclosingTree?: LocalTreeDescriptor;
  includeBoundary?(path: string): boolean | Promise<boolean>;
}

export type WireResolution =
  | { kind: "node"; path: string; node: ResolvedWireLogicalNode }
  | { kind: "rollup-row"; path: string; row: WireFileRollupRow; descriptor: RollupDescriptor }
  | { kind: "missing"; path: string };

export interface WireNodeProjection {
  resolution: Exclude<WireResolution, { kind: "missing" }>;
  snapshot: NodeResponse;
  children: NodeSummary[];
}

export function wireNodeStableKey(node: ResolvedWireLogicalNode): string | null {
  const file = node.object.type === "file" ? node.object : node.body;
  if (!file) return null;
  const id = parseMarkdown(new TextDecoder().decode(file.bytes)).frontmatter.id;
  return isPageID(id) ? pageIDStableKey(id) : null;
}

export function wireRollupRowTitle(row: WireFileRollupRow): string {
  return typeof row.properties.title === "string" ? row.properties.title
    : typeof row.properties.name === "string" ? row.properties.name
    : typeof row.properties.slug === "string" ? row.properties.slug
    : row.path;
}

export function wireRollupRowMarkdown(row: WireFileRollupRow): string {
  const json = JSON.stringify(row.properties, null, 2);
  const longest = Math.max(2, ...[...json.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `# ${wireRollupRowTitle(row).replaceAll(/\r?\n/g, " ")}\n\n${fence}json\n${json}\n${fence}\n`;
}

function properties(value: unknown): Record<string, JSONValue> {
  return (toJSONValue(value) ?? {}) as Record<string, JSONValue>;
}

/** Immutable node-model projection over a content-addressed Wire tree. */
export class WireProjection {
  constructor(private readonly options: WireProjectionOptions) {}

  async rollup(descriptor: RollupDescriptor): Promise<DecodedWireFileRollup> {
    const [source, schema] = await Promise.all([
      this.options.load(descriptor.source).then(decodeWireObject),
      this.options.load(descriptor.schemaSource).then(decodeWireObject),
    ]);
    if (source.type !== "file" || schema.type !== "file") throw new Error("Wire rollup targets must be file objects");
    const sandbox = new SchemaSandbox();
    try { return await decodeWireFileRollup(descriptor, source.bytes, schema.bytes, sandbox); }
    finally { await sandbox[Symbol.asyncDispose](); }
  }

  async resolve(requestedPath: string, stableKey: string | null = null): Promise<WireResolution> {
    const path = canonicalNodePath(requestedPath);
    let node = await resolveWireLogicalNode(this.options.root, path, this.options.load);
    if (node && (!stableKey || wireNodeStableKey(node) === stableKey)) return { kind: "node", path, node };

    const rollupRow = await this.findRollupRow(path, stableKey);
    if (rollupRow) return rollupRow;
    if (!stableKey) return { kind: "missing", path };

    const healed = await this.findNodeByStableKey(stableKey);
    return healed ?? { kind: "missing", path };
  }

  async project(requestedPath: string, stableKey: string | null = null): Promise<WireNodeProjection | null> {
    const resolution = await this.resolve(requestedPath, stableKey);
    if (resolution.kind === "missing") return null;
    if (resolution.kind === "rollup-row") {
      return { resolution, snapshot: this.rollupRowSummary(
        resolution.path.slice(0, resolution.path.lastIndexOf("/")) || "/",
        resolution.descriptor.schema,
        resolution.row,
      ), children: [] };
    }

    const { node, path } = resolution;
    const object = node.object;
    const objectName = node.objectName || (path === "/" ? this.options.rootName : path.split("/").at(-1)!) || this.options.rootName;
    const diagnostics: Diagnostic[] = node.duplicateBody ? [{
      code: "duplicate-body-representation",
      message: `${path} has both a sibling Markdown body and _index.md; keep only one.`,
      path,
      severity: "error",
    }] : [];
    if (object.type === "file") {
      const markdown = objectName.endsWith(".md");
      const document = markdown ? parseMarkdown(new TextDecoder().decode(object.bytes)) : undefined;
      const authoredTitle = document?.blocks.find((block) => block.type === "heading" && Number(block.props?.level ?? 1) === 1)?.content;
      const revision = revisionOf(object.bytes);
      return {
        resolution,
        snapshot: this.response({
          path,
          name: authoredTitle || (markdown ? objectName.slice(0, -3) : objectName),
          revision,
          stableKey: document && isPageID(document.frontmatter.id) ? pageIDStableKey(document.frontmatter.id) : null,
          properties: properties(document?.frontmatter),
          capabilities: document ? {
            properties: { revision, writable: false },
            content: { revision, mediaType: "text/markdown", format: "markdown", writable: false },
          } : { content: { revision, mediaType: mediaTypeForPath(path), writable: false } },
          ...(document ? { content: { source: document.source, representation: { state: "stored", origin: "sibling" } as const } } : {}),
          diagnostics,
        }),
        children: [],
      };
    }

    const source = node.body ? new TextDecoder().decode(node.body.bytes) : "";
    const rollupDescriptor = object.entries.find((entry) => entry.rollup)?.rollup;
    const rollup = rollupDescriptor ? await this.rollup(rollupDescriptor) : null;
    const children = (await Promise.all(object.entries
      .filter((entry) => entry.name !== "_index.md" && !entry.rollup && !(rollupDescriptor && entry.name === "schema.ts"))
      .map(async (entry) => {
        const childObject = entry.hash ? decodeWireObject(await this.options.load(entry.hash)) : null;
        const markdown = childObject?.type === "file" && entry.name.endsWith(".md");
        const name = markdown ? entry.name.slice(0, -3) : entry.name;
        const childPath = canonicalNodePath(`${path === "/" ? "" : path}/${name}`);
        if (entry.tree && this.options.includeBoundary && !await this.options.includeBoundary(childPath)) return null;
        const document = markdown && childObject?.type === "file"
          ? parseMarkdown(new TextDecoder().decode(childObject.bytes))
          : undefined;
        const revision = entry.hash ?? entry.tree ?? revisionOf(childPath);
        const stableKey = document && isPageID(document.frontmatter.id) ? pageIDStableKey(document.frontmatter.id) : null;
        const kind = entry.tree || childObject?.type === "directory" ? "directory" : markdown ? "markdown" : "file";
        const summary: NodeSummary = {
          ref: { tree: this.options.tree, path: childPath, stableKey },
          name,
          revision,
          properties: properties(document?.frontmatter),
          capabilities: document ? {
            properties: { revision, writable: false },
            content: { revision, mediaType: "text/markdown", format: "markdown", writable: false },
          } : kind === "file" ? { content: { revision, mediaType: mediaTypeForPath(childPath), writable: false } } : {},
          materialization: "available",
          diagnostics: [],
        };
        return { summary, descriptor: { path: childPath, kind, pageID: document?.frontmatter.id ?? null } };
      }))).filter((child): child is NonNullable<typeof child> => child !== null);
    if (rollup && rollupDescriptor) {
      for (const row of rollup.rows) {
        children.push({
          summary: this.rollupRowSummary(path, rollupDescriptor.schema, row),
          descriptor: { path: canonicalNodePath(`${path === "/" ? "" : path}/${row.path}`), kind: "file", pageID: null },
        });
      }
    }
    const document = parseMarkdown(source);
    const authoredTitle = document.blocks.find((block) => block.type === "heading" && Number(block.props?.level ?? 1) === 1)?.content;
    const descriptors = children.map(({ descriptor }) => descriptor)
      .sort((left, right) => Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
    const revision = revisionOf(`${source}\0${JSON.stringify(descriptors)}`);
    const snapshot = this.response({
      path,
      name: authoredTitle || objectName,
      revision,
      stableKey: isPageID(document.frontmatter.id) ? pageIDStableKey(document.frontmatter.id) : null,
      properties: properties(document.frontmatter),
      capabilities: {
        properties: { revision, writable: false },
        content: { revision, mediaType: "text/markdown", format: "markdown", writable: false },
        children: rollup && rollupDescriptor ? {
          revision: rollupDescriptor.source,
          schema: rollupDescriptor.schema,
          representation: {
            type: "rollup",
            codec: rollupDescriptor.codec,
            scope: rollupDescriptor.scope,
            modelDigest: rollupDescriptor.modelDigest,
          },
          total: rollup.rows.length,
          writable: false,
        } : { revision, representation: { type: "expanded" }, total: children.length, writable: false },
      },
      content: {
        source: document.source,
        representation: node.bodyOrigin
          ? { state: "stored", origin: node.bodyOrigin }
          : { state: "implicit" },
      },
      diagnostics: [...diagnostics, ...directoryPlacementDiagnostics(path, document)],
    });
    return { resolution, snapshot, children: children.map((child) => child.summary) };
  }

  private response(snapshot: Omit<NodeResponse, "ref" | "materialization" | "observedThrough" | "enclosingTree"> & {
    path: string;
    stableKey: string | null;
  }): NodeResponse {
    const { path, stableKey, ...rest } = snapshot;
    return {
      ...rest,
      ref: { tree: this.options.tree, path, stableKey },
      materialization: "available",
      observedThrough: this.options.observedThrough,
      ...(this.options.enclosingTree ? { enclosingTree: this.options.enclosingTree } : {}),
    };
  }

  private rollupRowSummary(parentPath: string, schema: Hash, row: WireFileRollupRow): NodeResponse {
    const revision = revisionOf(stableJSONString({ schema, properties: row.properties }));
    return this.response({
      path: canonicalNodePath(`${parentPath === "/" ? "" : parentPath}/${row.path}`),
      stableKey: row.stableKey,
      name: wireRollupRowTitle(row),
      revision,
      properties: row.properties,
      capabilities: { properties: { revision, schema, writable: false } },
      diagnostics: [],
    });
  }

  private async findRollupRow(path: string, stableKey: string | null): Promise<Extract<WireResolution, { kind: "rollup-row" }> | null> {
    if (path === "/") return null;
    const parentPath = path.slice(0, path.lastIndexOf("/")) || "/";
    const parent = await resolveWireLogicalNode(this.options.root, parentPath, this.options.load);
    if (parent?.object.type !== "directory") return null;
    const descriptor = parent.object.entries.find((entry) => entry.rollup)?.rollup;
    if (!descriptor) return null;
    const projection = await this.rollup(descriptor);
    const segment = path.split("/").at(-1)!;
    const row = projection.rows.find((candidate) => stableKey
      ? candidate.stableKey === stableKey
      : candidate.path === segment);
    return row ? {
      kind: "rollup-row",
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
      if (node.object.type !== "directory") continue;
      const directories = new Set(node.object.entries
        .filter((entry) => !entry.tree && entry.hash && entry.name !== "_index.md" && !entry.name.endsWith(".md"))
        .map((entry) => entry.name));
      for (const entry of node.object.entries) {
        if (entry.tree || !entry.hash || entry.name === "_index.md") continue;
        const name = entry.name.endsWith(".md") ? entry.name.slice(0, -3) : entry.name;
        if (entry.name.endsWith(".md") && directories.has(name)) continue;
        pending.push(canonicalNodePath(`${path === "/" ? "" : path}/${name}`));
      }
    }
    return null;
  }
}
