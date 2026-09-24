import { COLLECTION_SCHEMA_LIMITS, schemaFailure, type SourceLocation } from "./diagnostics.ts";

export type TokenKind = "ident" | "text" | "number" | "punct" | "control" | "eof";

export interface Token {
  kind: TokenKind;
  /** Identifier name, decoded text, raw number spelling, punctuation, or `.name`. */
  value: string;
  location: SourceLocation;
  numberKind?: "int" | "decimal";
  number?: number;
}

const PUNCTUATION = ["//=", "...", "/=", "//", "..", "=>", "=", "/", "{", "}", "[", "]", "(", ")", "<", ">", ",", ":", "?", "*", "+"] as const;
/** Valid RFC 8610 characters that start syntax outside the profile. */
const UNSUPPORTED_START = new Set(["~", "&", "#", "^", "'", "`"]);

const isDigit = (char: string | undefined) => char !== undefined && char >= "0" && char <= "9";
const isAlpha = (char: string | undefined) => char !== undefined && ((char >= "a" && char <= "z") || (char >= "A" && char <= "Z"));
/** RFC 8610 EALPHA: ALPHA / "@" / "_" / "$". */
const isEAlpha = (char: string | undefined) => isAlpha(char) || char === "@" || char === "_" || char === "$";

function isForbiddenControl(code: number): boolean {
  return code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f) || code === 0xfeff;
}

/**
 * Tokenize a profile source. The first failure throws: invalid characters,
 * literals, and syntax outside the profile are rejected rather than skipped.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let column = 1;
  const here = (): SourceLocation => ({ line, column });
  const advance = (units = 1) => {
    for (let consumed = 0; consumed < units; consumed += 1) {
      const code = source.charCodeAt(index);
      if (code === 0x0a) { line += 1; column = 1; index += 1; continue; }
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < source.length) {
        index += 2;
        consumed += 1;
      } else {
        index += 1;
      }
      column += 1;
    }
  };
  const push = (token: Token) => {
    if (tokens.length >= COLLECTION_SCHEMA_LIMITS.tokens) {
      throw schemaFailure("budget-exceeded", `The schema exceeds ${COLLECTION_SCHEMA_LIMITS.tokens} tokens`, token.location, "tokens");
    }
    tokens.push(token);
  };

  while (index < source.length) {
    const char = source[index]!;
    const code = char.codePointAt(0)!;
    if (char === " " || char === "\t" || char === "\n" || char === "\r") { advance(); continue; }
    if (char === ";") {
      while (index < source.length && source[index] !== "\n") {
        const commentCode = source.codePointAt(index)!;
        if (source[index] !== "\t" && source[index] !== "\r" && isForbiddenControl(commentCode)) {
          throw schemaFailure("invalid-character", "Control characters are not allowed in schema source", here());
        }
        advance();
      }
      continue;
    }
    if (isForbiddenControl(code)) throw schemaFailure("invalid-character", "Control characters are not allowed in schema source", here());
    const start = here();
    if (char === '"') { push(readText(start)); continue; }
    if (isDigit(char) || (char === "-" && isDigit(source[index + 1]))) { push(readNumber(start)); continue; }
    if (isEAlpha(char)) {
      const begin = index;
      advance();
      for (;;) {
        let probe = index;
        while (source[probe] === "-" || source[probe] === ".") probe += 1;
        const next = source[probe];
        if (!(isEAlpha(next) || isDigit(next))) break;
        advance(probe - index + 1);
      }
      const name = source.slice(begin, index);
      if (source[index] === "'") {
        throw schemaFailure("unsupported-syntax", "Prefixed byte-string literals are outside the collection schema profile", start);
      }
      if (name.startsWith("$")) {
        throw schemaFailure("unsupported-syntax", "Socket extension points are outside the collection schema profile", start);
      }
      push({ kind: "ident", value: name, location: start });
      continue;
    }
    if (char === "." && isEAlpha(source[index + 1])) {
      const begin = index;
      advance();
      while (isEAlpha(source[index]) || isDigit(source[index]) || source[index] === "-") advance();
      throw schemaFailure("unsupported-syntax", `Control operator ${source.slice(begin, index)} is outside the collection schema profile`, start);
    }
    if (UNSUPPORTED_START.has(char)) {
      throw schemaFailure("unsupported-syntax", `${char} syntax is outside the collection schema profile`, start);
    }
    const punctuation = PUNCTUATION.find((candidate) => source.startsWith(candidate, index));
    if (punctuation) {
      advance(punctuation.length);
      push({ kind: "punct", value: punctuation, location: start });
      continue;
    }
    throw schemaFailure("syntax-error", `Unexpected character ${JSON.stringify(String.fromCodePoint(code))}`, start);
  }
  tokens.push({ kind: "eof", value: "", location: here() });
  return tokens;

  function readText(start: SourceLocation): Token {
    advance();
    let value = "";
    for (;;) {
      if (index >= source.length || source[index] === "\n" || source[index] === "\r") {
        throw schemaFailure("syntax-error", "Unterminated text literal", start);
      }
      const current = source[index]!;
      if (current === '"') { advance(); break; }
      const currentCode = source.codePointAt(index)!;
      if (isForbiddenControl(currentCode)) {
        throw schemaFailure("invalid-character", "Control characters must be escaped in text literals", here());
      }
      if (current !== "\\") {
        const scalar = String.fromCodePoint(currentCode);
        value += scalar;
        advance(scalar.length);
        continue;
      }
      const escape = source[index + 1];
      const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (escape !== undefined && escape in simple) {
        value += simple[escape]!;
        advance(2);
        continue;
      }
      if (escape === "u" && /^[0-9a-fA-F]{4}$/.test(source.slice(index + 2, index + 6))) {
        value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
        advance(6);
        continue;
      }
      // Consume to the closing quote so the location names the literal.
      throw schemaFailure("invalid-literal", "Text literals use JSON escapes only", start);
    }
    if (!(value as string & { isWellFormed(): boolean }).isWellFormed()) {
      throw schemaFailure("invalid-literal", "Text literal contains an unpaired surrogate", start);
    }
    if (new TextEncoder().encode(value).byteLength > COLLECTION_SCHEMA_LIMITS["text-literal-bytes"]) {
      throw schemaFailure("budget-exceeded", "Text literal exceeds the literal size limit", start, "text-literal-bytes");
    }
    return { kind: "text", value, location: start };
  }

  function readNumber(start: SourceLocation): Token {
    const begin = index;
    if (source[index] === "-") advance();
    if (source[index] === "0" && /[xXbB]/.test(source[index + 1] ?? "")) {
      throw schemaFailure("unsupported-syntax", "Hexadecimal and binary numbers are outside the collection schema profile", start);
    }
    if (source[index] === "0" && isDigit(source[index + 1])) {
      throw schemaFailure("syntax-error", "Numbers have no leading zeros", start);
    }
    while (isDigit(source[index])) advance();
    let decimal = false;
    if (source[index] === "." && isDigit(source[index + 1])) {
      decimal = true;
      advance();
      while (isDigit(source[index])) advance();
    }
    if ((source[index] === "e" || source[index] === "E")
      && (isDigit(source[index + 1]) || ((source[index + 1] === "+" || source[index + 1] === "-") && isDigit(source[index + 2])))) {
      decimal = true;
      advance(2);
      while (isDigit(source[index])) advance();
    }
    if (isEAlpha(source[index]) || isDigit(source[index])) {
      throw schemaFailure("syntax-error", "A number must not run into an identifier", start);
    }
    const raw = source.slice(begin, index);
    if (!decimal) {
      const exact = BigInt(raw);
      if (exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < -BigInt(Number.MAX_SAFE_INTEGER)) {
        throw schemaFailure("invalid-literal", "Integer literals must lie within ±(2^53 − 1)", start);
      }
      return { kind: "number", value: raw, location: start, numberKind: "int", number: Number(raw) };
    }
    const number = Number(raw);
    if (!Number.isFinite(number)) throw schemaFailure("invalid-literal", "Decimal literal is not a finite number", start);
    return { kind: "number", value: raw, location: start, numberKind: "decimal", number };
  }
}
