import type { Diagnostic } from "@arbor/core";
import { parse } from "csv-parse/sync";
import type { ProjectionProviderKind, ProviderChildRecord } from "./types.ts";

type CollectionFileFormat = Extract<ProjectionProviderKind, "csv" | "json" | "jsonl">;
export interface DecodedCollectionFileSource {
  rows: ProviderChildRecord[];
  diagnostics: Diagnostic[];
}
/** Pure local/Wire source decoding. Validation, quotas, and trust policy stay with each caller. */
export function decodeCollectionFileSource(
  codec: CollectionFileFormat,
  source: string,
  sourcePath: string,
): DecodedCollectionFileSource {
  if (codec === "csv") {
    const records = parse(source, {
      columns: true,
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
    }) as Array<Record<string, unknown>>;
    return {
      rows: records.map((values, index) => ({
        key: `row:${index + 2}`, path: `~row-${index + 1}`, stableKey: null, values, diagnostics: [],
      })),
      diagnostics: [],
    };
  }
  if (codec === "json") {
    try {
      const value = JSON.parse(source) as unknown;
      if (!Array.isArray(value)) throw new Error("_store.json must contain one top-level array");
      return {
        rows: value.map((item, index) => item && typeof item === "object" && !Array.isArray(item)
          ? { key: `item:${index}`, path: `~row-${index + 1}`, stableKey: null, values: item as Record<string, unknown>, diagnostics: [] }
          : { key: `item:${index}`, path: `~row-${index + 1}`, stableKey: null, values: {}, diagnostics: [{
            code: "invalid-json-row", message: "Each _store.json item must be an object.", path: sourcePath, row: index, severity: "error" as const,
          }] }),
        diagnostics: [],
      };
    } catch (error) {
      return {
        rows: [],
        diagnostics: [{
          code: "invalid-json-store", message: error instanceof Error ? error.message : String(error), path: sourcePath, severity: "error",
        }],
      };
    }
  }
  const rows: ProviderChildRecord[] = [];
  let lineNumber = 0;
  for (const line of source.split(/\r\n|\n|\r/)) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Each _store.jsonl line must be an object");
      rows.push({ key: `line:${lineNumber}`, path: `~row-${rows.length + 1}`, stableKey: null, values: value as Record<string, unknown>, diagnostics: [] });
    } catch (error) {
      rows.push({ key: `line:${lineNumber}`, path: `~row-${rows.length + 1}`, stableKey: null, values: {}, diagnostics: [{
        code: "invalid-jsonl", message: error instanceof Error ? error.message : String(error), path: sourcePath, row: lineNumber, severity: "error",
      }] });
    }
  }
  return { rows, diagnostics: [] };
}
