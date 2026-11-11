// A collection's tables (spec 1.5 §2): the table, enum, connection and `re` declarations
// of a schema.beetle, checked by @ovst/usl's checker. They are translated to its syntax tree,
// so the layout, relationships, records, setup SQL and fingerprints built on its result
// are Beetle's too. Defaults and state tables stay here: neither is part of the data layer.

import { checkUsl, type CheckResult } from "@ovst/usl";
import type * as Usl from "@ovst/usl";
import type { Diagnostic, EnumDecl, Expr, ReDecl, SchemaAttribute, Span, TableDecl, TableMember, ViewFile } from "./ast.ts";
import { parseView } from "./parse.ts";

export interface SchemaResult extends CheckResult {
  /** Field defaults by table, then field (§2.1). */
  defaults: Record<string, Record<string, Expr>>;
}

const at = (span: Span): Usl.Position => ({ line: span.line, column: span.column });

function arg(e: Expr): Usl.Expr {
  const position = at(e.span);
  switch (e.kind) {
    case "name": return { kind: "ident", name: e.name, attrs: [], at: position };
    case "literal":
      if (typeof e.value === "string") return { kind: "string", value: e.value, at: position };
      if (typeof e.value === "number") return { kind: "number", value: e.value, at: position };
      return { kind: "ident", name: String(e.value), attrs: [], at: position };
    case "list": return { kind: "list", items: e.items.map(arg), at: position };
    case "annotated": {
      const value = arg(e.value);
      return value.kind === "ident" ? { ...value, attrs: attributes(e.attrs) } : value;
    }
    case "record": return { kind: "object", entries: e.entries.map((x) => ({ key: x.name, value: arg(x.value), at: at(x.nameSpan) })), at: position };
    default: return { kind: "string", value: "", at: position };
  }
}

/**
 * A row's color is data (spec 1.5 §2): a Text field named `color`, on a table's rows or in
 * an enum value's record. The list views built on @ovst/usl read it as that checker's
 * `~color`, so the translation adds that attribute; Beetle itself has no `~` attributes
 * except `~views`, which stays until lists are drawn from Beetle views.
 */
const COLOR = "color";

function colorAttribute(at: Usl.Position, value?: string): Usl.Attribute {
  return { sigil: "~", name: COLOR, args: value === undefined ? [] : [{ kind: "string", value, at }], at };
}

function isColorField(m: TableMember): boolean {
  return m.kind === "field" && m.name === COLOR && m.type === "Text" && m.arity !== "many";
}

/** `~x` written in a schema: only `~views` is left of Beetle's presentation attributes. */
function presentationAttributes(file: ViewFile): Diagnostic[] {
  const found: Diagnostic[] = [];
  const check = (attrs: SchemaAttribute[]) => {
    for (const a of attrs) {
      if (a.sigil === "~" && a.name !== "views") {
        found.push({
          code: "presentation-attribute",
          message: a.name === COLOR
            ? "A color is data: give the table or enum a `color Text` field, and enum values a record with their color"
            : `\`~${a.name}\` is not Beetle; presentation belongs in views`,
          ...a.span,
        });
      }
    }
  };
  const walk = (members: TableMember[]) => {
    for (const m of members) {
      if (m.kind === "field" || m.kind === "end" || m.kind === "value" || m.kind === "mention") check(m.attrs);
      else if (m.kind === "attribute") check([m.attr]);
      else if (m.kind === "seed") walk(m.rows);
    }
  };
  for (const { decl } of file.declarations) {
    if (decl.kind === "table" || decl.kind === "enum" || decl.kind === "re") walk(decl.members);
    else if (decl.kind === "connection") { check(decl.a.attrs); check(decl.b.attrs); }
  }
  return found;
}

function attributes(attrs: SchemaAttribute[]): Usl.Attribute[] {
  return attrs.map((a) => ({ sigil: a.sigil, name: a.name, args: (a.args ?? []).map(arg), at: at(a.span) }));
}

function row(member: Extract<TableMember, { kind: "value" }>): Usl.Row {
  return {
    name: member.name,
    values: (member.values?.entries ?? []).map((x) => ({ key: x.name, value: arg(x.value), at: at(x.nameSpan) })),
    attrs: attributes(member.attrs),
    at: at(member.span),
  };
}

function members(list: TableMember[], context: "table" | "enum" | "re"): Usl.Member[] {
  const result: Usl.Member[] = [];
  const values: Usl.Row[] = [];
  let valuesAt: Usl.Position | null = null;
  for (const m of list) {
    switch (m.kind) {
      case "field":
        result.push({
          kind: "field", name: m.name, modifiers: m.modifiers.map((name) => ({ name, at: at(m.span) })), type: m.type,
          arity: m.arity, attrs: [...attributes(m.attrs), ...(context === "table" && isColorField(m) && !m.attrs.some((a) => a.name === COLOR) ? [colorAttribute(at(m.span))] : [])],
          at: at(m.span),
        });
        break;
      case "end":
        result.push({
          kind: "end", model: m.table, field: m.field, arity: m.arity, ordered: m.ordered ? at(m.span) : null,
          as: m.as ? { name: m.as, at: at(m.span) } : null, attrs: attributes(m.attrs), at: at(m.span),
        });
        break;
      case "attribute":
        result.push({ kind: "modelAttribute", sigil: m.attr.sigil, name: m.attr.name, args: (m.attr.args ?? []).map(arg), at: at(m.attr.span) });
        break;
      case "value": {
        valuesAt ??= at(m.span);
        const value = row(m);
        const color = list.some(isColorField) ? m.values?.entries.find((e) => e.name === COLOR)?.value : undefined;
        if (color?.kind === "literal" && typeof color.value === "string" && !value.attrs.some((a) => a.name === COLOR)) value.attrs.push(colorAttribute(at(m.span), color.value));
        values.push(value);
        break;
      }
      case "seed":
        result.push({ kind: "rows", mode: "seed", rows: m.rows.flatMap((r) => (r.kind === "value" ? [row(r)] : [])), at: at(m.span) });
        break;
      case "mention":
        result.push({ kind: "mention", name: m.name, attrs: attributes(m.attrs), at: at(m.span) });
        break;
      case "comment":
        break;
    }
  }
  if (context === "enum") result.push({ kind: "rows", mode: "fixed", rows: values, at: valuesAt ?? { line: 1, column: 1 } });
  return result;
}

/** The data tables a file declares, as @ovst/usl's syntax tree, and where they may not be. */
export function uslFileOf(file: ViewFile, isSchema: boolean): { usl: Usl.SchemaFile; diagnostics: Diagnostic[]; defaults: SchemaResult["defaults"] } {
  const declarations: Usl.Declaration[] = [];
  const diagnostics: Diagnostic[] = [];
  const defaults: SchemaResult["defaults"] = {};
  for (const { decl } of file.declarations) {
    if (decl.kind === "table" && (decl.tableKind === "my" || decl.tableKind === "session")) continue;
    const isData = decl.kind === "table" || decl.kind === "connection" || decl.kind === "re";
    if (isData && !isSchema) {
      const span = decl.kind === "connection" ? decl.span : decl.nameSpan;
      diagnostics.push({
        code: "data-table-outside-schema",
        message: "A collection's data tables, connections and re blocks are declared only in its schema.beetle; declare state here as `my table` or `session table`",
        ...span,
      });
      continue;
    }
    switch (decl.kind) {
      case "table": {
        const table = decl as TableDecl;
        for (const m of table.members) {
          if (m.kind === "field" && m.default) (defaults[table.name] ??= {})[m.name] = m.default;
        }
        declarations.push({
          kind: "model", form: "model", name: table.name, main: table.tableKind === "main" ? at(table.span) : null,
          key: table.key ? { fields: table.key.map((k) => ({ name: k.name, at: at(k.span) })), at: at(table.key[0]!.span) } : null,
          members: members(table.members, "table"), at: at(table.nameSpan),
        });
        break;
      }
      case "enum": {
        if (!isSchema) break; // a file's own enums are checked with its state tables
        const e = decl as EnumDecl;
        declarations.push({ kind: "model", form: "enum", name: e.name, main: null, key: null, members: members(e.members, "enum"), at: at(e.nameSpan) });
        break;
      }
      case "re": {
        const re = decl as ReDecl;
        declarations.push({ kind: "re", name: re.name, members: members(re.members, "re"), at: at(re.nameSpan) });
        break;
      }
      case "connection": {
        const end = (m: typeof decl.a): Usl.EndDecl => ({
          kind: "end", model: m.table, field: m.field, arity: m.arity, ordered: m.ordered ? at(m.span) : null,
          as: m.as ? { name: m.as, at: at(m.span) } : null, attrs: attributes(m.attrs), at: at(m.span),
        });
        declarations.push({ kind: "connection", spelling: "arrow", members: [end(decl.a), end(decl.b)], at: at(decl.span) });
        break;
      }
      default:
        break;
    }
  }
  return { usl: { declarations }, diagnostics, defaults };
}

/** Checks a schema.beetle's tables. Its views, rules and mutations are checked by checkView. */
export function compileSchema(text: string): SchemaResult {
  const parsed = parseView(text);
  const { usl, diagnostics, defaults } = uslFileOf(parsed.file, true);
  const result = checkUsl(usl);
  return { ...result, diagnostics: [...parsed.diagnostics, ...presentationAttributes(parsed.file), ...diagnostics, ...result.diagnostics], defaults };
}
