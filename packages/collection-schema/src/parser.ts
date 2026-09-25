import { COLLECTION_SCHEMA_LIMITS, schemaFailure, type SourceLocation } from "./diagnostics.ts";
import { tokenize, type Token } from "./lexer.ts";

export interface ChoiceNode {
  kind: "choice";
  alternatives: TypeNode[];
  location: SourceLocation;
}

export type TypeNode =
  | { kind: "name"; name: string; location: SourceLocation }
  | { kind: "text"; value: string; location: SourceLocation }
  | { kind: "number"; value: number; numberKind: "int" | "decimal"; location: SourceLocation }
  | { kind: "range"; low: number; high: number; inclusive: boolean; integer: boolean; location: SourceLocation }
  /** `open`: the map declares the explicit `* tstr => any` entry. */
  | { kind: "map"; members: MemberNode[]; open: boolean; location: SourceLocation }
  | { kind: "array"; element: ChoiceNode; nonEmpty: boolean; location: SourceLocation };

export interface MemberNode {
  name: string;
  optional: boolean;
  type: ChoiceNode;
  location: SourceLocation;
}

export type MetadataValue =
  | { kind: "int"; value: number; location: SourceLocation }
  | { kind: "text"; value: string; location: SourceLocation }
  | { kind: "text-array"; values: string[]; location: SourceLocation };

export interface RuleNode {
  name: string;
  location: SourceLocation;
  type?: ChoiceNode;
  metadata?: MetadataValue;
}

export const METADATA_RULES = new Set(["overstory-schema-version", "overstory-primary-key", "overstory-child-name"]);

/** Parse the profile's subset of RFC 8610; the first failure throws. */
export function parseProfile(source: string): RuleNode[] {
  return parseProfileWithSize(source).rules;
}

/** The parsed rules and their syntax-node count, which bounds compiled size. */
export function parseProfileWithSize(source: string): { rules: RuleNode[]; nodes: number } {
  const tokens = tokenize(source);
  let position = 0;
  let nodes = 0;
  const rules: RuleNode[] = [];
  const peek = (offset = 0): Token => tokens[Math.min(position + offset, tokens.length - 1)]!;
  const next = (): Token => tokens[Math.min(position++, tokens.length - 1)]!;
  const is = (token: Token, value: string) => token.kind === "punct" && token.value === value;
  const node = (location: SourceLocation) => {
    nodes += 1;
    if (nodes > COLLECTION_SCHEMA_LIMITS["syntax-nodes"]) {
      throw schemaFailure("budget-exceeded", `The schema exceeds ${COLLECTION_SCHEMA_LIMITS["syntax-nodes"]} syntax nodes`, location, "syntax-nodes");
    }
  };
  const unexpected = (token: Token): never => {
    throw schemaFailure("syntax-error", token.kind === "eof" ? "Unexpected end of schema" : `Unexpected ${JSON.stringify(token.value)}`, token.location);
  };
  const unsupported = (token: Token, what: string): never => {
    throw schemaFailure("unsupported-syntax", `${what} is outside the collection schema profile`, token.location);
  };

  while (peek().kind !== "eof") {
    const name = next();
    if (name.kind !== "ident") unexpected(name);
    if (rules.length >= COLLECTION_SCHEMA_LIMITS.rules) {
      throw schemaFailure("budget-exceeded", `The schema exceeds ${COLLECTION_SCHEMA_LIMITS.rules} rules`, name.location, "rules");
    }
    const assign = next();
    if (is(assign, "<")) unsupported(assign, "A generic rule");
    if (is(assign, "/=") || is(assign, "//=")) unsupported(assign, "A choice extension");
    if (!is(assign, "=")) unexpected(assign);
    if (name.value.startsWith("overstory-")) {
      if (!METADATA_RULES.has(name.value)) {
        throw schemaFailure("reserved-rule", `${name.value} is not an Overstory metadata rule`, name.location);
      }
      rules.push({ name: name.value, location: name.location, metadata: metadata() });
      continue;
    }
    if (is(peek(), "(")) unsupported(peek(), "A group rule");
    rules.push({ name: name.value, location: name.location, type: type(0) });
    const after = peek();
    if (after.kind !== "eof" && after.kind !== "ident") unexpected(after);
  }
  return { rules, nodes };

  function metadata(): MetadataValue {
    const start = next();
    let value: MetadataValue | null = null;
    if (start.kind === "number" && start.numberKind === "int") {
      value = { kind: "int", value: start.number!, location: start.location };
    } else if (start.kind === "text") {
      value = { kind: "text", value: start.value, location: start.location };
    } else if (is(start, "[")) {
      const values: string[] = [];
      let valid = true;
      while (!is(peek(), "]")) {
        const item = next();
        if (item.kind !== "text") { valid = false; break; }
        values.push(item.value);
        if (is(peek(), ",")) next();
        else if (!is(peek(), "]")) { valid = false; break; }
      }
      if (valid) {
        next();
        value = { kind: "text-array", values, location: start.location };
      }
    }
    const after = peek();
    if (!value || is(after, "/") || is(after, "..") || is(after, "...")) {
      throw schemaFailure("invalid-metadata", "Overstory metadata rules take one literal value", start.location);
    }
    return value;
  }

  function type(depth: number): ChoiceNode {
    const start = peek();
    node(start.location);
    const alternatives = [type1(depth)];
    while (is(peek(), "/")) {
      const separator = next();
      if (alternatives.length >= COLLECTION_SCHEMA_LIMITS["choice-alternatives"]) {
        throw schemaFailure("budget-exceeded", `A choice exceeds ${COLLECTION_SCHEMA_LIMITS["choice-alternatives"]} alternatives`, separator.location, "choice-alternatives");
      }
      alternatives.push(type1(depth));
    }
    if (is(peek(), "//")) unsupported(peek(), "A group choice");
    return { kind: "choice", alternatives, location: start.location };
  }

  function type1(depth: number): TypeNode {
    const low = type2(depth);
    const operator = peek();
    if (!is(operator, "..") && !is(operator, "...")) return low;
    next();
    const high = type2(depth);
    if (low.kind !== "number" || high.kind !== "number") {
      throw schemaFailure("invalid-range", "Range bounds must be numeric literals", low.location);
    }
    if (low.numberKind !== high.numberKind) {
      throw schemaFailure("invalid-range", "Range bounds must both be integer literals or both be decimal literals", low.location);
    }
    if (low.value > high.value) throw schemaFailure("invalid-range", "A range's low bound exceeds its high bound", low.location);
    return {
      kind: "range",
      low: low.value,
      high: high.value,
      inclusive: operator.value === "..",
      integer: low.numberKind === "int",
      location: low.location,
    };
  }

  function type2(depth: number): TypeNode {
    const token = next();
    node(token.location);
    if (token.kind === "number") {
      return { kind: "number", value: token.number!, numberKind: token.numberKind!, location: token.location };
    }
    if (token.kind === "text") return { kind: "text", value: token.value, location: token.location };
    if (token.kind === "ident") {
      if (is(peek(), "<")) unsupported(peek(), "A generic argument");
      return { kind: "name", name: token.value, location: token.location };
    }
    if (is(token, "{")) return map(token, depth + 1);
    if (is(token, "[")) return array(token, depth + 1);
    if (is(token, "(")) unsupported(token, "A parenthesized type or group");
    return unexpected(token);
  }

  function nest(token: Token, depth: number): void {
    if (depth > COLLECTION_SCHEMA_LIMITS["nesting-depth"]) {
      throw schemaFailure("budget-exceeded", `Types nest deeper than ${COLLECTION_SCHEMA_LIMITS["nesting-depth"]} levels`, token.location, "nesting-depth");
    }
  }

  function map(start: Token, depth: number): TypeNode {
    nest(start, depth);
    const members: MemberNode[] = [];
    const names = new Set<string>();
    let open = false;
    while (!is(peek(), "}")) {
      let token = peek();
      if (token.kind === "eof") unexpected(token);
      if (openEntry()) {
        if (open) throw schemaFailure("duplicate-member", "The map declares * tstr => any more than once", token.location);
        next(); next(); next(); next();
        node(token.location);
        open = true;
        if (!is(peek(), ",") && !is(peek(), "}")) unsupported(peek(), "A * tstr => any entry followed by anything but , or }");
        if (is(peek(), ",")) next();
        continue;
      }
      let optional = false;
      if (is(token, "?")) {
        next();
        optional = true;
        token = peek();
      }
      if (is(token, "*") || is(token, "+")) unsupported(token, "A map occurrence indicator other than ?");
      if (token.kind === "number") unsupported(token, "A numeric map key or occurrence bound");
      if (token.kind !== "ident" && token.kind !== "text") {
        if (token.kind === "punct" && ["{", "[", "(", "~", "&"].includes(token.value)) unsupported(token, "A group entry");
        unexpected(token);
      }
      const separator = peek(1);
      if (is(separator, "=>")) unsupported(separator, "A => member key");
      if (!is(separator, ":")) unsupported(token, "A group entry");
      next();
      next();
      node(token.location);
      if (members.length >= COLLECTION_SCHEMA_LIMITS["map-members"]) {
        throw schemaFailure("budget-exceeded", `A map exceeds ${COLLECTION_SCHEMA_LIMITS["map-members"]} members`, token.location, "map-members");
      }
      if (names.has(token.value)) throw schemaFailure("duplicate-member", `Member ${JSON.stringify(token.value)} is declared twice`, token.location);
      names.add(token.value);
      members.push({ name: token.value, optional, type: type(depth), location: token.location });
      if (is(peek(), ",")) next();
    }
    next();
    return { kind: "map", members, open, location: start.location };
  }

  /** The one supported computed-key entry: exactly `* tstr => any` (or `* text => any`). */
  function openEntry(): boolean {
    const key = peek(1);
    const value = peek(3);
    return is(peek(), "*") && key.kind === "ident" && (key.value === "tstr" || key.value === "text")
      && is(peek(2), "=>") && value.kind === "ident" && value.value === "any";
  }

  function array(open: Token, depth: number): TypeNode {
    nest(open, depth);
    const occurrence = next();
    if (!is(occurrence, "*") && !is(occurrence, "+")) {
      if (occurrence.kind === "eof") unexpected(occurrence);
      unsupported(occurrence, "An array other than [* type] or [+ type]");
    }
    const first = peek();
    if ((first.kind === "ident" || first.kind === "text") && (is(peek(1), ":") || is(peek(1), "=>"))) {
      unsupported(first, "An array member key");
    }
    const element = type(depth);
    if (is(peek(), ",")) next();
    const close = next();
    if (!is(close, "]")) {
      if (close.kind === "eof") unexpected(close);
      unsupported(close, "An array with more than one entry");
    }
    return { kind: "array", element, nonEmpty: occurrence.value === "+", location: open.location };
  }
}
