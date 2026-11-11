// The conventional form of a VAD file (`vad fmt`): two-space indentation, one fact or
// field per line, field names and connections lined up, and an element's language
// attributes after its own, in the order for, where, if, group, orderBy, limit, key,
// fallback. Lines are kept within WIDTH where a break is allowed. Comments are kept;
// formatting refuses a source with syntax errors rather than lose any text.

import type {
  Attribute, Binding, Child, ConnectionDecl, DataEntry, DataRecord, Declaration, DeclarationEntry, Element, EndMember, Expr, Line, OrderTerm, Param,
  RuleLine, SchemaAttribute, TableMember, TextPart, TypeRef, ViewLine,
} from "./ast.ts";
import { parseView } from "./parse.ts";

const WIDTH = 100;
const LANGUAGE_ATTRIBUTES = ["for", "where", "if", "group", "orderBy", "limit", "key", "fallback"];

export class FormatError extends Error {}

// ---------------------------------------------------------------- expressions

const PRECEDENCE: Record<string, number> = {
  "??": 2, or: 3, and: 4,
  "==": 5, "!=": 5, "<": 5, "<=": 5, ">": 5, ">=": 5, in: 5, "∈": 5, excludes: 5, "∉": 5,
  "+": 6, "-": 6, "*": 7, "/": 7,
};

function precedence(expr: Expr): number {
  switch (expr.kind) {
    case "choice": return 1;
    case "binary": return PRECEDENCE[expr.operator]!;
    case "unary": return 8;
    case "comprehension": return 0;
    default: return 10;
  }
}

export function quote(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

function templateText(parts: TextPart[], escapeChars: RegExp): string {
  return parts
    .map((part) => (typeof part === "string" ? part.replace(/\\/g, "\\\\").replace(escapeChars, (ch) => `\\${ch}`).replace(/\n/g, "\\n") : `{${expr(part)}}`))
    .join("");
}

function wrap(e: Expr, min: number): string {
  const text = expr(e);
  return precedence(e) < min ? `(${text})` : text;
}

export function expr(e: Expr): string {
  switch (e.kind) {
    case "name": return e.name;
    case "literal": return typeof e.value === "string" ? quote(e.value) : String(e.value);
    case "duration": return e.text;
    case "template": return `"${templateText(e.parts, /["{}]/g)}"`;
    case "list": return `[${e.items.map(expr).join(", ")}]`;
    case "record": return e.entries.length ? `{ ${e.entries.map((x) => `${x.name}: ${expr(x.value)}`).join(", ")} }` : "{}";
    case "field": return `${wrap(e.object, 9)}.${e.name}`;
    case "call": return `${e.callee}(${e.args.map((a) => (a.name ? `${a.name}: ` : "") + expr(a.value)).join(", ")})`;
    case "unary": return e.operator === "not" ? `not ${wrap(e.operand, 8)}` : `-${wrap(e.operand, 8)}`;
    case "binary": {
      const p = PRECEDENCE[e.operator]!;
      return `${wrap(e.left, p)} ${e.operator} ${wrap(e.right, p + 1)}`;
    }
    case "choice": return `${wrap(e.test, 2)} ? ${expr(e.then)} : ${expr(e.otherwise)}`;
    // Multi-line only inside an attribute, where openTag indents its lines.
    case "element": return elementLines(e.element, "      ").join("\n");
    case "comprehension": {
      const where = e.where.length ? ` where ${e.where.map(expr).join(", ")}` : "";
      return `${e.binding.name} in ${expr(e.binding.source)}${where}`;
    }
  }
}

function orderBy(terms: OrderTerm[]): string {
  return terms.map((t) => expr(t.value) + (t.desc ? " desc" : "")).join(", ");
}

function params(ps: Param[]): string {
  return `(${ps.map((p) => (p.type ? `${p.name} ${p.type.name}${arityText(p.type.arity)}` : p.name)).join(", ")})`;
}

// ---------------------------------------------------------------- elements

function attribute(a: Attribute): string {
  switch (a.value.kind) {
    case "bare": return a.name;
    case "text": return `${a.name}=${expr(a.value.text)}`;
    case "expr": return `${a.name}={${expr(a.value.expr)}}`;
    case "for": return `for={${a.value.bindings.map((b) => `${b.name} in ${expr(b.source)}`).join(", ")}}`;
    case "where":
    case "if": return `${a.value.kind}={${a.value.conditions.map(expr).join(", ")}}`;
    case "orderBy": return `orderBy={${orderBy(a.value.terms)}}`;
  }
}

function textChild(parts: TextPart[]): string {
  return templateText(parts, /[{}<]/g);
}

function fits(indent: string, text: string): boolean {
  return !text.includes("\n") && indent.length + text.length <= WIDTH;
}

/**
 * The opening tag's lines, relative to the element's own column. It stays on one line
 * when it fits and either was written on one or has at most two language attributes;
 * otherwise the element's own attributes stay on the first line and the language
 * attributes follow in groups.
 */
function openTag(el: Element, indent: string, close: string): string[] {
  const own = el.attributes.filter((a) => !LANGUAGE_ATTRIBUTES.includes(a.name));
  const language = LANGUAGE_ATTRIBUTES.flatMap((name) => el.attributes.filter((a) => a.name === name));
  const all = [...own, ...language].map(attribute);
  const single = `<${el.type}${all.map((a) => " " + a).join("")}${close}`;
  // A tag written on one line stays on one when it fits; short tags join one line anyway.
  const oneLine = el.attributes.every((a) => a.span.endLine === el.typeSpan.line);
  if (fits(indent, single) && (oneLine || language.length < 3)) return [single];
  const lines: string[] = [];
  const first = `<${el.type}${own.map((a) => " " + attribute(a)).join("")}`;
  if (fits(indent, first)) lines.push(first);
  else {
    lines.push(`<${el.type}`);
    for (const a of own) lines.push("  " + attribute(a).replace(/\n/g, "\n  "));
  }
  const groups = [["for", "where", "if"], ["group", "orderBy", "limit"], ["key"], ["fallback"]];
  for (const group of groups) {
    const items = language.filter((a) => group.includes(a.name)).map(attribute);
    if (!items.length) continue;
    const together = "  " + items.join(" ");
    if (fits(indent, together)) lines.push(together);
    else for (const item of items) lines.push("  " + item.replace(/\n/g, "\n  "));
  }
  lines[lines.length - 1] += close;
  return lines.flatMap((line) => line.split("\n"));
}

/** An element's lines, relative to its own column; `indent` is that column, for widths. */
function elementLines(el: Element, indent: string): string[] {
  if (!el.children || el.children.length === 0) return openTag(el, indent, " />");
  const open = openTag(el, indent, ">");
  const closing = `</${el.type}>`;
  if (open.length === 1 && el.children.every((c) => c.kind === "text") && !el.children.some((c) => c.blankBefore)) {
    const single = open[0] + el.children.map((c) => textChild((c as Extract<Child, { kind: "text" }>).parts)).join(" ") + closing;
    if (fits(indent, single)) return [single];
  }
  const lines = [...open];
  el.children.forEach((child) => {
    if (child.blankBefore) lines.push("");
    if (child.kind === "comment") lines.push("  " + comment(child.text));
    else if (child.kind === "text") lines.push("  " + textChild(child.parts));
    else {
      for (const c of child.element.comments) lines.push("  " + comment(c));
      lines.push(...elementLines(child.element, indent + "  ").map((line) => (line ? "  " + line : line)));
    }
  });
  lines.push(closing);
  return lines;
}

/** An element's lines at `indent`. */
function indentElement(el: Element, indent: string): string[] {
  return elementLines(el, indent).map((line) => (line ? indent + line : line));
}

function comment(text: string): string {
  return `//${text}`;
}

// ---------------------------------------------------------------- mutations

/** Appends a line's comments: the first after its last line, the rest below it. */
function withComments(lines: string[], comments: string[], indent: string): string[] {
  if (comments.length) lines[lines.length - 1] += "  " + comment(comments[0]!);
  for (const c of comments.slice(1)) lines.push(indent + comment(c));
  return lines;
}

/** A call on lines of its own: its arguments fill lines, continuing under the first one. */
function callLines(head: string, call: Extract<Expr, { kind: "call" }>, indent: string): string[] {
  const single = `${indent}${head}${expr(call)}`;
  if (fits("", single) || call.args.length < 2) return [single];
  const args = call.args.map((a, i) => `${a.name ? `${a.name}: ` : ""}${expr(a.value)}${i < call.args.length - 1 ? "," : ")"}`);
  const lines: string[] = [];
  let line = `${indent}${head}${call.callee}(`;
  const hang = " ".repeat(line.length);
  let empty = true;
  for (const arg of args) {
    if (!empty && line.length + 1 + arg.length > WIDTH) {
      lines.push(line);
      line = hang + arg;
    } else line += (empty ? "" : " ") + arg;
    empty = false;
  }
  lines.push(line);
  return lines;
}

function bindingsText(bindings: Binding[]): string {
  return bindings.map((b) => `${b.name} in ${expr(b.source)}`).join(", ");
}

function mutationLine(line: Line, indent: string): string[] {
  switch (line.kind) {
    case "comment":
      return [indent + comment(line.text)];
    case "error":
      return withComments([`${indent}${line.code}${line.message !== undefined ? " " + quote(line.message) : ""}`], line.comments, indent);
    case "set":
      return withComments([`${indent}${expr(line.target)} = ${expr(line.value)}`], line.comments, indent);
    case "fact": {
      const head = `${line.name ? `let ${line.name} = ` : ""}${line.negated ? "not " : ""}`;
      return withComments(callLines(head, line.call, indent), line.comments, indent);
    }
    case "if":
    case "for": {
      const header = line.kind === "if"
        ? `if ${expr(line.condition)}:`
        : `for ${bindingsText(line.bindings)}${line.where.length ? ` where ${line.where.map(expr).join(", ")}` : ""}:`;
      return [...withComments([indent + header], line.comments, indent + "  "), ...mutationLines(line.body, indent + "  ")];
    }
  }
}

function mutationLines(list: Line[], indent: string): string[] {
  const lines: string[] = [];
  list.forEach((line, i) => {
    if (line.blankBefore && i > 0) lines.push("");
    lines.push(...mutationLine(line, indent));
  });
  return lines;
}

// ---------------------------------------------------------------- tables

function schemaAttribute(a: SchemaAttribute): string {
  return `${a.sigil}${a.name}${a.args ? `(${a.args.map(expr).join(", ")})` : ""}`;
}

function attrsText(attrs: SchemaAttribute[]): string {
  return attrs.map((a) => " " + schemaAttribute(a)).join("");
}

const arityText = (arity: TypeRef["arity"]): string => (arity === "optional" ? "?" : arity === "many" ? "[]" : "");

function endText(m: EndMember): string {
  return `${m.ordered ? "ordered " : ""}${m.table}.${m.field}${arityText(m.arity)}${m.as ? ` as ${m.as}` : ""}${attrsText(m.attrs)}`;
}

function valueName(m: Extract<TableMember, { kind: "value" }>): string {
  return m.quoted ? quote(m.name) : m.name;
}

/**
 * A table's, enum's or `re` block's members. Field names line up across a run of fields,
 * and value names across a run of values that carry records, so types and records start
 * in one column.
 */
function memberLines(members: TableMember[], indent: string): string[] {
  const width = new Map<TableMember, number>();
  let run: TableMember[] = [];
  const close = () => {
    const names = run.map((m) => (m.kind === "field" ? m.name.length : m.kind === "value" ? valueName(m).length : 0));
    const records = run.some((m) => m.kind === "value" && m.values);
    for (const m of run) if (m.kind === "field" || records) width.set(m, Math.max(...names));
    run = [];
  };
  for (const m of members) {
    const kind = m.kind === "field" || m.kind === "value" ? m.kind : null;
    if (m.kind === "comment" && !m.blankBefore) continue;
    if (!kind || m.blankBefore || (run.length && run[0]!.kind !== kind)) close();
    if (kind) run.push(m);
  }
  close();
  const lines: string[] = [];
  members.forEach((m, i) => {
    if (m.blankBefore && i > 0) lines.push("");
    switch (m.kind) {
      case "comment":
        lines.push(indent + comment(m.text));
        return;
      case "seed":
        lines.push(...withComments([`${indent}seed:`], m.comments, indent + "  "), ...memberLines(m.rows, indent + "  "));
        return;
      case "field": {
        const name = m.name.padEnd(width.get(m) ?? m.name.length);
        const modifiers = m.modifiers.map((x) => x + " ").join("");
        const value = m.default ? ` = ${expr(m.default)}` : "";
        lines.push(...withComments([`${indent}${name} ${modifiers}${m.type}${arityText(m.arity)}${value}${attrsText(m.attrs)}`], m.comments, indent));
        return;
      }
      case "end":
        lines.push(...withComments([indent + endText(m)], m.comments, indent));
        return;
      case "attribute":
        lines.push(...withComments([indent + schemaAttribute(m.attr)], m.comments, indent));
        return;
      case "value": {
        const name = valueName(m);
        const record = m.values ? " " + expr(m.values) : "";
        const text = (record ? name.padEnd(width.get(m) ?? name.length) : name) + record + attrsText(m.attrs);
        lines.push(...withComments([indent + text], m.comments, indent));
        return;
      }
      case "mention":
        lines.push(...withComments([`${indent}${m.name}${attrsText(m.attrs)}`], m.comments, indent));
        return;
    }
  });
  return lines;
}

// ---------------------------------------------------------------- data views

/**
 * A data view's record: on one line, `{ a, b: x }`, when it was written on one and fits;
 * otherwise one entry per line. The first line continues `head`; the rest are at `indent`.
 */
function dataRecordLines(record: DataRecord, head: string, indent: string): string[] {
  const oneLine = record.entries.every((e) => !e.newline && e.kind !== "comment" && !e.comments.length);
  if (oneLine) {
    const parts = record.entries.map((e) => dataEntryLines(e, "", "").join("\n"));
    const text = parts.length ? `{ ${parts.join(", ")} }` : "{}";
    if (!text.includes("\n") && fits("", indent + head + text)) return [head + text];
  }
  const lines = [head + "{"];
  record.entries.forEach((entry, i) => {
    if (entry.blankBefore && i > 0) lines.push("");
    lines.push(...withComments(dataEntryLines(entry, indent + "  ", indent + "  "), entry.comments, indent + "  "));
  });
  lines.push(indent + "}");
  return lines;
}

/** `lines` with `suffix` after the last one, the record's closing brace. */
function suffixed(lines: string[], suffix: string): string[] {
  lines[lines.length - 1] += suffix;
  return lines;
}

/** An entry's lines: the first starts with `first`, the rest are at `indent` or deeper. */
function dataEntryLines(entry: DataEntry, first: string, indent: string): string[] {
  switch (entry.kind) {
    case "comment": return [first + comment(entry.text)];
    case "value": return [`${first}${entry.key}: ${expr(entry.value)}`];
    case "field": return entry.record ? dataRecordLines(entry.record, `${first}${entry.name} `, indent) : [first + entry.name];
    case "record": {
      const attributes = LANGUAGE_ATTRIBUTES.flatMap((name) => entry.attributes.filter((a) => a.name === name))
        .concat(entry.attributes.filter((a) => !LANGUAGE_ATTRIBUTES.includes(a.name)));
      return suffixed(dataRecordLines(entry.record, `${first}${entry.key}: `, indent), attributes.map((a) => " " + attribute(a)).join(""));
    }
  }
}

// ---------------------------------------------------------------- declarations

function viewLine(line: ViewLine): string {
  switch (line.kind) {
    case "state":
    case "keep": return `${line.kind} ${line.name} = ${expr(line.value)}`;
    case "on": return `on ${line.event}${line.detail !== undefined ? " " + quote(line.detail) : ""} → ${expr(line.action)}`;
    case "every": return `every ${line.text} → ${expr(line.action)}`;
  }
}

function ruleLines(body: RuleLine[]): string[] {
  const lines: string[] = [];
  body.forEach((line, i) => {
    if (line.blankBefore && i > 0) lines.push("");
    if (line.kind === "comment") lines.push("  " + comment(line.text));
    else lines.push(...withComments(["  " + expr(line.condition)], line.comments, "  "));
  });
  return lines;
}

const TABLE_WORDS = { data: "table", main: "main table", my: "my table", session: "session table" } as const;

/** `connectionWidth` lines up `<->` across a run of connections. */
function declarationLines(entry: DeclarationEntry, connectionWidth: number): string[] {
  const decl: Declaration = entry.decl;
  const trailing = entry.trailing !== undefined ? "  " + comment(entry.trailing) : "";
  switch (decl.kind) {
    case "comment":
      return [comment(decl.text)];
    case "use":
      return [`use ${quote(decl.path)}${decl.picks ? ` (${decl.picks.map((p) => p.name + (p.as ? ` as ${p.as}` : "")).join(", ")})` : ""}${trailing}`];
    case "rule":
      return [`rule ${decl.name}${params(decl.params)}:${trailing}`, ...ruleLines(decl.body)];
    case "element":
      return [...decl.element.comments.map(comment), ...indentElement(decl.element, "")];
    case "view": {
      if (decl.data) return dataRecordLines(decl.data, `view${decl.name ? " " + decl.name : ""}${params(decl.params)} `, "");
      const lines = [`view${decl.name ? " " + decl.name : ""}${params(decl.params)}:${trailing}`];
      for (const line of decl.lines) {
        for (const c of line.leading ?? []) lines.push("  " + comment(c));
        lines.push(...withComments(["  " + viewLine(line)], line.comments, "  "));
      }
      if (decl.body) {
        if (decl.lines.length) lines.push("");
        for (const c of decl.body.comments) lines.push("  " + comment(c));
        lines.push(...indentElement(decl.body, "  "));
      }
      return lines;
    }
    case "mutation": {
      const action = decl.rowAction ? ` for ${decl.rowAction.model}.${decl.rowAction.op}` : "";
      return [`mutation ${decl.name}${params(decl.params)}${action}:${trailing}`, ...mutationLines(decl.body, "  ")];
    }
    case "table": {
      const key = decl.key ? ` (${decl.key.map((k) => k.name).join(", ")})` : "";
      return [`${TABLE_WORDS[decl.tableKind]} ${decl.name}${key}:${trailing}`, ...memberLines(decl.members, "  ")];
    }
    case "enum":
    case "re":
      return [`${decl.kind} ${decl.name}:${trailing}`, ...memberLines(decl.members, "  ")];
    case "connection":
      return [`${endText(decl.a).padEnd(connectionWidth)} <-> ${endText(decl.b)}${trailing}`];
  }
}

function sorted(list: string[]): string {
  return JSON.stringify([...list].sort());
}

/** The source in the conventional form. Throws a FormatError when it has syntax errors. */
export function formatView(source: string): string {
  const parsed = parseView(source);
  if (parsed.diagnostics.length) {
    const d = parsed.diagnostics[0]!;
    throw new FormatError(`${d.line}:${d.column}: ${d.message}`);
  }
  // `<->` lines up across a run of connections with no blank line between them.
  const widths = new Map<DeclarationEntry, number>();
  let run: DeclarationEntry[] = [];
  const close = () => {
    const width = Math.max(0, ...run.map((e) => endText((e.decl as ConnectionDecl).a).length));
    for (const e of run) widths.set(e, width);
    run = [];
  };
  for (const entry of parsed.file.declarations) {
    if (entry.decl.kind !== "connection" || entry.blankBefore) close();
    if (entry.decl.kind === "connection") run.push(entry);
  }
  close();
  const lines: string[] = [];
  parsed.file.declarations.forEach((entry, i) => {
    if (entry.blankBefore && i > 0) lines.push("");
    lines.push(...declarationLines(entry, widths.get(entry) ?? 0));
  });
  const result = lines.map((line) => line.replace(/[ \t]+$/, "")).join("\n") + "\n";
  const again = parseView(result);
  if (again.diagnostics.length || sorted(again.comments) !== sorted(parsed.comments)) {
    throw new FormatError("Formatting would change this source's meaning or drop a comment; it was left as it is");
  }
  return result;
}
