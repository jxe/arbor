import type {
  Diagnostic,
  JSONValue,
  LocalTreeDescriptor,
  MarkdownDocument,
  Materialization,
  NodeCapabilities,
  NodeResponse,
  NodeSummary,
  TreeRef,
} from "@arbor/core";
import { isPageID, mediaTypeForPath, pageIDStableKey, toJSONValue } from "@arbor/core";

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
  diagnostics: Diagnostic[];
}

export function expandedNodeProperties(node: ExpandedNode): Record<string, JSONValue> {
  return (toJSONValue(node.document?.frontmatter ?? {}) ?? {}) as Record<string, JSONValue>;
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
      mediaType: mediaTypeForPath(node.path),
      writable,
    };
  }
  if (node.kind === "directory") {
    result.children = {
      revision: node.childrenRevision ?? node.revision,
      representation: { type: "expanded" },
      ...(node.children ? { total: node.children.length } : {}),
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
