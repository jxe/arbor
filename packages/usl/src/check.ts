// Checks a parsed .usl file against the language's invariants and resolves
// each model's full set of fields: its own, those its connections give it,
// and, for a connection model, the ends that key it. `re` blocks are merged
// into the models they annotate first.

import { LayoutError, layoutOf } from "./layout.ts";
import type {
  Arity,
  Attribute,
  Diagnostic,
  EndDecl,
  Expr,
  FieldDecl,
  Member,
  ModelAttribute,
  ModelDecl,
  ObjectEntry,
  Position,
  RowsBlock,
  SchemaFile,
  Sigil,
} from "./ast.ts";

export const VALUE_TYPES = ["Text", "Markdown", "Int", "Number", "Bool", "Date"] as const;
export const BUILTIN_MODELS = ["Person"] as const;
export const IMPLICIT_FIELDS = ["id", "created", "modified"] as const;

// Each attribute name belongs to one layer (its sigil) and one level.
const FIELD_ATTRIBUTES: Record<string, Sigil> = { column: "@", fold: "@", body: "@", title: "@", color: "~" };
const MODEL_ATTRIBUTES: Record<string, Sigil> = { table: "@", index: "@", fold: "@", views: "~" };
const VALUE_ATTRIBUTES: Record<string, Sigil> = { stored: "@", color: "~" };
const MODIFIERS = ["ordered", "unique", "path"];
const VIEW_OPTIONS = ["label", "line", "group", "sort"];
// Presentation of one item in a view's line: `~bullet` draws an enum value as
// the row's colored bullet, `~summary` shows a many-valued field as a count,
// `~label("lead")` names one of its members, and `~sort(field)` lists a
// connection's members by a field of theirs.
const LINE_ATTRIBUTES = ["bullet", "summary", "label", "sort"];
const COLOR = /^#[0-9a-fA-F]{6}$/;

export interface ResolvedField {
  name: string;
  /** A value type or a model name. */
  type: string;
  arity: Arity;
  /** declared: written in the model. connection: gained from a connection. end: one of this connection model's ends. */
  origin: "declared" | "connection" | "end";
  ordered: boolean;
  unique: boolean;
  /** Holds the row's color (`~color`). */
  color: boolean;
  /** The stored column's name when it differs from the field's (`@column("…")`). */
  column?: string;
}

/** One end of a connection: the field `model` gains, and (for a connection model) the field the end gets there. */
export interface ResolvedEnd {
  model: string;
  field: string;
  arity: Arity;
  ordered: boolean;
  /** The field this end gets in its connection model (`as`, or the model's name in lower case). */
  as: string;
  /** `@column("…")` on the end. */
  column?: string;
  /** `@fold`: in data files, this end's rows hold the connection as an array. */
  fold: boolean;
}

/** A value written in the schema: a string, number, boolean, or a list of them. */
export type RowValue = string | number | boolean | RowValue[];

/** Where a connection's data lives. */
export type Storage =
  | { kind: "column"; on: string; field: string }
  | { kind: "array"; on: string; field: string; sqlite: "join table" }
  | { kind: "table" }
  | { kind: "fold"; into: string };

export interface ResolvedModel {
  name: string;
  /** `main model`: its rows are the collection folder's own children. */
  main: boolean;
  /** The stored table's name when it differs from the model's (`@table("…")`). */
  table?: string;
  /** `fixed` rows are an enum's values; `seed` rows are data with defaults; `data` is an ordinary collection. */
  rows: "fixed" | "seed" | "data";
  /** The fields that identify a row: its ends for a connection model, the header key, otherwise `id` (or the value's name, for an enum). */
  key: string[];
  fields: ResolvedField[];
  storage?: Storage;
  /** The field whose value is each row's path segment in an Overstory tree (`path`); otherwise its key is. */
  path?: string;
  /** In Markdown row files, the field written as the body (`@body`, else a `Markdown` field named `content`). */
  body?: string;
  /** In Markdown row files, the field written as the page title (`@title`, else a `Text` field named `title`). */
  title?: string;
  /** A connection model's ends. */
  ends: ResolvedEnd[];
  /** An enum's values or `seed` rows, with their values, an enum value's `~color` and its `@stored` text. */
  schemaRows: { name: string; values: Record<string, RowValue>; color?: string; stored?: string }[];
  /** `~views`, in tab order; empty when the model has none. */
  views: ResolvedView[];
  /** `@index(...)`, each a list of single-valued fields (`id`, `created` and `modified` included) to look rows up by. */
  indexes: string[][];
}

/** One item of a view's line: a field and its presentation. */
export interface LineItem {
  field: string;
  bullet: boolean;
  summary: boolean;
  label?: string;
  /** `~sort(field)`: lists a connection's members by a field of theirs instead of as connected. */
  sort?: string;
}

/** A default arrangement from `~views`. A view without a `line` uses the first view's. */
export interface ResolvedView {
  label: string;
  line: LineItem[];
  group?: string;
  /** `group: field ~sort(name)`: the groups in order of a field of theirs. */
  groupSort?: string;
  sort?: string;
}

export interface ResolvedConnection {
  ends: [string, string];
  a: ResolvedEnd;
  b: ResolvedEnd;
  storage: Storage;
}

export interface CheckResult {
  diagnostics: Diagnostic[];
  models: ResolvedModel[];
  connections: ResolvedConnection[];
}

interface EndInfo {
  decl: EndDecl;
  /** The type of the field the end's model gains: the other end's model, or the connection model. */
  target: string;
  /** The named model declaring the end, or null for an unnamed connection. */
  owner: ModelDecl | null;
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
/** The field a connection model gets for one of its ends: `as name`, or the end's model in lower case. */
const keyFieldOf = (end: EndDecl) => end.as?.name ?? lowerFirst(end.model);
const hasModifier = (field: FieldDecl, name: string) => field.modifiers.some((m) => m.name === name);
/** `{ column: "…" }` when `@column("…")` is among the attributes. */
const columnOf = (attrs: Attribute[]): { column?: string } => {
  const arg = attrs.find((a) => a.name === "column")?.args[0];
  return arg?.kind === "string" ? { column: arg.value } : {};
};
const resolvedEnd = (end: EndDecl): ResolvedEnd => ({
  model: end.model,
  field: end.field,
  arity: end.arity,
  ordered: end.ordered !== null,
  as: keyFieldOf(end),
  ...columnOf(end.attrs),
  fold: end.attrs.some((a) => a.name === "fold"),
});
const rowValue = (expr: Expr): RowValue => {
  switch (expr.kind) {
    case "string":
    case "number":
      return expr.value;
    case "ident":
      return expr.name === "true" ? true : expr.name === "false" ? false : expr.name;
    case "list":
      return expr.items.map(rowValue);
    case "object":
      return JSON.stringify(expr.entries);
  }
};
const arityText = (arity: Arity) => (arity === "many" ? "[]" : arity === "optional" ? "?" : "");
const isValueType = (type: string) => (VALUE_TYPES as readonly string[]).includes(type);

export function checkUsl(parsed: SchemaFile): CheckResult {
  // A copy, so merging `re` blocks never changes the parsed file.
  const file = structuredClone(parsed);
  const diagnostics: Diagnostic[] = [];
  const report = (code: string, at: Position, message: string) =>
    diagnostics.push({ code, message, line: at.line, column: at.column });

  // 1. Model names. The model layer is declared once; `re` adds to it.
  const models = new Map<string, ModelDecl>();
  for (const decl of file.declarations) {
    if (decl.kind !== "model") continue;
    if ((VALUE_TYPES as readonly string[]).includes(decl.name) || (BUILTIN_MODELS as readonly string[]).includes(decl.name)) {
      report("reserved-model", decl.at, `\`${decl.name}\` is built in and can't be declared`);
    } else if (models.has(decl.name)) {
      report("duplicate-model", decl.at, `Model \`${decl.name}\` is declared twice; add to it with \`re ${decl.name} { ... }\``);
    } else {
      models.set(decl.name, decl);
    }
  }
  const mains = [...models.values()].filter((m) => m.main);
  for (const extra of mains.slice(1)) report("main-model", extra.main!, "A schema has at most one `main` model");
  mergeRe(file, models, report);
  const modelExists = (name: string) => models.has(name) || (BUILTIN_MODELS as readonly string[]).includes(name);
  const rowsOf = (model: ModelDecl) => model.members.find((m): m is RowsBlock => m.kind === "rows");
  const connectionEndsOf = (decl: { members: Member[] }) => decl.members.filter((m): m is EndDecl => m.kind === "end");
  const isFixed = (name: string) => {
    const model = models.get(name);
    return model ? rowsOf(model)?.mode === "fixed" : false;
  };

  // 2. Connections and their ends. Each Model.field is declared by exactly one end.
  const ends = new Map<string, EndInfo>();
  const declareEnd = (decl: EndDecl, target: string, owner: ModelDecl | null) => {
    if (!modelExists(decl.model)) {
      report("unknown-model", decl.at, `No model \`${decl.model}\` for the end \`${decl.model}.${decl.field}\``);
      return;
    }
    const key = `${decl.model}.${decl.field}`;
    if (ends.has(key)) {
      const first = ends.get(key)!.decl.at;
      report("duplicate-end", decl.at, `\`${key}\` is already declared by the connection on line ${first.line}`);
      return;
    }
    ends.set(key, { decl, target, owner });
  };

  const unnamed: { a: EndDecl; b: EndDecl }[] = [];
  for (const decl of file.declarations) {
    if (decl.kind !== "connection") continue;
    const connectionEnds = decl.members.filter((m): m is EndDecl => m.kind === "end");
    for (const member of decl.members) {
      if (member.kind !== "end") {
        report("connection-member", member.at, "An unnamed connection holds only its two ends; give it a name (`model X { ... }`) to add fields or attributes");
      }
    }
    if (connectionEnds.length !== 2) {
      report("connection-ends", decl.at, `An unnamed connection has exactly two ends, not ${connectionEnds.length}`);
      continue;
    }
    const [a, b] = connectionEnds as [EndDecl, EndDecl];
    if (a.ordered && b.ordered) report("ordered-ends", b.ordered, "At most one end of a connection is `ordered`");
    declareEnd(a, b.model, null);
    declareEnd(b, a.model, null);
    if (modelExists(a.model) && modelExists(b.model)) unnamed.push({ a, b });
  }
  for (const model of models.values()) {
    for (const member of model.members) {
      if (member.kind === "end") declareEnd(member, model.name, model);
    }
  }

  // 3. Each model's fields.
  const resolved = new Map<string, ResolvedModel>();
  const fieldMaps = new Map<string, Map<string, ResolvedField>>();
  const allModelNames = [...BUILTIN_MODELS, ...models.keys()];
  for (const name of allModelNames) {
    const model = models.get(name);
    const fields = new Map<string, ResolvedField>();
    const declared = new Map<string, FieldDecl>();
    const modelEnds = model ? model.members.filter((m): m is EndDecl => m.kind === "end") : [];
    const rows = model ? rowsOf(model) : undefined;

    if (model) {
      for (const member of model.members) {
        if (member.kind !== "field") continue;
        if ((IMPLICIT_FIELDS as readonly string[]).includes(member.name)) {
          report("reserved-field", member.at, `\`${member.name}\` is implicit on every row and can't be declared`);
          continue;
        }
        if (declared.has(member.name)) {
          report("duplicate-field", member.at, `Field \`${member.name}\` is declared twice in \`${name}\``);
          continue;
        }
        declared.set(member.name, member);
        if (!isValueType(member.type) && !modelExists(member.type)) {
          report("unknown-type", member.at, `Unknown type \`${member.type}\``);
          continue;
        }
        if (isValueType(member.type)) {
          fields.set(member.name, {
            name: member.name,
            type: member.type,
            arity: member.arity,
            origin: "declared",
            ordered: hasModifier(member, "ordered"),
            unique: hasModifier(member, "unique"),
            ...columnOf(member.attrs),
            color: member.attrs.some((a) => a.name === "color" && a.sigil === "~"),
          });
        }
      }
    }

    // A connection model is keyed by its ends and has a field for each.
    for (const end of modelEnds) {
      if (!modelExists(end.model)) continue;
      const fieldName = keyFieldOf(end);
      if (fields.has(fieldName) || declared.has(fieldName)) {
        const hint = end.as ? "" : `; name this side with \`as ...\``;
        report("duplicate-field", end.at, `\`${name}\` already has a field \`${fieldName}\`, which this end would key it by${hint}`);
        continue;
      }
      fields.set(fieldName, { name: fieldName, type: end.model, arity: "one", origin: "end", ordered: false, unique: false, color: false, ...columnOf(end.attrs) });
    }

    // Fields gained from connections.
    for (const [key, info] of ends) {
      if (info.decl.model !== name) continue;
      const field = info.decl.field;
      if ((IMPLICIT_FIELDS as readonly string[]).includes(field)) {
        report("reserved-field", info.decl.at, `\`${field}\` is implicit on every row and can't be declared`);
        continue;
      }
      const existing = fields.get(field);
      const crossReference = declared.get(field);
      if (existing || (crossReference && isValueType(crossReference.type))) {
        report("duplicate-field", info.decl.at, `\`${key}\` clashes with another field \`${field}\` of \`${name}\``);
        continue;
      }
      fields.set(field, {
        name: field,
        type: info.target,
        arity: info.decl.arity,
        origin: "connection",
        ordered: info.decl.ordered !== null,
        unique: false,
        color: false,
        ...columnOf(info.decl.attrs),
      });
    }

    // Model-typed fields inside a model only cross-reference a connection.
    for (const decl of declared.values()) {
      if (isValueType(decl.type) || !modelExists(decl.type)) continue;
      const info = ends.get(`${name}.${decl.name}`);
      const written = `${decl.name} ${decl.type}${arityText(decl.arity)}`;
      if (!info) {
        report(
          "undeclared-connection",
          decl.at,
          `\`${written}\` refers to a connection nobody declares; add \`${name}.${decl.name}${arityText(decl.arity)} <-> ${decl.type}.<field>\``,
        );
        continue;
      }
      const declaredEnd = `${name}.${decl.name}${arityText(info.decl.arity)}`;
      if (info.target !== decl.type) {
        report("cross-reference-mismatch", decl.at, `\`${written}\` says ${decl.type}, but \`${declaredEnd}\` connects to ${info.target}`);
      } else if (info.decl.arity !== decl.arity) {
        report("cross-reference-mismatch", decl.at, `\`${written}\` disagrees with \`${declaredEnd}\` on arity`);
      }
      for (const attr of decl.attrs) {
        if (!info.decl.attrs.some((a) => a.name === attr.name)) {
          report("cross-reference-mismatch", attr.at, `\`${attr.sigil}${attr.name}\` belongs on the end \`${declaredEnd}\`, where the connection is declared`);
        }
      }
      for (const modifier of decl.modifiers) {
        if (modifier.name !== "ordered" || !info.decl.ordered) {
          report("cross-reference-mismatch", modifier.at, `\`${modifier.name}\` belongs on the end \`${declaredEnd}\`, where the connection is declared`);
        }
      }
    }

    const key = modelEnds.length >= 2 ? modelEnds.map(keyFieldOf) : rows?.mode === "fixed" ? ["name"] : ["id"];
    const entry: ResolvedModel = {
      name,
      main: model?.main != null,
      rows: rows?.mode ?? "data",
      key,
      // Fields written in the model come in the order they're written; the rest follow.
      fields: [
        ...[...declared.keys()].flatMap((f) => (fields.has(f) ? [fields.get(f)!] : [])),
        ...[...fields.values()].filter((f) => !declared.has(f.name)),
      ],
      ends: modelEnds.map(resolvedEnd),
      schemaRows: (rows?.rows ?? []).map((row) => {
        const color = row.attrs.find((a) => a.name === "color" && a.sigil === "~")?.args[0];
        const stored = row.attrs.find((a) => a.name === "stored" && a.sigil === "@")?.args[0];
        return {
          name: row.name,
          values: Object.fromEntries(row.values.map((v) => [v.key, rowValue(v.value)])),
          ...(color?.kind === "string" ? { color: color.value } : {}),
          ...(stored?.kind === "string" ? { stored: stored.value } : {}),
        };
      }),
      views: model ? resolvedViews(model) : [],
      indexes: [],
    };
    resolved.set(name, entry);
    fieldMaps.set(name, fields);
  }

  // 4. Field and end modifiers and attributes.
  const checkFieldAttrs = (attrs: Attribute[], arity: Arity, type: string | null, owner: string, end?: { decl: EndDecl; named: boolean }) => {
    const seen = new Set<string>();
    for (const attr of attrs) {
      const layer = FIELD_ATTRIBUTES[attr.name];
      if (seen.has(`${attr.sigil}${attr.name}`)) {
        report("duplicate-attribute", attr.at, `\`${attr.sigil}${attr.name}\` is set twice`);
        continue;
      }
      seen.add(`${attr.sigil}${attr.name}`);
      if (MODIFIERS.includes(attr.name) || attr.name === "as") {
        report("attribute-layer", attr.at, `\`${attr.name}\` is a keyword of the model: write it before the type (\`${attr.name === "as" ? "Model.field as name" : `field ${attr.name} Type`}\`)`);
        continue;
      }
      if (attr.name === "bullet" || attr.name === "summary" || attr.name === "label") {
        report("misplaced-attribute", attr.at, `\`~${attr.name}\` is presentation; put it on the field in a view's \`line\``);
        continue;
      }
      if (!layer) {
        report("unknown-attribute", attr.at, `Unknown attribute \`${attr.sigil}${attr.name}\``);
        continue;
      }
      if (layer !== attr.sigil) {
        report("attribute-layer", attr.at, `\`${attr.name}\` is ${layer === "@" ? "storage" : "presentation"}: write \`${layer}${attr.name}\``);
        continue;
      }
      if (attr.name === "column") {
        if (attr.args.length !== 1 || attr.args[0]!.kind !== "string" || attr.args[0]!.value === "") {
          report("attribute-arguments", attr.at, '`@column` names the stored column: `@column("list_id")`');
        }
      } else if (attr.name === "fold") {
        if (!end) report("misplaced-attribute", attr.at, "`@fold` goes on a connection end");
        else if (end.named) report("misplaced-attribute", attr.at, "A connection model folds with `@fold(Model)` as a model item");
        else if (attr.args.length > 0) report("attribute-arguments", attr.at, "`@fold` on an end takes no arguments");
        // Whether the connection can fold is checked with its storage.
      } else if (attr.args.length > 0) {
        report("attribute-arguments", attr.at, `\`${attr.sigil}${attr.name}\` on a field takes no arguments`);
      } else if (end) {
        report("misplaced-attribute", attr.at, `\`${attr.sigil}${attr.name}\` goes on a value field, not a connection end`);
      } else if (attr.name === "color" && (type !== "Text" || arity === "many")) {
        report("color-field-type", attr.at, "`~color` marks a single `Text` field holding each row's color");
      } else if (attr.name === "color" && isFixed(owner)) {
        report("misplaced-attribute", attr.at, "An enum's colors go on its values; a `~color` field is for models");
      } else if (attr.name === "body" && (type !== "Markdown" || arity === "many")) {
        report("body-field", attr.at, "`@body` marks a single `Markdown` field written as a Markdown row's body");
      } else if (attr.name === "title" && (type !== "Text" || arity === "many")) {
        report("title-field", attr.at, "`@title` marks a single `Text` field written as a Markdown row's title");
      }
    }
  };
  const checkModifiers = (field: FieldDecl, owner: string) => {
    const seen = new Set<string>();
    for (const modifier of field.modifiers) {
      if (seen.has(modifier.name)) {
        report("duplicate-attribute", modifier.at, `\`${modifier.name}\` is written twice`);
        continue;
      }
      seen.add(modifier.name);
      if (modifier.name === "ordered" && field.arity !== "many") {
        report("ordered-single", modifier.at, "`ordered` only applies to a many-valued field (`[]`)");
      } else if (modifier.name === "unique" && (!isValueType(field.type) || field.arity === "many")) {
        report("unique-value", modifier.at, "`unique` applies to a single value field; a connection's arity already says how many");
      } else if (modifier.name === "path" && (field.type !== "Text" || field.arity !== "one")) {
        report("path-field", modifier.at, "`path` marks a required `Text` field whose value names the row in the tree");
      } else if (modifier.name === "path" && isFixed(owner)) {
        report("path-field", modifier.at, "An enum's values are named by themselves");
      }
    }
  };
  const checkEnd = (end: EndDecl, named: boolean) => {
    if (end.ordered && end.arity !== "many") report("ordered-single", end.ordered, "`ordered` only applies to a many end (`[]`)");
    if (end.as && !named) report("misplaced-attribute", end.as.at, "`as` names a connection model's field for this end; an unnamed connection has no such field");
  };
  for (const model of models.values()) {
    for (const member of model.members) {
      if (member.kind === "field") {
        checkModifiers(member, model.name);
        if (isValueType(member.type)) checkFieldAttrs(member.attrs, member.arity, member.type, model.name);
      }
      if (member.kind === "end") {
        checkEnd(member, true);
        checkFieldAttrs(member.attrs, member.arity, null, model.name, { decl: member, named: true });
      }
    }
    const marked = (name: string) => model.members.filter((m): m is FieldDecl => m.kind === "field" && m.attrs.some((a) => a.name === name && a.sigil === FIELD_ATTRIBUTES[name]));
    const colorFields = marked("color");
    if (colorFields.length > 1) {
      report("duplicate-color", colorFields[1]!.at, "Only one field per model can hold the row's color");
    }
    const pathFields = model.members.filter((m): m is FieldDecl => m.kind === "field" && hasModifier(m, "path"));
    if (pathFields.length > 1) report("duplicate-path", pathFields[1]!.at, "Only one field per model can name its rows");
    const entry = resolved.get(model.name)!;
    if (pathFields[0]) entry.path = pathFields[0].name;
    for (const [name, fallback, type] of [["body", "content", "Markdown"], ["title", "title", "Text"]] as const) {
      const fields = marked(name);
      if (fields.length > 1) report(`duplicate-${name}`, fields[1]!.at, `Only one field per model is its \`@${name}\``);
      const conventional = model.members.find((m): m is FieldDecl => m.kind === "field" && m.name === fallback && m.type === type && m.arity !== "many");
      const chosen = fields[0]?.name ?? conventional?.name;
      if (chosen && model.form === "model") entry[name] = chosen;
    }
    const modelEnds = connectionEndsOf(model);
    const ordered = modelEnds.filter((e) => e.ordered);
    if (ordered.length > 1) report("ordered-ends", ordered[1]!.ordered!, "At most one end of a connection is `ordered`");
    if (model.main && (model.form === "enum" || modelEnds.length > 0)) {
      report("main-model", model.main, model.form === "enum" ? "An enum has no rows of its own to be the main model" : "A connection model can't be the main model");
    }
  }
  for (const decl of file.declarations) {
    if (decl.kind !== "connection") continue;
    for (const member of decl.members) {
      if (member.kind !== "end") continue;
      checkEnd(member, false);
      checkFieldAttrs(member.attrs, member.arity, null, member.model, { decl: member, named: false });
    }
  }

  // A connection's members sort by a field of theirs: `name` for a person or
  // an enum value, otherwise a field, `created` or `modified`.
  const sortable = (target: string, field: string) =>
    target === "Person" || isFixed(target)
      ? field === "name" || Boolean(fieldMaps.get(target)?.has(field))
      : (IMPLICIT_FIELDS as readonly string[]).includes(field) || Boolean(fieldMaps.get(target)?.has(field));

  // 5. Header keys and model attributes.
  for (const model of models.values()) {
    const fields = fieldMaps.get(model.name)!;
    const seen = new Set<string>();
    const modelEnds = connectionEndsOf(model);
    const rows = model.members.filter((m): m is RowsBlock => m.kind === "rows");
    const entry = resolved.get(model.name)!;

    if (model.key) {
      if (model.form === "enum") {
        report("id-on-rows", model.key.at, "An enum's values are identified by their names");
      } else {
        entry.key = [];
        for (const { name, at } of model.key.fields) {
          if (name === "id") {
            entry.key.push("id"); // the implicit id, unique only alongside the other key fields
            continue;
          }
          const field = fields.get(name);
          if (!field) report("unknown-field", at, `\`${model.name}\` has no field \`${name}\``);
          else if (field.arity !== "one") report("id-field", at, `\`${name}\` is part of the key, so it must hold exactly one value`);
          else entry.key.push(name);
        }
      }
    }
    if (rows.length > 1) report("duplicate-attribute", rows[1]!.at, model.form === "enum" ? "An enum has no `seed` block; make it a model" : "A model has at most one `seed` block");

    for (const member of model.members) {
      if (member.kind !== "modelAttribute") continue;
      const layer = MODEL_ATTRIBUTES[member.name];
      // A model may have several indexes; every other attribute appears once.
      if (seen.has(member.name) && member.name !== "index") {
        report("duplicate-attribute", member.at, `\`${member.sigil}${member.name}\` appears twice`);
        continue;
      }
      seen.add(member.name);
      if (!layer) {
        report("unknown-attribute", member.at, `Unknown model attribute \`${member.sigil}${member.name}\``);
      } else if (layer !== member.sigil) {
        report("attribute-layer", member.at, `\`${member.name}\` is ${layer === "@" ? "storage" : "presentation"}: write \`${layer}${member.name}\``);
      } else if (member.name === "views") {
        checkViews(member, model.name, fields, sortable, report);
      } else if (member.name === "index") {
        if (member.args.length === 0) report("attribute-arguments", member.at, "`@index` names at least one field");
        const index: string[] = [];
        for (const arg of member.args) {
          if (arg.kind !== "ident") {
            report("attribute-arguments", arg.at, "`@index` takes field names");
            continue;
          }
          const field = fields.get(arg.name);
          if (!field && !(IMPLICIT_FIELDS as readonly string[]).includes(arg.name)) report("unknown-field", arg.at, `\`${model.name}\` has no field \`${arg.name}\``);
          else if (field && field.arity === "many") report("index-many", arg.at, `\`${arg.name}\` holds many values; an index takes single-valued fields`);
          else index.push(arg.name);
        }
        if (index.length === member.args.length && index.length > 0) entry.indexes.push(index);
      } else if (member.name === "table" && modelEnds.length === 0) {
        const arg = member.args[0];
        if (member.args.length !== 1 || arg?.kind !== "string" || arg.value === "") {
          report("attribute-arguments", member.at, '`@table` names the stored table: `@table("lists")`');
        } else if (model.form === "enum") {
          report("stored-on-fixed", member.at, `\`${model.name}\` is an enum and has no table to name`);
        } else {
          entry.table = arg.value;
        }
      } else if (member.name === "fold" || member.name === "table") {
        if (modelEnds.length === 0) {
          report("storage-on-plain-model", member.at, `\`@${member.name}\` chooses storage for a connection; \`${model.name}\` has no ends`);
        } else if (member.name === "fold") {
          const arg = member.args[0];
          if (member.args.length !== 1 || arg?.kind !== "ident") {
            report("attribute-arguments", member.at, "`@fold` on a connection model names one model: `@fold(List)`");
          } else if (!modelEnds.some((e) => e.model === arg.name)) {
            report("fold-target", arg.at, `\`${model.name}\` can fold only into a model it connects, not \`${arg.name}\``);
          } else if (arg.name === "Person" || isFixed(arg.name)) {
            report("stored-on-fixed", arg.at, `\`${arg.name}\` has no table to fold into`);
          }
        }
      }
    }
    if (seen.has("fold") && seen.has("table") && modelEnds.length > 0) {
      const second = model.members.find((m) => m.kind === "modelAttribute" && m.name === "table")!;
      report("fold-and-table", second.at, "`@fold` and `@table` contradict each other");
    }

    const block = rows[0];
    if (block) checkRows(model, block, modelEnds, report);

    if (modelEnds.length > 0) {
      const fold = model.members.find((m): m is ModelAttribute => m.kind === "modelAttribute" && m.name === "fold");
      const into = fold?.args[0];
      entry.storage = into?.kind === "ident" ? { kind: "fold", into: into.name } : { kind: "table" };
    }
  }

  // 6. Storage of unnamed connections: never on a model without a table.
  const hasTable = (name: string) => name !== "Person" && !isFixed(name);
  const connections: ResolvedConnection[] = [];
  for (const { a, b } of unnamed) {
    const label: [string, string] = [`${a.model}.${a.field}${arityText(a.arity)}`, `${b.model}.${b.field}${arityText(b.arity)}`];
    let storage: Storage | null = null;
    const nm = a.arity === "many" && b.arity === "many";
    const candidates = nm ? [a, b] : [a, b].filter((e) => e.arity !== "many");
    const folded = [a, b].filter((e) => e.attrs.some((x) => x.name === "fold"));
    const foldAt = (e: EndDecl) => e.attrs.find((x) => x.name === "fold")!.at;
    if (folded.length > 0 && !nm) {
      report("fold-end", foldAt(folded[0]!), "Only an n:m connection folds; a 1:1 or 1:n is already a column on its single side");
    } else if (folded.length > 1) {
      report("fold-end", foldAt(folded[1]!), "Fold one end of a connection, not both");
    } else if (folded.length === 1 && !hasTable(folded[0]!.model)) {
      report("stored-on-fixed", foldAt(folded[0]!), `\`${folded[0]!.model}\` has no table to fold into`);
    }
    const on = folded.length === 1 && nm && hasTable(folded[0]!.model) ? folded[0] : candidates.find((e) => hasTable(e.model));
    for (const end of [a, b]) {
      const column = end.attrs.find((x) => x.name === "column");
      if (!column || !on) continue;
      if (nm && end !== folded[0]) {
        report("column-placement", column.at, "An n:m connection is stored in its own table; name its columns in a named connection model, or `@fold` this end");
      } else if (!nm && end !== on) {
        report("column-placement", column.at, `This connection is stored as a column on \`${on.model}.${on.field}\`; put \`@column\` there`);
      }
    }
    if (on) {
      storage = nm ? { kind: "array", on: on.model, field: on.field, sqlite: "join table" } : { kind: "column", on: on.model, field: on.field };
    }
    if (!storage) {
      const where = [...new Set(candidates.map((e) => e.model))].join(" or ");
      report(
        "stored-on-fixed",
        a.at,
        `\`${label[0]} <-> ${label[1]}\` would be stored on ${where}, which ${candidates.length > 1 ? "have" : "has"} no table (Person and enums don't)`,
      );
      continue;
    }
    connections.push({ ends: label, a: resolvedEnd(a), b: resolvedEnd(b), storage });
  }

  // 7. Top-level views can only be checked for their options.
  for (const decl of file.declarations) {
    if (decl.kind !== "view") continue;
    for (const entry of decl.options) {
      if (!VIEW_OPTIONS.includes(entry.key) || entry.key === "label") {
        report("unknown-view-option", entry.at, `Unknown view option \`${entry.key}\``);
      }
    }
  }

  // Names that only clash once stored (two fields given one @column, or a key column and a field).
  const result: CheckResult = { diagnostics, models: [...resolved.values()], connections };
  if (diagnostics.length === 0) {
    for (const store of ["database", "files"] as const) {
      try {
        layoutOf(result, { store });
      } catch (error) {
        if (!(error instanceof LayoutError)) throw error;
        const model = models.get(error.where?.split(".")[0] ?? "");
        report("duplicate-column", model?.at ?? { line: 1, column: 1 }, error.message);
        break;
      }
    }
  }
  diagnostics.sort((x, y) => x.line - y.line || x.column - y.column);
  return result;
}

type Report = (code: string, at: Position, message: string) => void;

/** A model's `~views`, as far as they are well formed; checkViews reports the rest. */
function resolvedViews(model: ModelDecl): ResolvedView[] {
  const attr = model.members.find((m): m is ModelAttribute => m.kind === "modelAttribute" && m.name === "views");
  const list = attr?.args[0];
  if (list?.kind !== "list") return [];
  const ident = (e: Expr | undefined) => (e?.kind === "ident" ? e.name : undefined);
  const views: ResolvedView[] = [];
  for (const view of list.items) {
    if (view.kind !== "object") continue;
    const option = (key: string) => view.entries.find((e) => e.key === key)?.value;
    const label = option("label");
    const line = option("line");
    const items: LineItem[] = line?.kind === "list"
      ? line.items.flatMap((item) => {
        if (item.kind !== "ident") return [];
        const named = item.attrs.find((a) => a.name === "label" && a.sigil === "~")?.args[0];
        return [{
          field: item.name,
          bullet: item.attrs.some((a) => a.name === "bullet" && a.sigil === "~"),
          summary: item.attrs.some((a) => a.name === "summary" && a.sigil === "~"),
          ...(named?.kind === "string" ? { label: named.value } : {}),
          ...sortOf(item.attrs),
        }];
      })
      : views[0]?.line ?? [];
    const group = ident(option("group"));
    const groupBy = option("group");
    const groupSort = groupBy?.kind === "ident" ? sortOf(groupBy.attrs).sort : undefined;
    const sort = ident(option("sort"));
    views.push({
      label: label?.kind === "string" ? label.value : "",
      line: items,
      ...(group ? { group } : {}),
      ...(groupSort ? { groupSort } : {}),
      ...(sort ? { sort } : {}),
    });
  }
  return views;
}

/** `{ sort: "…" }` when `~sort(field)` is among the attributes. */
function sortOf(attrs: Attribute[]): { sort?: string } {
  const arg = attrs.find((a) => a.name === "sort")?.args[0];
  return arg?.kind === "ident" ? { sort: arg.name } : {};
}

function checkViews(
  attr: ModelAttribute,
  model: string,
  fields: Map<string, ResolvedField>,
  sortable: (target: string, field: string) => boolean,
  report: Report,
) {
  /** `~sort(x)` on a view's field: it names a field of the members of a connection. */
  const checkSort = (field: string, a: Attribute) => {
    const arg = a.args[0];
    if (a.args.length !== 1 || arg?.kind !== "ident") {
      report("attribute-arguments", a.at, "`~sort` names one field of the members: `~sort(name)`");
      return;
    }
    const resolved = fields.get(field);
    if (!resolved) return;
    if (isValueType(resolved.type)) report("sort-field", a.at, `\`${field}\` holds values, not a connection's members`);
    else if (!sortable(resolved.type, arg.name)) report("unknown-field", arg.at, `\`${resolved.type}\` has no field \`${arg.name}\` to sort by`);
  };
  const list = attr.args[0];
  if (attr.args.length !== 1 || list?.kind !== "list") {
    report("attribute-arguments", attr.at, "`~views` takes one list of views: `~views([ { label: ... }, ... ])`");
    return;
  }
  const fieldRef = (expr: Expr, allowImplicit: boolean) => {
    if (expr.kind !== "ident") {
      report("view-field", expr.at, "Expected a field name");
      return;
    }
    const implicit = allowImplicit && (expr.name === "created" || expr.name === "modified");
    if (!implicit && !fields.has(expr.name)) report("unknown-field", expr.at, `\`${model}\` has no field \`${expr.name}\``);
  };
  const labels = new Set<string>();
  for (const view of list.items) {
    if (view.kind !== "object") {
      report("attribute-arguments", view.at, "Each view is an object: `{ label: \"...\", ... }`");
      continue;
    }
    const label = view.entries.find((e) => e.key === "label");
    if (!label || label.value.kind !== "string") {
      report("view-label", view.at, "Each view needs a `label` string");
    } else if (labels.has(label.value.value)) {
      report("duplicate-view", label.at, `Two views are labelled "${label.value.value}"`);
    } else {
      labels.add(label.value.value);
    }
    for (const entry of view.entries) {
      if (!VIEW_OPTIONS.includes(entry.key)) {
        report("unknown-view-option", entry.at, `Unknown view option \`${entry.key}\``);
      } else if (entry.key === "line") {
        if (entry.value.kind !== "list") {
          report("view-field", entry.value.at, "`line` is a list of fields");
          continue;
        }
        let bullets = 0;
        for (const item of entry.value.items) {
          fieldRef(item, false);
          if (item.kind !== "ident") continue;
          for (const a of item.attrs) {
            if (!LINE_ATTRIBUTES.includes(a.name)) {
              report("unknown-attribute", a.at, `\`${a.sigil}${a.name}\` isn't presentation; a line takes ${LINE_ATTRIBUTES.map((n) => `\`~${n}\``).join(", ")}`);
            } else if (a.sigil !== "~") {
              report("attribute-layer", a.at, `\`${a.name}\` is presentation: write \`~${a.name}\``);
            } else if (a.name === "sort") {
              checkSort(item.name, a);
            } else if (a.name === "label" ? a.args.length !== 1 || a.args[0]!.kind !== "string" : a.args.length > 0) {
              report("attribute-arguments", a.at, a.name === "label" ? '`~label` takes one string: `~label("lead")`' : `\`~${a.name}\` takes no arguments`);
            } else if (a.name === "bullet" && ++bullets > 1) {
              report("duplicate-bullet", a.at, "A line has at most one `~bullet`");
            }
          }
        }
      } else if (entry.key === "group" || entry.key === "sort") {
        fieldRef(entry.value, entry.key === "sort");
        if (entry.value.kind !== "ident") continue;
        for (const a of entry.value.attrs) {
          if (entry.key === "group" && a.name === "sort" && a.sigil !== "~") report("attribute-layer", a.at, "`sort` is presentation: write `~sort`");
          else if (entry.key === "group" && a.name === "sort") checkSort(entry.value.name, a);
          else report("misplaced-attribute", a.at, entry.key === "group" ? "A `group` takes only `~sort`; other attributes go on the items of a `line`" : "Attributes go on the items of a `line`");
        }
      }
    }
  }
}

function checkRows(model: ModelDecl, block: RowsBlock, modelEnds: EndDecl[], report: Report) {
  if (modelEnds.length > 0) {
    report("rows-with-ends", block.at, `\`${model.name}\` is a connection; its rows can't be written in the schema`);
  }
  if (block.mode === "fixed" && block.rows.length === 0) {
    report("empty-enum", model.at, `Enum \`${model.name}\` has no values`);
  }
  const fields = new Map(
    model.members.filter((m): m is FieldDecl => m.kind === "field" && isValueType(m.type)).map((f) => [f.name, f]),
  );
  if (block.mode === "seed") {
    const name = fields.get("name");
    if (!name || name.type !== "Text" || name.arity !== "one") {
      report("seed-needs-name", block.at, "A `seed` model needs a `name Text` field, so people can rename its rows");
    }
  }
  const names = new Set<string>();
  for (const row of block.rows) {
    if (names.has(row.name)) report("duplicate-row", row.at, `Row "${row.name}" appears twice`);
    names.add(row.name);
    for (const attr of row.attrs) {
      const layer = VALUE_ATTRIBUTES[attr.name];
      if (!layer) report("unknown-attribute", attr.at, `Unknown value attribute \`${attr.sigil}${attr.name}\``);
      else if (layer !== attr.sigil) report("attribute-layer", attr.at, `\`${attr.name}\` is ${layer === "@" ? "storage" : "presentation"}: write \`${layer}${attr.name}\``);
      else if (block.mode === "seed") report("misplaced-attribute", attr.at, `A \`seed\` row's ${attr.name === "color" ? "color is data; give it a value for the `~color` field" : "stored text is its id"}`);
      else if (attr.name === "stored" && (attr.args.length !== 1 || attr.args[0]!.kind !== "string" || attr.args[0]!.value === "")) {
        report("attribute-arguments", attr.at, '`@stored` gives the text a store holds: `@stored("pt")`');
      } else if (attr.name === "color" && (attr.args.length !== 1 || attr.args[0]!.kind !== "string" || !COLOR.test(attr.args[0]!.value))) {
        report("bad-color", attr.at, 'A value\'s color is `~color("#rrggbb")`');
      }
    }
    const given = new Set<string>();
    for (const entry of row.values) {
      const field = fields.get(entry.key);
      if (!field) {
        report("unknown-field", entry.at, `\`${model.name}\` has no value field \`${entry.key}\``);
        continue;
      }
      if (given.has(entry.key)) report("duplicate-value", entry.at, `\`${entry.key}\` is given twice`);
      given.add(entry.key);
      checkValue(entry, field, report);
    }
    for (const field of fields.values()) {
      if (field.arity === "one" && !given.has(field.name)) {
        report("missing-value", row.at, `Row "${row.name}" needs a value for \`${field.name}\``);
      }
    }
  }
}

function checkValue(entry: ObjectEntry, field: FieldDecl, report: Report) {
  const fits = (value: Expr): boolean => {
    switch (field.type) {
      case "Text":
      case "Markdown":
        return value.kind === "string";
      case "Number":
        return value.kind === "number";
      case "Int":
        return value.kind === "number" && Number.isSafeInteger(value.value);
      case "Bool":
        return value.kind === "ident" && (value.name === "true" || value.name === "false");
      case "Date":
        return value.kind === "string" && !Number.isNaN(Date.parse(value.value));
      default:
        return false;
    }
  };
  const value = entry.value;
  const ok = field.arity === "many" ? value.kind === "list" && value.items.every(fits) : fits(value);
  if (!ok) report("bad-value", value.at, `\`${field.name}\` holds ${field.type}${arityText(field.arity)}`);
  if (field.attrs.some((a) => a.name === "color" && a.sigil === "~") && value.kind === "string" && !COLOR.test(value.value)) {
    report("bad-color", value.at, 'A color is "#rrggbb"');
  }
}

/**
 * Merges each `re Name { ... }` into the model or enum it names: a mention adds
 * its attributes to that field, end or value, and a model attribute joins the
 * model's own. Nothing in a `re` block declares.
 */
function mergeRe(file: SchemaFile, models: Map<string, ModelDecl>, report: Report) {
  for (const decl of file.declarations) {
    if (decl.kind !== "re") continue;
    const model = models.get(decl.name);
    if (!model) {
      report("unknown-model", decl.at, `No model or enum \`${decl.name}\` to annotate`);
      continue;
    }
    for (const member of decl.members) {
      if (member.kind === "modelAttribute") {
        model.members.push(member);
        continue;
      }
      if (member.kind !== "mention") continue;
      const field = model.members.find((m): m is FieldDecl | EndDecl => (m.kind === "field" && m.name === member.name) || (m.kind === "end" && m.field === member.name));
      const value = model.members.find((m): m is RowsBlock => m.kind === "rows" && m.mode === "fixed")?.rows.find((r) => r.name === member.name);
      // A field the model gains from a connection declared outside it is annotated on that end.
      const outside = file.declarations.flatMap((d) => (d.kind === "connection" ? d.members : d.kind === "model" && d !== model ? d.members : []))
        .find((m): m is EndDecl => m.kind === "end" && m.model === model.name && m.field === member.name);
      const target = value ?? field ?? outside;
      if (!target) {
        report("unknown-field", member.at, `\`${decl.name}\` has no field or value \`${member.name}\``);
        continue;
      }
      target.attrs.push(...member.attrs);
    }
  }
}
