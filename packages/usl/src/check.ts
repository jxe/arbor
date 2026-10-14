// Checks a parsed .usl file against the language's invariants and resolves
// each model's full set of fields: its own, those its connections give it,
// and, for a connection model, the ends that key it.

import type {
  Arity,
  Attribute,
  Diagnostic,
  EndDecl,
  Expr,
  FieldDecl,
  ModelAttribute,
  ModelDecl,
  ObjectEntry,
  Position,
  RowsBlock,
  SchemaFile,
} from "./ast.ts";

export const VALUE_TYPES = ["Text", "Markdown", "Number", "Bool", "Date"] as const;
export const BUILTIN_MODELS = ["Person"] as const;
export const IMPLICIT_FIELDS = ["id", "created", "modified"] as const;

const FIELD_ATTRIBUTES = ["ordered", "color", "unique", "as", "within"];
const MODEL_ATTRIBUTES = ["views", "editableBy", "fold", "table", "id"];
const VIEW_OPTIONS = ["label", "line", "group", "sort"];
const COLOR = /^#[0-9a-fA-F]{6}$/;

export interface ResolvedField {
  name: string;
  /** A value type or a model name. */
  type: string;
  arity: Arity;
  /** declared: written in the model. connection: gained from a connection. end: one of this connection model's ends. */
  origin: "declared" | "connection" | "end";
  ordered: boolean;
}

/** Where a connection's data lives. */
export type Storage =
  | { kind: "column"; on: string; field: string }
  | { kind: "array"; on: string; field: string; sqlite: "join table" }
  | { kind: "table" }
  | { kind: "fold"; into: string };

export interface ResolvedModel {
  name: string;
  /** `fixed` rows live in the schema; `seed` rows are data with defaults; `data` is an ordinary collection. */
  rows: "fixed" | "seed" | "data";
  /** The fields that identify a row: its ends for a connection model, otherwise `id` (or the row name, for fixed rows). */
  key: string[];
  fields: ResolvedField[];
  storage?: Storage;
}

export interface ResolvedConnection {
  ends: [string, string];
  storage: Storage;
  /** Both ends share this field (`@within`); a stored reference keeps only the rest of the target's key. */
  within?: string;
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
const identArg = (attrs: Attribute[], name: string): string | undefined => {
  const arg = attrs.find((a) => a.name === name)?.args[0];
  return arg?.kind === "ident" ? arg.name : undefined;
};
/** The field a connection model gets for one of its ends: `@as(name)`, or the end's model in lower case. */
const keyFieldOf = (end: EndDecl) => identArg(end.attrs, "as") ?? lowerFirst(end.model);
const arityText = (arity: Arity) => (arity === "many" ? "[]" : arity === "optional" ? "?" : "");
const isValueType = (type: string) => (VALUE_TYPES as readonly string[]).includes(type);

export function checkUsl(file: SchemaFile): CheckResult {
  const diagnostics: Diagnostic[] = [];
  const report = (code: string, at: Position, message: string) =>
    diagnostics.push({ code, message, line: at.line, column: at.column });

  // 1. Model names.
  const models = new Map<string, ModelDecl>();
  for (const decl of file.declarations) {
    if (decl.kind !== "model") continue;
    if ((VALUE_TYPES as readonly string[]).includes(decl.name) || (BUILTIN_MODELS as readonly string[]).includes(decl.name)) {
      report("reserved-model", decl.at, `\`${decl.name}\` is built in and can't be declared`);
    } else if (models.has(decl.name)) {
      report("duplicate-model", decl.at, `Model \`${decl.name}\` is declared twice`);
    } else {
      models.set(decl.name, decl);
    }
  }
  const modelExists = (name: string) => models.has(name) || (BUILTIN_MODELS as readonly string[]).includes(name);
  const rowsOf = (model: ModelDecl) => model.members.find((m): m is RowsBlock => m.kind === "rows");
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
            ordered: member.attrs.some((a) => a.name === "ordered"),
          });
        }
      }
    }

    // A connection model is keyed by its ends and has a field for each.
    for (const end of modelEnds) {
      if (!modelExists(end.model)) continue;
      const fieldName = keyFieldOf(end);
      if (fields.has(fieldName) || declared.has(fieldName)) {
        const hint = end.attrs.some((a) => a.name === "as") ? "" : `; name this side with \`@as(...)\``;
        report("duplicate-field", end.at, `\`${name}\` already has a field \`${fieldName}\`, which this end would key it by${hint}`);
        continue;
      }
      fields.set(fieldName, { name: fieldName, type: end.model, arity: "one", origin: "end", ordered: false });
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
        ordered: info.decl.attrs.some((a) => a.name === "ordered"),
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
          report("cross-reference-mismatch", attr.at, `\`@${attr.name}\` belongs on the end \`${declaredEnd}\`, where the connection is declared`);
        }
      }
    }

    const key = modelEnds.length >= 2 ? modelEnds.map(keyFieldOf) : rows?.mode === "fixed" ? ["name"] : ["id"];
    const entry: ResolvedModel = { name, rows: rows?.mode ?? "data", key, fields: [...fields.values()] };
    resolved.set(name, entry);
    fieldMaps.set(name, fields);
  }

  // `@within(f)` on an end: the row and every row it points to share `f`.
  const checkWithin = (end: EndDecl, shared: string, at: Position) => {
    const info = ends.get(`${end.model}.${end.field}`);
    if (!info || info.decl !== end) return;
    const here = fieldMaps.get(end.model)?.get(shared);
    const there = fieldMaps.get(info.target)?.get(shared);
    if (!here || !there) {
      const missing = !here ? end.model : info.target;
      report("within-field", at, `\`@within(${shared})\` needs both ${end.model} and ${info.target} to have \`${shared}\`; ${missing} doesn't`);
    } else if (here.type !== there.type || here.arity !== "one" || there.arity !== "one") {
      report("within-field", at, `\`${shared}\` must hold exactly one value of the same type on both sides; it is ${here.type}${arityText(here.arity)} on ${end.model} and ${there.type}${arityText(there.arity)} on ${info.target}`);
    }
  };

  // 4. Field and end attributes.
  const checkFieldAttrs = (attrs: Attribute[], arity: Arity, type: string | null, owner: string, end?: { decl: EndDecl; named: boolean }) => {
    for (const attr of attrs) {
      const endOnly = attr.name === "as" || attr.name === "within";
      if (attr.name === "bullet") {
        report("misplaced-attribute", attr.at, "`@bullet` is presentation; put it on the field in a view's `line`");
      } else if (!FIELD_ATTRIBUTES.includes(attr.name)) {
        report("unknown-attribute", attr.at, `Unknown attribute \`@${attr.name}\``);
      } else if (endOnly && !end) {
        report("misplaced-attribute", attr.at, `\`@${attr.name}\` goes on a connection end`);
      } else if (endOnly && (attr.args.length !== 1 || attr.args[0]!.kind !== "ident")) {
        report("attribute-arguments", attr.at, `\`@${attr.name}\` names one field: \`@${attr.name}(list)\``);
      } else if (attr.name === "as" && !end!.named) {
        report("misplaced-attribute", attr.at, "`@as` names a connection model's field for this end; an unnamed connection has no such field");
      } else if (attr.name === "within") {
        checkWithin(end!.decl, (attr.args[0] as { name: string }).name, attr.at);
      } else if (endOnly) {
        // `@as` is applied where the connection model's fields are resolved.
      } else if (attr.args.length > 0) {
        report("attribute-arguments", attr.at, `\`@${attr.name}\` on a field takes no arguments`);
      } else if (attr.name === "ordered" && arity !== "many") {
        report("ordered-single", attr.at, "`@ordered` only applies to a many-valued field (`[]`)");
      } else if (attr.name === "color" && (type !== "Text" || arity === "many")) {
        report("color-field-type", attr.at, "`@color` marks a single `Text` field holding each row's color");
      } else if (attr.name === "unique" && (type === null || !isValueType(type) || arity === "many")) {
        report("unique-value", attr.at, "`@unique` applies to a single value field; a connection's arity already says how many");
      } else if (attr.name === "color" && isFixed(owner)) {
        report("misplaced-attribute", attr.at, "A fixed model's colors go on its rows; a `@color` field is for `@@seed` models");
      }
    }
  };
  for (const model of models.values()) {
    for (const member of model.members) {
      if (member.kind === "field" && isValueType(member.type)) checkFieldAttrs(member.attrs, member.arity, member.type, model.name);
      if (member.kind === "end") checkFieldAttrs(member.attrs, member.arity, null, model.name, { decl: member, named: true });
    }
    const colorFields = model.members.filter((m) => m.kind === "field" && m.attrs.some((a) => a.name === "color"));
    if (colorFields.length > 1) {
      report("duplicate-color", colorFields[1]!.at, "Only one field per model can hold the row's color");
    }
  }
  for (const decl of file.declarations) {
    if (decl.kind !== "connection") continue;
    for (const member of decl.members) if (member.kind === "end") checkFieldAttrs(member.attrs, member.arity, null, member.model, { decl: member, named: false });
  }

  // 5. Model attributes.
  for (const model of models.values()) {
    const fields = fieldMaps.get(model.name)!;
    const seen = new Set<string>();
    const modelEnds = model.members.filter((m): m is EndDecl => m.kind === "end");
    const rows = model.members.filter((m): m is RowsBlock => m.kind === "rows");

    for (const member of model.members) {
      if (member.kind !== "modelAttribute" && member.kind !== "rows") continue;
      const name = member.kind === "rows" ? "rows" : member.name;
      if (seen.has(name)) {
        report("duplicate-attribute", member.at, member.kind === "rows" ? "A model has at most one `@@fixed` or `@@seed` block" : `\`@@${name}\` appears twice`);
        continue;
      }
      seen.add(name);
      if (member.kind === "rows") continue;
      if (member.name === "fixed" || member.name === "seed") {
        report("syntax", member.at, `\`@@${member.name}\` takes a block of rows: \`@@${member.name} { A, B }\``);
      } else if (!MODEL_ATTRIBUTES.includes(member.name)) {
        report("unknown-attribute", member.at, `Unknown model attribute \`@@${member.name}\``);
      } else if (member.name === "views") {
        checkViews(member, model.name, fields, report);
      } else if (member.name === "editableBy") {
        if (member.args.length === 0) report("attribute-arguments", member.at, "`@@editableBy` names at least one field");
        for (const arg of member.args) {
          if (arg.kind !== "ident") {
            report("attribute-arguments", arg.at, "`@@editableBy` takes field names");
            continue;
          }
          const field = fields.get(arg.name);
          if (!field) report("unknown-field", arg.at, `\`${model.name}\` has no field \`${arg.name}\``);
          else if (field.type !== "Person") report("editable-by-person", arg.at, `\`${arg.name}\` holds ${field.type}, not Person`);
        }
      } else if (member.name === "id") {
        const entry = resolved.get(model.name)!;
        if (rows.length > 0) {
          report("id-on-rows", member.at, "Rows written in the schema are identified by their names");
          continue;
        }
        entry.key = member.args.length === 0 ? ["id"] : [];
        for (const arg of member.args) {
          if (arg.kind !== "ident") {
            report("attribute-arguments", arg.at, "`@@id` takes field names");
            continue;
          }
          if (arg.name === "id") {
            entry.key.push("id"); // the implicit id, now unique only alongside the other key fields
            continue;
          }
          const field = fields.get(arg.name);
          if (!field) report("unknown-field", arg.at, `\`${model.name}\` has no field \`${arg.name}\``);
          else if (field.arity !== "one") report("id-field", arg.at, `\`${arg.name}\` is part of the key, so it must hold exactly one value`);
          else entry.key.push(arg.name);
        }
      } else if (member.name === "fold" || member.name === "table") {
        if (modelEnds.length === 0) {
          report("storage-on-plain-model", member.at, `\`@@${member.name}\` chooses storage for a connection; \`${model.name}\` has no ends`);
        } else if (member.name === "fold") {
          const arg = member.args[0];
          if (member.args.length !== 1 || arg?.kind !== "ident") {
            report("attribute-arguments", member.at, "`@@fold` names one model: `@@fold(List)`");
          } else if (!modelEnds.some((e) => e.model === arg.name)) {
            report("fold-target", arg.at, `\`${model.name}\` can fold only into a model it connects, not \`${arg.name}\``);
          } else if (arg.name === "Person" || isFixed(arg.name)) {
            report("stored-on-fixed", arg.at, `\`${arg.name}\` has no table to fold into`);
          }
        } else if (member.args.length > 0) {
          report("attribute-arguments", member.at, "`@@table` takes no arguments");
        }
      }
    }
    if (seen.has("fold") && seen.has("table")) {
      const second = model.members.find((m) => m.kind === "modelAttribute" && m.name === "table")!;
      report("fold-and-table", second.at, "`@@fold` and `@@table` contradict each other");
    }

    const block = rows[0];
    if (block) checkRows(model, block, modelEnds, report);

    const entry = resolved.get(model.name)!;
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
    const on = candidates.find((e) => hasTable(e.model));
    if (on) {
      storage = nm ? { kind: "array", on: on.model, field: on.field, sqlite: "join table" } : { kind: "column", on: on.model, field: on.field };
    }
    if (!storage) {
      const where = [...new Set(candidates.map((e) => e.model))].join(" or ");
      report(
        "stored-on-fixed",
        a.at,
        `\`${label[0]} <-> ${label[1]}\` would be stored on ${where}, which ${candidates.length > 1 ? "have" : "has"} no table (Person and fixed models don't)`,
      );
      continue;
    }
    const within = identArg(a.attrs, "within") ?? identArg(b.attrs, "within");
    connections.push(within ? { ends: label, storage, within } : { ends: label, storage });
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

  diagnostics.sort((x, y) => x.line - y.line || x.column - y.column);
  return { diagnostics, models: [...resolved.values()], connections };
}

type Report = (code: string, at: Position, message: string) => void;

function checkViews(attr: ModelAttribute, model: string, fields: Map<string, ResolvedField>, report: Report) {
  const list = attr.args[0];
  if (attr.args.length !== 1 || list?.kind !== "list") {
    report("attribute-arguments", attr.at, "`@@views` takes one list of views: `@@views([ { label: ... }, ... ])`");
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
            if (a.name !== "bullet") report("unknown-attribute", a.at, `\`@${a.name}\` isn't presentation; only \`@bullet\` goes in a line`);
            else if (++bullets > 1) report("duplicate-bullet", a.at, "A line has at most one `@bullet`");
          }
        }
      } else if (entry.key === "group" || entry.key === "sort") {
        fieldRef(entry.value, entry.key === "sort");
        if (entry.value.kind === "ident" && entry.value.attrs.length > 0) {
          report("misplaced-attribute", entry.value.attrs[0]!.at, "Attributes go on the items of a `line`");
        }
      }
    }
  }
}

function checkRows(model: ModelDecl, block: RowsBlock, modelEnds: EndDecl[], report: Report) {
  if (modelEnds.length > 0) {
    report("rows-with-ends", block.at, `\`${model.name}\` is a connection; its rows can't be written in the schema`);
  }
  const fields = new Map(
    model.members.filter((m): m is FieldDecl => m.kind === "field" && isValueType(m.type)).map((f) => [f.name, f]),
  );
  if (block.mode === "seed") {
    const name = fields.get("name");
    if (!name || name.type !== "Text" || name.arity !== "one") {
      report("seed-needs-name", block.at, "A `@@seed` model needs a `name Text` field, so people can rename its rows");
    }
  }
  const names = new Set<string>();
  for (const row of block.rows) {
    if (names.has(row.name)) report("duplicate-row", row.at, `Row "${row.name}" appears twice`);
    names.add(row.name);
    for (const attr of row.attrs) {
      if (attr.name !== "color") report("unknown-attribute", attr.at, `Unknown row attribute \`@${attr.name}\``);
      else if (block.mode === "seed") report("misplaced-attribute", attr.at, "A `@@seed` row's color is data; give it a value for the `@color` field");
      else if (attr.args.length !== 1 || attr.args[0]!.kind !== "string" || !COLOR.test(attr.args[0]!.value)) {
        report("bad-color", attr.at, 'A row color is `@color("#rrggbb")`');
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
  if (field.attrs.some((a) => a.name === "color") && value.kind === "string" && !COLOR.test(value.value)) {
    report("bad-color", value.at, 'A color is "#rrggbb"');
  }
}
