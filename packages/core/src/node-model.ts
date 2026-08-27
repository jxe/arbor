import type { Diagnostic, Materialization } from "./types.ts";
import type { EventCursor, Hash, LogicalPath, TreeRef } from "./protocol.ts";
import { parseCanonicalStableKey } from "./node-key.ts";

export type JSONValue = null | boolean | number | string | JSONValue[] | { [name: string]: JSONValue };
export type NodeDiagnostic = Omit<Diagnostic, "path"> & { path?: LogicalPath };

export interface NodeRef {
  tree: TreeRef;
  path: LogicalPath;
  stableKey: string | null;
}

export type ResolvedNodeRef = NodeRef;

export interface IdentityRule {
  properties: string[];
}

export type ChildRepresentationSummary =
  | { type: "expanded" }
  | {
    type: "rollup";
    codec: "csv" | "json" | "jsonl" | "sqlite";
    scope: "children" | "subtree";
    modelDigest: Hash;
  }
  | { type: "external"; driver: string };

export interface NodeCapabilities {
  properties?: { revision: string; schema?: Hash; writable: boolean };
  content?: {
    revision: string;
    mediaType: string;
    format?: "markdown" | "mdx" | "tsx" | "json";
    writable: boolean;
  };
  children?: {
    revision: string;
    schema?: Hash;
    representation?: ChildRepresentationSummary;
    total?: number;
    writable: boolean;
  };
  executable?: {
    version: Hash;
    state: "runnable" | "diagnostic" | "inactive";
  };
}

export interface NodeContent {
  source: string;
  representation?: {
    state: "stored" | "implicit";
    origin?: "sibling" | "index";
  };
}

export interface NodeSummary {
  ref: ResolvedNodeRef;
  name: string;
  revision: string;
  properties: Record<string, JSONValue>;
  capabilities: NodeCapabilities;
  materialization: Materialization;
  diagnostics: NodeDiagnostic[];
}

export interface NodeSnapshot extends NodeSummary {
  content?: NodeContent;
  observedThrough: EventCursor;
}

export interface ChildrenPage {
  parent: ResolvedNodeRef;
  items: NodeSummary[];
  nextCursor: string | null;
  observedThrough: EventCursor;
}

export interface RollupDescriptor {
  version: 1;
  codec: "csv" | "json" | "jsonl" | "sqlite";
  source: Hash;
  schema: Hash;
  scope: "children" | "subtree";
  modelDigest: Hash;
}

const HASH = /^sha256:[a-f0-9]{64}$/;
const LEGACY_NODE_FIELDS = ["tree", "path", "kind", "pageID", "collection", "document", "children"] as const;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new TypeError(`${label} must be a nonempty string`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}

function hash(value: unknown, label: string): Hash {
  const result = string(value, label);
  if (!HASH.test(result)) throw new TypeError(`${label} must be a lowercase SHA-256 hash`);
  return result as Hash;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}

function json(value: unknown, label: string): JSONValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => json(item, `${label}[${index}]`));
  const source = object(value, label);
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, json(item, `${label}.${key}`)]));
}

function diagnostics(value: unknown): NodeDiagnostic[] {
  if (!Array.isArray(value)) throw new TypeError("diagnostics must be an array");
  return value.map((item, index) => {
    const source = object(item, `diagnostics[${index}]`);
    const severity = string(source.severity, `diagnostics[${index}].severity`);
    if (!(["info", "warning", "error"] as string[]).includes(severity)) {
      throw new TypeError(`diagnostics[${index}].severity is invalid`);
    }
    const path = optionalString(source.path, `diagnostics[${index}].path`);
    const row = source.row;
    if (row !== undefined && (!Number.isSafeInteger(row) || (row as number) < 0)) {
      throw new TypeError(`diagnostics[${index}].row must be a nonnegative integer`);
    }
    return {
      code: string(source.code, `diagnostics[${index}].code`),
      message: string(source.message, `diagnostics[${index}].message`),
      severity: severity as Diagnostic["severity"],
      ...(path ? { path } : {}),
      ...(row === undefined ? {} : { row: row as number }),
      ...(source.field === undefined ? {} : { field: string(source.field, `diagnostics[${index}].field`) }),
    };
  });
}

export function decodeNodeRef(value: unknown): NodeRef {
  const source = object(value, "ref");
  if (!Object.hasOwn(source, "stableKey")) throw new TypeError("ref.stableKey must be explicit, including null");
  if ("pageID" in source || "pathHint" in source) throw new TypeError("legacy PageID references are not node refs");
  const stableKey = source.stableKey;
  if (stableKey !== null && (typeof stableKey !== "string" || !parseCanonicalStableKey(stableKey))) {
    throw new TypeError("ref.stableKey must be null or canonical identity JSON");
  }
  return {
    tree: string(source.tree, "ref.tree"),
    path: string(source.path, "ref.path"),
    stableKey,
  };
}

export function decodeIdentityRule(value: unknown): IdentityRule {
  const source = object(value, "identityRule");
  if (Object.hasOwn(source, "scope")) throw new TypeError("identityRule.scope was removed; the declaration site defines the keyspace");
  if (!Array.isArray(source.properties) || !source.properties.length) {
    throw new TypeError("identityRule.properties must be nonempty");
  }
  const properties = source.properties.map((item, index) => string(item, `identityRule.properties[${index}]`));
  if (new Set(properties).size !== properties.length) throw new TypeError("identityRule.properties must be unique");
  return { properties };
}

function decodeRepresentation(value: unknown): ChildRepresentationSummary {
  const source = object(value, "capabilities.children.representation");
  if (source.type === "expanded") return { type: "expanded" };
  if (source.type === "external") return { type: "external", driver: string(source.driver, "representation.driver") };
  if (source.type !== "rollup") throw new TypeError("children representation type is invalid");
  if (!["csv", "json", "jsonl", "sqlite"].includes(source.codec as string)) throw new TypeError("rollup codec is invalid");
  if (source.scope !== "children" && source.scope !== "subtree") throw new TypeError("rollup scope is invalid");
  return {
    type: "rollup",
    codec: source.codec as "csv" | "json" | "jsonl" | "sqlite",
    scope: source.scope,
    modelDigest: hash(source.modelDigest, "representation.modelDigest"),
  };
}

export function decodeNodeCapabilities(value: unknown): NodeCapabilities {
  const source = object(value, "capabilities");
  const result: NodeCapabilities = {};
  if (source.properties !== undefined) {
    const capability = object(source.properties, "capabilities.properties");
    result.properties = {
      revision: string(capability.revision, "capabilities.properties.revision"),
      ...(capability.schema === undefined ? {} : { schema: hash(capability.schema, "capabilities.properties.schema") }),
      writable: boolean(capability.writable, "capabilities.properties.writable"),
    };
  }
  if (source.content !== undefined) {
    const capability = object(source.content, "capabilities.content");
    const format = optionalString(capability.format, "capabilities.content.format");
    if (format && !["markdown", "mdx", "tsx", "json"].includes(format)) throw new TypeError("content format is invalid");
    result.content = {
      revision: string(capability.revision, "capabilities.content.revision"),
      mediaType: string(capability.mediaType, "capabilities.content.mediaType"),
      ...(format ? { format: format as "markdown" | "mdx" | "tsx" | "json" } : {}),
      writable: boolean(capability.writable, "capabilities.content.writable"),
    };
  }
  if (source.children !== undefined) {
    const capability = object(source.children, "capabilities.children");
    if (capability.total !== undefined && (!Number.isSafeInteger(capability.total) || (capability.total as number) < 0)) {
      throw new TypeError("capabilities.children.total must be a nonnegative integer");
    }
    result.children = {
      revision: string(capability.revision, "capabilities.children.revision"),
      ...(capability.schema === undefined ? {} : { schema: hash(capability.schema, "capabilities.children.schema") }),
      ...(capability.representation === undefined ? {} : { representation: decodeRepresentation(capability.representation) }),
      ...(capability.total === undefined ? {} : { total: capability.total as number }),
      writable: boolean(capability.writable, "capabilities.children.writable"),
    };
  }
  if (source.executable !== undefined) {
    const capability = object(source.executable, "capabilities.executable");
    if (!(["runnable", "diagnostic", "inactive"] as unknown[]).includes(capability.state)) {
      throw new TypeError("executable state is invalid");
    }
    result.executable = {
      version: hash(capability.version, "capabilities.executable.version"),
      state: capability.state as "runnable" | "diagnostic" | "inactive",
    };
  }
  return result;
}

function decodeSummary(value: unknown, label: string): NodeSummary {
  const source = object(value, label);
  for (const field of LEGACY_NODE_FIELDS) {
    if (field in source) throw new TypeError(`${label}.${field} duplicates or violates the node model`);
  }
  const properties = object(source.properties, `${label}.properties`);
  const materialization = source.materialization;
  if (materialization !== "available" && materialization !== "placeholder") {
    throw new TypeError(`${label}.materialization is invalid`);
  }
  return {
    ref: decodeNodeRef(source.ref),
    name: string(source.name, `${label}.name`),
    revision: string(source.revision, `${label}.revision`),
    properties: Object.fromEntries(Object.entries(properties).map(([key, item]) => [key, json(item, `${label}.properties.${key}`)])),
    capabilities: decodeNodeCapabilities(source.capabilities),
    materialization,
    diagnostics: diagnostics(source.diagnostics),
  };
}

export function decodeNodeSnapshot(value: unknown): NodeSnapshot {
  const source = object(value, "snapshot");
  const summary = decodeSummary(source, "snapshot");
  let content: NodeContent | undefined;
  if (source.content !== undefined) {
    const rawContent = object(source.content, "snapshot.content");
    let representation: NodeContent["representation"];
    if (rawContent.representation !== undefined) {
      const rawRepresentation = object(rawContent.representation, "snapshot.content.representation");
      if (rawRepresentation.state !== "stored" && rawRepresentation.state !== "implicit") {
        throw new TypeError("content representation state is invalid");
      }
      if (rawRepresentation.origin !== undefined && rawRepresentation.origin !== "sibling" && rawRepresentation.origin !== "index") {
        throw new TypeError("content representation origin is invalid");
      }
      representation = {
        state: rawRepresentation.state,
        ...(rawRepresentation.origin === undefined ? {} : { origin: rawRepresentation.origin }),
      };
    }
    content = {
      source: text(rawContent.source, "snapshot.content.source"),
      ...(representation ? { representation } : {}),
    };
  }
  return {
    ...summary,
    ...(content ? { content } : {}),
    observedThrough: string(source.observedThrough, "snapshot.observedThrough"),
  };
}

export function decodeChildrenPage(value: unknown): ChildrenPage {
  const source = object(value, "childrenPage");
  if (!Array.isArray(source.items)) throw new TypeError("childrenPage.items must be an array");
  if (source.nextCursor !== null && typeof source.nextCursor !== "string") {
    throw new TypeError("childrenPage.nextCursor must be string or null");
  }
  return {
    parent: decodeNodeRef(source.parent),
    items: source.items.map((item, index) => decodeSummary(item, `childrenPage.items[${index}]`)),
    nextCursor: source.nextCursor,
    observedThrough: string(source.observedThrough, "childrenPage.observedThrough"),
  };
}

export function decodeRollupDescriptor(value: unknown): RollupDescriptor {
  const source = object(value, "rollup");
  if (source.version !== 1) throw new TypeError("rollup.version must be 1");
  if (!["csv", "json", "jsonl", "sqlite"].includes(source.codec as string)) throw new TypeError("rollup.codec is invalid");
  if (source.scope !== "children" && source.scope !== "subtree") throw new TypeError("rollup.scope is invalid");
  return {
    version: 1,
    codec: source.codec as "csv" | "json" | "jsonl" | "sqlite",
    source: hash(source.source, "rollup.source"),
    schema: hash(source.schema, "rollup.schema"),
    scope: source.scope,
    modelDigest: hash(source.modelDigest, "rollup.modelDigest"),
  };
}
