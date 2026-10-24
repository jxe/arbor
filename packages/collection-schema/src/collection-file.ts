import { parse } from "csv-parse/sync";
import {
  canonicalCBORHash,
  compareUTF8,
  stableKeyFromProperties,
  type Diagnostic,
  type Hash,
  type JSONValue,
} from "@ovst/protocol";
import type { CollectionSchema } from "./compile.ts";
import type { ValueDiagnostic } from "./diagnostics.ts";
import { csvHeaderDiagnostics, csvRowValue } from "./csv.ts";
import { ProtocolCollectionError } from "./directory-collection.ts";
import { logicalChildName } from "./names.ts";
import { collectionValidationBudget, validateRow, type ValidationBudget } from "./validate.ts";

export type CollectionFileFormat = "csv" | "json" | "jsonl";

/** One decoded source row before identity is assigned. Structurally a provider child record. */
export interface CollectionSourceRow {
  key: string;
  path: string;
  stableKey: null;
  values: Record<string, unknown>;
  diagnostics: Diagnostic[];
}

export interface DecodedCollectionFileSource {
  rows: CollectionSourceRow[];
  diagnostics: Diagnostic[];
}

function rawCells(header: readonly string[], cells: readonly string[]): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  header.forEach((name, column) => {
    if (cells[column] !== undefined && !Object.hasOwn(values, name)) values[name] = cells[column];
  });
  return values;
}

/** A value diagnostic in the protocol's provider vocabulary. */
export function valueDiagnostic(item: ValueDiagnostic, sourcePath: string, row?: number): Diagnostic {
  const field = item.path.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")).join(".");
  return {
    code: item.code,
    message: item.message,
    path: sourcePath,
    ...(row === undefined ? {} : { row }),
    ...(field ? { field } : {}),
    severity: "error",
  };
}

/**
 * Decode exact collection-file text into rows. With a schema, CSV cells are
 * converted by the schema-directed rules and every row is validated; without
 * one, CSV cells stay text and rows are not validated. JSON and JSONL values
 * are used exactly as parsed.
 */
export function decodeCollectionFileSource(
  format: CollectionFileFormat,
  source: string,
  sourcePath: string,
  schema?: CollectionSchema,
  budget: ValidationBudget = collectionValidationBudget(),
): DecodedCollectionFileSource {
  const validated = (index: number, values: unknown): Diagnostic[] => schema
    ? validateRow(schema, values, budget).map((item) => valueDiagnostic(item, sourcePath, index))
    : [];
  if (format === "csv") {
    let records: string[][];
    try {
      records = parse(source, { bom: true, relax_column_count: true, skip_empty_lines: true }) as string[][];
    } catch (error) {
      return { rows: [], diagnostics: [{ code: "invalid-csv", message: error instanceof Error ? error.message : String(error), path: sourcePath, severity: "error" }] };
    }
    const header = records[0] ?? [];
    const diagnostics: Diagnostic[] = [];
    if (schema) {
      diagnostics.push(...csvHeaderDiagnostics(schema, header).map((item) => valueDiagnostic(item, sourcePath)));
    }
    const rows = records.slice(1).map((cells, index): CollectionSourceRow => {
      const row = { key: `row:${index + 2}`, path: `~row-${index + 1}`, stableKey: null } as const;
      if (!schema || diagnostics.length) {
        return { ...row, values: rawCells(header, cells), diagnostics: [] };
      }
      const converted = csvRowValue(schema, header, cells, budget);
      return {
        ...row,
        values: converted.value ?? rawCells(header, cells),
        diagnostics: converted.diagnostics.map((item) => valueDiagnostic(item, sourcePath, index)),
      };
    });
    return { rows, diagnostics };
  }
  if (format === "json") {
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
      if (!Array.isArray(value)) throw new Error("_store.json must contain one top-level array");
    } catch (error) {
      return {
        rows: [],
        diagnostics: [{ code: "invalid-json-store", message: error instanceof Error ? error.message : String(error), path: sourcePath, severity: "error" }],
      };
    }
    return {
      rows: (value as unknown[]).map((item, index): CollectionSourceRow => item && typeof item === "object" && !Array.isArray(item)
        ? { key: `item:${index}`, path: `~row-${index + 1}`, stableKey: null, values: item as Record<string, unknown>, diagnostics: validated(index, item) }
        : { key: `item:${index}`, path: `~row-${index + 1}`, stableKey: null, values: {}, diagnostics: [{
          code: "invalid-json-row", message: "Each _store.json item must be an object.", path: sourcePath, row: index, severity: "error",
        }] }),
      diagnostics: [],
    };
  }
  const rows: CollectionSourceRow[] = [];
  let lineNumber = 0;
  for (const line of source.split(/\r\n|\n|\r/)) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Each _store.jsonl line must be an object");
      rows.push({ key: `line:${lineNumber}`, path: `~row-${rows.length + 1}`, stableKey: null, values: value as Record<string, unknown>, diagnostics: validated(lineNumber, value) });
    } catch (error) {
      rows.push({ key: `line:${lineNumber}`, path: `~row-${rows.length + 1}`, stableKey: null, values: {}, diagnostics: [{
        code: "invalid-jsonl", message: error instanceof Error ? error.message : String(error), path: sourcePath, row: lineNumber, severity: "error",
      }] });
    }
  }
  return { rows, diagnostics: [] };
}

/** The canonical child-set hash: `{ key, name, properties }` ordered by the UTF-8 bytes of the key. */
export function collectionChildSetHash(rows: ReadonlyArray<{ key: string | null; name: string; properties: unknown }>): Hash {
  return canonicalCBORHash([...rows]
    .sort((left, right) => compareUTF8(left.key ?? left.name, right.key ?? right.name))
    .map((row) => ({ key: row.key, name: row.name, properties: row.properties }))) as Hash;
}

export interface ProtocolCollectionFileRow {
  stableKey: string;
  path: string;
  properties: Record<string, JSONValue>;
}

/** A row's canonical member order: the schema's columns in layout order,
 * then undeclared members by UTF-8 name. Values are kept exactly. */
export function canonicalRow(schema: Pick<CollectionSchema, "columns">, properties: Readonly<Record<string, JSONValue>>): Record<string, JSONValue> {
  const declared = schema.columns.filter((name) => Object.hasOwn(properties, name));
  const extra = Object.keys(properties).filter((name) => !schema.columns.includes(name)).sort(compareUTF8);
  return Object.fromEntries([...declared, ...extra].map((name) => [name, properties[name]!]));
}

/** Validated rows of exact collection-file bytes, each with its source
 * position key (`line:N`, `item:N` or `row:N`), and their child-set hash. */
export function collectionFileRows(
  format: CollectionFileFormat,
  sourceBytes: Uint8Array,
  schema: CollectionSchema,
): { rows: Array<ProtocolCollectionFileRow & { sourceKey: string }>; childSetHash: Hash } {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  } catch {
    throw new ProtocolCollectionError("source", "Collection file must be UTF-8");
  }
  const decoded = decodeCollectionFileSource(format, source, `wire:_store.${format}`, schema);
  const fileDiagnostic = decoded.diagnostics[0];
  if (fileDiagnostic) {
    throw new ProtocolCollectionError(fileDiagnostic.code.startsWith("csv-") ? "constraint" : "source", fileDiagnostic.message);
  }
  if (decoded.rows.length > 100_000) throw new ProtocolCollectionError("source", "Collection file exceeds the 100,000 row limit");
  const rows: Array<ProtocolCollectionFileRow & { sourceKey: string }> = [];
  const keys = new Set<string>();
  const names = new Set<string>();
  for (const [index, raw] of decoded.rows.entries()) {
    const diagnostic = raw.diagnostics[0];
    if (diagnostic) {
      const kind = diagnostic.code === "invalid-json-row" || diagnostic.code === "invalid-jsonl" ? "source" : "constraint";
      throw new ProtocolCollectionError(kind, `Collection-file row ${index + 1} does not satisfy schema.usl: ${diagnostic.code}${diagnostic.field ? ` at ${diagnostic.field}` : ""}`);
    }
    const properties = raw.values as Record<string, JSONValue>;
    const stableKey = stableKeyFromProperties(schema.primaryKey, properties);
    if (!stableKey) throw new ProtocolCollectionError("constraint", `Collection-file row ${index + 1} has no valid stable key`);
    if (keys.has(stableKey)) throw new ProtocolCollectionError("constraint", `Collection-file stable key is duplicated: ${stableKey}`);
    keys.add(stableKey);
    let path: string;
    try {
      path = logicalChildName(schema, properties, stableKey);
    } catch (error) {
      throw new ProtocolCollectionError("constraint", error instanceof Error ? error.message : String(error));
    }
    if (names.has(path)) throw new ProtocolCollectionError("constraint", `Collection-file child name is duplicated: ${path}`);
    names.add(path);
    rows.push({ stableKey, path, properties, sourceKey: raw.key });
  }
  const childSetHash = collectionChildSetHash(rows.map((row) => ({ key: row.stableKey, name: row.path, properties: row.properties })));
  return { rows, childSetHash };
}
