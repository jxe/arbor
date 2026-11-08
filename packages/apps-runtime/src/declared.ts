// Declared views (executable documents §4.1, Apps 012): a schema's `~views`
// entry is the built-in list view applied to its model with that entry's line,
// group and sort. Here the built-in list view is a view like any other: it reads
// the rows of the tables the entry reaches, so it has a plan, a live stream and
// read rules like an authored view, and its result is `presentView`'s.

import {
  compareText,
  layoutOf,
  logicalFromRows,
  PERSON_RELATION,
  presentedModel,
  presentView,
  rowsFromLogical,
  viewsOf,
  type CheckResult,
  type Presentation,
  type ResolvedView,
  type RowsByTable,
  type Table,
} from "@ovst/usl";
import { node, type NodeHandle, type StandardSchemaV1 } from "./authoring.ts";
import { QueryInputError } from "./query-core.ts";
import { runningSchema, view, type Source, type View } from "./views.ts";

const ROW = Symbol.for("overstory.view.row");

/** A declared view's input: an optional search, as `presentView`'s `query`. */
export interface DeclaredViewInput {
  query?: string;
}

const declaredInput: StandardSchemaV1<DeclaredViewInput | undefined, DeclaredViewInput | undefined> = {
  "~standard": {
    version: 1,
    vendor: "overstory",
    validate(value) {
      if (value === undefined || value === null) return { value: undefined };
      if (typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).every((key) => key === "query")
        && ((value as DeclaredViewInput).query === undefined || typeof (value as DeclaredViewInput).query === "string")) {
        return { value: value as DeclaredViewInput };
      }
      return { issues: [{ message: "A declared view takes { query }, a string" }] };
    },
  },
};

/** Which model's `~views` entry a declared view is: by default the schema's presented model's. */
export interface DeclaredViewName {
  label: string;
  model?: string;
}

/** The model and view index a label names, or null. */
export function findDeclaredView(schema: CheckResult, name: DeclaredViewName): { model: string; index: number; view: ResolvedView } | null {
  const models = name.model ? [name.model] : [presentedModel(schema), ...schema.models.map((model) => model.name)];
  for (const model of models) {
    if (!schema.models.some((candidate) => candidate.name === model)) continue;
    const views = viewsOf(schema, model);
    const index = views.findIndex((candidate) => candidate.label === name.label);
    if (index >= 0) return { model, index, view: views[index]! };
  }
  return null;
}

/** The models an entry reaches: its own, and each model its line, group, sort and rows paths pass through. */
export function reachedModels(schema: CheckResult, model: string, entry: ResolvedView): Set<string> {
  const models = new Map(schema.models.map((candidate) => [candidate.name, candidate]));
  const reached = new Set([model]);
  const walk = (path: string | undefined) => {
    if (!path) return;
    let current = models.get(model);
    for (const segment of path.split(".")) {
      const field = current?.fields.find((candidate) => candidate.name === segment);
      if (!field) return;
      if (models.has(field.type) || field.type === PERSON_RELATION) reached.add(field.type);
      current = models.get(field.type);
    }
  };
  for (const item of entry.line) {
    walk(item.field);
    if (item.sort) walk(`${item.field}.${item.sort}`);
  }
  walk(entry.group);
  if (entry.group && entry.groupSort) walk(`${entry.group}.${entry.groupSort}`);
  walk(entry.sort);
  walk(entry.rows);
  return reached;
}

/** The database tables an entry reads: its models' own, and the join tables between them. */
export function reachedTables(schema: CheckResult, model: string, entry: ResolvedView): Table[] {
  const reached = reachedModels(schema, model, entry);
  return layoutOf(schema, { store: "database" }).filter((table) => table.ends
    ? table.ends.every((end) => reached.has(end.model))
    : reached.has(table.stores));
}

/**
 * The built-in list view for one `~views` entry of the collection at
 * `collection` (a logical path): the entry's lines and groups, as
 * `presentView` gives them, read through a plan. Its input may carry a search.
 */
export function declaredView(schema: CheckResult, collection: string, name: DeclaredViewName): View<DeclaredViewInput | undefined, Presentation> {
  const found = findDeclaredView(schema, name);
  if (!found) throw new QueryInputError([{ message: `The schema has no view named ${name.label}` }]);
  const tables = reachedTables(schema, found.model, found.view);
  const database = layoutOf(schema, { store: "database" });
  const files = layoutOf(schema, { store: "files" });
  const prefix = collection === "/" ? "" : collection;
  const sources = new Map(tables.map((table) => [table.name, (node(`${prefix}/${table.name}`) as NodeHandle).children as unknown as Source<Record<string, any>>]));
  return view(declaredInput, (input) => {
    const store = runningSchema();
    const rows: RowsByTable = {};
    const people = new Map<string, string>();
    for (const table of tables) {
      const relation = store.relations[table.name];
      if (!relation) continue;
      const columns = Object.keys(relation.fields);
      rows[table.name] = [...sources.get(table.name)!.all()].map((row) => {
        // The row's own columns, once the plan has read them: a foreign key keeps its value
        // even when the row it names is hidden from this reader.
        const raw = (row as Record<symbol, { raw?: Record<string, unknown> } | undefined>)[ROW]?.raw;
        const out: Record<string, unknown> = {};
        for (const column of columns) {
          const link = store.relationships[`${table.name}.${column}`];
          const pair = link?.direct?.length === 1 && link.direct[0]!.source === column ? link.direct[0]! : undefined;
          if (!link) { out[column] = row[column]; continue; }
          if (!pair) continue;
          // A foreign key named like its relationship: the key comes from the column, and a
          // person's name from their profile.
          const target = row[column] as Record<string, unknown> | null;
          out[column] = raw && column in raw ? raw[column] : target === null ? null : target[pair.target];
        }
        // People's names, from their profiles, through each relationship to a person.
        for (const link of Object.values(store.relationships)) {
          if (link.source !== table.name || store.relations[link.target]?.source !== "overstory-profile") continue;
          const value = row[link.name] as Record<string, unknown> | readonly Record<string, unknown>[] | null;
          for (const person of Array.isArray(value) ? value : value ? [value] : []) {
            const id = person.id, name = person.name;
            if (typeof id === "string" && typeof name === "string" && !people.has(id)) people.set(id, name);
          }
        }
        return out;
      });
    }
    // Present from the rows the plan read, laid out as data files are.
    const logical = logicalFromRows(schema, database.filter((table) => table.name in rows), rows, { now: "1970-01-01T00:00:00.000Z" });
    const presented = rowsFromLogical(schema, files, logical);
    return presentView(schema, presented, {
      model: found.model,
      view: found.index,
      ...(input?.query ? { query: input.query } : {}),
      // The host knows no directory order, so people are listed by name.
      people: [...people].map(([id, name]) => ({ id, name })).sort((left, right) => compareText(left.name, right.name) || compareText(left.id, right.id)),
    });
  });
}
