// The named relationships of a database layout: for each connection end, how
// to get from a row of one table to the rows it is connected to. Executable
// documents query along these (`list.owner`, `list.items`). People are rows of
// the virtual `Person` relation, keyed by profile id.

import type { CheckResult } from "./check.ts";
import type { Table } from "./layout.ts";

export const PERSON_RELATION = "Person";

/**
 * A `Person` value is a profile id, or `contact:<key>`: a placeholder naming a
 * row of the viewer's directory People collection (People 001), for someone
 * with no profile yet. When they get one, their placeholders are rewritten to
 * it. A reader that can't resolve a placeholder shows its key.
 */
export const PERSON_PLACEHOLDER_PREFIX = "contact:";
const PLACEHOLDER_KEY = /^[A-Za-z0-9_-]{1,128}$/;

/** The directory key a placeholder names, or undefined when `value` isn't a placeholder. */
export function personPlaceholderKey(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith(PERSON_PLACEHOLDER_PREFIX)) return undefined;
  const key = value.slice(PERSON_PLACEHOLDER_PREFIX.length);
  return PLACEHOLDER_KEY.test(key) ? key : undefined;
}

/** Whether `value` can be stored as a `Person`: a non-empty profile id, or a well-formed placeholder. */
export function isPersonValue(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  return !value.startsWith(PERSON_PLACEHOLDER_PREFIX) || personPlaceholderKey(value) !== undefined;
}

export interface Relationship {
  /** The table the relationship starts from. */
  source: string;
  /** The connection end's field. */
  name: string;
  /** The table it reaches, or `Person`. */
  target: string;
  cardinality: "one" | "maybe" | "many";
  /** The target columns that tell connected rows apart, when fewer than the target's key. */
  key?: string[];
  /** Matching columns: source columns equal target columns. */
  direct?: { source: string; target: string }[];
  /** A join table between them. */
  through?: {
    relation: string;
    source: { source: string; through: string }[];
    target: { through: string; target: string }[];
  };
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const zip = <A extends string, B extends string>(left: string[], right: string[], a: A, b: B) =>
  left.map((value, i) => ({ [a]: value, [b]: right[i]! }) as Record<A | B, string>);

/** The relationships of `tables`, which must be `layoutOf(result, { store: "database" })`. */
export function relationshipsOf(result: CheckResult, tables: Table[]): Relationship[] {
  const byModel = new Map(tables.map((t) => [t.stores, t]));
  const tableOf = (model: string) => (model === "Person" ? PERSON_RELATION : byModel.get(model)?.name);
  const keyOf = (model: string) => (model === "Person" ? ["id"] : byModel.get(model)!.primaryKey);
  // The columns named `name` that refer to a row of `model`, as the layout writes them.
  const refColumns = (model: string, name: string) => {
    const key = keyOf(model);
    return key.length === 1 ? [name] : key.map((k) => `${name}_${k}`);
  };
  // A many relationship's rows are told apart by the target's key, less the columns every row shares.
  const rest = (key: string[], shared: string[]) => {
    const left = key.filter((k) => !shared.includes(k));
    return left.length > 0 && left.length < key.length ? { key: left } : {};
  };
  const single = (arity: string) => (arity === "optional" ? "maybe" : "one");
  const out: Relationship[] = [];

  for (const { a, b, storage } of result.connections) {
    const [ta, tb] = [tableOf(a.model), tableOf(b.model)];
    if (!ta || !tb) continue; // a fixed model: its rows are values, not a relation
    if (storage.kind === "column") {
      const holder = storage.on === a.model && storage.field === a.field ? a : b;
      const other = holder === a ? b : a;
      const [from, to] = [tableOf(holder.model)!, tableOf(other.model)!];
      const columns = refColumns(other.model, holder.column ?? holder.field);
      const key = keyOf(other.model);
      out.push({ source: from, name: holder.field, target: to, cardinality: single(holder.arity), direct: zip(columns, key, "source", "target") });
      out.push({
        source: to,
        name: other.field,
        target: from,
        cardinality: other.arity === "many" ? "many" : single(other.arity),
        ...(other.arity === "many" ? rest(keyOf(holder.model), columns) : {}),
        direct: zip(key, columns, "source", "target"),
      });
    } else if (storage.kind === "array") {
      const join = byModel.get(`${a.model}.${a.field}`)!;
      const colsA = refColumns(a.model, lowerFirst(a.model));
      const colsB = refColumns(b.model, a.model === b.model ? a.field : lowerFirst(b.model));
      for (const [end, other, mine, theirs] of [[a, b, colsA, colsB], [b, a, colsB, colsA]] as const) {
        out.push({
          source: tableOf(end.model)!,
          name: end.field,
          target: tableOf(other.model)!,
          cardinality: "many",
          through: {
            relation: join.name,
            source: zip(keyOf(end.model), mine, "source", "through"),
            target: zip(theirs, keyOf(other.model), "through", "target"),
          },
        });
      }
    }
  }

  // A connection model's rows connect each of its ends.
  for (const model of result.models) {
    if (model.ends.length === 0 || !byModel.has(model.name)) continue;
    const table = byModel.get(model.name)!;
    for (const end of model.ends) {
      const target = tableOf(end.model);
      if (!target) continue;
      const columns = refColumns(end.model, end.column ?? end.as);
      const key = keyOf(end.model);
      out.push({ source: table.name, name: end.as, target, cardinality: "one", direct: zip(columns, key, "source", "target") });
      out.push({ source: target, name: end.field, target: table.name, cardinality: "many", ...rest(table.primaryKey, columns), direct: zip(key, columns, "source", "target") });
    }
  }
  return out;
}
