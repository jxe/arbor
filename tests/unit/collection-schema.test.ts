import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CollectionSchemaCache,
  CollectionSchemaError,
  COLLECTION_SCHEMA_LIMITS,
  collectionValidationBudget,
  compileCollectionSchema,
  csvHeaderDiagnostics,
  csvRowValue,
  csvSchemaDiagnostic,
  CsvEncodeError,
  decodeCollectionFileSource,
  decodeProtocolCollectionFile,
  encodeCsvRows,
  validateRow,
  ProtocolCollectionFileError,
  collectionChildSetHash,
  type CollectionSchema,
} from "@overstory/collection-schema";
import { revisionOf, type CollectionFileDescriptor, type Hash, type JSONValue } from "@overstory/protocol";

type Diagnostic = { code: string; path: string; limit?: string };
type Reject = { code: string; line?: number; column?: number; limit?: string };
interface SchemaVector {
  name: string;
  source: string;
  fingerprint?: string;
  accept?: { columns: string[]; primaryKey: string[] | null; childName: string | null };
  reject?: Reject;
  values?: Array<{ value: unknown; diagnostics: Diagnostic[] }>;
  csv?: {
    unrepresentable?: Diagnostic;
    header?: string[];
    rows?: Array<{ cells: string[]; value?: Record<string, JSONValue>; diagnostics?: Diagnostic[] }>;
    headers?: Array<{ header: string[]; diagnostics: Diagnostic[] }>;
    encode?: Array<{ rows: Record<string, JSONValue>[]; text?: string; diagnostics?: Diagnostic[] }>;
  };
}
type Part = string | { repeat: string; count: number; separator?: string };
const vectors = JSON.parse(readFileSync(join(import.meta.dir, "../../docs/overstory-spec/conformance/collection-schemas.json"), "utf8")) as {
  limits: Record<string, number>;
  schemas: SchemaVector[];
  sourceBytes: Array<{ name: string; sourceBase64: string; reject: Reject }>;
  generated: Array<{ name: string; parts: Part[]; accept?: boolean; reject?: Reject }>;
  budgetValues: Array<{ name: string; source: string; value: unknown; diagnostics: Diagnostic[] }>;
};

function expand(parts: Part[]): string {
  return parts.map((part) => typeof part === "string" ? part
    : Array.from({ length: part.count }, (_, index) => part.repeat
      .replaceAll("{i+1}", String(index + 1))
      .replaceAll("{i}", String(index))).join(part.separator ?? "")).join("");
}

function expandValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expandValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("$repeat" in record && typeof record.count === "number") return Array.from({ length: record.count }, () => expandValue(record.$repeat));
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, expandValue(item)]));
  }
  return value;
}

function rejection(source: string | Uint8Array): Reject {
  try {
    compileCollectionSchema(source);
  } catch (error) {
    if (!(error instanceof CollectionSchemaError)) throw error;
    const first = error.diagnostics[0]!;
    return { code: first.code, ...(first.location ?? {}), ...(first.limit ? { limit: first.limit } : {}) };
  }
  throw new Error("schema was accepted");
}

const summary = (items: Array<{ code: string; path: string; limit?: string }>) =>
  items.map((item) => ({ code: item.code, path: item.path, ...(item.limit ? { limit: item.limit } : {}) }));

describe("collection schema conformance vectors", () => {
  test("freeze the implemented limits", () => {
    expect(vectors.limits).toEqual({ ...COLLECTION_SCHEMA_LIMITS });
  });

  for (const vector of vectors.schemas) {
    test(vector.name, () => {
      if (vector.reject) {
        const actual = rejection(vector.source);
        const expected = vector.reject;
        expect({ code: actual.code, ...(expected.line ? { line: actual.line, column: actual.column } : {}), ...(expected.limit ? { limit: actual.limit } : {}) })
          .toEqual(expected);
        return;
      }
      const schema = compileCollectionSchema(vector.source);
      expect({
        columns: schema.columns,
        primaryKey: schema.primaryKey,
        childName: schema.childName.from === "property" ? schema.childName.property : null,
      }).toEqual(vector.accept!);
      expect(schema.revision).toBe(revisionOf(new TextEncoder().encode(vector.source)) as Hash);
      if (vector.fingerprint) expect(schema.revision).toBe(vector.fingerprint as Hash);
      for (const item of vector.values ?? []) expect(summary(validateRow(schema, item.value))).toEqual(item.diagnostics);
      const csv = vector.csv;
      if (!csv) return;
      if (csv.unrepresentable) {
        expect(summary([csvSchemaDiagnostic(schema)!])).toEqual([csv.unrepresentable]);
        return;
      }
      expect(csvSchemaDiagnostic(schema)).toBeNull();
      for (const row of csv.rows ?? []) {
        const converted = csvRowValue(schema, csv.header!, row.cells);
        if (row.value) {
          expect(converted.diagnostics).toEqual([]);
          expect(converted.value).toEqual(row.value);
        } else {
          expect(summary(converted.diagnostics)).toEqual(row.diagnostics!);
        }
      }
      for (const header of csv.headers ?? []) expect(summary(csvHeaderDiagnostics(schema, header.header))).toEqual(header.diagnostics);
      for (const encode of csv.encode ?? []) {
        if (encode.text !== undefined) {
          expect(encodeCsvRows(schema, encode.rows)).toBe(encode.text);
        } else {
          let caught: unknown;
          try { encodeCsvRows(schema, encode.rows); } catch (error) { caught = error; }
          expect(caught).toBeInstanceOf(CsvEncodeError);
          expect(summary([(caught as CsvEncodeError).diagnostic])).toEqual(encode.diagnostics!);
        }
      }
    });
  }

  for (const vector of vectors.sourceBytes) {
    test(vector.name, () => {
      expect(rejection(Uint8Array.from(Buffer.from(vector.sourceBase64, "base64"))).code).toBe(vector.reject.code);
    });
  }

  for (const vector of vectors.generated) {
    test(`generated: ${vector.name}`, () => {
      const source = expand(vector.parts);
      if (vector.accept) {
        expect(() => compileCollectionSchema(source)).not.toThrow();
        return;
      }
      const actual = rejection(source);
      expect({ code: actual.code, ...(vector.reject!.limit ? { limit: actual.limit } : {}) }).toEqual(vector.reject!);
    });
  }

  for (const vector of vectors.budgetValues) {
    test(`budget: ${vector.name}`, () => {
      const schema = compileCollectionSchema(vector.source);
      expect(summary(validateRow(schema, expandValue(vector.value)))).toEqual(vector.diagnostics);
    });
  }
});

describe("collection schema implementation", () => {
  const source = 'overstory-schema-version = 1\noverstory-primary-key = ["id"]\nrow = { id: tstr, title: tstr, count: int }\n';

  test("diagnostics are deterministic across repeated compilation", () => {
    const broken = "overstory-schema-version = 1\nrow = { a: missing, b: alsoMissing }\n";
    const first = (() => { try { compileCollectionSchema(broken); } catch (error) { return (error as CollectionSchemaError).diagnostics; } })();
    const second = (() => { try { compileCollectionSchema(broken); } catch (error) { return (error as CollectionSchemaError).diagnostics; } })();
    expect(first).toEqual(second!);
    expect(first![0]).toMatchObject({ code: "unknown-rule", location: { line: 2, column: 12 } });
  });

  test("validation neither normalizes nor strips values", () => {
    const schema = compileCollectionSchema(source);
    const value = { id: "a", title: "A", count: 1 };
    expect(validateRow(schema, value)).toEqual([]);
    expect(value).toEqual({ id: "a", title: "A", count: 1 });
    expect(validateRow(schema, { ...value, count: "1" })[0]?.code).toBe("type-mismatch");
  });

  test("the cache is content-addressed, bounded, and never stores a failure", () => {
    const cache = new CollectionSchemaCache(2);
    const first = cache.compile(source);
    expect(cache.compile(new TextEncoder().encode(source))).toBe(first);
    expect(() => cache.compile("row = { a: tstr }\n")).toThrow(CollectionSchemaError);
    expect(cache.size).toBe(1);
    cache.compile(`${source}; two\n`);
    cache.compile(`${source}; three\n`);
    expect(cache.size).toBe(2);
    expect(cache.compile(source)).not.toBe(first);
  });

  test("a collection file shares one step budget across its rows", () => {
    const schema = compileCollectionSchema('overstory-schema-version = 1\noverstory-primary-key = ["id"]\nrow = { id: tstr, items: [* int] }\n');
    const rows = Array.from({ length: 4 }, (_, index) => JSON.stringify({ id: `r${index}`, items: Array.from({ length: 100 }, () => 1) })).join("\n");
    const decoded = decodeCollectionFileSource("jsonl", rows, "_store.jsonl", schema, collectionValidationBudget(250));
    expect(decoded.rows.slice(0, 2).every((row) => row.diagnostics.length === 0)).toBe(true);
    expect(decoded.rows[2]!.diagnostics[0]).toMatchObject({ code: "budget-exceeded" });
  });

  test("a version-2 wire collection validates exact bytes without executing code", () => {
    const schemaBytes = new TextEncoder().encode(source);
    const store = new TextEncoder().encode('[{"id":"b","title":"B","count":2},{"id":"a","title":"A","count":1}]\n');
    const schema: CollectionSchema = compileCollectionSchema(schemaBytes);
    const childSetHash = collectionChildSetHash([
      { key: '[["id","a"]]', name: "a", properties: { id: "a", title: "A", count: 1 } },
      { key: '[["id","b"]]', name: "b", properties: { id: "b", title: "B", count: 2 } },
    ]);
    const descriptor: CollectionFileDescriptor = {
      version: 2, type: "collection-file", format: "json", source: "_store.json", schemaSource: "schema.cddl",
      schemaFingerprint: schema.revision, childSetHash,
    };
    const decoded = decodeProtocolCollectionFile(descriptor, store, schemaBytes);
    expect(decoded.rows.map((row) => row.path)).toEqual(["b", "a"]);
    expect(() => decodeProtocolCollectionFile({ ...descriptor, childSetHash: `sha256:${"0".repeat(64)}` as Hash }, store, schemaBytes))
      .toThrow("child-set hash");
    expect(() => decodeProtocolCollectionFile({ ...descriptor, version: 1, schemaSource: "schema.ts" }, store, schemaBytes))
      .toThrow(ProtocolCollectionFileError);
  });

  test("the child-set hash orders keys by UTF-8 bytes", () => {
    const rows = [
      { key: '[["id","￿"]]', name: "x", properties: {} },
      { key: '[["id","\u{1f600}"]]', name: "y", properties: {} },
    ];
    expect(collectionChildSetHash(rows)).toBe(collectionChildSetHash([...rows].reverse()));
  });
});
