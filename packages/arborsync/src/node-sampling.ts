import type {
  Diagnostic,
  Hash,
  JSONValue,
  LocalTreeDescriptor,
  MarkdownDocument,
  Materialization,
  NodeCapabilities,
  NodeResponse,
  NodeSummary,
  TreeRef,
} from "@arbor/core";
import { canonicalJSONString, isPageID, pageIDStableKey, sha256 } from "@arbor/core";
import type { ChildSetDescriptor } from "@arbor/stores";

/** Adapter-private expanded-filesystem record. Never crosses a node protocol boundary. */
export interface ExpandedChild {
  name: string;
  path: string;
  kind: "markdown" | "directory" | "file";
  materialization: Materialization;
  pageID?: string;
}

/** Exact filesystem read state used to construct the generic public node model. */
export interface ExpandedNode {
  path: string;
  name: string;
  kind: "markdown" | "directory" | "file";
  revision: string;
  contentRevision?: string;
  propertiesRevision?: string;
  childrenRevision?: string;
  writable: boolean;
  materialization: Materialization;
  bodyOrigin?: "sibling" | "index";
  document?: MarkdownDocument;
  children?: ExpandedChild[];
  childSet?: ChildSetDescriptor;
  diagnostics: Diagnostic[];
}

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

export function expandedNodeProperties(node: ExpandedNode): Record<string, JSONValue> {
  return (jsonValue(node.document?.frontmatter ?? {}) ?? {}) as Record<string, JSONValue>;
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

function capabilities(node: ExpandedNode, writable: boolean): NodeCapabilities {
  const result: NodeCapabilities = {};
  if (node.document) {
    result.properties = {
      revision: node.propertiesRevision ?? node.revision,
      writable,
    };
    result.content = {
      revision: node.contentRevision ?? node.revision,
      mediaType: "text/markdown",
      format: "markdown",
      writable,
    };
  } else if (node.kind === "file") {
    result.content = {
      revision: node.contentRevision ?? node.revision,
      mediaType: mediaType(node.path),
      writable,
    };
  }
  if (node.kind === "directory") {
    const childSet = node.childSet;
    const representation = childSet?.backing === "postgres"
      ? { type: "external" as const, driver: "postgres" }
      : childSet?.backing === "csv" || childSet?.backing === "json" || childSet?.backing === "jsonl" || childSet?.backing === "sqlite"
        ? {
          type: "rollup" as const,
          codec: childSet.backing,
          scope: childSet.rollupScope ?? "children" as const,
          modelDigest: (childSet.modelDigest ?? digest({ columns: childSet.columns, identityRule: childSet.identityRule })) as Hash,
        }
        : { type: "expanded" as const };
    result.children = {
      revision: node.childrenRevision ?? childSet?.revision ?? node.revision,
      ...(childSet ? { schema: (childSet.schemaRevision ?? digest({ columns: childSet.columns, identityRule: childSet.identityRule })) as Hash } : {}),
      representation,
      ...(childSet?.total !== undefined
        ? { total: childSet.total }
        : node.children ? { total: node.children.length } : {}),
      writable: childSet ? childSet.editable && writable : writable,
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

export function sampleExpandedNode(node: ExpandedNode, context: NodeSamplingContext): NodeResponse {
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
    properties: expandedNodeProperties(node),
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

export function summarizeExpandedNode(node: ExpandedNode, tree: TreeRef, writable = node.writable): NodeSummary {
  const { observedThrough: _observedThrough, content: _content, enclosingTree: _enclosingTree, ...summary } = sampleExpandedNode(node, {
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
