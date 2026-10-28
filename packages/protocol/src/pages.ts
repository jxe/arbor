import { isAlias, isMap, isScalar, isSeq, parseDocument, type DocumentOptions, type Node as YAMLNode, type ParseOptions, type ScalarTag, type SchemaOptions, type Document as YAMLDocument } from "yaml";
import { CBORTag, decodeCBOR, encodeCanonicalCBOR } from "./model/cbor.ts";
import { compareUTF8 } from "./model/utf8.ts";

/**
 * Pages (spec 01 §1.1.2, directory format §3): a Markdown page held as
 * logical state, its properties in the order they were added, its stable `id`
 * and its exact body bytes. Each placement writes the frontmatter in its own
 * spelling; this module reads a file into a page and writes a page into a
 * file, minimally against what the file already holds.
 */

/** Tag 1004 (RFC 8943) holds a `YYYY-MM-DD` date, tag 0 an RFC 3339 date-time in UTC. */
export type PageTimestamp = CBORTag & { tag: 0 | 1004; value: string };
export type PageValue = null | boolean | number | string | PageTimestamp | PageValue[] | { [name: string]: PageValue };
export type PageProperty = [string, PageValue];

export interface ProtocolPage {
  type: "page";
  /** The page's stable key, kept across rename and move. */
  id?: string;
  /** In the order they were added; names are unique and none is `id`. */
  properties: PageProperty[];
  /** Everything after the frontmatter's closing line, byte for byte. */
  body: Uint8Array;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CANONICAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d*[1-9])?Z$/;
/** YAML's timestamp forms: a date, or a date and time with an optional zone. */
const YAML_DATE_TIME = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[Tt]|[ \t]+)(\d{1,2}):(\d{2}):(\d{2})(\.\d+)?(?:[ \t]*(Z|[-+]\d{1,2}(?::?\d{2})?))?$/;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/** Whether a directory entry with this name is a page when its file parses. */
export function isPageName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".mdx");
}

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

export function pageDate(value: string): PageTimestamp {
  return new CBORTag(1004, value) as PageTimestamp;
}

export function pageDateTime(value: string): PageTimestamp {
  return new CBORTag(0, value) as PageTimestamp;
}

export function isPageTimestamp(value: unknown): value is PageTimestamp {
  if (!(value instanceof CBORTag) || typeof value.value !== "string") return false;
  if (value.tag === 1004) {
    const match = DATE.exec(value.value);
    return !!match && validDate(+match[1]!, +match[2]!, +match[3]!);
  }
  if (value.tag === 0) {
    const match = CANONICAL_DATE_TIME.exec(value.value);
    return !!match && validDate(+match[1]!, +match[2]!, +match[3]!) && +match[4]! < 24 && +match[5]! < 60 && +match[6]! < 60;
  }
  return false;
}

/**
 * A YAML timestamp as a page value, or null when the text is not a real date
 * or time (it then reads as a string). A date-time moves to UTC; its fraction
 * keeps its digits without trailing zeros.
 */
export function pageTimestamp(text: string): PageTimestamp | null {
  const date = DATE.exec(text);
  if (date) return validDate(+date[1]!, +date[2]!, +date[3]!) ? pageDate(text) : null;
  const match = YAML_DATE_TIME.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (!validDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  let offset = 0;
  const zone = match[8];
  if (zone && zone !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const hours = Number(digits.length <= 2 ? digits : digits.slice(0, -2));
    const minutes = digits.length <= 2 ? 0 : Number(digits.slice(-2));
    if (hours > 23 || minutes > 59) return null;
    offset = sign * (hours * 60 + minutes);
  }
  let minutes = daysFromCivil(year, month, day) * 1440 + hour * 60 + minute - offset;
  const days = Math.floor(minutes / 1440);
  minutes -= days * 1440;
  const civil = civilFromDays(days);
  if (civil.year < 0 || civil.year > 9999) return null;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const fraction = (match[7] ?? "").replace(/0+$/, "");
  return pageDateTime(`${pad(civil.year, 4)}-${pad(civil.month)}-${pad(civil.day)}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:${pad(second)}${fraction === "." ? "" : fraction}Z`);
}

/** Days since 1970-01-01 of a proleptic Gregorian date, for any year. */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

// MARK: Objects

function checkValue(value: unknown, depth: number): asserts value is PageValue {
  if (depth > 64) throw new Error("Page value nests too deeply");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Page numbers are finite");
    return;
  }
  if (value instanceof CBORTag) {
    if (!isPageTimestamp(value)) throw new Error("Invalid page timestamp");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) checkValue(item, depth + 1);
    return;
  }
  if (typeof value === "object" && !(value instanceof Uint8Array)) {
    for (const item of Object.values(value as Record<string, unknown>)) checkValue(item, depth + 1);
    return;
  }
  throw new Error("Invalid page value");
}

function checkPage(page: ProtocolPage): void {
  if (page.type !== "page" || !Array.isArray(page.properties) || !(page.body instanceof Uint8Array)) throw new Error("Invalid page object");
  if (page.id !== undefined && (typeof page.id !== "string" || !page.id.length)) throw new Error("A page's id is a nonempty string");
  const names = new Set<string>();
  for (const property of page.properties) {
    if (!Array.isArray(property) || property.length !== 2 || typeof property[0] !== "string" || !property[0].length)
      throw new Error("Invalid page property");
    if (property[0] === "id") throw new Error("A page's id is not a property");
    if (names.has(property[0])) throw new Error("Duplicate page property");
    names.add(property[0]);
    checkValue(property[1], 0);
  }
  decoder.decode(page.body);
}

/** The page's canonical CBOR object bytes; its hash is its object and model hash. */
export function encodeProtocolPage(page: ProtocolPage): Uint8Array {
  checkPage(page);
  return encodeCanonicalCBOR({
    type: "page",
    ...(page.id !== undefined ? { id: page.id } : {}),
    properties: page.properties,
    body: page.body,
  });
}

export function decodeProtocolPage(bytes: Uint8Array): ProtocolPage {
  const value = decodeCBOR(bytes, { tags: [0, 1004] });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid page object");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.type !== "page" || !keys.every((key) => ["type", "id", "properties", "body"].includes(key))
    || !keys.includes("properties") || !keys.includes("body")) throw new Error("Invalid page object");
  const page: ProtocolPage = {
    type: "page",
    ...(record.id !== undefined ? { id: record.id as string } : {}),
    properties: record.properties as PageProperty[],
    body: record.body as Uint8Array,
  };
  const canonical = encodeProtocolPage(page);
  if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) throw new Error("Page object is not canonical CBOR");
  return page;
}

export function samePage(left: ProtocolPage, right: ProtocolPage): boolean {
  const a = encodeProtocolPage(left), b = encodeProtocolPage(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** A property's value, or undefined when the page has none of that name. */
export function pageProperty(page: ProtocolPage, name: string): PageValue | undefined {
  return page.properties.find(([key]) => key === name)?.[1];
}

/** The page's properties as a plain record, `id` first when present, as a document reader sees them. */
export function pagePropertyRecord(page: ProtocolPage): Record<string, PageValue> {
  return Object.fromEntries([...(page.id !== undefined ? [["id", page.id] as const] : []), ...page.properties]);
}

/** A page value as JSON, where property operations and decisions carry it (spec 10 §4.1). */
export type PageValueJSON = null | boolean | number | string | PageValueJSON[] | { [name: string]: PageValueJSON };

const ESCAPED_KEYS = new Set(["$date", "$dateTime", "$map"]);

/**
 * A page value in JSON: a date is `{"$date": text}` and a date-time
 * `{"$dateTime": text}`, and a map whose one key is `$date`, `$dateTime` or
 * `$map` is wrapped as `{"$map": map}`, so every value has one spelling.
 */
export function pageValueJSON(value: PageValue): PageValueJSON {
  if (value instanceof CBORTag) return value.tag === 1004 ? { $date: value.value as string } : { $dateTime: value.value as string };
  if (Array.isArray(value)) return value.map(pageValueJSON);
  if (value && typeof value === "object") {
    const map = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, pageValueJSON(item)]));
    const keys = Object.keys(map);
    return keys.length === 1 && ESCAPED_KEYS.has(keys[0]!) ? { $map: map } : map;
  }
  return value;
}

/** The page value a JSON spelling stands for; throws on one that is no page value. */
export function pageValueFromJSON(value: unknown): PageValue {
  if (Array.isArray(value)) return value.map(pageValueFromJSON);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>, keys = Object.keys(record);
    if (keys.length === 1 && (keys[0] === "$date" || keys[0] === "$dateTime")) {
      const text = record[keys[0]];
      const stamp = typeof text === "string" ? pageTimestamp(text) : null;
      if (!stamp || (keys[0] === "$date") !== (stamp.tag === 1004) || stamp.value !== text) throw new Error("Invalid page timestamp");
      return stamp;
    }
    if (keys.length === 1 && keys[0] === "$map") {
      const inner = record.$map;
      if (!inner || typeof inner !== "object" || Array.isArray(inner)) throw new Error("Invalid page map");
      const innerKeys = Object.keys(inner);
      if (innerKeys.length !== 1 || !ESCAPED_KEYS.has(innerKeys[0]!)) throw new Error("Invalid page map");
      return Object.fromEntries(Object.entries(inner).map(([key, item]) => [key, pageValueFromJSON(item)]));
    }
    return Object.fromEntries(keys.map((key) => [key, pageValueFromJSON(record[key])]));
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error("Invalid page value");
}

/** One property operation on a page, as `applyPageOperations` takes it. */
export type PagePropertyEdit =
  | { kind: "set"; field: string; before: PageValueJSON; value: PageValueJSON }
  | { kind: "connect" | "disconnect"; field: string; member: PageValueJSON }
  | { kind: "move"; field: string; member: PageValueJSON; after: PageValueJSON | null };

/**
 * Apply property operations to a page, in order (spec 10 §4.1): `set`
 * checks `before` against the property (`null` is absent) and writes `value`,
 * a new property going last and `null` removing it; `connect`, `disconnect`
 * and `move` edit a list property, an absent one reading as empty. Throws on
 * an operation that does not apply. The body is unchanged.
 */
export function applyPageOperations(page: ProtocolPage, operations: readonly PagePropertyEdit[]): ProtocolPage {
  const fail = (message: string): never => { throw new Error(`Invalid page operation: ${message}`); };
  const properties = page.properties.map(([name, value]) => [name, value] as PageProperty);
  const same = (left: PageValue | undefined, right: PageValue | undefined) => left === undefined || right === undefined
    ? left === right : Buffer.from(encodeCanonicalCBOR(left)).equals(Buffer.from(encodeCanonicalCBOR(right)));
  for (const operation of operations) {
    if (!operation.field || operation.field === "id") fail("a page's id is no property");
    const index = properties.findIndex(([name]) => name === operation.field);
    const current = index >= 0 ? properties[index]![1] : undefined;
    if (operation.kind === "set") {
      const before = operation.before === null ? undefined : pageValueFromJSON(operation.before);
      const value = operation.value === null ? undefined : pageValueFromJSON(operation.value);
      if (!same(before, current)) fail("before does not match the page");
      if (same(before, value)) fail("set changes nothing");
      if (value === undefined) properties.splice(index, 1);
      else if (index >= 0) properties[index]![1] = value;
      else properties.push([operation.field, value]);
      continue;
    }
    if (current !== undefined && !Array.isArray(current)) fail("property is not a list");
    const list = [...((current ?? []) as PageValue[])];
    const at = (member: PageValueJSON) => { const value = pageValueFromJSON(member); return list.findIndex((item) => same(item, value)); };
    if (operation.kind === "connect") {
      if (at(operation.member) >= 0) fail("member is already present");
      list.push(pageValueFromJSON(operation.member));
    } else if (operation.kind === "disconnect") {
      const position = at(operation.member);
      if (position < 0) fail("member is absent");
      list.splice(position, 1);
    } else if (operation.kind === "move") {
      const position = at(operation.member);
      if (position < 0) fail("member is absent");
      const [moved] = list.splice(position, 1);
      const after = operation.after === null ? -1 : at(operation.after);
      if (operation.after !== null && after < 0) fail("after is absent");
      list.splice(after + 1, 0, moved!);
      if (position === after + 1) fail("move changes nothing");
    }
    if (index >= 0) properties[index]![1] = list;
    else properties.push([operation.field, list]);
  }
  const result: ProtocolPage = { ...page, properties };
  checkPage(result);
  return result;
}

// MARK: Reading a file

/** A file's frontmatter: the source lines between an opening `---` line and the next `---` line. */
export interface FrontmatterSplit {
  /** The whole block, both fence lines included, or null when the file has none. */
  block: string | null;
  /** The YAML between the fences. */
  yaml: string | null;
  /** Everything after the closing fence's line. */
  body: string;
}

export function splitPageFrontmatter(source: string): FrontmatterSplit {
  const firstEnd = source.indexOf("\n");
  const firstLine = firstEnd < 0 ? source : source.slice(0, firstEnd);
  if (firstLine.trim() !== "---" || firstEnd < 0) return { block: null, yaml: null, body: source };
  let start = firstEnd + 1;
  while (start <= source.length) {
    const end = source.indexOf("\n", start);
    const line = end < 0 ? source.slice(start) : source.slice(start, end);
    if (line.trim() === "---") {
      const after = end < 0 ? source.length : end + 1;
      return { block: source.slice(0, after), yaml: source.slice(firstEnd + 1, start), body: source.slice(after) };
    }
    if (end < 0) break;
    start = end + 1;
  }
  return { block: null, yaml: null, body: source };
}

const timestampTag: ScalarTag = {
  tag: "tag:yaml.org,2002:timestamp",
  default: true,
  test: /^(?:\d{4}-\d{2}-\d{2}|\d{4}-\d{1,2}-\d{1,2}(?:[Tt]|[ \t]+)\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?:[ \t]*(?:Z|[-+]\d{1,2}(?::?\d{2})?))?)$/,
  // A timestamp that is no real date or time reads as the string it is.
  resolve: (text: string) => pageTimestamp(text) ?? text,
  identify: (value: unknown) => value instanceof CBORTag,
  stringify: (item) => String((item.value as CBORTag).value),
};

/** YAML 1.2's core schema plus timestamps: the one reading of frontmatter. */
const YAML_OPTIONS: ParseOptions & DocumentOptions & SchemaOptions = { version: "1.2", schema: "core", customTags: [timestampTag], uniqueKeys: true };
const NODE_BUDGET = 100_000;

class Unreadable extends Error {}

function pageValue(node: unknown, document: YAMLDocument, budget: { nodes: number }, depth: number): PageValue {
  if (--budget.nodes < 0 || depth > 64) throw new Unreadable("Frontmatter is too large");
  if (node === null || node === undefined) return null;
  if (isAlias(node)) return pageValue(node.resolve(document), document, budget, depth + 1);
  if (isScalar(node)) {
    const value = node.value;
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Unreadable("Frontmatter numbers are finite");
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === "bigint") return Number(value);
    if (value instanceof CBORTag) return value as PageTimestamp;
    throw new Unreadable("Unsupported frontmatter value");
  }
  if (isSeq(node)) return node.items.map((item) => pageValue(item, document, budget, depth + 1));
  if (isMap(node)) {
    const result: Record<string, PageValue> = {};
    for (const pair of node.items) {
      const key = isAlias(pair.key) ? pair.key.resolve(document) : pair.key;
      if (!isScalar(key) || typeof key.value !== "string") throw new Unreadable("Frontmatter keys are strings");
      if (Object.hasOwn(result, key.value)) throw new Unreadable("Duplicate frontmatter key");
      result[key.value] = pageValue(pair.value, document, budget, depth + 1);
    }
    return result;
  }
  throw new Unreadable("Unsupported frontmatter node");
}

/** The page frontmatter YAML holds, or null when it is not a map of string keys YAML 1.2 reads. */
export function parsePageFrontmatter(yaml: string): { id?: string; properties: PageProperty[] } | null {
  let document: YAMLDocument;
  try {
    document = parseDocument(yaml, YAML_OPTIONS) as YAMLDocument;
  } catch {
    return null;
  }
  if (document.errors.length) return null;
  const contents = document.contents as YAMLNode | null;
  if (contents === null || (isScalar(contents) && contents.value === null)) return { properties: [] };
  if (!isMap(contents)) return null;
  try {
    const budget = { nodes: NODE_BUDGET };
    let id: string | undefined;
    const properties: PageProperty[] = [];
    const names = new Set<string>();
    for (const pair of contents.items) {
      const key = isAlias(pair.key) ? pair.key.resolve(document) : pair.key;
      if (!isScalar(key) || typeof key.value !== "string" || !key.value.length) return null;
      if (names.has(key.value)) return null;
      names.add(key.value);
      if (key.value === "id") {
        // An id is a key's text: `id: 123456` is the id "123456".
        const value = isAlias(pair.value) ? pair.value.resolve(document) : pair.value;
        if (!isScalar(value) || value.value === null) return null;
        const text = typeof value.value === "string" ? value.value : value.source ?? String(value.value);
        if (!text.length) return null;
        id = text;
        continue;
      }
      properties.push([key.value, pageValue(pair.value, document, budget, 0)]);
    }
    return { ...(id !== undefined ? { id } : {}), properties };
  } catch (error) {
    if (error instanceof Unreadable) return null;
    throw error;
  }
}

/**
 * The page a `.md` or `.mdx` file holds, or null when it is not one: its
 * bytes are not UTF-8, or its frontmatter does not read as YAML 1.2. Such a
 * file stays a file entry, with the `unparsed-front-matter` diagnostic.
 */
export function parsePage(bytes: Uint8Array): ProtocolPage | null {
  let source: string;
  try {
    source = decoder.decode(bytes);
  } catch {
    return null;
  }
  const split = splitPageFrontmatter(source);
  if (split.yaml === null) return { type: "page", properties: [], body: bytes };
  const frontmatter = parsePageFrontmatter(split.yaml);
  if (!frontmatter) return null;
  return { type: "page", ...frontmatter, body: encoder.encode(split.body) };
}

// MARK: Writing a file

const NULL_TEXT = /^(?:null|Null|NULL|~)$/;
const BOOL_TEXT = /^(?:true|True|TRUE|false|False|FALSE)$/;
const INT_TEXT = /^(?:[-+]?[0-9]+|0o[0-7]+|0x[0-9a-fA-F]+)$/;
const FLOAT_TEXT = /^(?:[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/;

/** Whether a string can be written plain and read back as the same string. */
function plain(text: string): boolean {
  if (!text.length || text !== text.trim()) return false;
  if (/[\u0000-\u001f\u007f\u0085\u2028\u2029\ufeff]/.test(text)) return false;
  if (/^[-?:,\[\]{}#&*!|>'"%@`.]/.test(text)) return false;
  if (text.includes(": ") || text.includes(" #") || text.endsWith(":")) return false;
  if (NULL_TEXT.test(text) || BOOL_TEXT.test(text) || INT_TEXT.test(text) || FLOAT_TEXT.test(text)) return false;
  if (timestampTag.test!.test(text)) return false;
  return true;
}

/** A double-quoted YAML scalar: JSON's escapes, all of which YAML reads. */
function quoted(text: string): string {
  return JSON.stringify(text);
}

/** A number as the shortest text that reads back to it: ECMAScript's form,
 * with integral values beyond the safe range in exponent form so they read
 * as floats. */
export function pageNumberText(value: number): string {
  if (Object.is(value, -0) || value === 0) return "0";
  if (Number.isSafeInteger(value)) return String(value);
  if (Number.isInteger(value)) return value.toExponential().replace(/\.?0*e/, "e");
  return String(value);
}

function scalarText(value: PageValue): string | null {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return pageNumberText(value);
  if (typeof value === "string") return plain(value) ? value : quoted(value);
  if (value instanceof CBORTag) return value.value as string;
  if (Array.isArray(value)) return value.length ? null : "[]";
  return Object.keys(value).length ? null : "{}";
}

function keyText(key: string): string {
  return plain(key) ? key : quoted(key);
}

/** One mapping entry in block style at `indent`. */
function entryLines(key: string, value: PageValue, indent: string): string {
  const scalar = scalarText(value);
  if (scalar !== null) return `${indent}${keyText(key)}: ${scalar}\n`;
  return `${indent}${keyText(key)}:\n${blockLines(value, `${indent}  `)}`;
}

/** A nonempty sequence or mapping in block style at `indent`. */
function blockLines(value: PageValue, indent: string): string {
  if (Array.isArray(value)) {
    return value.map((item) => {
      const scalar = scalarText(item);
      if (scalar !== null) return `${indent}- ${scalar}\n`;
      // A nested collection starts on the dash's line.
      const nested = blockLines(item, `${indent}  `);
      return `${indent}- ${nested.slice(indent.length + 2)}`;
    }).join("");
  }
  const record = value as Record<string, PageValue>;
  return Object.keys(record).sort(compareUTF8).map((key) => entryLines(key, record[key]!, indent)).join("");
}

/** The frontmatter block a page is written with from nothing, or "" when it has no id and no properties. */
export function canonicalPageFrontmatter(page: Pick<ProtocolPage, "id" | "properties">): string {
  if (page.id === undefined && !page.properties.length) return "";
  const lines = [
    ...(page.id !== undefined ? [entryLines("id", page.id, "")] : []),
    ...page.properties.map(([key, value]) => entryLines(key, value, "")),
  ];
  return `---\n${lines.join("")}---\n`;
}

function concat(text: string, body: Uint8Array): Uint8Array {
  const head = encoder.encode(text);
  const result = new Uint8Array(head.length + body.length);
  result.set(head);
  result.set(body, head.length);
  return result;
}

/** The file a page is written as from nothing (directory format §3, canonical form). */
export function canonicalPageFile(page: ProtocolPage): Uint8Array {
  return concat(canonicalPageFrontmatter(page), page.body);
}

/** Whether `bytes` read back to exactly `page`. */
export function fileHoldsPage(bytes: Uint8Array, page: ProtocolPage): boolean {
  const read = parsePage(bytes);
  return !!read && samePage(read, page);
}

/**
 * The file to write for `page` where `existing` is on disk (directory format
 * §3): unchanged when it already reads back to the page, otherwise only the
 * changed keys spliced into its frontmatter, keeping every untouched line as
 * it is, and the canonical form when that cannot be done.
 */
export function writePageFile(page: ProtocolPage, existing?: Uint8Array | null): Uint8Array {
  if (!existing) return canonicalPageFile(page);
  const before = parsePage(existing);
  if (before && samePage(before, page)) return existing;
  if (before) {
    const spliced = splicePage(decoder.decode(existing), before, page);
    if (spliced && fileHoldsPage(spliced, page)) return spliced;
  }
  return canonicalPageFile(page);
}

function sameValue(left: PageValue | undefined, right: PageValue | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  const a = encodeCanonicalCBOR(left), b = encodeCanonicalCBOR(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function splicePage(source: string, before: ProtocolPage, after: ProtocolPage): Uint8Array | null {
  const split = splitPageFrontmatter(source);
  const keys = (page: ProtocolPage) => [...(page.id !== undefined ? ["id"] : []), ...page.properties.map(([key]) => key)];
  const value = (page: ProtocolPage, key: string): PageValue | undefined => key === "id" ? page.id : pageProperty(page, key);
  const oldKeys = keys(before), newKeys = keys(after);
  // Kept keys keep their places; added ones go at the end, as the page orders them.
  const kept = oldKeys.filter((key) => newKeys.includes(key));
  const added = newKeys.filter((key) => !oldKeys.includes(key));
  if ([...kept, ...added].some((key, index) => key !== newKeys[index])) return null;
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = (key: string) => entryLines(key, value(after, key)!, "").replaceAll("\n", newline);
  if (split.yaml === null) {
    if (!newKeys.length) return encoder.encode(source);
    return concat(`---${newline}${newKeys.map(lines).join("")}---${newline}`, after.body);
  }
  const document = parseDocument(split.yaml, YAML_OPTIONS) as YAMLDocument;
  const contents = document.contents as YAMLNode | null;
  const yaml = split.yaml;
  const lineStart = (offset: number) => yaml.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = (offset: number) => {
    const end = yaml.indexOf("\n", Math.max(offset - 1, 0));
    return end < 0 ? yaml.length : end + 1;
  };
  // Each kept or removed key's source lines, from its key to its value's end.
  const spans = new Map<string, [number, number]>();
  if (contents !== null && !(isScalar(contents) && contents.value === null)) {
    if (!isMap(contents) || contents.flow) return null;
    for (const pair of contents.items) {
      const key = pair.key as YAMLNode & { range?: [number, number, number] };
      const node = pair.value as (YAMLNode & { range?: [number, number, number] }) | null;
      if (!isScalar(key) || !key.range) return null;
      const end = node?.range ? node.range[1] : key.range[1];
      spans.set(String(key.value), [lineStart(key.range[0]), lineEnd(end)]);
    }
  }
  let edited = yaml;
  const edits: Array<{ span: [number, number]; text: string }> = [];
  for (const key of oldKeys) {
    const span = spans.get(key);
    if (!span) return null;
    if (!newKeys.includes(key)) edits.push({ span, text: "" });
    else if (!sameValue(value(before, key), value(after, key))) edits.push({ span, text: lines(key) });
  }
  for (const edit of edits.sort((a, b) => b.span[0] - a.span[0]))
    edited = edited.slice(0, edit.span[0]) + edit.text + edited.slice(edit.span[1]);
  if (added.length) {
    if (edited.length && !edited.endsWith("\n")) edited += newline;
    edited += added.map(lines).join("");
  }
  const opening = split.block!.slice(0, split.block!.indexOf("\n") + 1);
  const closing = split.block!.slice(opening.length + yaml.length);
  return concat(`${opening}${edited}${closing}`, after.body);
}

/** The page's file text as an editor shows it from nothing. */
export function pageSourceText(page: ProtocolPage): string {
  return decoder.decode(canonicalPageFile(page));
}
