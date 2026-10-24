// The syntax tree of an Ultimate Schema Language (.usl) file.

export interface Position {
  line: number;
  column: number;
}

/** `[]` is many, `?` is at most one, nothing is exactly one. */
export type Arity = "one" | "optional" | "many";

/** `@` marks storage and `~` presentation; the model layer is keywords. */
export type Sigil = "@" | "~";

export interface Attribute {
  sigil: Sigil;
  name: string;
  args: Expr[];
  at: Position;
}

/** A keyword before a field's type: `ordered`, `unique` or `path`. */
export interface Modifier {
  name: string;
  at: Position;
}

/** `name [modifiers] Type`: a field of the model. */
export interface FieldDecl {
  kind: "field";
  name: string;
  modifiers: Modifier[];
  type: string;
  arity: Arity;
  attrs: Attribute[];
  at: Position;
}

/** `[ordered] Model.field [as name]`: an end of a connection, declaring the field that model gains. */
export interface EndDecl {
  kind: "end";
  model: string;
  field: string;
  arity: Arity;
  /** Where `ordered` was written before the end, if it was. */
  ordered: Position | null;
  /** `as name`: the field this end gets in a connection model. */
  as: { name: string; at: Position } | null;
  attrs: Attribute[];
  at: Position;
}

/** An attribute that starts an item in a block: `@table(...)`, `~views(...)`. */
export interface ModelAttribute {
  kind: "modelAttribute";
  sigil: Sigil;
  name: string;
  args: Expr[];
  at: Position;
}

/** An enum's values (`fixed`) or a model's `seed { ... }` rows. */
export interface RowsBlock {
  kind: "rows";
  mode: "fixed" | "seed";
  rows: Row[];
  at: Position;
}

export interface Row {
  name: string;
  values: ObjectEntry[];
  attrs: Attribute[];
  at: Position;
}

/** In a `re` block: a field or enum value named again, with attributes. */
export interface Mention {
  kind: "mention";
  name: string;
  attrs: Attribute[];
  at: Position;
}

export type Member = FieldDecl | EndDecl | ModelAttribute | RowsBlock | Mention;

/** `[main] model Name [(key, ...)] { ... }` or `enum Name { ... }`. */
export interface ModelDecl {
  kind: "model";
  form: "model" | "enum";
  name: string;
  /** Where `main` was written, if it was. */
  main: Position | null;
  /** The header key, `(list, id)`, if there is one. */
  key: { fields: { name: string; at: Position }[]; at: Position } | null;
  members: Member[];
  at: Position;
}

/** `re Name { ... }`: attributes for a model or enum declared elsewhere. */
export interface ReDecl {
  kind: "re";
  name: string;
  members: Member[];
  at: Position;
}

/** An unnamed connection: `{ A.x, B.y }` or `A.x <-> B.y`. */
export interface ConnectionDecl {
  kind: "connection";
  spelling: "braces" | "arrow";
  members: Member[];
  at: Position;
}

/** `view "Label" of ../Path/Model { options }`: a page presenting a collection kept elsewhere. */
export interface ViewDecl {
  kind: "view";
  label: string;
  of: string;
  options: ObjectEntry[];
  at: Position;
}

export type Declaration = ModelDecl | ReDecl | ConnectionDecl | ViewDecl;

export interface SchemaFile {
  declarations: Declaration[];
}

export interface ObjectEntry {
  key: string;
  value: Expr;
  at: Position;
}

export type Expr =
  | { kind: "string"; value: string; at: Position }
  | { kind: "number"; value: number; at: Position }
  | { kind: "ident"; name: string; attrs: Attribute[]; at: Position }
  | { kind: "list"; items: Expr[]; at: Position }
  | { kind: "object"; entries: ObjectEntry[]; at: Position };

export interface Diagnostic {
  code: string;
  message: string;
  line: number;
  column: number;
}
