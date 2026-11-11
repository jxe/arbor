// The conventional form of a view source (`uvl fmt`): two-space indentation, one
// statement per line, `else` aligned across consecutive guards, and an element's
// language attributes after its own, in the order for, where, orderBy, limit, key,
// fallback. Lines are kept within WIDTH where a break is allowed. Comments are kept;
// formatting refuses a source with syntax errors rather than lose any text.

import type {
  Attribute, Child, Declaration, DeclarationEntry, Element, Expr, OrderTerm, Param, Statement, TextPart, ViewLine,
} from "./ast.ts";
import { parseView } from "./parse.ts";

const WIDTH = 100;
const LANGUAGE_ATTRIBUTES = ["for", "where", "orderBy", "limit", "key", "fallback"];

export class FormatError extends Error {}

// ---------------------------------------------------------------- expressions

const PRECEDENCE: Record<string, number> = {
  "??": 2, or: 3, and: 4,
  "==": 5, "!=": 5, "<": 5, "<=": 5, ">": 5, ">=": 5, in: 5, "not in": 5,
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
  return `(${ps.map((p) => (p.type ? `${p.name}: ${p.type.name}${p.type.arity === "optional" ? "?" : p.type.arity === "many" ? "[]" : ""}` : p.name)).join(", ")})`;
}

// ---------------------------------------------------------------- elements

function attribute(a: Attribute): string {
  switch (a.value.kind) {
    case "bare": return a.name;
    case "text": return `${a.name}=${expr(a.value.text)}`;
    case "expr": return `${a.name}={${expr(a.value.expr)}}`;
    case "for": return `for={${a.value.bindings.map((b) => `${b.name} in ${expr(b.source)}`).join(", ")}}`;
    case "where": return `where={${a.value.conditions.map(expr).join(", ")}}`;
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
 * when it fits and has at most two language attributes; otherwise the element's own
 * attributes stay on the first line and the language attributes follow in groups.
 */
function openTag(el: Element, indent: string, close: string): string[] {
  const own = el.attributes.filter((a) => !LANGUAGE_ATTRIBUTES.includes(a.name));
  const language = LANGUAGE_ATTRIBUTES.flatMap((name) => el.attributes.filter((a) => a.name === name));
  const all = [...own, ...language].map(attribute);
  const single = `<${el.type}${all.map((a) => " " + a).join("")}${close}`;
  if (fits(indent, single) && language.length < 3) return [single];
  const lines: string[] = [];
  const first = `<${el.type}${own.map((a) => " " + attribute(a)).join("")}`;
  if (fits(indent, first)) lines.push(first);
  else {
    lines.push(`<${el.type}`);
    for (const a of own) lines.push("  " + attribute(a).replace(/\n/g, "\n  "));
  }
  const groups = [["for", "where"], ["orderBy", "limit"], ["key"], ["fallback"]];
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

// ---------------------------------------------------------------- statements

function suffix(s: Statement): string {
  let text = "";
  if (s.for) text += ` for ${s.for.map((b) => `${b.name} in ${expr(b.source)}`).join(", ")}`;
  if (s.where) text += ` where ${s.where.map(expr).join(", ")}`;
  if (s.orderBy) text += ` orderBy ${orderBy(s.orderBy)}`;
  return text;
}

/** A statement ending in a record: entries fill lines, continuing under the first entry. */
function recordLines(head: string, record: Extract<Expr, { kind: "record" }>, tail: string, indent: string): string[] {
  const single = `${head}${expr(record)}${tail}`;
  if (fits(indent, single) || !record.entries.length) return [indent + single];
  const entries = record.entries.map((x, i) => `${x.name}: ${expr(x.value)}${i < record.entries.length - 1 ? "," : " }" + tail}`);
  const lines: string[] = [];
  let line = `${indent}${head}{ `;
  const hang = " ".repeat(line.length);
  let empty = true;
  for (const entry of entries) {
    if (!empty && line.length + 1 + entry.length > WIDTH) {
      lines.push(line);
      line = hang + entry;
    } else line += (empty ? "" : " ") + entry;
    empty = false;
  }
  lines.push(line);
  return lines;
}

function statementLines(s: Statement, indent: string, requireWidth: number): string[] {
  let lines: string[];
  switch (s.kind) {
    case "comment":
      return [indent + comment(s.text)];
    case "require": {
      const condition = expr(s.condition).padEnd(requireWidth);
      lines = [`${indent}require ${condition} else ${s.code}${s.message !== undefined ? " " + quote(s.message) : ""}`];
      break;
    }
    case "insert":
      lines = recordLines(`${s.name ? `let ${s.name} = ` : ""}insert ${s.model} `, s.fields, suffix(s), indent);
      break;
    case "update":
      lines = s.for
        ? recordLines(`update ${expr(s.target)}${suffix(s)} `, s.fields, "", indent)
        : recordLines(`update ${expr(s.target)} `, s.fields, suffix(s), indent);
      break;
    case "delete":
      lines = [`${indent}delete ${expr(s.target)}${suffix(s)}`];
      break;
    case "upsert":
      lines = [
        `${indent}upsert ${s.model} ${expr(s.key)}`,
        `${indent}  create ${expr(s.create)}`,
        `${indent}  update ${expr(s.update)}${suffix(s)}`,
      ];
      break;
    case "append":
    case "remove":
      lines = [`${indent}${s.kind} ${expr(s.item)} ${s.kind === "append" ? "to" : "from"} ${expr(s.path)}${suffix(s)}`];
      break;
    case "reorder":
      lines = [`${indent}reorder ${expr(s.path)} to ${expr(s.to)}${suffix(s)}`];
      break;
    case "do":
      lines = [`${indent}do ${s.calls.map(expr).join(", ")}`];
      break;
    case "return":
      lines = recordLines("return ", s.value, "", indent);
      break;
    case "when":
      lines = [`${indent}when ${expr(s.condition)}`];
      if (s.comments.length) lines[0] += "  " + comment(s.comments[0]!);
      for (const c of s.comments.slice(1)) lines.push(indent + "  " + comment(c));
      return [...lines, ...statementList(s.body, indent + "  ")];
  }
  if (s.comments.length) lines[lines.length - 1] += "  " + comment(s.comments[0]!);
  for (const c of s.comments.slice(1)) lines.push(indent + comment(c));
  return lines;
}

function statementList(list: Statement[], indent: string): string[] {
  const lines: string[] = [];
  // `else` lines up across a run of guards.
  const widths = new Map<Statement, number>();
  let run: Statement[] = [];
  const close = () => {
    const lengths = run.map((s) => expr((s as Extract<Statement, { kind: "require" }>).condition).length);
    const width = Math.max(0, ...lengths);
    const aligned = run.length > 1 && width - Math.min(...lengths) <= 20;
    for (const s of run) widths.set(s, aligned ? width : 0);
    run = [];
  };
  for (const s of list) {
    if (s.kind === "require" && !s.blankBefore) run.push(s);
    else {
      close();
      if (s.kind === "require") run.push(s);
    }
  }
  close();
  list.forEach((s, i) => {
    if (s.blankBefore && i > 0) lines.push("");
    lines.push(...statementLines(s, indent, widths.get(s) ?? 0));
  });
  return lines;
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

function declarationLines(entry: DeclarationEntry): string[] {
  const decl: Declaration = entry.decl;
  const trailing = entry.trailing !== undefined ? "  " + comment(entry.trailing) : "";
  switch (decl.kind) {
    case "comment":
      return [comment(decl.text)];
    case "use":
      return [`use ${quote(decl.path)}${decl.picks ? ` (${decl.picks.map((p) => p.name + (p.as ? ` as ${p.as}` : "")).join(", ")})` : ""}${trailing}`];
    case "rule":
      return [`${decl.name}${params(decl.params)}: ${expr(decl.body)}${trailing}`];
    case "element":
      return [...decl.element.comments.map(comment), ...indentElement(decl.element, "")];
    case "view": {
      const lines = [`view${decl.name ? " " + decl.name : ""}${params(decl.params)}:${trailing}`];
      for (const line of decl.lines) {
        for (const c of line.comments) lines.push("  " + comment(c));
        lines.push("  " + viewLine(line));
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
      return [`mutation ${decl.name}${params(decl.params)}${action}:${trailing}`, ...statementList(decl.body, "  ")];
    }
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
  const lines: string[] = [];
  parsed.file.declarations.forEach((entry, i) => {
    if (entry.blankBefore && i > 0) lines.push("");
    lines.push(...declarationLines(entry));
  });
  const result = lines.map((line) => line.replace(/[ \t]+$/, "")).join("\n") + "\n";
  const again = parseView(result);
  if (again.diagnostics.length || sorted(again.comments) !== sorted(parsed.comments)) {
    throw new FormatError("Formatting would change this source's meaning or drop a comment; it was left as it is");
  }
  return result;
}
