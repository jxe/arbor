// A hand-written lexer and recursive-descent parser for .usl files.
//
// Items in any block are separated by newlines or commas. Newlines inside
// parentheses, lists and object literals are ignored. The model layer is
// keywords (`main`, `enum`, `ordered`, `unique`, `path`, `as`, `seed`), which
// are keywords only where they appear; `@` attributes are storage and `~`
// attributes presentation.

import type {
  Arity,
  Attribute,
  Declaration,
  Diagnostic,
  EndDecl,
  Expr,
  Member,
  ModelDecl,
  Modifier,
  ObjectEntry,
  Position,
  Row,
  SchemaFile,
} from "./ast.ts";

type TokenKind = "ident" | "string" | "number" | "punct" | "newline" | "eof";

interface Token {
  kind: TokenKind;
  text: string;
  value?: string | number;
  start: number;
  end: number;
  line: number;
  column: number;
}

export class UslSyntaxError extends Error {
  constructor(
    message: string,
    readonly at: Position,
    readonly code: "syntax" | "limit" = "syntax",
  ) {
    super(message);
  }
}

/** Bounds on what a schema may ask of a parser, so an untrusted schema can't exhaust a host. */
export const USL_LIMITS = {
  sourceBytes: 1_048_576,
  tokens: 65_536,
  depth: 32,
} as const;

const PUNCT = ["<->", "@@", "{", "}", "(", ")", "[", "]", ",", ".", ":", "?", "@", "~", "/"];

/** Keywords that may come between a field's name and its type. */
const MODIFIERS = ["ordered", "unique", "path"];

/** A `//` comment, kept only for `usl fmt`. `own` is true when no token precedes it on its line. */
export interface Comment {
  line: number;
  column: number;
  text: string;
  own: boolean;
}

function lex(source: string, comments: Comment[] = []): Token[] {
  if (new TextEncoder().encode(source).length > USL_LIMITS.sourceBytes) {
    throw new UslSyntaxError(`A schema is at most ${USL_LIMITS.sourceBytes} bytes`, { line: 1, column: 1 }, "limit");
  }
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const push = (kind: TokenKind, start: number, end: number, value?: string | number) =>
    tokens.push({ kind, text: source.slice(start, end), value, start, end, line, column: start - lineStart + 1 });

  while (i < source.length) {
    const c = source[i]!;
    if (c === "\n") {
      push("newline", i, i + 1);
      i++;
      line++;
      lineStart = i;
    } else if (c === " " || c === "\t" || c === "\r") {
      i++;
    } else if (source.startsWith("//", i)) {
      const start = i;
      while (i < source.length && source[i] !== "\n") i++;
      const last = tokens[tokens.length - 1];
      const own = !last || last.kind === "newline";
      comments.push({ line, column: start - lineStart + 1, text: source.slice(start, i).trimEnd(), own });
    } else if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) i++;
      push("ident", start, i);
    } else if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(source[i + 1] ?? ""))) {
      const start = i;
      i++;
      while (i < source.length && /[0-9.]/.test(source[i]!)) i++;
      const text = source.slice(start, i);
      if (!/^-?\d+(\.\d+)?$/.test(text)) {
        throw new UslSyntaxError(`Malformed number ${text}`, { line, column: start - lineStart + 1 });
      }
      push("number", start, i, Number(text));
    } else if (c === '"') {
      const start = i;
      i++;
      let value = "";
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\n") break;
        if (source[i] === "\\") {
          const next = source[i + 1];
          value += next === "n" ? "\n" : next === "t" ? "\t" : (next ?? "");
          i += 2;
        } else {
          value += source[i];
          i++;
        }
      }
      if (source[i] !== '"') {
        throw new UslSyntaxError("Unterminated string", { line, column: start - lineStart + 1 });
      }
      i++;
      push("string", start, i, value);
    } else {
      const punct = PUNCT.find((p) => source.startsWith(p, i));
      if (!punct) throw new UslSyntaxError(`Unexpected character ${JSON.stringify(c)}`, { line, column: i - lineStart + 1 });
      push("punct", i, i + punct.length);
      i += punct.length;
    }
  }
  tokens.push({ kind: "eof", text: "", start: i, end: i, line, column: i - lineStart + 1 });
  if (tokens.length > USL_LIMITS.tokens) {
    throw new UslSyntaxError(`A schema has at most ${USL_LIMITS.tokens} tokens`, { line: 1, column: 1 }, "limit");
  }
  return tokens;
}

function describe(token: Token): string {
  if (token.kind === "eof") return "end of file";
  if (token.kind === "newline") return "end of line";
  return JSON.stringify(token.text);
}

class Parser {
  private pos = 0;
  /** The line each declaration, member and row ends on, for `usl fmt`. */
  readonly ends = new WeakMap<object, number>();

  constructor(
    private readonly source: string,
    private readonly tokens: Token[],
  ) {}

  private get token(): Token {
    return this.tokens[this.pos]!;
  }

  private peek(offset = 1): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]!;
  }

  private at(token = this.token): Position {
    return { line: token.line, column: token.column };
  }

  private is(text: string, token = this.token): boolean {
    return (token.kind === "punct" || token.kind === "ident") && token.text === text;
  }

  /** Records the line of the last token taken as where `node` ends. */
  private ended<T extends object>(node: T): T {
    this.ends.set(node, this.tokens[this.pos - 1]!.line);
    return node;
  }

  private fail(expected: string): never {
    throw new UslSyntaxError(`Expected ${expected}, found ${describe(this.token)}`, this.at());
  }

  private next(): Token {
    const token = this.token;
    if (token.kind !== "eof") this.pos++;
    return token;
  }

  private expect(text: string): Token {
    if (!this.is(text)) this.fail(JSON.stringify(text));
    return this.next();
  }

  private ident(what: string): Token {
    if (this.token.kind !== "ident") this.fail(what);
    return this.next();
  }

  private atEnd(): boolean {
    return this.token.kind === "eof";
  }

  private skipNewlines() {
    while (this.token.kind === "newline") this.next();
  }

  /** Skips any run of newlines and commas; true if there was one. */
  private separators(): boolean {
    let any = false;
    while (this.token.kind === "newline" || this.is(",")) {
      this.next();
      any = true;
    }
    return any;
  }

  file(): SchemaFile {
    const declarations: Declaration[] = [];
    this.skipNewlines();
    while (!this.atEnd()) {
      declarations.push(this.ended(this.declaration()));
      if (!this.atEnd() && !this.separators()) this.fail("a new line");
    }
    return { declarations };
  }

  private declaration(): Declaration {
    const at = this.at();
    if (this.is("main") && this.is("model", this.peek()) && this.peek(2).kind === "ident") {
      this.next();
      return this.model(at, at);
    }
    if (this.is("model") && this.peek().kind === "ident") return this.model(at, null);
    if (this.is("enum") && this.peek().kind === "ident") {
      this.next();
      const name = this.next().text;
      return { kind: "model", form: "enum", name, main: null, key: null, members: this.block("enum"), at };
    }
    if (this.is("re") && this.peek().kind === "ident") {
      this.next();
      const name = this.next().text;
      return { kind: "re", name, members: this.block("re"), at };
    }
    if (this.is("view") && this.peek().kind === "string") {
      this.next();
      const label = this.next().value as string;
      this.expect("of");
      const path: Token[] = [];
      for (let t = this.token; t.kind !== "eof" && t.kind !== "newline" && !this.is("{"); t = this.token) path.push(this.next());
      if (path.length === 0) this.fail("a collection path");
      const of = this.source.slice(path[0]!.start, path[path.length - 1]!.end);
      this.expect("{");
      const options = this.entries("}");
      return { kind: "view", label, of, options, at };
    }
    if (this.is("{")) {
      return { kind: "connection", spelling: "braces", members: this.block("connection"), at };
    }
    if (this.startsEnd()) {
      const left = this.end();
      this.expect("<->");
      const right = this.end();
      if (this.is("<->")) this.fail("one arrow per connection; use a named model for more ends");
      return { kind: "connection", spelling: "arrow", members: [left, right], at };
    }
    this.oldSpelling();
    this.fail("`model`, `enum`, `re`, `view`, a connection `{ A.x, B.y }` or `A.x <-> B.y`");
  }

  /** `model Name [(key, ...)] { ... }`, after any `main`. */
  private model(at: Position, main: Position | null): ModelDecl {
    this.expect("model");
    const name = this.next().text;
    let key: ModelDecl["key"] = null;
    if (this.is("(")) {
      const keyAt = this.at();
      this.next();
      const fields: { name: string; at: Position }[] = [];
      this.separators();
      while (!this.is(")")) {
        const field = this.ident("a key field");
        fields.push({ name: field.text, at: this.at(field) });
        if (!this.is(")") && !this.separators()) this.fail("`,` or `)`");
      }
      this.next();
      key = { fields, at: keyAt };
    }
    return { kind: "model", form: "model", name, main, key, members: this.block("model"), at };
  }

  /** `[ordered] Model.field` starts here. */
  private startsEnd(): boolean {
    if (this.is("ordered") && this.peek().kind === "ident" && this.is(".", this.peek(2))) return true;
    return this.token.kind === "ident" && this.is(".", this.peek());
  }

  /** Spellings from before 2026-10-24 get a pointer to the new one. */
  private oldSpelling() {
    if (this.is("@@")) {
      this.fail("an item; USL has no `@@` (write keys as `model X (a, b)`, an enum as `enum X { ... }`, `seed { ... }`, and `@table`, `@index` or `~views`)");
    }
  }

  /** `{ member (sep member)* }` */
  private block(context: "model" | "enum" | "re" | "connection"): Member[] {
    this.expect("{");
    const members: Member[] = [];
    const values: Row[] = [];
    let valuesAt: Position | null = null;
    this.separators();
    while (!this.is("}")) {
      if (context === "enum" && this.startsValue()) {
        valuesAt ??= this.at();
        values.push(this.ended(this.row()));
      } else {
        members.push(this.ended(this.member(context)));
      }
      if (!this.is("}") && !this.separators()) this.fail("a new line, `,` or `}`");
    }
    this.next();
    if (context === "enum") members.push({ kind: "rows", mode: "fixed", rows: values, at: valuesAt ?? this.at() });
    return members;
  }

  /** In an enum, a value rather than a field: a name not followed by a type. */
  private startsValue(): boolean {
    if (this.token.kind === "string") return true;
    return this.token.kind === "ident" && this.peek().kind !== "ident";
  }

  private member(context: "model" | "enum" | "re" | "connection"): Member {
    const at = this.at();
    this.oldSpelling();
    if (this.is("@") || this.is("~")) {
      const sigil = this.next().text as "@" | "~";
      const name = this.ident("an attribute name").text;
      return { kind: "modelAttribute", sigil, name, args: this.is("(") ? this.args() : [], at };
    }
    if (context === "re") {
      let name: string;
      if (this.token.kind === "ident") name = this.next().text;
      else if (this.token.kind === "string") name = this.next().value as string;
      else this.fail("a field or value to annotate, or an attribute");
      const attrs = this.attrs();
      if (attrs.length === 0) this.fail(`an attribute for \`${name}\` (\`re\` blocks only annotate)`);
      return { kind: "mention", name, attrs, at };
    }
    if (this.is("seed") && this.is("{", this.peek())) {
      this.next();
      return { kind: "rows", mode: "seed", rows: this.rows(), at };
    }
    if (this.startsEnd()) return this.end();
    if (this.token.kind === "ident") {
      const name = this.next().text;
      const modifiers: Modifier[] = [];
      while (MODIFIERS.includes(this.token.text) && this.token.kind === "ident" && this.peek().kind === "ident") {
        modifiers.push({ name: this.token.text, at: this.at() });
        this.next();
      }
      const type = this.ident(`a type for field \`${name}\``).text;
      return { kind: "field", name, modifiers, type, arity: this.arity(), attrs: this.attrs(), at };
    }
    this.fail("a field, a connection end `Model.field`, or an attribute");
  }

  private end(): EndDecl {
    const at = this.at();
    let ordered: Position | null = null;
    if (this.is("ordered") && this.peek().kind === "ident" && this.is(".", this.peek(2))) {
      ordered = this.at();
      this.next();
    }
    const model = this.ident("a model name").text;
    this.expect(".");
    const field = this.ident("a field name").text;
    const arity = this.arity();
    let as: EndDecl["as"] = null;
    if (this.is("as") && this.peek().kind === "ident") {
      this.next();
      const name = this.next();
      as = { name: name.text, at: this.at(name) };
    }
    return { kind: "end", model, field, arity, ordered, as, attrs: this.attrs(), at };
  }

  private arity(): Arity {
    if (this.is("?")) {
      this.next();
      return "optional";
    }
    if (this.is("[")) {
      this.next();
      this.expect("]");
      return "many";
    }
    return "one";
  }

  private attrs(): Attribute[] {
    const attrs: Attribute[] = [];
    while (this.is("@") || this.is("~")) {
      const at = this.at();
      const sigil = this.next().text as "@" | "~";
      const name = this.ident("an attribute name").text;
      attrs.push({ sigil, name, args: this.is("(") ? this.args() : [], at });
    }
    return attrs;
  }

  private row(): Row {
    const at = this.at();
    let name: string;
    if (this.token.kind === "ident") name = this.next().text;
    else if (this.token.kind === "string") name = this.next().value as string;
    else this.fail("a value name");
    let values: ObjectEntry[] = [];
    if (this.is("{")) {
      this.next();
      values = this.entries("}");
    }
    return { name, values, attrs: this.attrs(), at };
  }

  private rows(): Row[] {
    this.expect("{");
    const rows: Row[] = [];
    this.separators();
    while (!this.is("}")) {
      rows.push(this.ended(this.row()));
      if (!this.is("}") && !this.separators()) this.fail("a new line, `,` or `}`");
    }
    this.next();
    return rows;
  }

  private args(): Expr[] {
    this.expect("(");
    const items = this.items(")");
    return items;
  }

  /** Expressions up to `close`, separated by commas or newlines. */
  private items(close: string): Expr[] {
    const items: Expr[] = [];
    this.separators();
    while (!this.is(close)) {
      items.push(this.expr());
      if (!this.is(close) && !this.separators()) this.fail(`\`,\` or \`${close}\``);
    }
    this.next();
    return items;
  }

  /** `key: value` entries up to `close`, separated by commas or newlines. */
  private entries(close: string): ObjectEntry[] {
    const entries: ObjectEntry[] = [];
    this.separators();
    while (!this.is(close)) {
      const at = this.at();
      let key: string;
      if (this.token.kind === "ident") key = this.next().text;
      else if (this.token.kind === "string") key = this.next().value as string;
      else this.fail("a key");
      this.expect(":");
      this.skipNewlines();
      entries.push({ key, value: this.expr(), at });
      if (!this.is(close) && !this.separators()) this.fail(`\`,\` or \`${close}\``);
    }
    this.next();
    return entries;
  }

  private depth = 0;

  private expr(): Expr {
    if (++this.depth > USL_LIMITS.depth) {
      throw new UslSyntaxError(`Values nest at most ${USL_LIMITS.depth} deep`, this.at(), "limit");
    }
    try {
      return this.exprInner();
    } finally {
      this.depth--;
    }
  }

  private exprInner(): Expr {
    const token = this.token;
    const at = this.at();
    if (token.kind === "string") {
      this.next();
      return { kind: "string", value: token.value as string, at };
    }
    if (token.kind === "number") {
      this.next();
      return { kind: "number", value: token.value as number, at };
    }
    if (token.kind === "ident") {
      this.next();
      // A path through connections in a view: `ties.group`.
      let name = token.text;
      while (this.is(".") && this.peek().kind === "ident") {
        this.next();
        name += `.${this.token.text}`;
        this.next();
      }
      return { kind: "ident", name, attrs: this.attrs(), at };
    }
    if (this.is("[")) {
      this.next();
      return { kind: "list", items: this.items("]"), at };
    }
    if (this.is("{")) {
      this.next();
      return { kind: "object", entries: this.entries("}"), at };
    }
    this.fail("a value");
  }
}

export interface ParseResult {
  file: SchemaFile | null;
  diagnostics: Diagnostic[];
}

export function parseUsl(source: string): ParseResult {
  try {
    const file = new Parser(source, lex(source)).file();
    return { file, diagnostics: [] };
  } catch (error) {
    if (error instanceof UslSyntaxError) {
      return { file: null, diagnostics: [{ code: error.code, message: error.message, ...error.at }] };
    }
    throw error;
  }
}

/** The syntax tree with what `usl fmt` needs besides: comments, and where each item ends. */
export function parseUslForFormat(
  source: string,
): { file: SchemaFile; comments: Comment[]; ends: WeakMap<object, number> } | { file: null; diagnostics: Diagnostic[] } {
  try {
    const comments: Comment[] = [];
    const parser = new Parser(source, lex(source, comments));
    return { file: parser.file(), comments, ends: parser.ends };
  } catch (error) {
    if (error instanceof UslSyntaxError) {
      return { file: null, diagnostics: [{ code: error.code, message: error.message, ...error.at }] };
    }
    throw error;
  }
}
