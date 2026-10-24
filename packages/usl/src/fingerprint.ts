// The model layer of a checked schema, in the canonical form its model
// fingerprint hashes (spec 11 §9): models, fields, values and connections in
// UTF-8 order of name, with every storage (`@`) and presentation (`~`)
// attribute left out. A caller hashes it as canonical CBOR; this package has
// no hashing of its own.

import type { Arity } from "./ast.ts";
import type { CheckResult, ResolvedEnd, RowValue } from "./check.ts";

export interface ModelLayer {
  models: {
    name: string;
    main: boolean;
    rows: "fixed" | "seed" | "data";
    key: string[];
    path: string | null;
    fields: { name: string; type: string; arity: Arity; ordered: boolean; unique: boolean }[];
    /** The rows written in the schema: an enum's values or a model's seed rows. */
    written: { name: string; values: [string, RowValue][] }[];
  }[];
  connections: { ends: [ModelLayerEnd, ModelLayerEnd] }[];
}

export interface ModelLayerEnd {
  model: string;
  field: string;
  arity: Arity;
  ordered: boolean;
  as: string;
}

const utf8 = (a: string, b: string) => {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
};
const byName = <T extends { name: string }>(a: T, b: T) => utf8(a.name, b.name);
const endName = (e: ModelLayerEnd) => `${e.model}.${e.field}`;
const end = (e: ResolvedEnd): ModelLayerEnd => ({ model: e.model, field: e.field, arity: e.arity, ordered: e.ordered, as: e.as });

/** The model layer of a schema that checked clean. */
export function modelLayer(result: CheckResult): ModelLayer {
  if (result.diagnostics.length > 0) throw new Error("A schema with diagnostics has no model layer");
  const models = result.models
    .filter((m) => !(m.name === "Person" && m.fields.length === 0))
    .map((m) => ({
      name: m.name,
      main: m.main,
      rows: m.rows,
      key: m.key,
      path: m.path ?? null,
      fields: m.fields
        .map((f) => ({ name: f.name, type: f.type, arity: f.arity, ordered: f.ordered, unique: f.unique }))
        .sort(byName),
      written: m.schemaRows
        .map((r) => ({ name: r.name, values: Object.entries(r.values).sort(([a], [b]) => utf8(a, b)) }))
        .sort(byName),
    }))
    .sort(byName);
  const connections = result.connections
    .map((c) => ({ ends: [end(c.a), end(c.b)].sort((x, y) => utf8(endName(x), endName(y))) as [ModelLayerEnd, ModelLayerEnd] }))
    .sort((x, y) => utf8(endName(x.ends[0]), endName(y.ends[0])));
  return { models, connections };
}
