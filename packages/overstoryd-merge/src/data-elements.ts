/**
 * Data files as elements (overstoryd 017 step 7): JSON, YAML and TOML
 * members named by their key paths, array items by an identifying field or
 * by identity, and CSV/TSV rows by their record key or by identity. The
 * shared check in `elements.ts` then merges them as it merges Markdown
 * blocks: two sides adding different keys, or items to one array, merge;
 * the same key added twice, or one element changed two ways, is a choice
 * about that element.
 */
import type Parser from "web-tree-sitter";
import { parseDocument, isMap, isPair, isScalar, isSeq, isAlias, type Node as YamlNode } from "yaml";
import type { Element } from "./elements.ts";
import { byte } from "./web-formats.ts";

/** Fields that name an array's object items, in order of preference. */
const identifying = ["id", "key", "name"];

interface Builder {
  elements: Element[];
  add(element: Omit<Element, "parent" | "inline" | "attributes"> & { attributes?: string }, parent: number): number;
}
const builder = (): Builder => {
  const elements: Element[] = [];
  return {
    elements,
    add(element, parent) {
      elements.push({ attributes: "", inline: "", ...element, parent });
      return elements.length - 1;
    },
  };
};
const named = (path: string[]) => JSON.stringify(path);

/** A JSON document's members and array items. */
export function jsonElements(source: string, root: Parser.SyntaxNode): Element[] | null {
  if (root.hasError()) return null;
  const { elements, add } = builder();
  const at = (offset: number) => byte(source, offset);
  const visit = (node: Parser.SyntaxNode, path: string[], parent: number): boolean => {
    if (node.type === "object") {
      for (const pair of node.namedChildren) {
        if (pair.type === "comment") continue;
        if (pair.type !== "pair") return false;
        const key = pair.childForFieldName("key"), value = pair.childForFieldName("value");
        if (!key || !value || key.type !== "string") return false;
        const name = JSON.parse(key.text) as string, inner = [...path, name];
        const index = add({ name: named(inner), start: at(pair.startIndex), end: at(pair.endIndex), content: at(value.startIndex), kind: value.type }, parent);
        if (!visit(value, inner, index)) return false;
      }
    } else if (node.type === "array") {
      for (const item of node.namedChildren) {
        if (item.type === "comment") continue;
        const id = item.type === "object" ? jsonIdentity(item) : undefined;
        const inner = id === undefined ? [...path, "[]"] : [...path, `[${id}]`];
        const index = add({ name: id === undefined ? undefined : named(inner), start: at(item.startIndex), end: at(item.endIndex), content: at(item.startIndex), kind: item.type }, parent);
        if (!visit(item, inner, index)) return false;
      }
    }
    return true;
  };
  const top = root.namedChildren.filter((n) => n.type !== "comment");
  if (top.length !== 1) return null;
  return visit(top[0]!, [], -1) ? elements : null;
}
/** The value of an object's identifying field, when it has a string or number one. */
function jsonIdentity(object: Parser.SyntaxNode): string | undefined {
  for (const field of identifying)
    for (const pair of object.namedChildren) {
      const key = pair.childForFieldName("key"), value = pair.childForFieldName("value");
      if (key?.type === "string" && JSON.parse(key.text) === field && value && (value.type === "string" || value.type === "number"))
        return `${field}=${value.text}`;
    }
  return undefined;
}

/** A YAML document's mapping members and sequence items. Anchors, aliases,
 * tags and more than one document are not read. */
export function yamlElements(source: string): Element[] | null {
  const doc = parseDocument(source, { uniqueKeys: false, keepSourceTokens: true });
  if (doc.errors.length || doc.warnings.length) return null;
  if (/^---[\s\S]*\n---/m.test(source.replace(/^---\r?\n/, ""))) return null;
  const { elements, add } = builder();
  const at = (offset: number) => byte(source, offset);
  let readable = true;
  const visit = (node: YamlNode | null, path: string[], parent: number) => {
    if (!node || !readable) return;
    if (isAlias(node) || node.anchor || node.tag) { readable = false; return; }
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isPair(pair) || !isScalar(pair.key)) { readable = false; return; }
        const key = pair.key as YamlNode & { range?: [number, number, number] }, value = pair.value as (YamlNode & { range?: [number, number, number] }) | null;
        const inner = [...path, String((pair.key as { value: unknown }).value)];
        const start = key.range?.[0], end = (value?.range ?? key.range)?.[1];
        if (start === undefined || end === undefined) { readable = false; return; }
        const kind = !value ? "null" : isMap(value) ? "map" : isSeq(value) ? "seq" : "scalar";
        const index = add({ name: named(inner), start: at(start), end: at(end), content: at(value?.range?.[0] ?? end), kind }, parent);
        visit(value, inner, index);
      }
    } else if (isSeq(node)) {
      for (const item of node.items as Array<YamlNode & { range?: [number, number, number] }>) {
        if (!item?.range) { readable = false; return; }
        const id = isMap(item) ? yamlIdentity(item) : undefined;
        const inner = id === undefined ? [...path, "[]"] : [...path, `[${id}]`];
        const index = add({ name: id === undefined ? undefined : named(inner), start: at(item.range[0]), end: at(item.range[1]), content: at(item.range[0]), kind: isMap(item) ? "map" : isSeq(item) ? "seq" : "scalar" }, parent);
        visit(item, inner, index);
      }
    }
  };
  visit(doc.contents as YamlNode | null, [], -1);
  return readable ? elements : null;
}
function yamlIdentity(map: YamlNode): string | undefined {
  if (!isMap(map)) return undefined;
  for (const field of identifying)
    for (const pair of map.items)
      if (isPair(pair) && isScalar(pair.key) && pair.key.value === field && isScalar(pair.value) &&
        (typeof pair.value.value === "string" || typeof pair.value.value === "number"))
        return `${field}=${JSON.stringify(pair.value.value)}`;
  return undefined;
}

/** A TOML document's tables and pairs, with array items. Dotted keys are
 * read as their full path. */
export function tomlElements(source: string, root: Parser.SyntaxNode): Element[] | null {
  if (root.hasError()) return null;
  const { elements, add } = builder();
  const at = (offset: number) => byte(source, offset);
  const key = (node: Parser.SyntaxNode): string[] =>
    node.type === "dotted_key" ? node.namedChildren.flatMap(key)
      : [node.text.startsWith('"') ? JSON.parse(node.text) : node.text.startsWith("'") ? node.text.slice(1, -1) : node.text];
  const values = (node: Parser.SyntaxNode, path: string[], parent: number) => {
    if (node.type === "array")
      for (const item of node.namedChildren) {
        if (item.type === "comment") continue;
        const index = add({ start: at(item.startIndex), end: at(item.endIndex), content: at(item.startIndex), kind: item.type }, parent);
        values(item, [...path, "[]"], index);
      }
    else if (node.type === "inline_table") pairs(node, path, parent);
  };
  const pairs = (node: Parser.SyntaxNode, path: string[], parent: number) => {
    for (const pair of node.namedChildren) {
      if (pair.type !== "pair") continue;
      const k = pair.namedChildren[0], value = pair.namedChildren[1];
      if (!k || !value) continue;
      const inner = [...path, ...key(k)];
      const index = add({ name: named(inner), start: at(pair.startIndex), end: at(pair.endIndex), content: at(value.startIndex), kind: value.type }, parent);
      values(value, inner, index);
    }
  };
  pairs(root, [], -1);
  for (const table of root.namedChildren) {
    if (table.type !== "table" && table.type !== "table_array_element") continue;
    const header = table.namedChildren[0];
    if (!header) return null;
    const path = key(header);
    // An array of tables is a sequence of unnamed tables.
    const name = table.type === "table" ? named(["[table]", ...path]) : undefined;
    const index = add({ name, start: at(table.startIndex), end: at(table.endIndex), content: at(header.endIndex), kind: table.type }, -1);
    pairs(table, table.type === "table" ? path : [...path, "[]"], index);
  }
  return elements;
}

/** A CSV or TSV table's header and rows. Rows are named by `key`'s column
 * when given, else by identity. A merged row must have the header's width. */
export function tableElements(source: string, delimiter: string, key: string | undefined): Element[] | null {
  const rows = tableRows(source, delimiter);
  if (!rows?.length) return null;
  const header = rows[0]!;
  const column = key === undefined ? -1 : header.cells.indexOf(key);
  if (key !== undefined && column < 0) return null;
  return rows.map((row, i) => ({
    name: i === 0 ? "header" : column >= 0 && row.cells[column] ? JSON.stringify(["row", row.cells[column]]) : undefined,
    start: row.start, end: row.end, content: row.start,
    kind: i === 0 ? "header" : "row",
    attributes: "",
    // The header's cells are its structure; a row's is its width.
    inline: i === 0 ? JSON.stringify(header.cells) : String(row.cells.length),
    parent: -1,
  }));
}
/** Rows of the merged table whose width differs from its header's. */
export function tableInvalid(elements: Element[]): number[] {
  const width = elements[0]?.kind === "header" ? JSON.parse(elements[0].inline).length : undefined;
  return width === undefined ? [] : elements.flatMap((e, i) => e.kind === "row" && Number(e.inline) !== width ? [i] : []);
}
function tableRows(source: string, delimiter: string): Array<{ cells: string[]; start: number; end: number }> | null {
  const rows: Array<{ cells: string[]; start: number; end: number }> = [];
  let cells: string[] = [], value = "", quoted = false, closed = false, rowStart = 0, fieldStart = 0;
  for (let i = 0; i <= source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') { value += '"'; i++; } else { quoted = false; closed = true; }
      } else if (c === undefined) return null;
      else value += c;
      continue;
    }
    if (closed && c !== delimiter && c !== "\n" && c !== undefined && !(c === "\r" && source[i + 1] === "\n")) return null;
    if (c === '"') {
      if (i !== fieldStart) return null;
      quoted = true;
      continue;
    }
    if (c === delimiter || c === "\n" || c === undefined) {
      cells.push(value.replace(/\r$/, ""));
      value = ""; closed = false; fieldStart = i + 1;
      if (c !== delimiter) {
        if (cells.length > 1 || cells[0] !== "") rows.push({ cells, start: byte(source, rowStart), end: byte(source, Math.min(i + 1, source.length)) });
        cells = []; rowStart = i + 1;
      }
    } else value += c;
  }
  return rows;
}
