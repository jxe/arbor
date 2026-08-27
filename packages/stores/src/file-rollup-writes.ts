import { parse as parseCSV } from "csv-parse/sync";
import type { JSONValue } from "@arbor/core";

export type WritableFileRollup = "csv" | "json" | "jsonl";

function rowIndex(key: string, prefix: string, offset: number): number {
  const match = new RegExp(`^${prefix}:(\\d+)$`).exec(key);
  const value = match ? Number(match[1]) - offset : -1;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${prefix} row key: ${key}`);
  return value;
}

function scanJSONString(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === '"') return index + 1;
    index += 1;
  }
  throw new Error("Unterminated JSON string");
}

function scanJSONValue(source: string, start: number): number {
  if (source[start] === '"') return scanJSONString(source, start);
  if (source[start] === "{" || source[start] === "[") {
    const stack = [source[start] === "{" ? "}" : "]"];
    let index = start + 1;
    while (index < source.length && stack.length) {
      const character = source[index]!;
      if (character === '"') {
        index = scanJSONString(source, index);
        continue;
      }
      if (character === "{") stack.push("}");
      else if (character === "[") stack.push("]");
      else if (character === stack.at(-1)) stack.pop();
      index += 1;
    }
    if (stack.length) throw new Error("Unterminated JSON value");
    return index;
  }
  let index = start;
  while (index < source.length && source[index] !== "," && source[index] !== "]") index += 1;
  return index;
}

function jsonArrayItemSpans(source: string): Array<{ start: number; end: number }> {
  let index = 0;
  const whitespace = () => { while (/\s/.test(source[index] ?? "")) index += 1; };
  whitespace();
  if (source[index] !== "[") throw new Error("_store.json must contain one top-level array");
  index += 1;
  const result: Array<{ start: number; end: number }> = [];
  while (true) {
    whitespace();
    if (source[index] === "]") {
      index += 1;
      break;
    }
    const start = index;
    const end = scanJSONValue(source, start);
    result.push({ start, end });
    index = end;
    whitespace();
    if (source[index] === ",") {
      index += 1;
      continue;
    }
    if (source[index] !== "]") throw new Error("Invalid top-level JSON array");
  }
  whitespace();
  if (index !== source.length) throw new Error("Unexpected content after top-level JSON array");
  return result;
}

function replaceJSON(source: string, key: string, properties: Record<string, JSONValue>): string {
  const index = rowIndex(key, "item", 0);
  const span = jsonArrayItemSpans(source)[index];
  if (!span) throw new Error(`JSON row ${index} no longer exists`);
  return `${source.slice(0, span.start)}${JSON.stringify(properties)}${source.slice(span.end)}`;
}

function physicalLines(source: string): Array<{ number: number; start: number; contentEnd: number }> {
  const result: Array<{ number: number; start: number; contentEnd: number }> = [];
  let start = 0;
  let number = 1;
  for (let index = 0; index <= source.length; index += 1) {
    if (index < source.length && source[index] !== "\r" && source[index] !== "\n") continue;
    result.push({ number, start, contentEnd: index });
    if (source[index] === "\r" && source[index + 1] === "\n") index += 1;
    start = index + 1;
    number += 1;
  }
  return result;
}

function replaceJSONL(source: string, key: string, properties: Record<string, JSONValue>): string {
  const lineNumber = rowIndex(key, "line", 0);
  const line = physicalLines(source).find((candidate) => candidate.number === lineNumber);
  if (!line) throw new Error(`JSONL line ${lineNumber} no longer exists`);
  const content = source.slice(line.start, line.contentEnd);
  const leading = content.match(/^\s*/)?.[0] ?? "";
  const trailing = content.match(/\s*$/)?.[0] ?? "";
  return `${source.slice(0, line.start)}${leading}${JSON.stringify(properties)}${trailing}${source.slice(line.contentEnd)}`;
}

interface RawCSVRecord {
  record: string[];
  raw: string;
}

function csvField(value: JSONValue | undefined): string {
  const text = value === undefined || value === null ? ""
    : typeof value === "string" ? value
    : typeof value === "number" || typeof value === "boolean" ? String(value)
    : JSON.stringify(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function replaceCSV(source: string, key: string, properties: Record<string, JSONValue>): string {
  const index = rowIndex(key, "row", 2);
  const parsed = parseCSV(source, {
    bom: true,
    raw: true,
    info: true,
    relax_column_count: true,
  }) as unknown as RawCSVRecord[];
  const header = parsed[0]?.record;
  const target = parsed[index + 1];
  if (!header || !target) throw new Error(`CSV row ${index + 1} no longer exists`);
  if (new Set(header).size !== header.length) throw new Error("Writable CSV requires unique header names");
  const unknown = Object.keys(properties).filter((name) => !header.includes(name));
  if (unknown.length) throw new Error(`CSV has no column for: ${unknown.join(", ")}`);
  const current = Object.fromEntries(header.map((name, column) => [name, target.record[column] ?? ""]));
  const values = header.map((name) => csvField(Object.hasOwn(properties, name) ? properties[name] : current[name]));
  const ending = target.raw.endsWith("\n") ? "\n" : target.raw.endsWith("\r") ? "\r" : "";
  const replacement = `${values.join(",")}${ending}`;
  let searchFrom = 0;
  let start = -1;
  for (const record of parsed.slice(0, index + 2)) {
    start = source.indexOf(record.raw, searchFrom);
    if (start < 0) throw new Error("Could not locate the exact CSV record source");
    searchFrom = start + record.raw.length;
  }
  return `${source.slice(0, start)}${replacement}${source.slice(start + target.raw.length)}`;
}

export function replaceFileRollupRow(
  backing: WritableFileRollup,
  source: string,
  rowKey: string,
  properties: Record<string, JSONValue>,
): string {
  if (backing === "json") return replaceJSON(source, rowKey, properties);
  if (backing === "jsonl") return replaceJSONL(source, rowKey, properties);
  return replaceCSV(source, rowKey, properties);
}
