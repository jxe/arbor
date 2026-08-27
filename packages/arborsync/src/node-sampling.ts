import type {
  Hash,
  JSONValue,
  LocalTreeDescriptor,
  NodeCapabilities,
  NodeResponse,
  NodeSummary,
  TreeRef,
} from "@arbor/core";
import type { CollectionPage, CollectionRow, TreeNode } from "@arbor/core/internal";
import { canonicalJSONString, canonicalStableKey, isPageID, pageIDStableKey, sha256 } from "@arbor/core";

function jsonValue(value: unknown): JSONValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const result: JSONValue[] = [];
    for (const item of value) {
      const converted = jsonValue(item);
      if (converted !== undefined) result.push(converted);
    }
    return result;
  }
  if (value && typeof value === "object") {
    const result: Record<string, JSONValue> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = jsonValue(item);
      if (converted !== undefined) result[key] = converted;
    }
    return result;
  }
  return undefined;
}

export function nodeProperties(node: TreeNode): Record<string, JSONValue> {
  return (jsonValue(node.document?.frontmatter ?? {}) ?? {}) as Record<string, JSONValue>;
}

export function collectionRowSummary(
  row: CollectionRow,
  page: CollectionPage,
  parentPath: string,
  tree: TreeRef,
): NodeSummary {
  const properties = (jsonValue(row.values) ?? {}) as Record<string, JSONValue>;
  const id = properties.id;
  const stableKey = page.backing === "markdown" && (
    typeof id === "string" || typeof id === "number" || typeof id === "boolean"
  )
    ? canonicalStableKey([["id", id]])
    : null;
  const segment = row.path ?? row.key.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const revision = row.revision ?? digest({ key: row.key, properties });
  return {
    ref: {
      tree,
      path: `${parentPath === "/" ? "" : parentPath}/${segment}`,
      stableKey,
    },
    name: typeof properties.title === "string" ? properties.title
      : typeof properties.name === "string" ? properties.name
      : typeof properties.slug === "string" ? properties.slug
      : segment,
    revision,
    properties,
    capabilities: {
      properties: {
        revision,
        schema: digest({ columns: page.columns }),
        writable: page.editable,
      },
      ...(page.backing === "markdown" ? {
        content: {
          revision,
          mediaType: "text/markdown",
          format: "markdown" as const,
          writable: page.editable,
        },
      } : {}),
    },
    materialization: "available",
    diagnostics: row.diagnostics,
  };
}

function digest(value: unknown): Hash {
  return `sha256:${sha256(canonicalJSONString(value))}`;
}

function mediaType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "gif") return "image/gif";
  if (extension === "svg") return "image/svg+xml";
  if (extension === "pdf") return "application/pdf";
  if (extension === "json") return "application/json";
  if (["txt", "css", "js", "ts", "tsx", "csv"].includes(extension)) return "text/plain";
  return "application/octet-stream";
}

function capabilities(node: TreeNode, writable: boolean): NodeCapabilities {
  const result: NodeCapabilities = {};
  if (node.document) {
    result.properties = {
      revision: node.revision,
      writable,
    };
    result.content = {
      revision: node.revision,
      mediaType: "text/markdown",
      format: "markdown",
      writable,
    };
  } else if (node.kind === "file") {
    result.content = {
      revision: node.revision,
      mediaType: mediaType(node.path),
      writable,
    };
  }
  if (node.kind === "directory" || node.kind === "collection" || node.kind === "postgres") {
    const collection = node.collection;
    const representation = collection?.backing === "postgres"
      ? { type: "external" as const, driver: "postgres" }
      : collection?.backing === "csv" || collection?.backing === "jsonl"
        ? {
          type: "rollup" as const,
          codec: collection.backing,
          scope: "children" as const,
          modelDigest: digest({ columns: collection.columns }),
        }
        : { type: "expanded" as const };
    result.children = {
      revision: node.revision,
      ...(collection ? { schema: digest({ columns: collection.columns }) } : {}),
      representation,
      ...(collection?.total !== undefined
        ? { total: collection.total }
        : node.children ? { total: node.children.length } : {}),
      writable,
    };
  }
  return result;
}

export interface NodeSamplingContext {
  tree: TreeRef;
  observedThrough: string;
  writable?: boolean;
  enclosingTree?: LocalTreeDescriptor;
}

export function sampleTreeNode(node: TreeNode, context: NodeSamplingContext): NodeResponse {
  const writable = context.writable ?? node.writable;
  const pageID = isPageID(node.document?.frontmatter.id) ? node.document.frontmatter.id : null;
  return {
    ref: {
      tree: context.tree,
      path: node.path,
      stableKey: pageID ? pageIDStableKey(pageID) : null,
    },
    name: node.name,
    revision: node.revision,
    properties: nodeProperties(node),
    capabilities: capabilities(node, writable),
    ...(node.document ? {
      content: {
        source: node.document.source,
        representation: node.bodyOrigin
          ? { state: "stored" as const, origin: node.bodyOrigin }
          : { state: "implicit" as const },
      },
    } : {}),
    materialization: node.materialization,
    diagnostics: node.diagnostics,
    observedThrough: context.observedThrough,
    ...(context.enclosingTree ? { enclosingTree: context.enclosingTree } : {}),
  };
}

export function summarizeTreeNode(node: TreeNode, tree: TreeRef, writable = node.writable): NodeSummary {
  const { observedThrough: _observedThrough, content: _content, enclosingTree: _enclosingTree, ...summary } = sampleTreeNode(node, {
    tree,
    observedThrough: "summary",
    writable,
  });
  return summary;
}

export function summarizeSample(sample: NodeResponse): NodeSummary {
  const { observedThrough: _observedThrough, content: _content, enclosingTree: _enclosingTree, ...summary } = sample;
  return summary;
}
