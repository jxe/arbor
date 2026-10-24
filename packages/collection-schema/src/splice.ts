// Splicing changed rows into a file projection's exact text (spec 06 §2.4
// "minimal write"): untouched rows keep their bytes.

import { parse as parseCSV } from "csv-parse/sync";
import type { JSONValue } from "@ovst/protocol";
import type { CollectionSchema } from "./compile.ts";
import type { CollectionFileFormat } from "./collection-file.ts";
import { CsvEncodeError, encodeCsvRecord } from "./csv.ts";
import { ProtocolCollectionError } from "./directory-collection.ts";

type Row = Record<string, JSONValue>;
/** A changed row: `null` deletes it. Rows are named by their source position key. */
export interface CollectionRowSplice {
  replaced: ReadonlyMap<string, Row | null>;
  appended: readonly Row[];
}

interface Line { number: number; start: number; contentEnd: number; end: number }

function physicalLines(source: string): Line[] {
  const result: Line[] = [];
  let start = 0, number = 1;
  for (let index = 0; index < source.length; index++) {
    if (source[index] !== "\r" && source[index] !== "\n") continue;
    const contentEnd = index;
    if (source[index] === "\r" && source[index + 1] === "\n") index++;
    result.push({ number, start, contentEnd, end: index + 1 });
    start = index + 1;
    number++;
  }
  if (start < source.length) result.push({ number, start, contentEnd: source.length, end: source.length });
  return result;
}

function spliceJSONL(source: string, splice: CollectionRowSplice): string {
  let output = "", cursor = 0;
  for (const line of physicalLines(source)) {
    const key = `line:${line.number}`;
    if (!splice.replaced.has(key)) continue;
    output += source.slice(cursor, line.start);
    const row = splice.replaced.get(key)!;
    if (row) {
      const content = source.slice(line.start, line.contentEnd);
      const leading = content.match(/^\s*/)![0], trailing = content.match(/\s*$/)![0];
      output += `${leading}${JSON.stringify(row)}${trailing}${source.slice(line.contentEnd, line.end)}`;
    }
    cursor = line.end;
  }
  output += source.slice(cursor);
  if (splice.appended.length && output && !/[\r\n]$/.test(output)) output += "\n";
  for (const row of splice.appended) output += `${JSON.stringify(row)}\n`;
  return output;
}

function scanJSONString(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") { index += 2; continue; }
    if (source[index] === '"') return index + 1;
    index++;
  }
  throw new ProtocolCollectionError("source", "Unterminated JSON string");
}

function scanJSONValue(source: string, start: number): number {
  if (source[start] === '"') return scanJSONString(source, start);
  if (source[start] === "{" || source[start] === "[") {
    const stack = [source[start] === "{" ? "}" : "]"];
    let index = start + 1;
    while (index < source.length && stack.length) {
      const character = source[index]!;
      if (character === '"') { index = scanJSONString(source, index); continue; }
      if (character === "{") stack.push("}");
      else if (character === "[") stack.push("]");
      else if (character === stack.at(-1)) stack.pop();
      index++;
    }
    return index;
  }
  let index = start;
  while (index < source.length && !/[,\]\s]/.test(source[index]!)) index++;
  return index;
}

/** The top-level array's item spans, and where its brackets are. */
function jsonArray(source: string): { open: number; close: number; items: Array<{ start: number; end: number }> } {
  let index = 0;
  const whitespace = () => { while (/\s/.test(source[index] ?? "")) index++; };
  whitespace();
  const open = index;
  if (source[index] !== "[") throw new ProtocolCollectionError("source", "_store.json must contain one top-level array");
  index++;
  const items: Array<{ start: number; end: number }> = [];
  for (;;) {
    whitespace();
    if (source[index] === "]") break;
    const start = index, end = scanJSONValue(source, start);
    items.push({ start, end });
    index = end;
    whitespace();
    if (source[index] === ",") { index++; continue; }
    if (source[index] !== "]") throw new ProtocolCollectionError("source", "Invalid top-level JSON array");
  }
  return { open, close: index, items };
}

function spliceJSON(source: string, splice: CollectionRowSplice): string {
  const { open, close, items } = jsonArray(source);
  const removes = [...splice.replaced.values()].some((row) => row === null);
  if (!removes && !splice.appended.length) {
    let output = "", cursor = 0;
    items.forEach((item, index) => {
      const row = splice.replaced.get(`item:${index}`);
      if (row === undefined) return;
      output += source.slice(cursor, item.start) + JSON.stringify(row);
      cursor = item.end;
    });
    return output + source.slice(cursor);
  }
  // Removing or adding an item re-joins the array with the separator its
  // first two items use (or the default two-space layout).
  const texts: string[] = [];
  items.forEach((item, index) => {
    const row = splice.replaced.get(`item:${index}`);
    if (row === null) return;
    texts.push(row === undefined ? source.slice(item.start, item.end) : JSON.stringify(row));
  });
  texts.push(...splice.appended.map((row) => JSON.stringify(row)));
  const opening = items.length ? source.slice(open + 1, items[0]!.start) : "\n  ";
  const separator = items.length > 1 ? source.slice(items[0]!.end, items[1]!.start) : `,${opening}`;
  const closing = items.length ? source.slice(items.at(-1)!.end, close) : "\n";
  const body = texts.length ? `${opening}${texts.join(separator)}${closing}` : "";
  return `${source.slice(0, open)}[${body}${source.slice(close)}`;
}

interface RawRecord { record: string[]; raw: string }

function spliceCSV(source: string, schema: CollectionSchema, splice: CollectionRowSplice): string {
  const parsed = parseCSV(source, { bom: true, raw: true, info: true, relax_column_count: true, skip_empty_lines: true }) as unknown as RawRecord[];
  const header = parsed[0]?.record ?? [];
  const encode = (row: Row) => {
    try {
      return encodeCsvRecord(schema, header, row);
    } catch (error) {
      if (error instanceof CsvEncodeError) throw new ProtocolCollectionError("constraint", error.message);
      throw error;
    }
  };
  let output = "", cursor = 0;
  for (const [index, record] of parsed.entries()) {
    const start = source.indexOf(record.raw, cursor);
    if (start < 0) throw new ProtocolCollectionError("source", "Could not locate the exact CSV record source");
    const end = start + record.raw.length;
    const key = `row:${index + 1}`;
    if (index > 0 && splice.replaced.has(key)) {
      const row = splice.replaced.get(key)!;
      const ending = record.raw.match(/(\r\n|\n|\r)$/)?.[0] ?? "";
      output += source.slice(cursor, start) + (row ? `${encode(row)}${ending}` : "");
    } else output += source.slice(cursor, end);
    cursor = end;
  }
  output += source.slice(cursor);
  if (splice.appended.length && output && !/[\r\n]$/.test(output)) output += "\n";
  for (const row of splice.appended) output += `${encode(row)}\n`;
  return output;
}

/** Splice changed rows into exact collection-file text: untouched rows keep
 * their bytes, a changed row is re-encoded in place, a deleted one is removed
 * with its line ending, and new rows are appended in order. */
export function spliceCollectionFile(
  format: CollectionFileFormat,
  source: string,
  schema: CollectionSchema,
  splice: CollectionRowSplice,
): string {
  if (format === "jsonl") return spliceJSONL(source, splice);
  if (format === "json") return spliceJSON(source, splice);
  return spliceCSV(source, schema, splice);
}
