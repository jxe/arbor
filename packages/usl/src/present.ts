// Presented views: a collection's rows arranged by one of its views, and the
// inverse that turns what a person does to that arrangement into row
// operations (spec 10 §4.1). Story's structured editor draws a presentation
// and sends intents; the host applies the row operations and presents again.
//
// - Rows are the data-file rows `layoutOf(…, { store: "files" })` lays out,
//   by table name, in creation order. A row is named by its canonical stable
//   key, the JSON of its key's column and value pairs: `[["id","g1"]]`.
// - A view is one of the model's `~views`, or its default arrangement: the
//   line is every field in order, with one grouping per field that refers to
//   another model (fixed, `Person` or with rows).
// - A grouped view has a group for each value the field can refer to, in the
//   order they're written or created, and "Unassigned" for rows in none of
//   them. A row appears under every group it belongs to. A group stored as
//   an `ordered` list keeps that order and can be reordered; otherwise lines
//   keep the rows' creation order. A line lists a connection's members by
//   its `~sort(field)`, otherwise in their stored order or the order they
//   were connected; `group: field ~sort(name)` orders the groups likewise.
// - `sort` orders lines by a field (newest first for `created` and
//   `modified`, rows without one last); in groups whose order is stored it
//   orders the groups instead, by their own rows.
// - Presentation never changes data. Grouping is never stored: an edit made
//   under any group changes the one row.
//
// Ported from cranberries' `src/model.ts`: `groups`, `sortGroups`, `search`,
// `newEntity`, `apply` (`applyRowEdits`), `checkValue`/`validate`
// (`checkFieldValue`, `checkRows`). Ownership (`canEdit`) is access policy,
// so a host supplies it as `canEdit`.

import type { CheckResult, LineItem, ResolvedField, ResolvedModel, ResolvedView } from "./check.ts";
import { layoutOf, type Column, type JoinEnd, type Table } from "./layout.ts";
import type { RowsByTable } from "./records.ts";
import { PERSON_RELATION, personPlaceholderKey } from "./relationships.ts";
import { fitsColumn, validateRow } from "./rows.ts";

export type Scalar = string | number | boolean;
export type Json = null | Scalar | Json[] | { [key: string]: Json };
type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Presentation types. These are the shape both stacks produce, and what the
// conformance vectors (`presented-views.json`) bind.

export interface Chip {
  /** The member as stored: a row's key value, a profile id, a fixed row's name, or a listed value. */
  member: Scalar;
  name: string;
  color?: string;
  /** A `Person` placeholder (`contact:<key>`): someone with no profile yet. */
  placeholder?: true;
}

export type Cell =
  | { kind: "text"; field: string; type: "Text" | "Int" | "Number" | "Bool" | "Date"; value: Scalar | null; ago?: true }
  | { kind: "markdown"; field: string; value: string | null; paragraph: string }
  | { kind: "chips"; field: string; chips: Chip[]; summary?: true; label?: string }
  | { kind: "choice"; field: string; value: string | null; color?: string; bullet?: true };

export interface PresentedLine {
  /** The row's stable key. */
  row: string;
  /** Stable across presentations: the view, the group and the row. */
  occurrence: string;
  /** The `~bullet` choice's color, which colors the line too. */
  color?: string;
  cells: Cell[];
}

export type GroupKind = "flat" | "connection" | "choice" | "unassigned";

export interface PresentedGroup {
  /** "" for a flat view, "unassigned", or the JSON of the group's member. */
  id: string;
  kind: GroupKind;
  heading: string;
  member?: Scalar;
  color?: string;
  /** A `Person` group whose member is a placeholder. */
  placeholder?: true;
  /** A connection group whose member is a row: that row's table and key. */
  table?: string;
  row?: string;
  /** The field of `row` its heading edits; absent when the heading is read-only. */
  headingField?: string;
  /** Lines can be reordered: the group's order is stored (`ordered`). */
  ordered: boolean;
  /** What Delete does to a line here: disconnects it from this group, or deletes the row. */
  remove: "disconnect" | "delete";
  lines: PresentedLine[];
}

export interface RowCapabilities {
  edit: boolean;
  delete: boolean;
  /** The groups of this view the row is in, so "Delete row" can name them. */
  groups: string[];
}

export interface Presentation {
  model: string;
  table: string;
  tabs: { label: string }[];
  tab: number;
  group?: string;
  groups: PresentedGroup[];
  /** For each choice or chips field of the line: what a picker offers. */
  options: Record<string, Chip[]>;
  capabilities: Record<string, RowCapabilities>;
}

export interface Person {
  id: string;
  name: string;
}

export interface PresentOptions {
  /** The model whose rows are the lines: by default the one with `~views`, else the first with rows. */
  model?: string;
  /** Which view, by index into the views (default 0). */
  view?: number;
  /** A page's override of the model's views. */
  views?: ResolvedView[];
  /** People's profile ids and display names, in the order a `Person` grouping and picker list them. */
  people?: Person[];
  /** Filters lines by their text, choices and related names. */
  query?: string;
  /** Whether a row may be changed (ownership is access policy). Everything is editable by default. */
  canEdit?: (table: string, row: string) => boolean;
}

// ---------------------------------------------------------------------------
// Row operations, as spec 10 §4.1 defines them, without the change-scoped
// `key` and the `collection` reference, which the publisher adds.

export type RowEdit = { table: string; row: string } & (
  | { kind: "rowCreate"; values: Record<string, Json>; at?: string }
  | { kind: "rowDelete" }
  | { kind: "rowSet"; field: string; before: Json; value: Json; at?: string }
  | { kind: "rowConnect" | "rowDisconnect"; field: string; member: Scalar; at?: string }
  | { kind: "rowMove"; field: string; member: Scalar; after: Scalar | null; at?: string }
);

/** What a person does to a presented view. Rows and groups are named as the presentation names them. */
export type ViewIntent = { at?: string } & (
  /** Set one field of a row: a value, a single reference, or a whole list. */
  | { kind: "set"; row: string; field: string; value: Json }
  | { kind: "connect" | "disconnect"; row: string; field: string; member: Scalar }
  /** A new row, in a group (preset its field, or connect the group's row to it), placed after a line of an ordered group. */
  | { kind: "create"; id: string; group?: string; values?: Record<string, Json>; after?: string | null }
  /** "Delete row": always deletes, disconnecting it from every row that refers to it. */
  | { kind: "delete"; row: string }
  /** The Delete key on a line: disconnects in a connection group, deletes in a flat or choice-grouped view. */
  | { kind: "remove"; row: string; group: string }
  /** Within an ordered group: place the row after another line, or first. */
  | { kind: "move"; row: string; group: string; after: string | null }
  /** Drag to another group. */
  | { kind: "regroup"; row: string; from: string; to: string; after?: string | null }
  /** Edit a connection group's heading: that row's name. */
  | { kind: "rename"; group: string; value: string }
);

export class ViewError extends Error {}

// ---------------------------------------------------------------------------
// JSON helpers that both stacks spell the same way.

const isScalar = (v: unknown): v is Scalar =>
  typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

/** JSON with object keys sorted by code point: equality of JSON values. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Row).filter(([, v]) => v !== undefined).sort(([a], [b]) => compareText(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);

/** Orders strings by Unicode code point, which Swift's unicode scalars give too. */
export function compareText(a: string, b: string): number {
  const x = [...a], y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** A row's canonical stable key, or null when a key column holds no scalar. */
export function rowKey(table: Table, row: Row): string | null {
  const pairs: [string, Scalar][] = [];
  for (const column of table.primaryKey) {
    const value = row[column];
    if (!isScalar(value)) return null;
    pairs.push([column, value]);
  }
  return JSON.stringify(pairs);
}

/** The first paragraph of Markdown: its first run of non-blank lines, trimmed. */
export function firstParagraph(markdown: string): string {
  const lines = markdown.split(/\r\n|\n|\r/);
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") start++;
  let end = start;
  while (end < lines.length && lines[end]!.trim() !== "") end++;
  return lines.slice(start, end).map((l) => l.trim()).join(" ");
}

/** A scalar as a person reads it. */
const scalarText = (v: Scalar) => (typeof v === "string" ? v : String(v));

// ---------------------------------------------------------------------------
// Where a field's members are stored, relative to a row of its model.

type Access =
  /** A value field on the row. */
  | { kind: "value"; column: string; many: boolean }
  /** A single reference on the row, with the column ordering the target's list of these rows. */
  | { kind: "column"; column: string; target: string; nullable: boolean; key: boolean; position?: string }
  /** References folded into an array on the row. */
  | { kind: "array"; column: string; target: string }
  /** The target's rows hold this row's key in an array (the other end is folded). */
  | { kind: "otherArray"; table: Table; column: string; target: string; ordered: boolean }
  /** The target's rows hold this row's key in a column (the many side of 1:n, or a connection model). */
  | { kind: "otherColumn"; table: Table; column: string; target: string; nullable: boolean; position?: string }
  /** A join table. */
  | { kind: "join"; table: Table; mine: JoinEnd; theirs: JoinEnd; target: string };

const VALUE_TYPES = new Set(["Text", "Markdown", "Int", "Number", "Bool", "Date"]);

/** The lines of a view of Person are keyed by profile id, as `[["id", "tr_..."]]`. */
const PERSON_TABLE = { name: PERSON_RELATION, stores: PERSON_RELATION, primaryKey: ["id"], columns: [], fields: [] } as unknown as Table;

/** Values without repeats, in first-seen order. */
function distinct(values: Scalar[]): Scalar[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = canonical(v);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A schema and its rows, with what a view needs to read them. */
class Collection {
  readonly models: Map<string, ResolvedModel>;
  readonly tables: Table[];
  private readonly byModel = new Map<string, Table>();
  rows: RowsByTable;

  readonly people: Person[];

  constructor(readonly schema: CheckResult, rows: RowsByTable, people: Person[] = []) {
    this.people = people;
    if (schema.diagnostics.length > 0) throw new ViewError("The schema has errors; check it first");
    this.models = new Map(schema.models.map((m) => [m.name, m]));
    this.tables = layoutOf(schema, { store: "files" });
    for (const table of this.tables) if (!table.ends) this.byModel.set(table.stores, table);
    this.rows = rows;
  }

  model(name: string): ResolvedModel {
    const model = this.models.get(name);
    if (!model) throw new ViewError(`No model \`${name}\``);
    return model;
  }

  tableOf(model: string): Table | undefined {
    return this.byModel.get(model);
  }

  /** The table a row operation names: a model's table by the model's name, a join table by its own. */
  tableNamed(name: string): Table {
    const table = this.byModel.get(name) ?? this.tables.find((t) => t.ends && t.name === name);
    if (!table) throw new ViewError(`No table \`${name}\``);
    return table;
  }

  /** The name a row operation gives a table. */
  opName(table: Table): string {
    return table.ends ? table.name : table.stores;
  }

  rowsOf(table: Table): Row[] {
    return (this.rows[table.name] ?? []) as Row[];
  }

  isFixed(model: string) {
    return this.models.get(model)?.rows === "fixed";
  }

  /** The value naming a row of `model` in a reference: its one key column's value. */
  memberOf(model: string, row: Row): Scalar {
    if (model === PERSON_RELATION) return row.id as Scalar;
    const table = this.tableOf(model)!;
    if (table.primaryKey.length !== 1) throw new ViewError(`\`${model}\` has a key of several columns; a view refers to rows by one`);
    const value = row[table.primaryKey[0]!];
    if (!isScalar(value)) throw new ViewError(`A row of \`${model}\` has no key`);
    return value;
  }

  findRow(table: Table, key: string): Row | undefined {
    return this.rowsOf(table).find((r) => rowKey(table, r) === key);
  }

  /** The row of `model` a reference names. */
  rowByMember(model: string, member: Scalar): Row | undefined {
    const table = this.tableOf(model);
    if (!table) return undefined;
    return this.rowsOf(table).find((r) => same(r[table.primaryKey[0]!], member));
  }

  access(model: ResolvedModel, field: ResolvedField): Access {
    const table = this.tableOf(model.name);
    // Person has no table: its fields are the other ends of connections.
    if (!table && model.name !== PERSON_RELATION) throw new ViewError(`\`${model.name}\` has no rows`);
    const stored = table?.fields.find((f) => f.name === field.name);
    if (stored && !stored.target) return { kind: "value", column: stored.columns[0]!, many: field.arity === "many" };
    if (stored && stored.target) {
      if (stored.columns.length !== 1) throw new ViewError(`\`${model.name}.${field.name}\` refers to a key of several columns`);
      const column = table!.columns.find((c) => c.name === stored.columns[0])!;
      if (column.array) return { kind: "array", column: column.name, target: stored.target };
      const position = this.positionOn(model, field);
      return {
        kind: "column",
        column: column.name,
        target: stored.target,
        nullable: column.nullable,
        key: table!.primaryKey.includes(column.name),
        ...(position ? { position } : {}),
      };
    }
    // The other side of a connection model.
    const through = this.models.get(field.type);
    const end = through && through.ends.length >= 2 ? through.ends.find((e) => e.model === model.name && e.field === field.name) : undefined;
    if (through && end) {
      const holder = this.tableOf(through.name)!;
      const column = holder.fields.find((f) => f.name === end.as)!.columns[0]!;
      return {
        kind: "otherColumn",
        table: holder,
        column,
        target: through.name,
        nullable: false,
        ...(end.ordered ? { position: `${end.field}_position` } : {}),
      };
    }
    for (const connection of this.schema.connections) {
      const mine = [connection.a, connection.b].find((e) => e.model === model.name && e.field === field.name);
      if (!mine) continue;
      const other = mine === connection.a ? connection.b : connection.a;
      const holder = this.tableOf(other.model);
      const held = holder?.fields.find((f) => f.name === other.field);
      if (holder && held) {
        const column = holder.columns.find((c) => c.name === held.columns[0])!;
        if (column.array) return { kind: "otherArray", table: holder, column: column.name, target: other.model, ordered: other.ordered };
        return {
          kind: "otherColumn",
          table: holder,
          column: column.name,
          target: other.model,
          nullable: column.nullable,
          ...(mine.ordered ? { position: `${mine.field}_position` } : {}),
        };
      }
      const join = this.tables.find((t) => t.ends?.some((e) => e.model === model.name && e.field === field.name));
      if (join) {
        const ends = join.ends!;
        const mineEnd = ends[0].model === model.name && ends[0].field === field.name ? ends[0] : ends[1];
        const theirs = mineEnd === ends[0] ? ends[1] : ends[0];
        return { kind: "join", table: join, mine: mineEnd, theirs, target: other.model };
      }
    }
    throw new ViewError(`\`${model.name}.${field.name}\` isn't stored where a view can reach it`);
  }

  /** For a single reference on the row: the column that orders the target's list of these rows (`ordered` on the other end). */
  private positionOn(model: ResolvedModel, field: ResolvedField): string | undefined {
    const end = model.ends.find((e) => e.as === field.name);
    if (end) return end.ordered ? `${end.field}_position` : undefined;
    for (const c of this.schema.connections) {
      const mine = [c.a, c.b].find((e) => e.model === model.name && e.field === field.name);
      if (!mine) continue;
      const other = mine === c.a ? c.b : c.a;
      return other.ordered ? `${other.field}_position` : undefined;
    }
    return undefined;
  }

  /** The members `row` of `model` holds in `field`, in their order. */
  members(model: ResolvedModel, field: ResolvedField, row: Row): Scalar[] {
    return this.membersBy(model, this.access(model, field), row);
  }

  /** Members of `target` by one of its fields (`~sort`): newest first for `created` and `modified`, members without it last. */
  sortMembers<T>(target: string, sort: string, items: T[], memberOf: (item: T) => Scalar = (item) => item as Scalar): T[] {
    const descending = sort === "created" || sort === "modified";
    return sortBy(items, (item) => this.memberSortKey(target, sort, memberOf(item)), descending);
  }

  memberSortKey(target: string, sort: string, member: Scalar): Scalar | undefined {
    if (target === "Person") return sort === "name" ? this.chip(target, member).name : undefined;
    const model = this.models.get(target);
    if (model?.rows === "fixed") {
      if (sort === "name") return member;
      const value = model.schemaRows.find((r) => r.name === member)?.values[sort];
      return isScalar(value) ? value : undefined;
    }
    const row = this.rowByMember(target, member);
    return row && model ? sortKey(this, model, sort, row) : undefined;
  }

  membersBy(model: ResolvedModel, access: Access, row: Row): Scalar[] {
    switch (access.kind) {
      case "value": {
        const value = row[access.column];
        if (access.many) return Array.isArray(value) ? value.filter(isScalar) : [];
        return isScalar(value) ? [value] : [];
      }
      case "column": {
        const value = row[access.column];
        return isScalar(value) ? [value] : [];
      }
      case "array": {
        const value = row[access.column];
        return Array.isArray(value) ? value.filter(isScalar) : [];
      }
      case "otherArray": {
        const key = this.memberOf(model.name, row);
        return this.rowsOf(access.table)
          .filter((t) => Array.isArray(t[access.column]) && (t[access.column] as unknown[]).some((m) => same(m, key)))
          .map((t) => this.memberOf(access.target, t));
      }
      case "otherColumn": {
        const key = this.memberOf(model.name, row);
        const held = this.rowsOf(access.table).filter((t) => same(t[access.column], key));
        const ordered = access.position ? byPosition(held, access.position) : held;
        return ordered.map((t) => this.memberOf(access.target, t));
      }
      case "join": {
        const key = this.memberOf(model.name, row);
        const held = this.rowsOf(access.table).filter((t) => same(t[access.mine.columns[0]!], key));
        const ordered = access.mine.position ? byPosition(held, access.mine.position) : held;
        return ordered.map((t) => t[access.theirs.columns[0]!]).filter(isScalar);
      }
    }
  }

  /** The field a row of `model` is called by: `name`, its `path` field, or its first single `Text` field. */
  nameField(model: string): string | undefined {
    const resolved = this.models.get(model);
    if (!resolved) return undefined;
    const single = (f: ResolvedField) => f.type === "Text" && f.arity !== "many" && f.origin === "declared";
    const field = resolved.fields.find((f) => f.name === "name" && single(f))
      ?? resolved.fields.find((f) => f.name === resolved.path)
      ?? resolved.fields.find(single);
    return field ? field.column ?? field.name : undefined;
  }

  /** A member's chip: its display name and color. */
  chip(target: string, member: Scalar): Chip {
    if (target === "Person") {
      const placeholder = personPlaceholderKey(member);
      const name = this.people.find((p) => p.id === member)?.name ?? placeholder ?? scalarText(member);
      return { member, name, ...(placeholder !== undefined ? { placeholder: true } : {}) };
    }
    if (VALUE_TYPES.has(target)) return { member, name: scalarText(member) };
    const model = this.models.get(target);
    if (model?.rows === "fixed") {
      const row = model.schemaRows.find((r) => r.name === member);
      return { member, name: scalarText(member), ...(row?.color ? { color: row.color } : {}) };
    }
    const row = this.rowByMember(target, member);
    const nameField = this.nameField(target);
    const name = row && nameField && typeof row[nameField] === "string" ? (row[nameField] as string) : scalarText(member);
    const colorField = model?.fields.find((f) => f.color);
    const color = row && colorField ? row[colorField.column ?? colorField.name] : undefined;
    return { member, name, ...(typeof color === "string" ? { color } : {}) };
  }

  /** The table a view's lines are keyed by: a model's, or for Person one keyed by profile id. */
  linesTable(model: string): Table | undefined {
    return model === PERSON_RELATION ? PERSON_TABLE : this.tableOf(model);
  }

  /** Person's rows: every person a Person field of any row names, in table, row and column order. */
  personRows(): Row[] {
    const seen = new Set<string>();
    const out: Row[] = [];
    for (const table of this.tables) {
      for (const row of this.rowsOf(table)) {
        for (const column of table.columns) {
          if (!column.profile) continue;
          const value = row[column.name];
          for (const v of Array.isArray(value) ? value : [value]) {
            if (typeof v === "string" && !seen.has(v)) {
              seen.add(v);
              out.push({ id: v });
            }
          }
        }
      }
    }
    return out;
  }

  /** The row of `model` a member names; a person's is just their id. */
  rowOf(model: string, member: Scalar): Row | undefined {
    return model === PERSON_RELATION ? { id: member } : this.rowByMember(model, member);
  }

  /**
   * The values a field, or a path through connections (`ties.group`), gives
   * for `rows` of `model`: distinct, in the order they are reached. `many`
   * when a step can give several. A person's `name` is the person.
   */
  pathValues(model: ResolvedModel, rows: Row[], path: string): { field?: ResolvedField; values: Scalar[]; many: boolean } {
    const steps = path.split(".");
    let owner = model;
    let current = rows;
    let many = false;
    for (const [i, step] of steps.entries()) {
      const last = i === steps.length - 1;
      if (last && owner.name === PERSON_RELATION && step === "name") return { values: distinct(current.map((r) => r.id as Scalar)), many };
      if (last && (step === "created" || step === "modified")) {
        return { values: distinct(current.flatMap((r) => (typeof r[step] === "string" ? [r[step] as string] : []))), many };
      }
      const field = owner.fields.find((f) => f.name === step);
      if (!field) throw new ViewError(`\`${owner.name}\` has no field \`${step}\``);
      if (field.arity === "many") many = true;
      const values = distinct(current.flatMap((r) => this.members(owner, field, r)));
      if (last) return { field, values, many };
      owner = this.model(field.type);
      const target = field.type;
      current = values.flatMap((v): Row[] => {
        const row = this.rowOf(target, v);
        return row ? [row] : [];
      });
    }
    throw new ViewError("An empty path");
  }

  /** Everything a field can refer to, for a picker and for groups. */
  candidates(target: string): Chip[] {
    if (target === "Person") return this.people.map((p) => this.chip("Person", p.id));
    const model = this.models.get(target);
    if (model?.rows === "fixed") return model.schemaRows.map((r) => this.chip(target, r.name));
    const table = this.tableOf(target);
    if (!table) return [];
    return this.rowsOf(table).flatMap((r) => (rowKey(table, r) === null ? [] : [this.chip(target, this.memberOf(target, r))]));
  }
}

function byPosition(rows: Row[], position: string): Row[] {
  return rows
    .map((row, i) => ({ row, i, at: typeof row[position] === "number" ? (row[position] as number) : Infinity }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.i - b.i))
    .map((x) => x.row);
}

// ---------------------------------------------------------------------------
// Views.

/**
 * The model a collection presents: its `main` model, else the one with
 * `~views`, else Person when `re Person` gives it views and no model with rows
 * has any, else the first with rows.
 */
export function presentedModel(schema: CheckResult): string {
  const data = schema.models.filter((m) => m.name !== PERSON_RELATION && m.rows !== "fixed");
  const person = schema.models.find((m) => m.name === PERSON_RELATION && m.views.length > 0);
  if (person && !data.some((m) => m.views.length > 0)) return person.name;
  const model = data.find((m) => m.main) ?? data.find((m) => m.views.length > 0) ?? data.find((m) => m.ends.length < 2) ?? data[0];
  if (!model) throw new ViewError("The schema has no model with rows");
  return model.name;
}

/** A model's views: its `~views`, or the default arrangement. A view without a line shows every field. */
export function viewsOf(schema: CheckResult, modelName: string): ResolvedView[] {
  const model = schema.models.find((m) => m.name === modelName);
  if (!model) throw new ViewError(`No model \`${modelName}\``);
  const line: LineItem[] = model.fields.map((f) => ({ field: f.name, bullet: false, summary: false }));
  if (model.views.length > 0) return model.views.map((v) => (v.line.length > 0 ? v : { ...v, line }));
  return [
    { label: "All", line },
    ...model.fields.filter((f) => !VALUE_TYPES.has(f.type)).map((f) => ({ label: `By ${f.name}`, line, group: f.name })),
  ];
}

interface Arranged {
  id: string;
  kind: GroupKind;
  heading: string;
  member?: Scalar;
  color?: string;
  placeholder?: true;
  table?: Table;
  row?: string;
  ordered: boolean;
  remove: "disconnect" | "delete";
  rows: Row[];
}

interface Arrangement {
  collection: Collection;
  model: ResolvedModel;
  table: Table;
  views: ResolvedView[];
  index: number;
  view: ResolvedView;
  field?: ResolvedField;
  access?: Access;
  groups: Arranged[];
}

const canDisconnect = (access: Access) =>
  access.kind === "column" ? access.nullable && !access.key : access.kind === "otherColumn" ? access.nullable : true;

/** cranberries' `groups` and `sortGroups`, over rows. */
function arrange(collection: Collection, options: PresentOptions): Arrangement {
  const model = collection.model(options.model ?? presentedModel(collection.schema));
  const table = collection.linesTable(model.name);
  if (!table) throw new ViewError(`\`${model.name}\` has no rows to present`);
  const views = options.views ?? viewsOf(collection.schema, model.name);
  const index = options.view ?? 0;
  const view = views[index];
  if (!view) throw new ViewError(`No view ${index}`);
  const all = model.name === PERSON_RELATION ? collection.personRows() : collection.rowsOf(table).filter((r) => rowKey(table, r) !== null);
  const base = { collection, model, table, views, index, view };
  // Lines summed up over several rows are sorted as lines, by presentView.
  const sortHere = (groups: Arranged[]) => (summarized(model, view) ? groups : sortGroups(collection, model, view, groups));
  if (!view.group) {
    const groups: Arranged[] = [{ id: "", kind: "flat", heading: "", ordered: false, remove: "delete", rows: all }];
    return { ...base, groups: sortHere(groups) };
  }
  // A path (`ties.group`), or any field of Person, groups by the values it reaches.
  const byPath = view.group.includes(".") || model.name === PERSON_RELATION;
  const field = byPath ? collection.pathValues(model, [], view.group).field : model.fields.find((f) => f.name === view.group);
  if (!field) throw new ViewError(`\`${model.name}\` has no field \`${view.group}\``);
  const access = byPath ? undefined : collection.access(model, field);
  const target = field.type;
  const kind: GroupKind = target === "Person" || (!VALUE_TYPES.has(target) && !collection.isFixed(target)) ? "connection" : "choice";
  const members = new Map(all.map((r) => [r, access ? collection.membersBy(model, access, r) : collection.pathValues(model, [r], view.group!).values] as const));

  // The groups: everything the field can refer to, then members nobody listed (people, values).
  const listedFirst = VALUE_TYPES.has(target) ? [] : collection.candidates(target);
  const candidates = view.groupSort ? collection.sortMembers(target, view.groupSort, listedFirst, (c) => c.member) : listedFirst;
  const listed = new Set(candidates.map((c) => canonical(c.member)));
  if (target === "Person" || VALUE_TYPES.has(target)) {
    for (const r of all) {
      for (const m of members.get(r)!) {
        if (listed.has(canonical(m))) continue;
        listed.add(canonical(m));
        candidates.push(collection.chip(target, m));
      }
    }
  }
  const ordered = !access ? false : access.kind === "otherArray" ? access.ordered : access.kind === "join" ? Boolean(access.theirs.position) : access.kind === "column" && Boolean(access.position);
  const targetTable = kind === "connection" ? collection.tableOf(target) : undefined;
  const remove = kind === "connection" && access && canDisconnect(access) ? "disconnect" : "delete";
  const groups: Arranged[] = candidates.map((c) => {
    const inGroup = all.filter((r) => members.get(r)!.some((m) => same(m, c.member)));
    let rows = inGroup;
    if (!access) {
      // A path keeps the lines' own order.
    } else if (access.kind === "otherArray") {
      // The list's own order: the group's row holds its members.
      const owner = collection.rowByMember(target, c.member);
      const list = (Array.isArray(owner?.[access.column]) ? owner![access.column] : []) as unknown[];
      rows = list.flatMap((m) => inGroup.filter((r) => same(collection.memberOf(model.name, r), m)));
    } else if (access.kind === "join") {
      const joined = collection.rowsOf(access.table).filter((j) => same(j[access.theirs.columns[0]!], c.member));
      const sorted = access.theirs.position ? byPosition(joined, access.theirs.position) : joined;
      rows = sorted.flatMap((j) => inGroup.filter((r) => same(collection.memberOf(model.name, r), j[access.mine.columns[0]!])));
    } else if (access.kind === "column" && access.position) {
      rows = byPosition(inGroup, access.position);
    }
    const groupRow = targetTable ? collection.rowByMember(target, c.member) : undefined;
    return {
      id: JSON.stringify(c.member),
      kind,
      heading: c.name,
      member: c.member,
      ...(c.color ? { color: c.color } : {}),
      ...(c.placeholder ? { placeholder: true } : {}),
      ...(targetTable && groupRow ? { table: targetTable, row: rowKey(targetTable, groupRow)! } : {}),
      ordered,
      remove,
      rows,
    };
  });
  const unassigned = all.filter((r) => !members.get(r)!.some((m) => listed.has(canonical(m))));
  if (unassigned.length) groups.push({ id: "unassigned", kind: "unassigned", heading: "Unassigned", ordered: false, remove: "delete", rows: unassigned });
  return { ...base, field, ...(access ? { access } : {}), groups: sortHere(groups) };
}

/** Whether a view's lines are summed up over rows (`rows:`), are people, or sort by a path: sorted as lines. */
function summarized(model: ResolvedModel, view: ResolvedView): boolean {
  return Boolean(view.rows) || model.name === PERSON_RELATION || Boolean(view.sort?.includes("."));
}

/** Newest first for `created` and `modified`; otherwise ascending. Rows without the field keep their place, last. */
function sortKey(collection: Collection, model: ResolvedModel, sort: string, row: Row): Scalar | undefined {
  if (sort === "created" || sort === "modified") return typeof row[sort] === "string" ? (row[sort] as string) : undefined;
  if (sort === "id") return isScalar(row.id) ? row.id : undefined;
  const field = model.fields.find((f) => f.name === sort);
  if (!field) return undefined;
  const members = collection.members(model, field, row);
  if (members.length === 0) return undefined;
  return VALUE_TYPES.has(field.type) ? members[0] : collection.chip(field.type, members[0]!).name;
}

/** `~latest` or `~earliest` of several values: the greatest or least, as one value. */
function pick(values: Scalar[], aggregate: "latest" | "earliest" | "count"): Scalar[] {
  if (values.length === 0 || aggregate === "count") return [];
  const sorted = [...values].sort(compareScalars);
  return [aggregate === "latest" ? sorted[sorted.length - 1]! : sorted[0]!];
}

function compareScalars(a: Scalar, b: Scalar): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return compareText(scalarText(a), scalarText(b));
}

function sortBy<T>(items: T[], key: (item: T) => Scalar | undefined, descending: boolean): T[] {
  return items
    .map((item, i) => ({ item, i, key: key(item) }))
    .sort((x, y) => {
      if (x.key === undefined || y.key === undefined) return x.key === undefined && y.key === undefined ? x.i - y.i : x.key === undefined ? 1 : -1;
      const d = compareScalars(x.key, y.key);
      return (descending ? -d : d) || x.i - y.i;
    })
    .map((x) => x.item);
}

/** cranberries' `sortGroups`: lines by the sort field, or, where groups keep their own order, the groups by their rows. */
function sortGroups(collection: Collection, model: ResolvedModel, view: ResolvedView, groups: Arranged[]): Arranged[] {
  const sort = view.sort;
  if (!sort) return groups;
  const descending = sort === "created" || sort === "modified";
  if (groups.some((g) => g.ordered)) {
    return sortBy(groups, (g) => {
      const row = g.table && g.row ? collection.findRow(g.table, g.row) : undefined;
      const owner = g.table ? collection.models.get(g.table.stores) : undefined;
      return row && owner ? sortKey(collection, owner, sort, row) : undefined;
    }, descending);
  }
  return groups.map((g) => ({ ...g, rows: sortBy(g.rows, (r) => sortKey(collection, model, sort, r), descending) }));
}

// ---------------------------------------------------------------------------
// presentView.

/** A collection's rows as one of its views presents them. */
export function presentView(schema: CheckResult, rows: RowsByTable, options: PresentOptions = {}): Presentation {
  const collection = new Collection(schema, rows, options.people);
  const arranged = arrange(collection, options);
  const { model, table, view, groups } = arranged;

  const lineItems = view.line;
  // A path's field is the one it ends at; a person's `name` has none.
  const fields = lineItems.map((item) => {
    const field = collection.pathValues(model, [], item.field).field;
    if (!field && !(model.name === PERSON_RELATION && item.field === "name")) throw new ViewError(`\`${model.name}\` has no field \`${item.field}\``);
    return { item, field };
  });
  const bullet = fields.find(({ item }) => item.bullet);
  const summed = summarized(model, view);

  /** One field's cell from its members, as a single row holds them. */
  const cellOf = (name: string, item: LineItem, field: ResolvedField, members: Scalar[]): Cell => {
    if (VALUE_TYPES.has(field.type) && field.arity !== "many") {
      const value = members[0] ?? null;
      if (field.type === "Markdown") {
        const text = typeof value === "string" ? value : null;
        return { kind: "markdown", field: name, value: text, paragraph: text === null ? "" : firstParagraph(text) };
      }
      return { kind: "text", field: name, type: field.type as "Text", value };
    }
    if (collection.isFixed(field.type) && field.arity !== "many") {
      const value = (members[0] as string | undefined) ?? null;
      const color = value === null ? undefined : collection.chip(field.type, value).color;
      return { kind: "choice", field: name, value, ...(color ? { color } : {}), ...(item.bullet ? { bullet: true as const } : {}) };
    }
    return chipsOf(name, item, field.type, members);
  };
  const chipsOf = (name: string, item: LineItem, type: string, members: Scalar[]): Cell => ({
    kind: "chips",
    field: name,
    chips: members.map((m) => collection.chip(type, m)),
    ...(item.summary ? { summary: true as const } : {}),
    ...(item.label ? { label: item.label } : {}),
  });

  const cell = (row: Row, item: LineItem, field: ResolvedField): Cell => {
    const connected = collection.members(model, field, row);
    const members = item.sort ? collection.sortMembers(field.type, item.sort, connected) : connected;
    return cellOf(field.name, item, field, members);
  };

  /**
   * An item summed up over the rows of a line: a path's values, or a field
   * over the rows `rows:` puts on one line. Several values are distinct
   * chips; `~latest`, `~earliest` and `~count` make them one.
   */
  const summedCell = (rows: Row[], item: LineItem, field: ResolvedField | undefined): Cell => {
    const { values, many } = collection.pathValues(model, rows, item.field);
    const several = many || (Boolean(view.rows) && item.field !== view.rows);
    let result: Cell;
    if (item.aggregate === "count") {
      result = { kind: "text", field: item.field, type: "Int", value: values.length };
    } else {
      const picked = item.aggregate ? pick(values, item.aggregate) : values;
      if (!field) result = chipsOf(item.field, item, PERSON_RELATION, picked);
      else if (several && !item.aggregate) result = chipsOf(item.field, item, field.type, picked);
      else result = cellOf(item.field, item, { ...field, arity: "one" }, picked);
    }
    return item.ago && result.kind === "text" ? { ...result, ago: true } : result;
  };

  /** A group's lines: one per row, or with `rows:` one per value of that field. */
  const sourcesOf = (rows: Row[]): { key: string; rows: Row[] }[] => {
    if (!view.rows) return rows.map((r) => ({ key: rowKey(table, r)!, rows: [r] }));
    const byValue = new Map<string, { key: string; rows: Row[] }>();
    for (const r of rows) {
      const value = collection.pathValues(model, [r], view.rows).values[0] ?? null;
      const id = canonical(value);
      const entry = byValue.get(id) ?? { key: JSON.stringify([[view.rows, value]]), rows: [] };
      entry.rows.push(r);
      byValue.set(id, entry);
    }
    return [...byValue.values()];
  };
  /** A line's sort key, summed up over its rows: `~latest` and dates of rows newest first. */
  const sortValue = (rows: Row[]): Scalar | undefined => {
    const sort = view.sort!;
    const { field, values } = collection.pathValues(model, rows, sort);
    const picked = view.sortAggregate ? pick(values, view.sortAggregate) : values;
    const value = picked[0];
    if (value === undefined) return undefined;
    if (!field) return collection.chip(PERSON_RELATION, value).name;
    return VALUE_TYPES.has(field.type) ? value : collection.chip(field.type, value).name;
  };
  const sortLines = (sources: { key: string; rows: Row[] }[]) => {
    if (!summed || !view.sort) return sources;
    const last = view.sort.split(".").pop();
    const descending = view.sortAggregate === "latest" || last === "created" || last === "modified";
    return sortBy(sources, (src) => sortValue(src.rows), descending);
  };

  const words = (options.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const has = (text: string) => words.every((w) => text.toLowerCase().includes(w));
  const haystack = (cells: Cell[]) =>
    cells
      .map((c) =>
        c.kind === "chips" ? c.chips.map((x) => x.name).join(" ")
        : c.kind === "markdown" ? c.value ?? ""
        : c.value === null ? "" : scalarText(c.value))
      .join("\n");

  const presented: PresentedGroup[] = [];
  const capabilities: Record<string, RowCapabilities> = {};
  for (const group of groups) {
    const keepAll = words.length === 0 || (group.kind !== "flat" && group.kind !== "unassigned" && has(group.heading));
    const lines: PresentedLine[] = [];
    for (const { key, rows: sourceRows } of sortLines(sourcesOf(group.rows))) {
      const cells = fields.map(({ item, field }) =>
        summed || item.field.includes(".") || !field ? summedCell(sourceRows, item, field) : cell(sourceRows[0]!, item, field));
      if (!keepAll && !has(haystack(cells))) continue;
      const bulletCell = bullet ? cells[fields.indexOf(bullet)] : undefined;
      const color = bulletCell?.kind === "choice" ? bulletCell.color : undefined;
      lines.push({ row: key, occurrence: JSON.stringify([view.label, group.id, key]), ...(color ? { color } : {}), cells });
    }
    if (words.length > 0 && lines.length === 0) continue;
    const nameField = group.table ? collection.nameField(group.table.stores) : undefined;
    presented.push({
      id: group.id,
      kind: group.kind,
      heading: group.heading,
      ...(group.member !== undefined ? { member: group.member } : {}),
      ...(group.color ? { color: group.color } : {}),
      ...(group.placeholder ? { placeholder: true } : {}),
      ...(group.table && group.row ? { table: collection.opName(group.table), row: group.row } : {}),
      ...(group.table && group.row && nameField ? { headingField: nameField } : {}),
      ordered: group.ordered,
      remove: group.remove,
      lines,
    });
    for (const line of lines) {
      // A line summed up over rows, or a person, is not one row to edit.
      const edit = !summed && (options.canEdit?.(collection.opName(table), line.row) ?? true);
      const entry = (capabilities[line.row] ??= { edit, delete: edit, groups: [] });
      if (group.kind !== "flat") entry.groups.push(group.id);
    }
  }

  const options_: Record<string, Chip[]> = {};
  for (const { item, field } of fields) {
    if (!field || item.field.includes(".") || VALUE_TYPES.has(field.type)) continue;
    options_[field.name] = collection.candidates(field.type);
  }

  return {
    model: model.name,
    table: collection.opName(table),
    tabs: arranged.views.map((v) => ({ label: v.label })),
    tab: arranged.index,
    ...(view.group ? { group: view.group } : {}),
    groups: presented,
    options: options_,
    capabilities,
  };
}

// ---------------------------------------------------------------------------
// Values and rows: cranberries' `checkValue` and `validate`.

/** Whether `value` fits a field of `model`, as a row stores it (null for none). References aren't looked up. */
export function checkFieldValue(schema: CheckResult, modelName: string, fieldName: string, value: unknown): boolean {
  const table = layoutOf(schema, { store: "files" }).find((t) => !t.ends && t.stores === modelName);
  const stored = table?.fields.find((f) => f.name === fieldName);
  if (!table || !stored) return false;
  const column = table.columns.find((c) => c.name === stored.columns[0])!;
  return fitsValue(column, value);
}

function fitsValue(column: Column, value: unknown): boolean {
  if (value === null || value === undefined) return column.nullable || column.array;
  if (column.array && Array.isArray(value) && new Set(value.map(canonical)).size !== value.length) return false;
  return fitsColumn(value, column);
}

export interface RowsDiagnostic {
  code: "bad-value" | "missing-value" | "extra-column" | "duplicate-key" | "missing-key" | "dangling-reference" | "duplicate-member";
  table: string;
  /** The row's stable key, when it has one. */
  row?: string;
  column?: string;
  message: string;
}

/** Every row against its table: values, keys, distinct members, and references to rows that exist. */
export function checkRows(schema: CheckResult, rows: RowsByTable): RowsDiagnostic[] {
  const tables = layoutOf(schema, { store: "files" });
  const out: RowsDiagnostic[] = [];
  const keys = new Map<string, Set<string>>();
  for (const table of tables) {
    const seen = new Set<string>();
    keys.set(table.name, seen);
    for (const row of (rows[table.name] ?? []) as Row[]) {
      const key = rowKey(table, row);
      if (key === null) {
        out.push({ code: "missing-key", table: table.name, message: `A row of ${table.name} has no key` });
        continue;
      }
      for (const d of validateRow(table, row)) out.push({ code: d.code, table: table.name, row: key, column: d.column, message: d.message });
      for (const column of table.columns) {
        const value = row[column.name];
        if (column.array && Array.isArray(value) && new Set(value.map(canonical)).size !== value.length) {
          out.push({ code: "duplicate-member", table: table.name, row: key, column: column.name, message: `\`${column.name}\` lists a member twice` });
        }
      }
      if (seen.has(key)) out.push({ code: "duplicate-key", table: table.name, row: key, message: `Two rows of ${table.name} have the key ${key}` });
      seen.add(key);
    }
  }
  const present = (table: string, values: unknown[]) => {
    const target = tables.find((t) => t.name === table)!;
    return ((rows[table] ?? []) as Row[]).some((r) => target.primaryKey.every((c, i) => same(r[c], values[i])));
  };
  for (const table of tables) {
    for (const row of (rows[table.name] ?? []) as Row[]) {
      const key = rowKey(table, row);
      if (key === null) continue;
      for (const column of table.columns) {
        const ref = column.references;
        const items = row[column.name];
        if (!ref || !Array.isArray(items)) continue;
        for (const item of items) {
          const values = ref.columns.length === 1 ? [item] : ref.columns.map((c) => (item as Row)?.[c.name]);
          if (!present(ref.table, values)) {
            out.push({ code: "dangling-reference", table: table.name, row: key, column: column.name, message: `\`${column.name}\` names ${JSON.stringify(item)}, which is no row of ${ref.table}` });
          }
        }
      }
      for (const fk of table.foreignKeys) {
        const values = fk.columns.map((c) => row[c] ?? null);
        if (values.every((v) => v === null)) continue;
        if (!present(fk.table, values)) {
          out.push({ code: "dangling-reference", table: table.name, row: key, column: fk.columns.join(","), message: `${JSON.stringify(values)} names no row of ${fk.table}` });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Applying row operations: cranberries' `apply`, as spec 10 §4.1 replays them.

/** A row with its members in the table's column order, then undeclared ones by name. */
function canonicalRow(table: Table, row: Row): Row {
  const declared = table.columns.map((c) => c.name).filter((name) => Object.hasOwn(row, name));
  const extra = Object.keys(row).filter((name) => !table.columns.some((c) => c.name === name)).sort(compareText);
  return Object.fromEntries([...declared, ...extra].map((name) => [name, row[name]]));
}

const SYSTEM = ["created", "modified"];

/** Rows after row operations, by spec 10 §4.1's rules. Throws on an operation that doesn't apply. */
export function applyRowEdits(schema: CheckResult, rows: RowsByTable, edits: readonly RowEdit[]): RowsByTable {
  const collection = new Collection(schema, rows);
  const out: RowsByTable = Object.fromEntries(Object.entries(rows).map(([name, list]) => [name, [...list]]));
  for (const edit of edits) {
    const table = collection.tableNamed(edit.table);
    const list = (out[table.name] ??= []) as Row[];
    const index = list.findIndex((r) => rowKey(table, r) === edit.row);
    const fail = (message: string): never => {
      throw new ViewError(`${edit.kind} ${edit.table} ${edit.row}: ${message}`);
    };
    const stamp = (row: Row, created: boolean) => {
      if (edit.kind === "rowDelete" || edit.at === undefined) return;
      if (created) row.created = edit.at;
      row.modified = edit.at;
    };
    if (edit.kind === "rowCreate") {
      if (index >= 0) fail("the row already exists");
      if (rowKey(table, edit.values) !== edit.row) fail("its values don't have the row's key");
      if (edit.at !== undefined && SYSTEM.some((s) => Object.hasOwn(edit.values, s))) fail("a timed row's times come from its operation");
      const row: Row = { ...edit.values };
      stamp(row, true);
      list.push(canonicalRow(table, row));
      continue;
    }
    if (index < 0) fail("the row is absent");
    if (edit.kind === "rowDelete") {
      list.splice(index, 1);
      continue;
    }
    if (table.primaryKey.includes(edit.field)) fail("a key field is never set");
    if (SYSTEM.includes(edit.field)) fail(`${edit.field} is set only by an operation's time`);
    const row: Row = { ...list[index]! };
    if (edit.kind === "rowSet") {
      if (!same(row[edit.field], edit.before)) fail(`${edit.field} doesn't have the value seen`);
      if (same(edit.before, edit.value)) fail("it changes nothing");
      if (edit.value === null) delete row[edit.field];
      else row[edit.field] = edit.value;
    } else {
      const value = row[edit.field];
      if (value !== undefined && value !== null && !Array.isArray(value)) fail(`${edit.field} isn't many-valued`);
      const members = (Array.isArray(value) ? value : []) as unknown[];
      const at = members.findIndex((m) => same(m, edit.member));
      const set = (next: unknown[]) => {
        if (next.length) row[edit.field] = next;
        else delete row[edit.field];
      };
      if (edit.kind === "rowConnect") {
        if (at >= 0) fail("the member is already present");
        set([...members, edit.member]);
      } else {
        if (at < 0) fail("the member is absent");
        const rest = members.filter((_, i) => i !== at);
        if (edit.kind !== "rowMove") set(rest);
        else {
          const anchor = edit.after;
          const after = anchor === null ? -1 : rest.findIndex((m) => same(m, anchor));
          if (anchor !== null && after < 0) fail("the anchor member is absent");
          rest.splice(after + 1, 0, members[at]);
          if (rest.every((m, i) => same(m, members[i]))) fail("it changes nothing");
          set(rest);
        }
      }
    }
    stamp(row, false);
    list[index] = canonicalRow(table, row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The inverse: intents to row operations.

/** The row operations that carry out `intent` on the view `options` presents. */
export function viewEdits(schema: CheckResult, rows: RowsByTable, options: PresentOptions, intent: ViewIntent): RowEdit[] {
  const collection = new Collection(schema, rows, options.people);
  const arrangement = arrange(collection, { ...options, query: undefined });
  const { model, table } = arrangement;
  if (summarized(model, arrangement.view)) throw new ViewError("A view summed up over rows, or of people, is read-only");
  const edits: RowEdit[] = [];
  const at = intent.at !== undefined ? { at: intent.at } : {};
  // Each edit is computed against the rows the earlier ones leave.
  const emit = (edit: RowEdit) => {
    collection.rows = applyRowEdits(schema, collection.rows, [edit]);
    edits.push(edit);
  };
  const lineRow = (key: string): Row => {
    const row = collection.findRow(table, key);
    if (!row) throw new ViewError(`No row ${key} in ${table.name}`);
    return row;
  };
  const fieldNamed = (name: string): ResolvedField => {
    const field = model.fields.find((f) => f.name === name);
    if (!field) throw new ViewError(`\`${model.name}\` has no field \`${name}\``);
    return field;
  };
  const group = (id: string): Arranged => {
    const found = arrangement.groups.find((g) => g.id === id);
    if (!found) throw new ViewError(`No group ${id} in the view "${arrangement.view.label}"`);
    return found;
  };
  const groupField = () => {
    if (!arrangement.field) throw new ViewError(`The view "${arrangement.view.label}" isn't grouped`);
    return arrangement.field;
  };
  const opTable = collection.opName(table);

  /** A position in a list ordered by `position` (the row placed leaves it out): after the row `keyOf` gives
   * `anchor`, first for null, last when undefined. Between two rows it is halfway. */
  const positionAt = (peers: Row[], position: string, keyOf: (r: Row) => unknown, anchor: Scalar | null | undefined): number => {
    const sorted = byPosition(peers, position);
    const index = anchor === undefined ? sorted.length : anchor === null ? 0 : sorted.findIndex((r) => same(keyOf(r), anchor)) + 1;
    if (anchor !== undefined && anchor !== null && index === 0) throw new ViewError(`${JSON.stringify(anchor)} isn't in that group`);
    const before = sorted[index - 1]?.[position];
    const next = sorted[index]?.[position];
    if (typeof before !== "number") return typeof next === "number" ? next - 1 : 0;
    return typeof next === "number" ? (before + next) / 2 : before + 1;
  };
  /** The member naming a line's row, from its key. */
  const anchorOf = (after: string | null | undefined) =>
    after === undefined || after === null ? after : collection.memberOf(model.name, lineRow(after));

  /** Connects a line's row to `member`; where positions order the group, places it after `anchor`. */
  const connect = (key: string, field: ResolvedField, member: Scalar, anchor?: Scalar | null) => {
    const access = collection.access(model, field);
    const row = lineRow(key);
    const self = collection.membersBy(model, access, row);
    if (self.some((m) => same(m, member))) return;
    switch (access.kind) {
      case "value":
      case "array":
        if (access.kind === "value" && !access.many) {
          emit({ kind: "rowSet", table: opTable, row: key, field: access.column, before: (row[access.column] ?? null) as Json, value: member, ...at });
        } else emit({ kind: "rowConnect", table: opTable, row: key, field: access.column, member, ...at });
        return;
      case "column": {
        if (access.key) throw new ViewError(`\`${field.name}\` is part of the row's key`);
        emit({ kind: "rowSet", table: opTable, row: key, field: access.column, before: (row[access.column] ?? null) as Json, value: member, ...at });
        if (access.position) {
          const peers = collection.rowsOf(table).filter((r) => same(r[access.column], member) && rowKey(table, r) !== key);
          const value = positionAt(peers, access.position, (r) => collection.memberOf(model.name, r), anchor);
          const current = lineRow(key)[access.position] ?? null;
          if (!same(current, value)) emit({ kind: "rowSet", table: opTable, row: key, field: access.position, before: current as Json, value, ...at });
        }
        return;
      }
      case "otherArray": {
        const owner = collection.rowByMember(access.target, member);
        if (!owner) throw new ViewError(`No row of \`${access.target}\` is ${JSON.stringify(member)}`);
        emit({ kind: "rowConnect", table: collection.opName(access.table), row: rowKey(access.table, owner)!, field: access.column, member: collection.memberOf(model.name, row), ...at });
        return;
      }
      case "otherColumn": {
        const other = collection.rowByMember(access.target, member);
        if (!other) throw new ViewError(`No row of \`${access.target}\` is ${JSON.stringify(member)}`);
        const otherKey = rowKey(access.table, other)!;
        const name = collection.opName(access.table);
        const mine = collection.memberOf(model.name, row);
        emit({ kind: "rowSet", table: name, row: otherKey, field: access.column, before: (other[access.column] ?? null) as Json, value: mine, ...at });
        if (access.position) {
          const peers = collection.rowsOf(access.table).filter((r) => same(r[access.column], mine) && rowKey(access.table, r) !== otherKey);
          const value = positionAt(peers, access.position, () => null, undefined);
          const current = collection.findRow(access.table, otherKey)![access.position] ?? null;
          if (!same(current, value)) emit({ kind: "rowSet", table: name, row: otherKey, field: access.position, before: current as Json, value, ...at });
        }
        return;
      }
      case "join": {
        const values: Record<string, Json> = { [access.mine.columns[0]!]: collection.memberOf(model.name, row), [access.theirs.columns[0]!]: member };
        const joined = collection.rowsOf(access.table);
        for (const end of [access.mine, access.theirs]) {
          if (!end.position) continue;
          const peers = joined.filter((j) => same(j[end.columns[0]!], values[end.columns[0]!]));
          const placed = end === access.theirs ? anchor : undefined;
          values[end.position] = positionAt(peers, end.position, (j) => j[access.mine.columns[0]!], placed);
        }
        const ordered = canonicalRow(access.table, values) as Record<string, Json>;
        emit({ kind: "rowCreate", table: collection.opName(access.table), row: rowKey(access.table, ordered)!, values: ordered, ...at });
        return;
      }
    }
  };

  const disconnect = (key: string, field: ResolvedField, member: Scalar) => {
    const access = collection.access(model, field);
    const row = lineRow(key);
    if (!collection.membersBy(model, access, row).some((m) => same(m, member))) return;
    if (!canDisconnect(access)) throw new ViewError(`\`${field.name}\` needs a value`);
    switch (access.kind) {
      case "value":
      case "array":
        if (access.kind === "value" && !access.many) {
          emit({ kind: "rowSet", table: opTable, row: key, field: access.column, before: row[access.column] as Json, value: null, ...at });
        } else emit({ kind: "rowDisconnect", table: opTable, row: key, field: access.column, member, ...at });
        return;
      case "column":
        emit({ kind: "rowSet", table: opTable, row: key, field: access.column, before: row[access.column] as Json, value: null, ...at });
        if (access.position && lineRow(key)[access.position] !== undefined) {
          emit({ kind: "rowSet", table: opTable, row: key, field: access.position, before: lineRow(key)[access.position] as Json, value: null, ...at });
        }
        return;
      case "otherArray": {
        const owner = collection.rowByMember(access.target, member)!;
        emit({ kind: "rowDisconnect", table: collection.opName(access.table), row: rowKey(access.table, owner)!, field: access.column, member: collection.memberOf(model.name, row), ...at });
        return;
      }
      case "otherColumn": {
        const other = collection.rowByMember(access.target, member)!;
        const otherKey = rowKey(access.table, other)!;
        const name = collection.opName(access.table);
        emit({ kind: "rowSet", table: name, row: otherKey, field: access.column, before: other[access.column] as Json, value: null, ...at });
        const after = collection.findRow(access.table, otherKey)!;
        if (access.position && after[access.position] !== undefined) {
          emit({ kind: "rowSet", table: name, row: otherKey, field: access.position, before: after[access.position] as Json, value: null, ...at });
        }
        return;
      }
      case "join": {
        const mine = collection.memberOf(model.name, row);
        for (const j of collection.rowsOf(access.table)) {
          if (same(j[access.mine.columns[0]!], mine) && same(j[access.theirs.columns[0]!], member)) {
            emit({ kind: "rowDelete", table: collection.opName(access.table), row: rowKey(access.table, j)! });
            return;
          }
        }
      }
    }
  };

  /** Places `key` after the line `after` (or first) in an ordered group. */
  const place = (key: string, target: Arranged, after: string | null) => {
    const access = arrangement.access!;
    if (!target.ordered || target.member === undefined) throw new ViewError(`The group ${target.id} keeps no order`);
    const member = collection.memberOf(model.name, lineRow(key));
    const anchor = after === null ? null : collection.memberOf(model.name, lineRow(after));
    if (access.kind === "otherArray") {
      const owner = collection.rowByMember(access.target, target.member)!;
      const list = (owner[access.column] ?? []) as unknown[];
      const rest = list.filter((m) => !same(m, member));
      const index = anchor === null ? 0 : rest.findIndex((m) => same(m, anchor)) + 1;
      if (anchor !== null && index === 0) throw new ViewError(`${after} isn't in the group ${target.id}`);
      if (list.findIndex((m) => same(m, member)) === index) return;
      emit({ kind: "rowMove", table: collection.opName(access.table), row: rowKey(access.table, owner)!, field: access.column, member, after: anchor, ...at });
      return;
    }
    // Positions: a number between the neighbours'.
    let holder: Table, position: string, peers: Row[], self: Row, keyOf: (r: Row) => unknown;
    if (access.kind === "join") {
      holder = access.table;
      position = access.theirs.position!;
      peers = collection.rowsOf(holder).filter((j) => same(j[access.theirs.columns[0]!], target.member));
      keyOf = (j) => j[access.mine.columns[0]!];
    } else if (access.kind === "column" && access.position) {
      holder = table;
      position = access.position;
      peers = collection.rowsOf(table).filter((r) => same(r[access.column], target.member));
      keyOf = (r) => collection.memberOf(model.name, r);
    } else throw new ViewError(`The group ${target.id} keeps no order`);
    const sorted = byPosition(peers, position);
    self = sorted.find((r) => same(keyOf(r), member))!;
    const rest = sorted.filter((r) => r !== self);
    const index = anchor === null ? 0 : rest.findIndex((r) => same(keyOf(r), anchor)) + 1;
    if (anchor !== null && index === 0) throw new ViewError(`${after} isn't in the group ${target.id}`);
    if (sorted.indexOf(self) === index) return;
    const value = positionAt(rest, position, keyOf, anchor);
    emit({ kind: "rowSet", table: collection.opName(holder), row: rowKey(holder, self)!, field: position, before: (self[position] ?? null) as Json, value, ...at });
  };

  /** cranberries' `apply` for a delete: the row goes, and so does every reference to it. */
  const deleteRow = (key: string) => {
    const row = lineRow(key);
    const member = collection.memberOf(model.name, row);
    for (const other of collection.tables) {
      const name = collection.opName(other);
      if (other.ends) {
        for (const end of other.ends) {
          if (end.model !== model.name) continue;
          for (const j of collection.rowsOf(other).filter((j) => same(j[end.columns[0]!], member))) {
            emit({ kind: "rowDelete", table: name, row: rowKey(other, j)! });
          }
        }
        continue;
      }
      for (const stored of other.fields) {
        if (stored.target !== model.name) continue;
        const column = other.columns.find((c) => c.name === stored.columns[0])!;
        for (const r of [...collection.rowsOf(other)]) {
          const rKey = rowKey(other, r)!;
          if (other === table && rKey === key) continue;
          if (column.array) {
            if (Array.isArray(r[column.name]) && (r[column.name] as unknown[]).some((m) => same(m, member))) {
              emit({ kind: "rowDisconnect", table: name, row: rKey, field: column.name, member, ...at });
            }
          } else if (same(r[column.name], member)) {
            if (other.primaryKey.includes(column.name)) emit({ kind: "rowDelete", table: name, row: rKey });
            else if (column.nullable) {
              emit({ kind: "rowSet", table: name, row: rKey, field: column.name, before: member, value: null, ...at });
              // Its place in the deleted row's list goes too.
              const holder = collection.models.get(other.stores)!;
              const access = collection.access(holder, holder.fields.find((f) => f.name === stored.name)!);
              const position = access.kind === "column" ? access.position : undefined;
              const placed = position === undefined ? undefined : collection.findRow(other, rKey)![position];
              if (position !== undefined && placed !== undefined) emit({ kind: "rowSet", table: name, row: rKey, field: position, before: placed as Json, value: null, ...at });
            } else throw new ViewError(`${name} ${rKey} needs the row ${key} in \`${column.name}\``);
          }
        }
      }
    }
    emit({ kind: "rowDelete", table: opTable, row: key });
  };

  switch (intent.kind) {
    case "set": {
      const field = fieldNamed(intent.field);
      const access = collection.access(model, field);
      const row = lineRow(intent.row);
      if (access.kind === "value") {
        if (!checkFieldValue(schema, model.name, field.name, intent.value)) throw new ViewError(`${JSON.stringify(intent.value)} doesn't fit \`${field.name}\``);
        const value = Array.isArray(intent.value) && intent.value.length === 0 ? null : intent.value;
        if (!same(row[access.column] ?? null, value)) {
          emit({ kind: "rowSet", table: opTable, row: intent.row, field: access.column, before: (row[access.column] ?? null) as Json, value, ...at });
        }
        break;
      }
      // A reference: connect what's new, disconnect what's gone.
      const wanted = intent.value === null ? [] : Array.isArray(intent.value) ? intent.value : [intent.value];
      if (!wanted.every(isScalar)) throw new ViewError(`\`${field.name}\` holds references`);
      if (field.arity !== "many" && wanted.length > 1) throw new ViewError(`\`${field.name}\` holds one value`);
      const current = collection.membersBy(model, access, row);
      if (field.arity !== "many" && wanted.length === 1) {
        connect(intent.row, field, wanted[0] as Scalar);
        break;
      }
      for (const m of current) if (!wanted.some((w) => same(w, m))) disconnect(intent.row, field, m);
      for (const m of wanted as Scalar[]) connect(intent.row, field, m);
      break;
    }
    case "connect":
      connect(intent.row, fieldNamed(intent.field), intent.member);
      break;
    case "disconnect":
      disconnect(intent.row, fieldNamed(intent.field), intent.member);
      break;
    case "create": {
      const target = intent.group === undefined ? undefined : group(intent.group);
      const values = newRow(model, table, intent.id, intent.values ?? {});
      const field = arrangement.field;
      const access = arrangement.access;
      // Preset the group's field when the new row holds it.
      let preset = false;
      if (target?.member !== undefined && field && access && (access.kind === "value" || access.kind === "column" || access.kind === "array")) {
        values[access.column] = access.kind === "array" || (access.kind === "value" && access.many) ? [target.member] : target.member;
        if (access.kind === "column" && access.position) {
          const peers = collection.rowsOf(table).filter((r) => same(r[access.column], target.member));
          values[access.position] = positionAt(peers, access.position, (r) => collection.memberOf(model.name, r), target.ordered ? anchorOf(intent.after) : undefined);
        }
        preset = true;
      }
      const row = canonicalRow(table, values) as Record<string, Json>;
      const key = rowKey(table, row);
      if (key === null) throw new ViewError("A new row needs its key");
      if (validateRow(table, row).length > 0) throw new ViewError(`The new row doesn't fit \`${model.name}\``);
      emit({ kind: "rowCreate", table: opTable, row: key, values: row, ...at });
      // Otherwise connect the group's row to it, and place it in a list.
      if (target?.member !== undefined && field && !preset) connect(key, field, target.member, target.ordered ? anchorOf(intent.after) : undefined);
      if (target?.ordered && intent.after !== undefined && access?.kind === "otherArray") place(key, target, intent.after);
      break;
    }
    case "delete":
      deleteRow(intent.row);
      break;
    case "remove": {
      const g = group(intent.group);
      if (g.kind === "connection" && g.remove === "disconnect") disconnect(intent.row, groupField(), g.member!);
      else deleteRow(intent.row);
      break;
    }
    case "move":
      place(intent.row, group(intent.group), intent.after);
      break;
    case "regroup": {
      const from = group(intent.from);
      const to = group(intent.to);
      const field = groupField();
      if (from.id === to.id) {
        if (intent.after !== undefined) place(intent.row, to, intent.after);
        break;
      }
      const access = arrangement.access!;
      // A single value on the row is replaced in one step.
      const replaces = access.kind === "column" || (access.kind === "value" && !access.many);
      if (from.member !== undefined && !(replaces && to.member !== undefined)) disconnect(intent.row, field, from.member);
      if (to.member !== undefined) connect(intent.row, field, to.member, to.ordered ? anchorOf(intent.after) : undefined);
      if (to.ordered && intent.after !== undefined && access.kind === "otherArray") place(intent.row, to, intent.after);
      break;
    }
    case "rename": {
      const g = group(intent.group);
      if (!g.table || !g.row) throw new ViewError(`The heading of ${g.id} isn't a row's name`);
      const nameField = collection.nameField(g.table.stores);
      if (!nameField) throw new ViewError(`\`${g.table.stores}\` has no name to edit`);
      const row = collection.findRow(g.table, g.row)!;
      if (!same(row[nameField] ?? null, intent.value)) {
        emit({ kind: "rowSet", table: collection.opName(g.table), row: g.row, field: nameField, before: (row[nameField] ?? null) as Json, value: intent.value, ...at });
      }
      break;
    }
  }
  // Every edit is a row operation the schema validates before it is published.
  const known = new Set(checkRows(schema, rows).map((d) => canonical(d)));
  const added = checkRows(schema, collection.rows).filter((d) => !known.has(canonical(d)));
  if (added.length > 0) throw new ViewError(added[0]!.message);
  return edits;
}

/** cranberries' `newEntity`: a new row's values, with each required value it lacks given its type's empty value. */
function newRow(model: ResolvedModel, table: Table, id: string, given: Record<string, Json>): Record<string, Json> {
  const values: Record<string, Json> = {};
  if (table.primaryKey.length === 1 && table.primaryKey[0] === "id") values.id = id;
  for (const [name, value] of Object.entries(given)) {
    const field = model.fields.find((f) => f.name === name);
    const stored = field && table.fields.find((f) => f.name === field.name);
    if (!stored || stored.columns.length !== 1) throw new ViewError(`A new row of \`${model.name}\` can't be given \`${name}\` directly`);
    if (value !== null) values[stored.columns[0]!] = value;
  }
  for (const column of table.columns) {
    if (column.name in values || column.nullable || column.array || column.type === "timestamp" || column.type === "position") continue;
    if (column.allowed) values[column.name] = column.allowed[0]!;
    else if (column.type === "text" && !column.profile && !table.foreignKeys.some((fk) => fk.columns.includes(column.name))) values[column.name] = "";
    else if (column.type === "int" || column.type === "number") values[column.name] = 0;
    else if (column.type === "bool") values[column.name] = false;
  }
  return values;
}
