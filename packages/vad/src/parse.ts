// Parser for VAD files (spec 1.5). Declarations start in the first column; a declaration
// runs until the next line that does, so a broken one doesn't hide the rest. A header's
// `:` ends its line, and its body is the lines below it, indented further; a line indented
// further than its body continues the line above it. Elements and expressions are
// free-form within their declaration.

import {
  ERROR_CODES,
  type Arg, type Attribute, type AttributeValue, type Binding, type BinaryOperator, type Child, type ConnectionDecl,
  type DataEntry, type DataRecord, type Declaration, type DeclarationEntry, type Diagnostic, type Element, type EndMember, type EnumDecl, type ErrorCode,
  type Expr, type Line as MutationLine, type MutationDecl, type OrderTerm, type Param, type ReDecl, type RuleDecl,
  type RuleLine, type SchemaAttribute, type Span, type TableDecl, type TableMember, type TextPart, type TypeRef,
  type UseDecl, type ViewDecl, type ViewFile, type ViewLine,
} from "./ast.ts";

export class ViewSyntaxError extends Error {
  constructor(readonly code: string, message: string, readonly offset: number, readonly endOffset = offset + 1) {
    super(message);
  }
}

export interface ParseResult {
  file: ViewFile;
  diagnostics: Diagnostic[];
  /** Every comment in the source, in order: the text after `//`. The formatter keeps them all. */
  comments: string[];
}

/** Built-in functions that take `name in source where …`. */
export const COMPREHENSION_FUNCTIONS = ["count", "exists", "sum", "min", "max"] as const;

interface Line {
  start: number;
  end: number;
  indent: number;
  blank: boolean;
  comment: boolean;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

class Source {
  readonly lines: Line[] = [];
  readonly lineStarts: number[] = [];
  readonly comments: { text: string; offset: number }[] = [];

  constructor(readonly text: string) {
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      let end = newline < 0 ? text.length : newline;
      if (end > start && text[end - 1] === "\r") end -= 1;
      const body = text.slice(start, end);
      const indent = body.length - body.replace(/^[ \t]+/, "").length;
      const rest = body.slice(indent);
      this.lineStarts.push(start);
      this.lines.push({ start, end, indent, blank: rest.length === 0, comment: rest.startsWith("//") });
      if (newline < 0) break;
      start = newline + 1;
    }
  }

  position(offset: number): { line: number; column: number } {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: offset - this.lineStarts[low]! + 1 };
  }

  span(start: number, end: number): Span {
    const a = this.position(start);
    const b = this.position(Math.max(start, end));
    return { line: a.line, column: a.column, endLine: b.line, endColumn: b.column };
  }

  lineOf(offset: number): number {
    return this.position(offset).line - 1;
  }
}

/** A position in one stretch of the source, which parsing never reads past. */
class Cursor {
  pos: number;

  constructor(readonly src: Source, start: number, readonly end: number) {
    this.pos = start;
  }

  get text(): string { return this.src.text; }
  atEnd(): boolean { return this.pos >= this.end; }
  peek(offset = 0): string { return this.pos + offset < this.end ? this.text[this.pos + offset]! : ""; }
  startsWith(s: string): boolean { return this.pos + s.length <= this.end && this.text.startsWith(s, this.pos); }
  span(start: number): Span { return this.src.span(start, this.pos); }
  fail(message: string, start = this.pos, end = start + 1): never {
    throw new ViewSyntaxError("syntax", message, start, end);
  }

  mark(): [number, number] { return [this.pos, this.src.comments.length]; }
  reset([pos, comments]: [number, number]): void {
    this.pos = pos;
    this.src.comments.length = comments;
  }

  /** Skips spaces, line breaks and comments. */
  ws(): void {
    while (this.pos < this.end) {
      const c = this.text[this.pos]!;
      if (c === " " || c === "\t" || c === "\r" || c === "\n") this.pos += 1;
      else if (this.startsWith("//")) this.comment();
      else break;
    }
  }

  /** Skips spaces on this line only. */
  inlineWs(): void {
    while (this.pos < this.end && (this.text[this.pos] === " " || this.text[this.pos] === "\t")) this.pos += 1;
  }

  comment(): string {
    const start = this.pos;
    let end = this.text.indexOf("\n", start);
    if (end < 0 || end > this.end) end = this.end;
    const text = this.text.slice(start + 2, end).trimEnd();
    this.src.comments.push({ text, offset: start });
    this.pos = end;
    return text;
  }

  /** True when nothing but spaces and a comment remain on this line. */
  atLineEnd(): boolean {
    const m = this.mark();
    this.inlineWs();
    const result = this.atEnd() || this.peek() === "\n" || this.peek() === "\r" || this.startsWith("//");
    this.reset(m);
    return result;
  }

  identAt(): string | null {
    if (!IDENT_START.test(this.peek())) return null;
    let end = this.pos + 1;
    while (end < this.end && IDENT_PART.test(this.text[end]!)) end += 1;
    return this.text.slice(this.pos, end);
  }

  ident(what = "a name"): string {
    const name = this.identAt();
    if (!name) this.fail(`Expected ${what}`);
    this.pos += name.length;
    return name;
  }

  /** Consumes `word` (after whitespace) when it is the next name. */
  keyword(word: string): boolean {
    const m = this.mark();
    this.ws();
    if (this.identAt() === word) {
      this.pos += word.length;
      return true;
    }
    this.reset(m);
    return false;
  }

  /** Consumes `token` (after whitespace) when it comes next. */
  accept(token: string): boolean {
    const m = this.mark();
    this.ws();
    if (this.startsWith(token)) {
      this.pos += token.length;
      return true;
    }
    this.reset(m);
    return false;
  }

  expect(token: string, what = `'${token}'`): void {
    this.ws();
    if (!this.startsWith(token)) this.fail(`Expected ${what}`);
    this.pos += token.length;
  }

  /** The next token after whitespace, without consuming it. */
  lookingAt(token: string): boolean {
    const m = this.mark();
    this.ws();
    const result = this.startsWith(token);
    this.reset(m);
    return result;
  }

  /** The next name after whitespace, without consuming it. */
  nextIdent(): string | null {
    const m = this.mark();
    this.ws();
    const result = this.identAt();
    this.reset(m);
    return result;
  }
}

// ---------------------------------------------------------------- expressions

const KEYWORDS = new Set(["in", "excludes", "not", "and", "or", "true", "false", "null", "where", "for", "orderBy", "desc", "asc"]);

/** Duration units, in milliseconds. */
const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function expression(c: Cursor): Expr {
  return choice(c);
}

function joinSpan(a: Span, b: Span): Span {
  return { line: a.line, column: a.column, endLine: b.endLine, endColumn: b.endColumn };
}

function choice(c: Cursor): Expr {
  const test = coalesce(c);
  const m = c.mark();
  c.ws();
  if (c.peek() === "?" && c.peek(1) !== "?") {
    c.pos += 1;
    const then = expression(c);
    c.expect(":");
    const otherwise = expression(c);
    return { kind: "choice", test, then, otherwise, span: joinSpan(test.span, otherwise.span) };
  }
  c.reset(m);
  return test;
}

function binaryLevel(c: Cursor, next: (c: Cursor) => Expr, operators: (c: Cursor) => BinaryOperator | null): Expr {
  let left = next(c);
  for (;;) {
    const m = c.mark();
    c.ws();
    const operator = operators(c);
    if (!operator) {
      c.reset(m);
      return left;
    }
    c.ws();
    const right = next(c);
    left = { kind: "binary", operator, left, right, span: joinSpan(left.span, right.span) };
  }
}

function word(c: Cursor, w: string): boolean {
  if (c.identAt() !== w) return false;
  c.pos += w.length;
  return true;
}

function coalesce(c: Cursor): Expr {
  return binaryLevel(c, or, (c) => (c.startsWith("??") ? ((c.pos += 2), "??") : null));
}

function or(c: Cursor): Expr {
  return binaryLevel(c, and, (c) => (word(c, "or") ? "or" : null));
}

function and(c: Cursor): Expr {
  return binaryLevel(c, comparison, (c) => (word(c, "and") ? "and" : null));
}

function comparison(c: Cursor): Expr {
  return binaryLevel(c, additive, (c) => {
    for (const op of ["==", "!=", "<=", ">="] as const) {
      if (c.startsWith(op)) {
        c.pos += 2;
        return op;
      }
    }
    if (c.peek() === "<" && c.peek(1) !== "/") return (c.pos += 1), "<";
    if (c.peek() === ">") return (c.pos += 1), ">";
    if (word(c, "in")) return "in";
    if (word(c, "excludes")) return "excludes";
    if (c.peek() === "∈") return (c.pos += 1), "∈";
    if (c.peek() === "∉") return (c.pos += 1), "∉";
    if (c.identAt() === "not") {
      const m = c.mark();
      c.pos += 3;
      c.ws();
      if (c.identAt() === "in") c.fail("Write `S excludes x` or `x ∉ S` for not-in");
      c.reset(m);
    }
    return null;
  });
}

function additive(c: Cursor): Expr {
  return binaryLevel(c, multiplicative, (c) => {
    if (c.peek() === "+") return (c.pos += 1), "+";
    if (c.peek() === "-" && c.peek(1) !== ">") return (c.pos += 1), "-";
    return null;
  });
}

function multiplicative(c: Cursor): Expr {
  return binaryLevel(c, unary, (c) => {
    if (c.peek() === "*") return (c.pos += 1), "*";
    if (c.peek() === "/" && c.peek(1) !== "/") return (c.pos += 1), "/";
    return null;
  });
}

function unary(c: Cursor): Expr {
  c.ws();
  const start = c.pos;
  if (c.identAt() === "not") {
    c.pos += 3;
    const operand = unary(c);
    return { kind: "unary", operator: "not", operand, span: joinSpan(c.src.span(start, start + 3), operand.span) };
  }
  if (c.peek() === "-" && c.peek(1) !== ">") {
    c.pos += 1;
    const operand = unary(c);
    return { kind: "unary", operator: "-", operand, span: joinSpan(c.src.span(start, start + 1), operand.span) };
  }
  return postfix(c);
}

/** A primary expression followed by fields: names, paths and calls. */
function postfix(c: Cursor): Expr {
  let expr = primary(c);
  for (;;) {
    const m = c.mark();
    c.ws();
    if (c.peek() === "." && IDENT_START.test(c.peek(1))) {
      c.pos += 1;
      const start = c.pos;
      const name = c.ident("a field name");
      const nameSpan = c.span(start);
      expr = { kind: "field", object: expr, name, nameSpan, span: joinSpan(expr.span, nameSpan) };
    } else {
      c.reset(m);
      return expr;
    }
  }
}

function primary(c: Cursor): Expr {
  c.ws();
  const start = c.pos;
  const ch = c.peek();
  if (ch === "(") {
    c.pos += 1;
    const inner = expression(c);
    c.expect(")");
    return inner;
  }
  if (ch === '"') return { kind: "literal", value: plainString(c), span: c.span(start) };
  if (/[0-9]/.test(ch)) {
    const match = /^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h|d)?(?![A-Za-z0-9_])/.exec(c.text.slice(c.pos, c.end));
    if (!match) c.fail("Expected a number, or a duration such as 16ms, 5m or 7d");
    c.pos += match[0].length;
    if (match[2]) return { kind: "duration", text: match[0], milliseconds: Number(match[1]) * DURATION_UNITS[match[2]]!, span: c.span(start) };
    return { kind: "literal", value: Number(match[0]), span: c.span(start) };
  }
  if (ch === "[") {
    c.pos += 1;
    const items: Expr[] = [];
    if (!c.accept("]")) {
      do items.push(expression(c));
      while (c.accept(","));
      c.expect("]");
    }
    return { kind: "list", items, span: c.span(start) };
  }
  if (ch === "{") return record(c);
  if (ch === "<" && IDENT_START.test(c.peek(1))) {
    const element = parseElement(c);
    return { kind: "element", element, span: element.span };
  }
  const name = c.identAt();
  if (!name) c.fail(ch ? `Unexpected '${ch}'` : "Expected an expression");
  if (name === "true" || name === "false" || name === "null") {
    c.pos += name.length;
    return { kind: "literal", value: name === "null" ? null : name === "true", span: c.span(start) };
  }
  if (KEYWORDS.has(name)) c.fail(`'${name}' can't start an expression`, start, start + name.length);
  c.pos += name.length;
  const nameSpan = c.span(start);
  if (c.peek() === "(") return call(c, name, nameSpan, start);
  return { kind: "name", name, span: nameSpan };
}

function call(c: Cursor, callee: string, calleeSpan: Span, start: number): Expr {
  c.pos += 1;
  const args: Arg[] = [];
  if (!c.accept(")")) {
    do args.push(argument(c, callee));
    while (c.accept(","));
    c.expect(")", "',' or ')'");
  }
  return { kind: "call", callee, calleeSpan, args, span: c.span(start) };
}

function argument(c: Cursor, callee: string): Arg {
  c.ws();
  const start = c.pos;
  const name = c.identAt();
  if (name && !KEYWORDS.has(name)) {
    const m = c.mark();
    c.pos += name.length;
    const nameSpan = c.span(start);
    c.inlineWs();
    if (c.peek() === ":") {
      c.pos += 1;
      return { name, nameSpan, value: expression(c) };
    }
    if ((COMPREHENSION_FUNCTIONS as readonly string[]).includes(callee) && c.keyword("in")) {
      const source = postfix(c);
      const binding: Binding = { name, nameSpan, source };
      const where = c.keyword("where") ? conditions(c) : [];
      return { value: { kind: "comprehension", binding, where, span: c.span(start) } };
    }
    c.reset(m);
  }
  return { value: expression(c) };
}

function record(c: Cursor): Extract<Expr, { kind: "record" }> {
  c.ws();
  const start = c.pos;
  c.expect("{");
  const entries: { name: string; nameSpan: Span; value: Expr }[] = [];
  if (!c.accept("}")) {
    do {
      if (c.lookingAt("}")) break; // a trailing comma
      c.ws();
      const nameStart = c.pos;
      const name = c.ident("a field name");
      const nameSpan = c.span(nameStart);
      c.expect(":");
      entries.push({ name, nameSpan, value: expression(c) });
    } while (c.accept(","));
    c.expect("}", "',' or '}'");
  }
  return { kind: "record", entries, span: c.span(start) };
}

function escape(c: Cursor): string {
  const next = c.peek(1);
  c.pos += 2;
  switch (next) {
    case "n": return "\n";
    case "t": return "\t";
    case "": c.fail("Unfinished escape");
    default: return next;
  }
}

function plainString(c: Cursor): string {
  const start = c.pos;
  c.pos += 1;
  let value = "";
  for (;;) {
    const ch = c.peek();
    if (ch === "" || ch === "\n") c.fail("Unterminated text", start);
    if (ch === '"') {
      c.pos += 1;
      return value;
    }
    if (ch === "\\") value += escape(c);
    else {
      value += ch;
      c.pos += 1;
    }
  }
}

/** Quoted attribute text, which may hold `{expression}`. */
function template(c: Cursor): Extract<Expr, { kind: "template" }> {
  const start = c.pos;
  c.pos += 1;
  const parts: TextPart[] = [];
  let text = "";
  for (;;) {
    const ch = c.peek();
    if (ch === "" || ch === "\n") c.fail("Unterminated text", start);
    if (ch === '"') {
      c.pos += 1;
      break;
    }
    if (ch === "\\") text += escape(c);
    else if (ch === "{") {
      if (text) parts.push(text);
      text = "";
      c.pos += 1;
      parts.push(expression(c));
      c.expect("}");
    } else {
      text += ch;
      c.pos += 1;
    }
  }
  if (text) parts.push(text);
  return { kind: "template", parts, span: c.span(start) };
}

function conditions(c: Cursor): Expr[] {
  const result = [expression(c)];
  while (c.accept(",")) result.push(expression(c));
  return result;
}

function binding(c: Cursor): Binding {
  c.ws();
  const start = c.pos;
  const name = c.ident("a name to bind");
  const nameSpan = c.span(start);
  if (!c.keyword("in")) c.fail("Expected 'in'");
  return { name, nameSpan, source: postfix(c) };
}

function bindings(c: Cursor): Binding[] {
  const result = [binding(c)];
  while (c.accept(",")) result.push(binding(c));
  return result;
}

function orderTerms(c: Cursor): OrderTerm[] {
  const result: OrderTerm[] = [];
  do {
    const value = expression(c);
    const desc = c.keyword("desc");
    if (!desc) c.keyword("asc");
    result.push({ value, desc });
  } while (c.accept(","));
  return result;
}

// ---------------------------------------------------------------- data views

/** Skips spaces, line breaks, commas and comments between data entries; reports what it crossed. */
function entryGap(c: Cursor): { newline: boolean; blank: boolean; comma: boolean; comments: { text: string; ownLine: boolean }[] } {
  const gap = { newline: false, blank: false, comma: false, comments: [] as { text: string; ownLine: boolean }[] };
  let lineHasContent = true;
  let newlines = 0;
  while (!c.atEnd()) {
    const ch = c.peek();
    if (ch === " " || ch === "\t" || ch === "\r") c.pos += 1;
    else if (ch === "\n") {
      c.pos += 1;
      gap.newline = true;
      newlines += 1;
      if (newlines > 1 && !lineHasContent) gap.blank = true;
      lineHasContent = false;
    } else if (ch === ",") {
      if (gap.comma) c.fail("Expected an entry between the commas");
      c.pos += 1;
      gap.comma = true;
      lineHasContent = true;
    } else if (c.startsWith("//")) {
      gap.comments.push({ text: c.comment(), ownLine: gap.newline });
      lineHasContent = true;
      newlines = gap.newline ? 1 : newlines;
    } else break;
  }
  return gap;
}

function dataRecord(c: Cursor): DataRecord {
  c.ws();
  const start = c.pos;
  c.expect("{");
  const entries: DataEntry[] = [];
  for (;;) {
    const gap = entryGap(c);
    const last = entries.at(-1);
    for (const comment of gap.comments) {
      if (!comment.ownLine && last && last.kind !== "comment") last.comments.push(comment.text);
      else entries.push({ kind: "comment", text: comment.text, span: c.span(c.pos), newline: true, blankBefore: false, comments: [] });
    }
    if (c.peek() === "}") {
      c.pos += 1;
      return { entries, span: c.span(start) };
    }
    if (c.atEnd()) c.fail("Expected '}'");
    if (last && last.kind !== "comment" && !gap.comma && !gap.newline) c.fail("Expected ',', a new line or '}' after the entry");
    const entry = dataEntry(c);
    entry.newline = gap.newline;
    entry.blankBefore = gap.blank && entries.length > 0;
    entries.push(entry);
  }
}

function dataEntry(c: Cursor): DataEntry {
  const start = c.pos;
  const key = c.ident("an entry: a field name, or key: value");
  const keySpan = c.span(start);
  const base = { newline: false, blankBefore: false, comments: [] as string[] };
  c.inlineWs();
  if (c.peek() === ":") {
    c.pos += 1;
    const word = c.nextIdent();
    if (word === "for" || word === "if") c.fail(`A list or a conditional record is written key: { … } ${word}={…}, the record first`, c.pos + 1);
    if (c.lookingAt("{")) {
      const record = dataRecord(c);
      // Attributes follow the record on the line of its closing brace, as on an element.
      const attributes: Attribute[] = [];
      for (;;) {
        const m = c.mark();
        c.inlineWs();
        const name = c.identAt();
        if (name && c.text[c.pos + name.length] === "=") attributes.push(attribute(c));
        else {
          c.reset(m);
          break;
        }
      }
      return { kind: "record", key, keySpan, record, attributes, span: c.span(start), ...base };
    }
    const value = expression(c);
    return { kind: "value", key, keySpan, value, span: c.span(start), ...base };
  }
  if (c.peek() === "{") {
    const record = dataRecord(c);
    return { kind: "field", name: key, nameSpan: keySpan, record, span: c.span(start), ...base };
  }
  return { kind: "field", name: key, nameSpan: keySpan, span: c.span(start), ...base };
}

// ---------------------------------------------------------------- elements

function parseElement(c: Cursor): Element {
  c.ws();
  const start = c.pos;
  c.expect("<");
  const typeStart = c.pos;
  const type = elementType(c);
  const typeSpan = c.span(typeStart);
  const attributes: Attribute[] = [];
  const commentsBefore = c.src.comments.length;
  let children: Child[] | null = null;
  let comments: string[] = [];
  for (;;) {
    c.ws();
    if (c.startsWith("/>")) {
      c.pos += 2;
      comments = c.src.comments.slice(commentsBefore).map((x) => x.text);
      break;
    }
    if (c.startsWith(">")) {
      c.pos += 1;
      comments = c.src.comments.slice(commentsBefore).map((x) => x.text);
      children = parseChildren(c, type);
      break;
    }
    if (c.atEnd()) c.fail(`Unclosed <${type}>`, start, start + 1 + type.length);
    attributes.push(attribute(c));
  }
  return { type, typeSpan, attributes, children, span: c.span(start), comments };
}

function elementType(c: Cursor): string {
  return c.ident("an element type");
}

function attribute(c: Cursor): Attribute {
  const start = c.pos;
  const name = c.ident("an attribute name");
  const nameSpan = c.span(start);
  let value: AttributeValue;
  if (c.accept("=")) {
    c.ws();
    if (c.peek() === '"') value = { kind: "text", text: template(c) };
    else if (c.peek() === "{") {
      c.pos += 1;
      if (name === "for") value = { kind: "for", bindings: bindings(c) };
      else if (name === "where" || name === "if") value = { kind: name, conditions: conditions(c) };
      else if (name === "orderBy") value = { kind: "orderBy", terms: orderTerms(c) };
      else value = { kind: "expr", expr: expression(c) };
      c.expect("}");
    } else c.fail(`Expected text or {expression} for ${name}`);
  } else value = { kind: "bare" };
  return { name, nameSpan, value, span: c.span(start) };
}

/** Whitespace in element text: runs collapse to one space, and a run's ends are trimmed. */
function normalizeRun(parts: TextPart[]): TextPart[] {
  const result: TextPart[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      const text = part.replace(/\s+/g, " ");
      const last = result[result.length - 1];
      if (typeof last === "string") result[result.length - 1] = last + text;
      else result.push(text);
    } else result.push(part);
  }
  if (typeof result[0] === "string") result[0] = result[0].replace(/^ /, "");
  const lastIndex = result.length - 1;
  if (typeof result[lastIndex] === "string") result[lastIndex] = (result[lastIndex] as string).replace(/ $/, "");
  return result.filter((part) => part !== "");
}

function parseChildren(c: Cursor, type: string): Child[] {
  const children: Child[] = [];
  let run: TextPart[] = [];
  let runStart = -1;
  let text = "";
  let gap = ""; // whitespace since the last child, to find blank lines
  const blank = () => /\n[ \t\r]*\n/.test(gap);
  const flush = () => {
    if (text) run.push(text);
    text = "";
    const parts = normalizeRun(run);
    if (parts.length) {
      const leading = typeof run[0] === "string" ? (run[0] as string).match(/^\s*/)![0] : "";
      children.push({ kind: "text", parts, span: c.src.span(runStart, c.pos), blankBefore: /\n[ \t\r]*\n/.test(gap + leading) });
      gap = "";
    } else if (run.length) gap += run.join("");
    run = [];
    runStart = -1;
  };
  for (;;) {
    if (c.atEnd()) c.fail(`Expected </${type}>`);
    const ch = c.peek();
    if (c.startsWith("</")) {
      flush();
      const start = c.pos;
      c.pos += 2;
      const closing = elementType(c);
      if (closing !== type) c.fail(`Expected </${type}>, found </${closing}>`, start, c.pos);
      c.expect(">");
      return children;
    }
    if (ch === "<") {
      flush();
      const element = parseElement(c);
      children.push({ kind: "element", element, blankBefore: blank() });
      gap = "";
      continue;
    }
    if (c.startsWith("//") && /^[ \t]*$/.test(c.text.slice(c.text.lastIndexOf("\n", c.pos - 1) + 1, c.pos))) {
      if (text.trim() || run.some((p) => typeof p !== "string")) flush();
      else {
        gap += text;
        text = "";
        run = [];
      }
      const start = c.pos;
      const comment = c.comment();
      children.push({ kind: "comment", text: comment, span: c.span(start), blankBefore: blank() });
      gap = "";
      continue;
    }
    if (runStart < 0) runStart = c.pos;
    if (ch === "{") {
      if (text) run.push(text);
      text = "";
      c.pos += 1;
      run.push(expression(c));
      c.expect("}");
      continue;
    }
    if (ch === "\\") text += escape(c);
    else {
      text += ch;
      c.pos += 1;
    }
  }
}

// ---------------------------------------------------------------- declarations

function params(c: Cursor): Param[] {
  c.expect("(");
  const result: Param[] = [];
  if (c.accept(")")) return result;
  do {
    c.ws();
    const start = c.pos;
    const name = c.ident("a parameter name");
    let type: TypeRef | undefined;
    if (c.lookingAt(":")) c.fail(`Write a parameter like a field: ${name} Type`);
    if (c.nextIdent()) type = typeRef(c);
    result.push({ name, type, span: c.span(start) });
  } while (c.accept(","));
  c.expect(")", "',' or ')'");
  return result;
}

function typeRef(c: Cursor): TypeRef {
  c.ws();
  const start = c.pos;
  if (c.peek() === "[") {
    c.pos += 1;
    c.ws();
    const name = c.ident("a type");
    c.expect("]");
    return { name, arity: "many", span: c.span(start) };
  }
  const name = c.ident("a type");
  let arity: TypeRef["arity"] = "one";
  if (c.peek() === "?") {
    c.pos += 1;
    arity = "optional";
  } else if (c.startsWith("[]")) {
    c.pos += 2;
    arity = "many";
  }
  return { name, arity, span: c.span(start) };
}

function arrow(c: Cursor): void {
  c.ws();
  if (c.startsWith("→")) c.pos += 1;
  else if (c.startsWith("->")) c.pos += 2;
  else c.fail("Expected '→'");
}

/** Lines first..last (indexes) taken as one stretch of source. */
function stretch(src: Source, first: number, last: number, from?: number): Cursor {
  return new Cursor(src, from ?? src.lines[first]!.start, src.lines[last]!.end);
}

/** The last line of the item starting at `first`: lines after it that are blank or indented past `indent`. */
function itemEnd(src: Source, first: number, last: number, indent: number): number {
  let end = first;
  for (let i = first + 1; i <= last; i += 1) {
    const line = src.lines[i]!;
    if (line.blank) continue;
    if (line.indent <= indent) break;
    end = i;
  }
  return end;
}

function finish(c: Cursor, what: string): void {
  c.ws();
  if (!c.atEnd()) c.fail(`Unexpected text after ${what}`, c.pos, c.end);
}

function viewLine(c: Cursor): ViewLine {
  c.ws();
  const start = c.pos;
  const commentsBefore = c.src.comments.length;
  const kind = c.ident();
  const comments = () => c.src.comments.slice(commentsBefore).map((x) => x.text);
  if (kind === "state" || kind === "keep") {
    c.ws();
    const nameStart = c.pos;
    const name = c.ident("a name");
    const nameSpan = c.span(nameStart);
    c.expect("=");
    const value = expression(c);
    const span = c.span(start);
    finish(c, `${kind} ${name}`);
    return { kind, name, nameSpan, value, span, comments: comments() };
  }
  if (kind === "on") {
    c.ws();
    const event = c.ident("an event name");
    c.ws();
    const detail = c.peek() === '"' ? plainString(c) : undefined;
    arrow(c);
    const action = expression(c);
    const span = c.span(start);
    finish(c, "the action");
    return { kind: "on", event, detail, action, span, comments: comments() };
  }
  if (kind === "every") {
    c.ws();
    const duration = primary(c);
    if (duration.kind !== "duration") c.fail("Expected a duration such as 16ms or 2s");
    arrow(c);
    const action = expression(c);
    const span = c.span(start);
    finish(c, "the action");
    return { kind: "every", text: duration.text, milliseconds: duration.milliseconds, action, span, comments: comments() };
  }
  c.fail(`Expected state, keep, on, every or an element, found '${kind}'`, start, c.pos);
}

const VIEW_LINE_WORDS = new Set(["state", "keep", "on", "every"]);

function firstWord(src: Source, line: Line): string {
  return /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.text.slice(line.start + line.indent, line.end))?.[0] ?? "";
}

function viewBody(src: Source, c: Cursor, headerLine: number, last: number, diagnostics: Diagnostic[]): { lines: ViewLine[]; body: Element | null } {
  const lines: ViewLine[] = [];
  let pending: string[] = [];
  let base = -1;
  for (let i = headerLine + 1; i <= last; i += 1) {
    const line = src.lines[i]!;
    if (line.blank) continue;
    if (base < 0) base = line.indent;
    if (line.indent !== base) throw new ViewSyntaxError("indent", "This line's indentation doesn't match the lines above it", line.start, line.end);
    if (line.comment) {
      const cursor = new Cursor(src, line.start + line.indent, line.end);
      pending.push(cursor.comment());
      continue;
    }
    if (VIEW_LINE_WORDS.has(firstWord(src, line)) && src.text[line.start + line.indent] !== "<") {
      const end = itemEnd(src, i, last, base);
      try {
        const parsed = viewLine(stretch(src, i, end));
        if (pending.length) parsed.leading = pending;
        lines.push(parsed);
      } catch (error) {
        if (!(error instanceof ViewSyntaxError)) throw error;
        diagnostics.push(diagnosticOf(src, error));
      }
      pending = [];
      i = end;
      continue;
    }
    const cursor = stretch(src, i, last);
    const body = parseElement(cursor);
    body.comments.unshift(...pending);
    finish(cursor, "the view's element (a view has one)");
    return { lines, body };
  }
  if (base < 0) throw new ViewSyntaxError("syntax", "Expected the view's element", c.pos, c.pos + 1);
  return { lines, body: null };
}

function diagnosticOf(src: Source, error: ViewSyntaxError): Diagnostic {
  const span = src.span(error.offset, error.endOffset);
  return { code: error.code, message: error.message, ...span };
}

/** After a header's `:`: only a comment may follow on its line. Returns that comment. */
function headerEnd(c: Cursor): string | undefined {
  c.inlineWs();
  if (c.startsWith("//")) return c.comment();
  if (!c.atLineEnd()) c.fail("Nothing follows ':' on its line; the body goes on the lines below, indented", c.pos, c.pos + 1);
  return undefined;
}

interface Item {
  first: number;
  last: number;
  blankBefore: boolean;
  /** A comment-only line's text. */
  comment?: string;
}

/** A body's items: lines at the body's indentation, each with the lines indented past it. */
function items(src: Source, first: number, last: number, diagnostics: Diagnostic[]): Item[] {
  const result: Item[] = [];
  let base = -1;
  let blankBefore = false;
  for (let i = first; i <= last; i += 1) {
    const line = src.lines[i]!;
    if (line.blank) {
      blankBefore = result.length > 0;
      continue;
    }
    if (base < 0) base = line.indent;
    const end = itemEnd(src, i, last, line.indent);
    if (line.indent !== base) {
      diagnostics.push({ code: "indent", message: "This line's indentation doesn't match the lines above it", ...src.span(line.start, line.end) });
    } else if (line.comment) {
      result.push({ first: i, last: i, blankBefore, comment: new Cursor(src, line.start + line.indent, line.end).comment() });
    } else result.push({ first: i, last: end, blankBefore });
    blankBefore = false;
    i = end;
  }
  return result;
}

function itemCursor(src: Source, item: Item): Cursor {
  const line = src.lines[item.first]!;
  return stretch(src, item.first, item.last, line.start + line.indent);
}

/** Parses each item with `parse`, reporting a syntax error and going on. */
function each<T>(src: Source, list: Item[], diagnostics: Diagnostic[], parse: (item: Item) => T): T[] {
  const result: T[] = [];
  for (const item of list) {
    try {
      result.push(parse(item));
    } catch (error) {
      if (!(error instanceof ViewSyntaxError)) throw error;
      diagnostics.push(diagnosticOf(src, error));
    }
  }
  return result;
}

// ---------------------------------------------------------------- mutations

const ERROR_WORDS = new Set<string>(ERROR_CODES);

function mutationLines(src: Source, first: number, last: number, diagnostics: Diagnostic[]): MutationLine[] {
  return each(src, items(src, first, last, diagnostics), diagnostics, (item) => mutationLine(src, item, diagnostics));
}

function mutationLine(src: Source, item: Item, diagnostics: Diagnostic[]): MutationLine {
  const line = src.lines[item.first]!;
  if (item.comment !== undefined) {
    return { kind: "comment", text: item.comment, span: src.span(line.start + line.indent, line.end), blankBefore: item.blankBefore, comments: [] };
  }
  const c = itemCursor(src, item);
  const start = c.pos;
  const commentsBefore = src.comments.length;
  const comments = () => src.comments.slice(commentsBefore).map((x) => x.text);
  const base = { blankBefore: item.blankBefore };
  const word = c.identAt();
  const block = (body: () => MutationLine[]) => {
    const headerComment = headerEnd(c);
    const own = headerComment !== undefined ? [headerComment] : [];
    if (item.last === item.first) c.fail("Expected the block's lines below it, indented", start, line.end);
    return { own, body: body() };
  };
  if (word === "if") {
    c.pos += 2;
    const condition = expression(c);
    c.expect(":");
    const { own, body } = block(() => mutationLines(src, item.first + 1, item.last, diagnostics));
    return { kind: "if", condition, body, span: src.span(start, line.end), comments: own, ...base };
  }
  if (word === "for") {
    c.pos += 3;
    const bs = bindings(c);
    const where = c.keyword("where") ? conditions(c) : [];
    c.expect(":");
    const { own, body } = block(() => mutationLines(src, item.first + 1, item.last, diagnostics));
    return { kind: "for", bindings: bs, where, body, span: src.span(start, line.end), comments: own, ...base };
  }
  if (word && ERROR_WORDS.has(word)) {
    const m = c.mark();
    c.pos += word.length;
    c.inlineWs();
    if (c.peek() === '"' || c.atLineEnd()) {
      const message = c.peek() === '"' ? plainString(c) : undefined;
      const span = c.span(start);
      finish(c, "the error");
      return { kind: "error", code: word as ErrorCode, message, span, comments: comments(), ...base };
    }
    c.reset(m);
  }
  let negated = false;
  let name: string | undefined;
  let nameSpan: Span | undefined;
  if (word === "let") {
    c.pos += 3;
    c.ws();
    const nameStart = c.pos;
    name = c.ident("a name");
    nameSpan = c.span(nameStart);
    c.expect("=");
  } else if (word === "not") {
    c.pos += 3;
    negated = true;
  }
  const target = postfix(c);
  if (!name && !negated && c.lookingAt("=") && !c.lookingAt("==")) {
    c.expect("=");
    if (target.kind !== "field") c.fail("The left of `=` is a row's field, such as l.name", start, c.pos);
    const value = expression(c);
    const span = c.span(start);
    finish(c, "the value");
    return { kind: "set", target: target as Extract<Expr, { kind: "field" }>, value, span, comments: comments(), ...base };
  }
  if (target.kind !== "call") {
    c.fail("Expected a fact (Table(…), not Table(…), row.field = value), a mutation call, if, for or an error", start, c.pos);
  }
  const span = c.span(start);
  finish(c, "the fact");
  return { kind: "fact", negated, name, nameSpan, call: target as Extract<Expr, { kind: "call" }>, span, comments: comments(), ...base };
}

// ---------------------------------------------------------------- tables

const MODIFIERS = new Set(["ordered", "unique", "path"]);

function schemaAttributes(c: Cursor): SchemaAttribute[] {
  const attrs: SchemaAttribute[] = [];
  for (;;) {
    c.inlineWs();
    const ch = c.peek();
    if (ch !== "@" && ch !== "~") return attrs;
    const start = c.pos;
    c.pos += 1;
    const name = c.ident("an attribute name");
    let args: Expr[] | null = null;
    if (c.peek() === "(") {
      c.pos += 1;
      args = [];
      if (!c.accept(")")) {
        do args.push(expression(c));
        while (c.accept(","));
        c.expect(")", "',' or ')'");
      }
    }
    attrs.push({ sigil: ch, name, args, span: c.span(start) });
  }
}

function arity(c: Cursor): TypeRef["arity"] {
  if (c.peek() === "?") {
    c.pos += 1;
    return "optional";
  }
  if (c.startsWith("[]")) {
    c.pos += 2;
    return "many";
  }
  return "one";
}

/** `[ordered] Table.field[?|[]] [as name] attrs`, with `c` at its start. */
function end(c: Cursor): Omit<EndMember, "blankBefore" | "comments"> {
  c.ws();
  const start = c.pos;
  let ordered = false;
  if (c.identAt() === "ordered") {
    c.pos += 7;
    c.ws();
    ordered = true;
  }
  const table = c.ident("a table name");
  c.expect(".");
  const field = c.ident("a field name");
  const a = arity(c);
  let as: string | undefined;
  if (c.keyword("as")) {
    c.ws();
    as = c.ident("a name");
  }
  const attrs = schemaAttributes(c);
  return { kind: "end", ordered, table, field, arity: a, ...(as ? { as } : {}), attrs, span: c.span(start) };
}

/** True when the cursor is at an end, `[ordered] Table.field`. */
function atEnd(c: Cursor): boolean {
  const m = c.mark();
  c.ws();
  if (c.identAt() === "ordered") {
    c.pos += 7;
    c.inlineWs();
  }
  const name = c.identAt();
  let result = false;
  if (name && /^[A-Z]/.test(name)) {
    c.pos += name.length;
    result = c.peek() === "." && IDENT_START.test(c.peek(1));
  }
  c.reset(m);
  return result;
}

function field(c: Cursor): Extract<TableMember, { kind: "field" }> {
  c.ws();
  const start = c.pos;
  const name = c.ident("a field name");
  const modifiers: string[] = [];
  for (;;) {
    c.inlineWs();
    const next = c.identAt();
    if (!next) c.fail(`Expected ${name}'s type`);
    const m = c.mark();
    c.pos += next.length;
    c.inlineWs();
    if (MODIFIERS.has(next) && c.identAt()) {
      modifiers.push(next);
      continue;
    }
    c.reset(m);
    break;
  }
  c.inlineWs();
  const type = c.ident("a type");
  const a = arity(c);
  let defaultValue: Expr | undefined;
  if (c.lookingAt("=") && !c.lookingAt("==")) {
    c.expect("=");
    defaultValue = expression(c);
  }
  const attrs = schemaAttributes(c);
  return {
    kind: "field", name, modifiers, type, arity: a, ...(defaultValue ? { default: defaultValue } : {}), attrs,
    span: c.span(start), blankBefore: false, comments: [],
  };
}

function value(c: Cursor): Extract<TableMember, { kind: "value" }> {
  c.ws();
  const start = c.pos;
  const quoted = c.peek() === '"';
  const name = quoted ? plainString(c) : c.ident("a value name");
  c.inlineWs();
  const values = c.peek() === "{" ? record(c) : undefined;
  const attrs = schemaAttributes(c);
  return { kind: "value", name, quoted, ...(values ? { values } : {}), attrs, span: c.span(start), blankBefore: false, comments: [] };
}

/** True when the line is an enum value or seed row rather than a field. */
function atValue(c: Cursor): boolean {
  const m = c.mark();
  c.ws();
  if (c.peek() === '"') {
    c.reset(m);
    return true;
  }
  const name = c.identAt();
  if (!name) {
    c.reset(m);
    return false;
  }
  c.pos += name.length;
  c.inlineWs();
  const result = c.atLineEnd() || c.peek() === "{" || c.peek() === "@" || c.peek() === "~";
  c.reset(m);
  return result;
}

function tableMembers(src: Source, first: number, last: number, diagnostics: Diagnostic[], context: "table" | "enum" | "re" | "seed"): TableMember[] {
  return each(src, items(src, first, last, diagnostics), diagnostics, (item): TableMember => {
    const line = src.lines[item.first]!;
    if (item.comment !== undefined) {
      return { kind: "comment", text: item.comment, span: src.span(line.start + line.indent, line.end), blankBefore: item.blankBefore, comments: [] };
    }
    const c = itemCursor(src, item);
    const start = c.pos;
    const commentsBefore = src.comments.length;
    const finishMember = <T extends TableMember>(member: T): T => {
      finish(c, "the line");
      member.blankBefore = item.blankBefore;
      member.comments = src.comments.slice(commentsBefore).map((x) => x.text);
      return member;
    };
    if (c.peek() === "@" || c.peek() === "~") {
      const attrs = schemaAttributes(c);
      if (attrs.length !== 1) c.fail("One table-level attribute per line", start, c.pos);
      return finishMember({ kind: "attribute", attr: attrs[0]!, span: c.span(start), blankBefore: false, comments: [] });
    }
    if (context === "table" && c.identAt() === "seed") {
      const m = c.mark();
      c.pos += 4;
      if (c.accept(":")) {
        const own = headerEnd(c);
        const rows = tableMembers(src, item.first + 1, item.last, diagnostics, "seed");
        return { kind: "seed", rows, span: src.span(start, line.end), blankBefore: item.blankBefore, comments: own !== undefined ? [own] : [] };
      }
      c.reset(m);
    }
    if (context === "re") {
      c.ws();
      const name = c.ident("a field or value name");
      const attrs = schemaAttributes(c);
      return finishMember({ kind: "mention", name, attrs, span: c.span(start), blankBefore: false, comments: [] });
    }
    if (context === "seed" || (context === "enum" && atValue(c))) return finishMember(value(c));
    if (context === "table" && atEnd(c)) return finishMember({ ...end(c), blankBefore: false, comments: [] });
    return finishMember(field(c));
  });
}

// ---------------------------------------------------------------- declarations

function ruleBody(src: Source, first: number, last: number, diagnostics: Diagnostic[]): RuleLine[] {
  return each(src, items(src, first, last, diagnostics), diagnostics, (item): RuleLine => {
    if (item.comment !== undefined) return { kind: "comment", text: item.comment, blankBefore: item.blankBefore };
    const c = itemCursor(src, item);
    const commentsBefore = src.comments.length;
    const condition = expression(c);
    finish(c, "the condition");
    return { kind: "condition", condition, comments: src.comments.slice(commentsBefore).map((x) => x.text), blankBefore: item.blankBefore };
  });
}

function declaration(src: Source, first: number, last: number, diagnostics: Diagnostic[]): { decl: Declaration; trailing?: string } {
  const line = src.lines[first]!;
  const c = stretch(src, first, last);
  const start = c.pos;
  const commentsAt = src.comments.length;
  const trailingOn = (offsetLimit: number) => src.comments.slice(commentsAt).find((x) => x.offset < offsetLimit)?.text;
  const needBody = () => {
    if (last === first) c.fail("Expected the body on the lines below, indented", start, line.end);
  };
  if (c.peek() === "<") {
    const element = parseElement(c);
    finish(c, "the element (a view block has at most one)");
    return { decl: { kind: "element", element, span: element.span } };
  }
  if (atEnd(c)) {
    const a = { ...end(c), blankBefore: false, comments: [] };
    c.expect("<->", "'<->' and the connection's other end");
    const b = { ...end(c), blankBefore: false, comments: [] };
    const decl: ConnectionDecl = { kind: "connection", a, b, span: c.span(start) };
    finish(c, "the connection");
    return { decl, trailing: trailingOn(line.end + 1) };
  }
  const word = c.ident("a declaration (use, view, rule, mutation, table or enum)");
  if (word === "use") {
    c.ws();
    if (c.peek() !== '"') c.fail('Expected a path in quotes, such as use "data/schema.vad"');
    const path = plainString(c);
    const decl: UseDecl = { kind: "use", path, span: c.span(start) };
    if (c.accept("(")) {
      decl.picks = [];
      do {
        c.ws();
        const pickStart = c.pos;
        const name = c.ident("a name to use, or view");
        let as: string | undefined;
        if (c.keyword("as")) {
          c.ws();
          as = c.ident("a name");
        }
        decl.picks.push({ name, as, span: c.span(pickStart) });
      } while (c.accept(","));
      c.expect(")", "',' or ')'");
      decl.span = c.span(start);
    }
    finish(c, "the use");
    return { decl, trailing: trailingOn(line.end + 1) };
  }
  if (word === "view") {
    c.ws();
    const nameStart = c.pos;
    const name = c.identAt();
    if (name) c.pos += name.length;
    const nameSpan = name ? c.span(nameStart) : c.src.span(start, start + 4);
    const ps = params(c);
    if (c.lookingAt("{")) {
      const data = dataRecord(c);
      finish(c, "the data view");
      const decl: ViewDecl = { kind: "view", name, nameSpan, params: ps, lines: [], body: null, data, span: c.span(start) };
      return { decl };
    }
    c.expect(":");
    const trailing = headerEnd(c);
    needBody();
    const { lines, body } = viewBody(src, c, first, last, diagnostics);
    const decl: ViewDecl = { kind: "view", name, nameSpan, params: ps, lines, body, span: src.span(start, src.lines[last]!.end) };
    return { decl, trailing };
  }
  if (word === "rule") {
    c.ws();
    const nameStart = c.pos;
    const name = c.ident("a rule name");
    const nameSpan = c.span(nameStart);
    const ps = params(c);
    c.expect(":");
    const trailing = headerEnd(c);
    needBody();
    const decl: RuleDecl = { kind: "rule", name, nameSpan, params: ps, body: ruleBody(src, first + 1, last, diagnostics), span: src.span(start, src.lines[last]!.end) };
    return { decl, trailing };
  }
  if (word === "mutation") {
    c.ws();
    const nameStart = c.pos;
    const name = c.ident("a mutation name");
    const nameSpan = c.span(nameStart);
    const ps = params(c);
    let rowAction: MutationDecl["rowAction"];
    if (c.keyword("for")) {
      c.ws();
      const actionStart = c.pos;
      const table = c.ident("a table name");
      c.expect(".");
      const op = c.ident("create, edit, delete or move");
      rowAction = { model: table, op, span: c.span(actionStart) };
    }
    c.expect(":");
    const trailing = headerEnd(c);
    needBody();
    const body = mutationLines(src, first + 1, last, diagnostics);
    const decl: MutationDecl = { kind: "mutation", name, nameSpan, params: ps, rowAction, body, span: src.span(start, src.lines[last]!.end) };
    return { decl, trailing };
  }
  if (word === "table" || word === "main" || word === "my" || word === "session") {
    const tableKind = word === "table" ? "data" : word;
    if (word !== "table" && !c.keyword("table")) c.fail(`Expected 'table' after '${word}'`);
    c.ws();
    const nameStart = c.pos;
    const name = c.ident("a table name");
    const nameSpan = c.span(nameStart);
    let key: TableDecl["key"];
    if (c.accept("(")) {
      key = [];
      do {
        c.ws();
        const keyStart = c.pos;
        key.push({ name: c.ident("a key field"), span: c.span(keyStart) });
      } while (c.accept(","));
      c.expect(")", "',' or ')'");
    }
    c.expect(":");
    const trailing = headerEnd(c);
    const decl: TableDecl = {
      kind: "table", tableKind, name, nameSpan, ...(key ? { key } : {}),
      members: tableMembers(src, first + 1, last, diagnostics, "table"), span: src.span(start, src.lines[last]!.end),
    };
    return { decl, trailing };
  }
  if (word === "enum" || word === "re") {
    c.ws();
    const nameStart = c.pos;
    const name = c.ident(word === "enum" ? "an enum name" : "a table or enum name");
    const nameSpan = c.span(nameStart);
    c.expect(":");
    const trailing = headerEnd(c);
    needBody();
    const members = tableMembers(src, first + 1, last, diagnostics, word);
    const decl: EnumDecl | ReDecl = { kind: word, name, nameSpan, members, span: src.span(start, src.lines[last]!.end) };
    return { decl, trailing };
  }
  if (word === "model") c.fail("Write `table`, not `model`", start, c.pos);
  if (c.peek() === "(") c.fail(`A rule is written \`rule ${word}(…):\`, with its conditions on the lines below`, start, c.pos);
  return c.fail(`Expected use, view, rule, mutation, table, enum, re or a connection, found '${word}'`, start, c.pos);
}

export function parseView(text: string): ParseResult {
  const src = new Source(text);
  const diagnostics: Diagnostic[] = [];
  const declarations: DeclarationEntry[] = [];
  let blankBefore = false;
  const last = src.lines.length - 1;
  for (let i = 0; i <= last; i += 1) {
    const line = src.lines[i]!;
    if (line.blank) {
      blankBefore = declarations.length > 0;
      continue;
    }
    if (line.comment && line.indent === 0) {
      const c = new Cursor(src, line.start, line.end);
      declarations.push({ decl: { kind: "comment", text: c.comment(), span: src.span(line.start, line.end) }, blankBefore });
      blankBefore = false;
      continue;
    }
    // The declaration runs to the line before the next one in the first column.
    let end = i;
    for (let j = i + 1; j <= last; j += 1) {
      const next = src.lines[j]!;
      if (next.blank) continue;
      // A data view's closing brace sits in the first column and still belongs to it.
      if (next.indent === 0 && src.text[next.start] !== "}") break;
      end = j;
    }
    if (line.indent > 0) {
      diagnostics.push({ code: "indent", message: "A declaration starts in the first column", ...src.span(line.start, line.end) });
    } else {
      try {
        const { decl, trailing } = declaration(src, i, end, diagnostics);
        declarations.push({ decl, blankBefore, trailing });
      } catch (error) {
        if (!(error instanceof ViewSyntaxError)) throw error;
        diagnostics.push(diagnosticOf(src, error));
      }
    }
    blankBefore = false;
    i = end;
  }
  return { file: { declarations }, diagnostics, comments: src.comments.map((x) => x.text) };
}

