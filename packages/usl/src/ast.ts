// The syntax tree of an Ultimate Schema Language (.usl) file.

export interface Position {
  line: number;
  column: number;
}

/** `[]` is many, `?` is at most one, nothing is exactly one. */
export type Arity = "one" | "optional" | "many";

export interface Attribute {
  name: string;
  args: Expr[];
  at: Position;
}

/** `name Type`: a field of the model. */
export interface FieldDecl {
  kind: "field";
  name: string;
  type: string;
  arity: Arity;
  attrs: Attribute[];
  at: Position;
}

/** `Model.field`: an end of a connection, declaring the field that model gains. */
export interface EndDecl {
  kind: "end";
  model: string;
  field: string;
  arity: Arity;
  attrs: Attribute[];
  at: Position;
}

/** `@@name(args)` on a model. */
export interface ModelAttribute {
  kind: "modelAttribute";
  name: string;
  args: Expr[];
  at: Position;
}

/** `@@fixed { ... }` or `@@seed { ... }`. */
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

export type Member = FieldDecl | EndDecl | ModelAttribute | RowsBlock;

export interface ModelDecl {
  kind: "model";
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

export type Declaration = ModelDecl | ConnectionDecl | ViewDecl;

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
