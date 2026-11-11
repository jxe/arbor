// The syntax tree of a VAD file: a `.vad` file, a page's view blocks, or a collection's
// schema.vad. Positions are 1-based lines and columns, as in @ovst/usl.

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
  | "in" | "∈" | "excludes" | "∉"
  | "and" | "or" | "??";

export type Expr =
  | { kind: "name"; name: string; span: Span }
  | { kind: "literal"; value: string | number | boolean | null; span: Span }
  /** `16ms`, `1s`, `5m`, `2h`, `7d`. */
  | { kind: "duration"; text: string; milliseconds: number; span: Span }
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
  | { kind: "comprehension"; binding: Binding; where: Expr[]; span: Span }
  /** `name ~attr(…)`: a name with attributes, only inside a schema attribute's arguments (`~views`). */
  | { kind: "annotated"; value: Expr; attrs: SchemaAttribute[]; span: Span };

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
  | { kind: "where" | "if"; conditions: Expr[] }
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

export type ViewLine = (
  | { kind: "state" | "keep"; name: string; nameSpan: Span; value: Expr; span: Span }
  | { kind: "on"; event: string; detail?: string; action: Expr; span: Span }
  | { kind: "every"; text: string; milliseconds: number; action: Expr; span: Span }
) & {
  /** Comment lines above the line. */
  leading?: string[];
  /** Comments on the line or inside it. */
  comments: string[];
};

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
  /** A data view's shape (`view Name(params) { … }`), in place of `lines` and `body`. */
  data?: DataRecord;
  span: Span;
}

/** The braces of a data view: the shape of the JSON it returns. */
export interface DataRecord {
  entries: DataEntry[];
  span: Span;
}

interface DataEntryBase {
  span: Span;
  /** On a line of its own after the previous entry, rather than after a comma. */
  newline: boolean;
  blankBefore: boolean;
  /** Comments after the entry on its line. */
  comments: string[];
}

export type DataEntry = DataEntryBase & (
  /** `key: expression`. */
  | { kind: "value"; key: string; keySpan: Span; value: Expr }
  /**
   * `key: { … }`, followed by the attributes an element takes (`for`, `where`, `orderBy`,
   * `limit`, `if`): a record about the same row, a list of one per match, or a record
   * that holds only when its conditions do.
   */
  | { kind: "record"; key: string; keySpan: Span; record: DataRecord; attributes: Attribute[] }
  /** `field`, or `field { … }` to follow a relationship. */
  | { kind: "field"; name: string; nameSpan: Span; record?: DataRecord }
  | { kind: "comment"; text: string }
);

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
  /** Conditions, one per line, joined by *and*, and comment lines. */
  body: RuleLine[];
  span: Span;
}

export type RuleLine =
  | { kind: "condition"; condition: Expr; comments: string[]; blankBefore: boolean }
  | { kind: "comment"; text: string; blankBefore: boolean };

export interface MutationDecl {
  kind: "mutation";
  name: string;
  nameSpan: Span;
  params: Param[];
  /** `for Model.op`: the mutation is that model's row action. */
  rowAction?: { model: string; op: string; span: Span };
  body: Line[];
  span: Span;
}

export interface CommentDecl {
  kind: "comment";
  text: string;
  span: Span;
}

export type Declaration =
  | UseDecl | ViewDecl | BlockElementDecl | RuleDecl | MutationDecl | CommentDecl
  | TableDecl | EnumDecl | ReDecl | ConnectionDecl;

export interface DeclarationEntry {
  decl: Declaration;
  blankBefore: boolean;
  /** A comment after the declaration's first line, on that line. */
  trailing?: string;
}

export interface ViewFile {
  declarations: DeclarationEntry[];
}

// ---------------------------------------------------------------- tables

/** `@name(args)` (storage) or `~name(args)` (presentation). */
export interface SchemaAttribute {
  sigil: "@" | "~";
  name: string;
  /** `null` when written without parentheses. */
  args: Expr[] | null;
  span: Span;
}

interface MemberBase {
  span: Span;
  blankBefore: boolean;
  /** Comments on the member's line or inside it. */
  comments: string[];
}

export type TableMember = MemberBase & (
  | {
      kind: "field"; name: string; modifiers: string[]; type: string; arity: TypeRef["arity"];
      default?: Expr; attrs: SchemaAttribute[];
    }
  | {
      kind: "end"; ordered: boolean; table: string; field: string; arity: TypeRef["arity"];
      as?: string; attrs: SchemaAttribute[];
    }
  /** A table-level attribute on a line of its own. */
  | { kind: "attribute"; attr: SchemaAttribute }
  /** An enum value or seed row: `Name`, `"Some name"`, with a record of its fields. */
  | { kind: "value"; name: string; quoted: boolean; values?: Extract<Expr, { kind: "record" }>; attrs: SchemaAttribute[] }
  | { kind: "seed"; rows: TableMember[] }
  /** In a `re` block: a field or value named again, with attributes. */
  | { kind: "mention"; name: string; attrs: SchemaAttribute[] }
  | { kind: "comment"; text: string }
);

export interface TableDecl {
  kind: "table";
  /** `table`, `main table`, `my table` or `session table`. */
  tableKind: "data" | "main" | "my" | "session";
  name: string;
  nameSpan: Span;
  key?: { name: string; span: Span }[];
  members: TableMember[];
  span: Span;
}

export interface EnumDecl {
  kind: "enum";
  name: string;
  nameSpan: Span;
  members: TableMember[];
  span: Span;
}

export interface ReDecl {
  kind: "re";
  name: string;
  nameSpan: Span;
  members: TableMember[];
  span: Span;
}

export type EndMember = Extract<TableMember, { kind: "end" }>;

/** `A.x <-> B.y`. */
export interface ConnectionDecl {
  kind: "connection";
  a: EndMember;
  b: EndMember;
  span: Span;
}

// ---------------------------------------------------------------- mutation lines

export const ERROR_CODES = ["unauthorized", "forbidden", "missing", "invalid", "conflict"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type LineBody =
  | { kind: "if"; condition: Expr; body: Line[] }
  | { kind: "for"; bindings: Binding[]; where: Expr[]; body: Line[] }
  | { kind: "error"; code: ErrorCode; message?: string }
  /**
   * `Table(…)`, `not Table(…)` or `let name = Table(…)`: a row fact; or `other(…)`, another
   * mutation's facts. Which one a call is depends on what its name names.
   */
  | { kind: "fact"; negated: boolean; name?: string; nameSpan?: Span; call: Extract<Expr, { kind: "call" }> }
  /** `row.field = value`. */
  | { kind: "set"; target: Extract<Expr, { kind: "field" }>; value: Expr }
  | { kind: "comment"; text: string };

export type Line = LineBody & {
  span: Span;
  blankBefore: boolean;
  /** Comments inside the line or after it. */
  comments: string[];
};
