// The syntax tree of a view source: a `.view` file, or a page's view blocks.
// Positions are 1-based lines and columns, as in @ovst/usl.

export interface Span {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface Diagnostic {
  code: string;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  /** The source the diagnostic is in, when it isn't the source being checked. */
  path?: string;
}

// ---------------------------------------------------------------- expressions

export type BinaryOperator =
  | "*" | "/" | "+" | "-"
  | "==" | "!=" | "<" | "<=" | ">" | ">="
  | "in" | "not in"
  | "and" | "or" | "??";

export type Expr =
  | { kind: "name"; name: string; span: Span }
  | { kind: "literal"; value: string | number | boolean | null; span: Span }
  /** Quoted attribute text, which may hold `{expression}`. */
  | { kind: "template"; parts: TextPart[]; span: Span }
  | { kind: "list"; items: Expr[]; span: Span }
  | { kind: "record"; entries: RecordEntry[]; span: Span }
  | { kind: "field"; object: Expr; name: string; nameSpan: Span; span: Span }
  | { kind: "call"; callee: string; calleeSpan: Span; args: Arg[]; span: Span }
  | { kind: "unary"; operator: "not" | "-"; operand: Expr; span: Span }
  | { kind: "binary"; operator: BinaryOperator; left: Expr; right: Expr; span: Span }
  | { kind: "choice"; test: Expr; then: Expr; otherwise: Expr; span: Span }
  | { kind: "element"; element: Element; span: Span }
  /** `name in source where …`, the argument of `count(…)` or `exists(…)`. */
  | { kind: "comprehension"; binding: Binding; where: Expr[]; span: Span };

export type TextPart = string | Expr;

export interface RecordEntry {
  name: string;
  nameSpan: Span;
  value: Expr;
}

export interface Arg {
  /** Set for a named argument, `name: value`. */
  name?: string;
  nameSpan?: Span;
  value: Expr;
}

/** `name in source`, in `for` and in comprehensions. */
export interface Binding {
  name: string;
  nameSpan: Span;
  source: Expr;
}

export interface OrderTerm {
  value: Expr;
  desc: boolean;
}

// ---------------------------------------------------------------- elements

export type AttributeValue =
  | { kind: "expr"; expr: Expr }
  | { kind: "text"; text: Extract<Expr, { kind: "template" }> }
  | { kind: "bare" }
  | { kind: "for"; bindings: Binding[] }
  | { kind: "where"; conditions: Expr[] }
  | { kind: "orderBy"; terms: OrderTerm[] };

export interface Attribute {
  name: string;
  nameSpan: Span;
  value: AttributeValue;
  span: Span;
}

export interface Element {
  type: string;
  typeSpan: Span;
  attributes: Attribute[];
  /** `null` for a self-closing element. */
  children: Child[] | null;
  span: Span;
  /** Comments written inside the opening tag; the formatter prints them before the element. */
  comments: string[];
}

export type Child =
  | { kind: "element"; element: Element; blankBefore: boolean }
  | { kind: "text"; parts: TextPart[]; span: Span; blankBefore: boolean }
  | { kind: "comment"; text: string; span: Span; blankBefore: boolean };

// ---------------------------------------------------------------- declarations

export interface TypeRef {
  name: string;
  arity: "one" | "optional" | "many";
  span: Span;
}

export interface Param {
  name: string;
  type?: TypeRef;
  span: Span;
}

export type ViewLine =
  | { kind: "state" | "keep"; name: string; nameSpan: Span; value: Expr; span: Span; comments: string[] }
  | { kind: "on"; event: string; detail?: string; action: Expr; span: Span; comments: string[] }
  | { kind: "every"; text: string; milliseconds: number; action: Expr; span: Span; comments: string[] };

export interface UseDecl {
  kind: "use";
  path: string;
  /** `use "…" (A, B as C, view as D)`: only these names, some renamed. */
  picks?: { name: string; as?: string; span: Span }[];
  span: Span;
}

export interface ViewDecl {
  kind: "view";
  /** `null` for an unnamed view. */
  name: string | null;
  nameSpan: Span;
  params: Param[];
  lines: ViewLine[];
  body: Element | null;
  span: Span;
}

/** An element written on its own in a view block: an unnamed view with no parameters. */
export interface BlockElementDecl {
  kind: "element";
  element: Element;
  span: Span;
}

export interface RuleDecl {
  kind: "rule";
  name: string;
  nameSpan: Span;
  params: Param[];
  body: Expr;
  span: Span;
}

export interface MutationDecl {
  kind: "mutation";
  name: string;
  nameSpan: Span;
  params: Param[];
  /** `for Model.op`: the mutation is that model's row action. */
  rowAction?: { model: string; op: string; span: Span };
  body: Statement[];
  span: Span;
}

export interface CommentDecl {
  kind: "comment";
  text: string;
  span: Span;
}

export type Declaration = UseDecl | ViewDecl | BlockElementDecl | RuleDecl | MutationDecl | CommentDecl;

export interface DeclarationEntry {
  decl: Declaration;
  blankBefore: boolean;
  /** A comment after the declaration's first line, on that line. */
  trailing?: string;
}

export interface ViewFile {
  declarations: DeclarationEntry[];
}

// ---------------------------------------------------------------- mutation statements

export interface StatementSuffix {
  for?: Binding[];
  where?: Expr[];
  orderBy?: OrderTerm[];
}

export type StatementBody =
  | { kind: "require"; condition: Expr; code: string; message?: string }
  | { kind: "insert"; name?: string; nameSpan?: Span; model: string; modelSpan: Span; fields: Extract<Expr, { kind: "record" }> }
  | { kind: "update"; target: Expr; fields: Extract<Expr, { kind: "record" }> }
  | { kind: "delete"; target: Expr }
  | {
      kind: "upsert"; model: string; modelSpan: Span;
      key: Extract<Expr, { kind: "record" }>;
      create: Extract<Expr, { kind: "record" }>;
      update: Extract<Expr, { kind: "record" }>;
    }
  | { kind: "append" | "remove"; item: Expr; path: Expr }
  | { kind: "reorder"; path: Expr; to: Expr }
  | { kind: "when"; condition: Expr; body: Statement[] }
  | { kind: "do"; calls: Extract<Expr, { kind: "call" }>[] }
  | { kind: "return"; value: Extract<Expr, { kind: "record" }> }
  | { kind: "comment"; text: string };

export type Statement = StatementBody & StatementSuffix & {
  span: Span;
  blankBefore: boolean;
  /** Comments inside the statement or after it on its lines. */
  comments: string[];
};
