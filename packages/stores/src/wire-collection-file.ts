import {
  canonicalCBORHash,
  requireJSONValue,
  stableKeyFromProperties,
  type CollectionFileDescriptor,
  type Hash,
  type JSONValue,
} from "@arbor/core";
import { logicalChildName, SchemaSandbox, type SchemaDescription } from "./schema.ts";
import { decodeCollectionFileSource } from "./providers/collection-file-codec.ts";

export interface WireCollectionFileRow {
  stableKey: string;
  path: string;
  properties: Record<string, JSONValue>;
}

export interface DecodedWireCollectionFile {
  format: CollectionFileDescriptor["format"];
  schema: SchemaDescription;
  rows: WireCollectionFileRow[];
  childSetHash: Hash;
}

export class WireCollectionFileError extends Error {
  constructor(
    readonly kind: "schema" | "constraint" | "source",
    message: string,
  ) {
    super(message);
    this.name = "WireCollectionFileError";
  }
}

function jsonValue(value: unknown): JSONValue {
  try {
    return requireJSONValue(value);
  } catch {
    throw new WireCollectionFileError("constraint", "Validated collection-file properties must be finite JSON values");
  }
}

function sourceRows(format: CollectionFileDescriptor["format"], source: string): Record<string, unknown>[] {
  try {
    const decoded = decodeCollectionFileSource(format, source, `wire:_store.${format}`);
    const diagnostic = decoded.diagnostics[0] ?? decoded.rows.flatMap((row) => row.diagnostics)[0];
    if (diagnostic) throw new WireCollectionFileError("source", diagnostic.message);
    return decoded.rows.map((row) => row.values);
  } catch (error) {
    if (error instanceof WireCollectionFileError) throw error;
    throw new WireCollectionFileError("source", `Invalid ${format.toUpperCase()} collection file: ${String(error)}`);
  }
}

export async function decodeWireCollectionFile(
  descriptor: CollectionFileDescriptor,
  sourceBytes: Uint8Array,
  schemaBytes: Uint8Array,
  schemas: SchemaSandbox,
): Promise<DecodedWireCollectionFile> {
  if (sourceBytes.byteLength > 16 * 1024 * 1024) {
    throw new WireCollectionFileError("source", "Collection file exceeds the 16 MiB validation limit");
  }
  if (schemaBytes.byteLength > 1024 * 1024) {
    throw new WireCollectionFileError("schema", "schema.ts exceeds the 1 MiB validation limit");
  }
  let source: string;
  let schemaSource: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    source = decoder.decode(sourceBytes);
    schemaSource = decoder.decode(schemaBytes);
  } catch {
    throw new WireCollectionFileError("source", "Collection file and schema.ts must be UTF-8");
  }
  const schema = await schemas.compileSource(schemaSource, descriptor.schemaFingerprint);
  if (schema.revision !== descriptor.schemaFingerprint) {
    throw new WireCollectionFileError("schema", "Collection-file schema fingerprint does not match schema.ts");
  }
  if (!schema.primaryKey) {
    throw new WireCollectionFileError("constraint", "A synchronized collection file requires a declared primaryKey");
  }
  const rawRows = sourceRows(descriptor.format, source);
  if (rawRows.length > 100_000) throw new WireCollectionFileError("source", "Collection file exceeds the 100,000 row limit");
  const rows: WireCollectionFileRow[] = [];
  const keys = new Set<string>();
  const names = new Set<string>();
  for (const [index, raw] of rawRows.entries()) {
    const result = await schemas.validateSource(schemaSource, raw, descriptor.schemaFingerprint);
    if (result.diagnostics.length || !result.value) {
      throw new WireCollectionFileError("constraint", `Collection-file row ${index + 1} does not satisfy schema.ts`);
    }
    const properties = jsonValue(result.value) as Record<string, JSONValue>;
    const stableKey = stableKeyFromProperties(schema.primaryKey, properties);
    if (!stableKey) throw new WireCollectionFileError("constraint", `Collection-file row ${index + 1} has no valid stable key`);
    if (keys.has(stableKey)) throw new WireCollectionFileError("constraint", `Collection-file stable key is duplicated: ${stableKey}`);
    keys.add(stableKey);
    let path: string;
    try {
      path = logicalChildName(schema, properties, stableKey);
    } catch (error) {
      throw new WireCollectionFileError("constraint", error instanceof Error ? error.message : String(error));
    }
    if (names.has(path)) throw new WireCollectionFileError("constraint", `Collection-file child name is duplicated: ${path}`);
    names.add(path);
    rows.push({ stableKey, path, properties });
  }
  const childSetHash = canonicalCBORHash([...rows]
    .sort((left, right) => left.stableKey < right.stableKey ? -1 : left.stableKey > right.stableKey ? 1 : 0)
    .map((row) => ({ key: row.stableKey, name: row.path, properties: row.properties })));
  if (childSetHash !== descriptor.childSetHash) {
    throw new WireCollectionFileError("constraint", "Collection-file child-set hash does not match its schema-normalized rows");
  }
  return { format: descriptor.format, schema, rows, childSetHash };
}

function csvCell(value: JSONValue | undefined): string {
  const source = value === undefined || value === null ? ""
    : typeof value === "object" ? JSON.stringify(value)
    : String(value);
  return /[",\r\n]/.test(source) ? `"${source.replaceAll('"', '""')}"` : source;
}

export function encodeWireCollectionFile(
  format: CollectionFileDescriptor["format"],
  schema: SchemaDescription,
  rows: readonly WireCollectionFileRow[],
): Uint8Array {
  let source: string;
  if (format === "json") {
    source = `${JSON.stringify(rows.map((row) => row.properties), null, 2)}\n`;
  } else if (format === "jsonl") {
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
