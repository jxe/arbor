import {
  canonicalJSONString,
  revisionOf,
  rowPathSegment,
  stableKeyFromProperties,
  type Hash,
  type JSONValue,
  type RollupDescriptor,
} from "@arbor/core";
import { SchemaSandbox, type SchemaDescription } from "./schema.ts";
import { decodeFileRollupSource } from "./providers/file-rollup-codec.ts";

export interface WireFileRollupRow {
  stableKey: string;
  path: string;
  properties: Record<string, JSONValue>;
}

export interface DecodedWireFileRollup {
  codec: RollupDescriptor["codec"];
  schema: SchemaDescription;
  rows: WireFileRollupRow[];
  modelDigest: Hash;
}

export class WireFileRollupError extends Error {
  constructor(
    readonly kind: "schema" | "constraint" | "source",
    message: string,
  ) {
    super(message);
    this.name = "WireFileRollupError";
  }
}

function jsonValue(value: unknown): JSONValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  }
  throw new WireFileRollupError("constraint", "Validated rollup properties must be finite JSON values");
}

function sourceRows(codec: RollupDescriptor["codec"], source: string): Record<string, unknown>[] {
  try {
    const decoded = decodeFileRollupSource(codec, source, `wire:_store.${codec}`);
    const diagnostic = decoded.diagnostics[0] ?? decoded.rows.flatMap((row) => row.diagnostics)[0];
    if (diagnostic) throw new WireFileRollupError("source", diagnostic.message);
    return decoded.rows.map((row) => row.values);
  } catch (error) {
    if (error instanceof WireFileRollupError) throw error;
    throw new WireFileRollupError("source", `Invalid ${codec.toUpperCase()} rollup: ${String(error)}`);
  }
}

export async function decodeWireFileRollup(
  descriptor: RollupDescriptor,
  sourceBytes: Uint8Array,
  schemaBytes: Uint8Array,
  schemas: SchemaSandbox,
): Promise<DecodedWireFileRollup> {
  if (sourceBytes.byteLength > 16 * 1024 * 1024) {
    throw new WireFileRollupError("source", "Rollup source exceeds the 16 MiB validation limit");
  }
  if (schemaBytes.byteLength > 1024 * 1024) {
    throw new WireFileRollupError("schema", "schema.ts exceeds the 1 MiB validation limit");
  }
  let source: string;
  let schemaSource: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    source = decoder.decode(sourceBytes);
    schemaSource = decoder.decode(schemaBytes);
  } catch {
    throw new WireFileRollupError("source", "Rollup source and schema.ts must be UTF-8");
  }
  const schema = await schemas.compileSource(schemaSource, descriptor.schemaSource);
  if (schema.revision !== descriptor.schema) {
    throw new WireFileRollupError("schema", "Rollup schema fingerprint does not match schema.ts");
  }
  if (!schema.primaryKey) {
    throw new WireFileRollupError("constraint", "A synchronized file rollup requires a declared primaryKey");
  }
  const rawRows = sourceRows(descriptor.codec, source);
  if (rawRows.length > 100_000) throw new WireFileRollupError("source", "Rollup exceeds the 100,000 row limit");
  const rows: WireFileRollupRow[] = [];
  const keys = new Set<string>();
  for (const [index, raw] of rawRows.entries()) {
    const result = await schemas.validateSource(schemaSource, raw, descriptor.schemaSource);
    if (result.diagnostics.length || !result.value) {
      throw new WireFileRollupError("constraint", `Rollup row ${index + 1} does not satisfy schema.ts`);
    }
    const properties = jsonValue(result.value) as Record<string, JSONValue>;
    const stableKey = stableKeyFromProperties(schema.primaryKey, properties);
    if (!stableKey) throw new WireFileRollupError("constraint", `Rollup row ${index + 1} has no valid stable key`);
    if (keys.has(stableKey)) throw new WireFileRollupError("constraint", `Rollup stable key is duplicated: ${stableKey}`);
    keys.add(stableKey);
    rows.push({ stableKey, path: rowPathSegment(stableKey), properties });
  }
  const modelDigest = revisionOf(canonicalJSONString([...rows]
    .sort((left, right) => left.stableKey < right.stableKey ? -1 : left.stableKey > right.stableKey ? 1 : 0)
    .map((row) => ({ key: row.stableKey, path: row.path, properties: row.properties })))) as Hash;
  if (modelDigest !== descriptor.modelDigest) {
    throw new WireFileRollupError("constraint", "Rollup model digest does not match its schema-normalized rows");
  }
  return { codec: descriptor.codec, schema, rows, modelDigest };
}

function csvCell(value: JSONValue | undefined): string {
  const source = value === undefined || value === null ? ""
    : typeof value === "object" ? JSON.stringify(value)
    : String(value);
  return /[",\r\n]/.test(source) ? `"${source.replaceAll('"', '""')}"` : source;
}

export function encodeWireFileRollup(
  codec: RollupDescriptor["codec"],
  schema: SchemaDescription,
  rows: readonly WireFileRollupRow[],
): Uint8Array {
  let source: string;
  if (codec === "json") {
    source = `${JSON.stringify(rows.map((row) => row.properties), null, 2)}\n`;
  } else if (codec === "jsonl") {
    source = rows.map((row) => JSON.stringify(row.properties)).join("\n") + (rows.length ? "\n" : "");
  } else {
    const columns = schema.columns;
    source = [
      columns.map(csvCell).join(","),
      ...rows.map((row) => columns.map((column) => csvCell(row.properties[column])).join(",")),
    ].join("\n") + "\n";
  }
  return new TextEncoder().encode(source);
}
