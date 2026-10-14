// A hand-written lexer and recursive-descent parser for .usl files.
//
// Items in any block are separated by newlines or commas. Newlines inside
// parentheses, lists and object literals are ignored.

import type {
  Arity,
  Attribute,
  Declaration,
  Diagnostic,
  EndDecl,
  Expr,
  Member,
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

const PUNCT = ["<->", "@@", "{", "}", "(", ")", "[", "]", ",", ".", ":", "?", "@", "/"];

function lex(source: string): Token[] {
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
      while (i < source.length && source[i] !== "\n") i++;
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
      declarations.push(this.declaration());
      if (!this.atEnd() && !this.separators()) this.fail("a new line");
    }
    return { declarations };
  }

  private declaration(): Declaration {
    const at = this.at();
    if (this.is("model") && this.peek().kind === "ident") {
      this.next();
      const name = this.next().text;
      return { kind: "model", name, members: this.block(), at };
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
      return { kind: "connection", spelling: "braces", members: this.block(), at };
    }
    if (this.token.kind === "ident" && this.is(".", this.peek())) {
      const left = this.end();
      this.expect("<->");
      const right = this.end();
      if (this.is("<->")) this.fail("one arrow per connection; use a named model for more ends");
      return { kind: "connection", spelling: "arrow", members: [left, right], at };
    }
    this.fail("`model`, `view`, a connection `{ A.x, B.y }` or `A.x <-> B.y`");
  }

  /** `{ member (sep member)* }` */
  private block(): Member[] {
    this.expect("{");
    const members: Member[] = [];
    this.separators();
    while (!this.is("}")) {
      members.push(this.member());
      if (!this.is("}") && !this.separators()) this.fail("a new line, `,` or `}`");
    }
    this.next();
    return members;
  }

  private member(): Member {
    const at = this.at();
    if (this.is("@@")) {
      this.next();
      const name = this.ident("a model attribute name").text;
      if ((name === "fixed" || name === "seed") && this.is("{")) {
        return { kind: "rows", mode: name, rows: this.rows(), at };
      }
      return { kind: "modelAttribute", name, args: this.is("(") ? this.args() : [], at };
    }
    if (this.token.kind === "ident" && this.is(".", this.peek())) return this.end();
    if (this.token.kind === "ident") {
      const name = this.next().text;
      const type = this.ident(`a type for field \`${name}\``).text;
      return { kind: "field", name, type, arity: this.arity(), attrs: this.attrs(), at };
    }
    this.fail("a field, a connection end `Model.field`, or `@@attribute`");
  }

  private end(): EndDecl {
    const at = this.at();
    const model = this.ident("a model name").text;
    this.expect(".");
    const field = this.ident("a field name").text;
    return { kind: "end", model, field, arity: this.arity(), attrs: this.attrs(), at };
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
    while (this.is("@")) {
      const at = this.at();
      this.next();
      const name = this.ident("an attribute name").text;
      attrs.push({ name, args: this.is("(") ? this.args() : [], at });
    }
    return attrs;
  }

  private rows(): Row[] {
    this.expect("{");
    const rows: Row[] = [];
    this.separators();
    while (!this.is("}")) {
      const at = this.at();
      let name: string;
      if (this.token.kind === "ident") name = this.next().text;
      else if (this.token.kind === "string") name = this.next().value as string;
      else this.fail("a row name");
      let values: ObjectEntry[] = [];
      if (this.is("{")) {
        this.next();
        values = this.entries("}");
      }
      rows.push({ name, values, attrs: this.attrs(), at });
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
      return { kind: "ident", name: token.text, attrs: this.attrs(), at };
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
