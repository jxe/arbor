// `usl fmt`: prints a schema in the conventional form (spec 11 §2).
//
// - Presentation (`~`) attributes written in a `model` or `enum` block move
//   to that model's `re` block, which is created after the model if there
//   isn't one. Storage (`@`) attributes stay where they are written.
// - In a block, fields, ends and annotations come first, then an enum's
//   values, then model-level items (`seed`, `@table`, `@index`, `~views`),
//   each group after a blank line.
// - Two spaces indent a block; field names, value names and trailing comments
//   are aligned across lines that no blank line separates.
// - Comments are kept with the item they precede or follow. An item that
//   spans lines with a comment inside it is kept as written.
// - A blank line in the source is kept (runs of them become one), and
//   multi-line declarations are separated by one.

import type { Attribute, Declaration, Diagnostic, EndDecl, Expr, Member, ModelDecl, ObjectEntry, ReDecl, Row } from "./ast.ts";
import { parseUslForFormat, type Comment } from "./parse.ts";

const WIDTH = 80;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Formats a schema, or returns its syntax error. */
export function formatUsl(source: string): { text: string; diagnostics: [] } | { text: null; diagnostics: Diagnostic[] } {
  const parsed = parseUslForFormat(source);
  if (!parsed.file) return { text: null, diagnostics: parsed.diagnostics };
  const printer = new Printer(source, parsed.ends);
  const declarations = movePresentation(parsed.file.declarations);
  const items = declarations.map((d) => printer.declarationItem(d));
  const lines = printer.render(printer.place(items, parsed.comments, 0, Infinity).entries, "", true);
  return { text: lines.join("\n") + "\n", diagnostics: [] };
}

/** Moves `~` attributes out of `model` and `enum` blocks into `re` blocks. */
function movePresentation(declarations: Declaration[]): Declaration[] {
  const out: Declaration[] = [];
  const reFor = new Map<string, ReDecl>();
  for (const d of declarations) if (d.kind === "re" && !reFor.has(d.name)) reFor.set(d.name, d);
  for (const d of declarations) {
    out.push(d);
    if (d.kind !== "model") continue;
    const moved: Member[] = [];
    const kept: Member[] = [];
    for (const m of d.members) {
      if (m.kind === "modelAttribute" && m.sigil === "~") moved.push(m);
      else kept.push(m);
      if (m.kind === "field") {
        const presentation = m.attrs.filter((a) => a.sigil === "~");
        if (presentation.length === 0) continue;
        m.attrs = m.attrs.filter((a) => a.sigil !== "~");
        moved.push({ kind: "mention", name: m.name, attrs: presentation, at: m.at });
      }
      if (m.kind === "rows" && m.mode === "fixed") {
        for (const row of m.rows) {
          const presentation = row.attrs.filter((a) => a.sigil === "~");
          if (presentation.length === 0) continue;
          row.attrs = row.attrs.filter((a) => a.sigil !== "~");
          moved.push({ kind: "mention", name: row.name, attrs: presentation, at: row.at });
        }
      }
    }
    if (moved.length === 0) continue;
    d.members = kept;
    // Annotations of fields and values go before the model-level ones moved with them.
    moved.sort((a, b) => Number(a.kind === "modelAttribute") - Number(b.kind === "modelAttribute"));
    const re = reFor.get(d.name);
    if (re) re.members.push(...moved);
    else {
      const created: ReDecl = { kind: "re", name: d.name, members: moved, at: d.at };
      reFor.set(d.name, created);
      out.push(created);
    }
  }
  return out;
}

/** One item of a block or of the file, before comments are placed. */
interface Item {
  /** Source lines; null for an item `usl fmt` created. */
  start: number | null;
  end: number | null;
  column: number;
  /** Members of a block printed with their own comments, or null for a leaf. */
  inner: Item[] | null;
  /** For a block: its header (`model Game`), and its one-line form when it has one. */
  header?: string;
  oneLine?: string;
  /** For a leaf: an aligned name and the rest, or lines already laid out. */
  name?: string;
  rest?: string;
  lines?: string[];
  /** Starts a group of its block (enum values, model-level items) after a blank line. */
  group: number;
}

interface Entry {
  blank: boolean;
  leading: { text: string; blank: boolean }[];
  bodyBlank: boolean;
  name?: string;
  rest?: string;
  comment?: string;
  lines?: string[];
}

class Printer {
  private readonly lines: string[];

  constructor(
    source: string,
    private readonly ends: WeakMap<object, number>,
  ) {
    this.lines = source.split("\n");
  }

  private span(node: object & { at: { line: number; column: number } }, created = false) {
    const end = this.ends.get(node);
    if (created || end === undefined) return { start: null, end: null, column: 0 };
    return { start: node.at.line, end, column: node.at.column };
  }

  declarationItem(d: Declaration): Item {
    switch (d.kind) {
      case "model":
        return this.modelItem(d);
      case "re": {
        const created = !this.ends.has(d);
        return { ...this.span(d, created), inner: this.blockItems(d.members), header: `re ${d.name}`, group: 0 };
      }
      case "connection": {
        const ends = d.members.filter((m): m is EndDecl => m.kind === "end");
        const text =
          d.spelling === "arrow" && ends.length === 2
            ? `${end(ends[0]!)} <-> ${end(ends[1]!)}`
            : `{ ${d.members.map((m) => member(m)).join(", ")} }`;
        return { ...this.span(d), inner: null, rest: text, group: 0 };
      }
      case "view":
        return { ...this.span(d), inner: null, rest: `view ${quote(d.label)} of ${d.of} ${object(d.options)}`, group: 0 };
    }
  }

  private modelItem(d: ModelDecl): Item {
    const key = d.key ? ` (${d.key.fields.map((f) => f.name).join(", ")})` : "";
    const header = d.form === "enum" ? `enum ${d.name}` : `${d.main ? "main " : ""}model ${d.name}${key}`;
    const item: Item = { ...this.span(d), inner: this.blockItems(d.members), header, group: 0 };
    if (d.form === "enum") {
      const plain = d.members.every((m) => m.kind === "rows" && m.rows.every((r) => r.values.length === 0 && r.attrs.length === 0));
      if (plain) {
        const values = d.members.flatMap((m) => (m.kind === "rows" ? m.rows.map((r) => name(r.name)) : []));
        item.oneLine = values.length === 0 ? `${header} {}` : `${header} { ${values.join(", ")} }`;
      }
    }
    return item;
  }

  /** A block's members in conventional order: items, then values, then model-level items. */
  private blockItems(members: Member[]): Item[] {
    const items: Item[] = [];
    const values: Item[] = [];
    const modelLevel: Item[] = [];
    for (const m of members) {
      if (m.kind === "rows" && m.mode === "fixed") {
        for (const row of m.rows) values.push({ ...this.span(row), inner: null, ...rowParts(row), group: 1 });
      } else if (m.kind === "rows") {
        const rows = m.rows.map((row): Item => ({ ...this.span(row), inner: null, ...rowParts(row), group: 0 }));
        modelLevel.push({ ...this.span(m), inner: rows, header: "seed", group: 2 });
      } else if (m.kind === "modelAttribute") {
        modelLevel.push({ ...this.span(m), inner: null, lines: attributeLines(m), group: 2 });
      } else if (m.kind === "field") {
        const rest = [...m.modifiers.map((x) => x.name), m.type + arity(m.arity), ...m.attrs.map(attribute)].join(" ");
        items.push({ ...this.span(m), inner: null, name: m.name, rest, group: 0 });
      } else if (m.kind === "mention") {
        items.push({ ...this.span(m), inner: null, name: name(m.name), rest: m.attrs.map(attribute).join(" "), group: 0 });
      } else {
        items.push({ ...this.span(m), inner: null, rest: member(m), group: 0 });
      }
    }
    return [...items, ...values, ...modelLevel];
  }

  /**
   * Places comments between `open` and `close` (exclusive) on items: before
   * one (leading), after one on its line (trailing), inside a block (passed
   * down), or after the last (dangling).
   */
  place(items: Item[], comments: Comment[], open: number, close: number): { entries: Entry[] } {
    const located = items.filter((i) => i.start !== null).sort((a, b) => a.start! - b.start!);
    const leading = new Map<Item, Comment[]>();
    const trailing = new Map<Item, Comment>();
    const inside = new Map<Item, Comment[]>();
    const verbatim = new Set<Item>();
    const dangling: Comment[] = [];
    for (const c of comments) {
      if (c.line <= open || c.line >= close) continue;
      const host = [...located].reverse().find((i) => i.start! <= c.line && c.line <= i.end!);
      if (host) {
        if (host.start === host.end || (host.inner && c.line === host.end && !c.own)) trailing.set(host, c);
        else if (host.inner) inside.set(host, [...(inside.get(host) ?? []), c]);
        else verbatim.add(host);
        continue;
      }
      const next = located.find((i) => i.start! > c.line);
      if (next) leading.set(next, [...(leading.get(next) ?? []), c]);
      else dangling.push(c);
    }

    // Blank lines, from the source, before each comment and item.
    const blankBetween = (after: number, before: number) => {
      for (let l = after + 1; l < before; l++) if ((this.lines[l - 1] ?? "").trim() === "") return true;
      return false;
    };
    const entries: Entry[] = [];
    let previousGroup = 0;
    let last = open;
    const sourceBlank = new Map<Item, { blank: boolean; leading: { text: string; blank: boolean }[]; bodyBlank: boolean }>();
    for (const item of located) {
      const lead = (leading.get(item) ?? []).map((c) => {
        const blank = blankBetween(last, c.line);
        last = c.line;
        return { text: c.text, blank };
      });
      const bodyBlank = blankBetween(last, item.start!);
      sourceBlank.set(item, { blank: lead[0]?.blank ?? bodyBlank, leading: lead, bodyBlank: lead.length > 0 && bodyBlank });
      last = item.end!;
    }
    items.forEach((item, index) => {
      const known = sourceBlank.get(item) ?? { blank: false, leading: [], bodyBlank: false };
      const startsGroup = index > 0 && item.group !== previousGroup;
      previousGroup = item.group;
      const entry: Entry = { blank: index > 0 && (known.blank || startsGroup), leading: known.leading, bodyBlank: known.bodyBlank };
      const comment = trailing.get(item)?.text;
      if (verbatim.has(item)) entry.lines = this.verbatim(item);
      else if (item.inner) entry.lines = this.block(item, inside.get(item) ?? [], comment);
      else if (item.lines && item.lines.length > 1) entry.lines = item.lines.map((l, i) => (i === item.lines!.length - 1 && comment ? `${l}  ${comment}` : l));
      else {
        entry.name = item.name;
        entry.rest = item.lines?.[0] ?? item.rest ?? "";
        entry.comment = comment;
      }
      entries.push(entry);
    });
    if (dangling.length > 0) {
      const lead = dangling.map((c) => {
        const blank = blankBetween(last, c.line);
        last = c.line;
        return { text: c.text, blank };
      });
      entries.push({ blank: entries.length > 0 && lead[0]!.blank, leading: lead, bodyBlank: false, lines: [] });
    }
    return { entries };
  }

  private block(item: Item, comments: Comment[], trailing: string | undefined): string[] {
    const header = comments.find((c) => c.line === item.start && !c.own);
    const innerComments = comments.filter((c) => c !== header);
    const close = trailing ? `}  ${trailing}` : "}";
    if (item.oneLine && innerComments.length === 0 && !header && item.oneLine.length <= WIDTH) {
      return [trailing ? `${item.oneLine}  ${trailing}` : item.oneLine];
    }
    const { entries } = this.place(item.inner!, innerComments, item.start ?? 0, item.end ?? Infinity);
    const open = `${item.header} {${header ? `  ${header.text}` : ""}`;
    if (entries.length === 0) return [header ? open : `${item.header} {}${trailing ? `  ${trailing}` : ""}`, ...(header ? [close] : [])];
    return [open, ...this.render(entries, "  ", false), close];
  }

  /** An item with a comment inside, as written, re-indented. */
  private verbatim(item: Item): string[] {
    const first = this.lines[item.start! - 1]!;
    const base = first.length - first.trimStart().length;
    const out = [first.slice(item.column - 1).trimEnd()];
    for (let l = item.start! + 1; l <= item.end!; l++) {
      const line = this.lines[l - 1]!.trimEnd();
      const indent = line.length - line.trimStart().length;
      out.push(line.slice(Math.min(indent, base)));
    }
    return out;
  }

  /** Lays out entries at an indent, aligning names and comments within each group. */
  render(entries: Entry[], indent: string, topLevel: boolean): string[] {
    const out: string[] = [];
    const groups: Entry[][] = [];
    entries.forEach((entry, index) => {
      const previous = entries[index - 1];
      const separate = topLevel && previous !== undefined && (isBlock(previous) || isBlock(entry));
      if (separate) entry.blank = true;
      if (groups.length === 0 || entry.blank || entry.bodyBlank) groups.push([]);
      groups[groups.length - 1]!.push(entry);
    });
    for (const group of groups) {
      const named = group.filter((e) => e.lines === undefined && e.name !== undefined);
      const nameWidth = Math.max(0, ...named.map((e) => e.name!.length));
      const code = (e: Entry) => (e.name !== undefined ? `${e.name.padEnd(nameWidth)} ${e.rest}`.trimEnd() : e.rest!);
      const commented = group.filter((e) => e.lines === undefined && e.comment !== undefined);
      const commentAt = Math.max(0, ...commented.map((e) => code(e).length)) + 2;
      for (const entry of group) {
        if (entry.blank && out.length > 0) out.push("");
        entry.leading.forEach((c, i) => {
          if (i > 0 && c.blank) out.push("");
          out.push(indent + c.text);
        });
        if (entry.bodyBlank) out.push("");
        if (entry.lines !== undefined) {
          for (const line of entry.lines) out.push(line === "" ? "" : indent + line);
        } else {
          const text = code(entry);
          out.push(indent + (entry.comment !== undefined ? `${text.padEnd(commentAt)}${entry.comment}` : text));
        }
      }
    }
    return out;
  }
}

function isBlock(entry: Entry): boolean {
  return entry.lines !== undefined && entry.lines.length > 1;
}

function rowParts(row: Row): { name: string; rest: string } {
  return { name: name(row.name), rest: [...(row.values.length > 0 ? [object(row.values)] : []), ...row.attrs.map(attribute)].join(" ") };
}

function member(m: Member): string {
  switch (m.kind) {
    case "end":
      return end(m);
    case "field":
      return [m.name, ...m.modifiers.map((x) => x.name), m.type + arity(m.arity), ...m.attrs.map(attribute)].join(" ");
    case "mention":
      return [name(m.name), ...m.attrs.map(attribute)].join(" ");
    case "modelAttribute":
      return attribute(m);
    case "rows":
      return `seed { ${m.rows.map((r) => [rowParts(r).name, rowParts(r).rest].filter(Boolean).join(" ")).join(", ")} }`;
  }
}

function end(e: EndDecl): string {
  const as = e.as ? ` as ${e.as.name}` : "";
  return [`${e.ordered ? "ordered " : ""}${e.model}.${e.field}${arity(e.arity)}${as}`, ...e.attrs.map(attribute)].join(" ");
}

function arity(a: "one" | "optional" | "many"): string {
  return a === "many" ? "[]" : a === "optional" ? "?" : "";
}

function attribute(a: Pick<Attribute, "sigil" | "name" | "args">): string {
  return `${a.sigil}${a.name}${a.args.length > 0 ? `(${a.args.map(expr).join(", ")})` : ""}`;
}

/** A model-level attribute; a list of more than one object, or a long one, gets a line per item. */
function attributeLines(a: Pick<Attribute, "sigil" | "name" | "args">): string[] {
  const inline = attribute(a);
  const list = a.args.length === 1 && a.args[0]!.kind === "list" ? a.args[0]! : null;
  if (!list || list.kind !== "list" || list.items.length === 0) return [inline];
  const objects = list.items.filter((i) => i.kind === "object").length;
  if (objects < 2 && inline.length + 2 <= WIDTH) return [inline];
  return [`${a.sigil}${a.name}([`, ...list.items.map((i) => `  ${expr(i)},`), "])"];
}

function expr(e: Expr): string {
  switch (e.kind) {
    case "string":
      return quote(e.value);
    case "number":
      return String(e.value);
    case "ident":
      return [e.name, ...e.attrs.map(attribute)].join(" ");
    case "list":
      return `[${e.items.map(expr).join(", ")}]`;
    case "object":
      return object(e.entries);
  }
}

function object(entries: ObjectEntry[]): string {
  if (entries.length === 0) return "{}";
  return `{ ${entries.map((e) => `${name(e.key)}: ${expr(e.value)}`).join(", ")} }`;
}

/** A name as written: bare when it is an identifier, else quoted. */
function name(text: string): string {
  return IDENT.test(text) ? text : quote(text);
}

function quote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}
