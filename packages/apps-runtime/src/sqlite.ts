import { Database } from "bun:sqlite";
import { posix } from "node:path";
import type {
  OverstoryUser,
  CountExpression,
  ExistsExpression,
  FieldExpression,
  SomeExpression,
  OrderExpression,
  PredicateExpression,
  QueryHandle,
  QueryPlan,
  RelationshipSelection,
  SelectionPlan,
  ValueExpression,
} from "./authoring.ts";
import type {
  RelationMetadata,
  RelationshipMetadata,
  ResolvedDatabaseLocation,
  ResolvedStorySource,
  StoreSchema,
} from "./schema.ts";
import { introspectStoreSchema } from "./schema.ts";
import {
  compareQueryValues,
  containsRequiredUser,
  evaluateQueryPredicate,
  finishCardinality,
  isPortableNodePlan,
  parameterValue,
  QueryCompileError,
  QueryUserRequiredError,
  runtimeQueryValue,
  sortPortablePropertyRows,
  validateQueryInput,
} from "./query-core.ts";

export { QueryCompileError, QueryInputError, QueryUserRequiredError } from "./query-core.ts";

export interface ProfileResolver {
  resolve(ids: readonly string[], fields: readonly string[]): Promise<{
    rows: readonly Record<string, unknown>[];
    dependencies: readonly ProfileDependency[];
  }>;
  subscribe?(listener: (change: { profile: string; tree: string; ref: string }) => void): () => void;
}

export interface ProfileDependency {
  profile: string;
  tree: string;
  ref: string;
}

export interface QueryExecutionOptions<Input = unknown> {
  input?: Input;
  user?: OverstoryUser | null;
  /** Rows bound by scope for the plan's scoped fields (a view's enclosing rows from other plans). */
  bindings?: Record<string, Record<string, unknown>>;
}

export interface ExecutedStatement {
  sql: string;
  parameters: unknown[];
}

export interface QueryExecution<Result> {
  result: Result;
  statements: ExecutedStatement[];
  queryPlans: Array<{ sql: string; details: string[] }>;
  dependencies: {
    profiles: ProfileDependency[];
    database: Record<string, { rows: Record<string, unknown>[]; matchAny: Record<string, unknown>[] }>;
  };
  schemaFingerprint: string;
}

interface ExecutionContext {
  database: Database;
  input: unknown;
  user: OverstoryUser | null;
  statements: ExecutedStatement[];
  queryPlans: Array<{ sql: string; details: string[] }>;
  profileDependencies: Map<string, ProfileDependency>;
  databaseDependencies: Map<string, {
    rows: Map<string, Record<string, unknown>>;
    matchAny: Map<string, Record<string, unknown>>;
  }>;
  /** Bound rows by scope: the caller's, plus each enclosing row while a nested selection runs. */
  bindings: Record<string, Record<string, unknown>>;
  /** SQL aliases by scope for the statement being compiled. */
  aliases: Map<string, string>;
}

interface CompiledQuery<Result = unknown, Input = unknown> {
  handle: QueryHandle<Result, Input>;
  plan: QueryPlan;
  schema: StoreSchema;
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function relationship(schema: StoreSchema, source: string, name: string): RelationshipMetadata {
  const value = schema.relationships[`${source}.${name}`];
  if (!value) throw new QueryCompileError(`Unknown relationship ${source}.${name}`);
  return value;
}

function field(schema: StoreSchema, relation: string, name: string): void {
  if (!schema.relations[relation]?.fields[name]) throw new QueryCompileError(`Unknown field ${relation}.${name}`);
}

function validateValue(schema: StoreSchema, relation: string, value: ValueExpression): void {
  if (value.kind === "field") field(schema, value.scope ? value.relation : relation, value.field);
  if (value.kind === "count") {
    const metadata = relationship(schema, relation, value.relationship);
    if (value.where) validatePredicate(schema, metadata.target, value.where);
  }
}

function inDatabase(schema: StoreSchema, relation: string): boolean {
  return schema.relations[relation]?.source === "sqlite";
}

function validatePredicate(schema: StoreSchema, relation: string, value: PredicateExpression): void {
  if (value.kind === "logical") {
    if (value.operands.length === 0) throw new QueryCompileError("A logical predicate cannot be empty");
    for (const operand of value.operands) validatePredicate(schema, relation, operand);
    return;
  }
  if (value.kind === "not") {
    validatePredicate(schema, relation, value.operand);
    return;
  }
  if (value.kind === "some") {
    if (!schema.relations[value.relation]) throw new QueryCompileError(`Unknown relation ${value.relation}`);
    if (!inDatabase(schema, relation) || !inDatabase(schema, value.relation)) {
      throw new QueryCompileError(`A helper variable over ${value.relation} must stay inside the database`);
    }
    validatePredicate(schema, relation, value.where);
    return;
  }
  if (value.kind === "exists") {
    if (value.scope && value.scope !== "self") relation = value.relation;
    const metadata = relationship(schema, relation, value.relationship);
    const keyOnly = value.keys && !value.where;
    if (!inDatabase(schema, relation) || (!inDatabase(schema, metadata.target) && !(keyOnly && (metadata.through || metadata.direct)))) {
      throw new QueryCompileError(`A join along ${relation}.${value.relationship} must stay inside the database`);
    }
    if (value.keys) {
      const key = schema.relations[metadata.target]!.primaryKey;
      if (key.length !== value.keys.length) throw new QueryCompileError(`${metadata.target} is named by ${key.length} key fields`);
      for (const keyed of value.keys) validateValue(schema, relation, keyed);
    }
    if (value.where) validatePredicate(schema, metadata.target, value.where);
    return;
  }
  validateValue(schema, relation, value.left);
  validateValue(schema, relation, value.right);
  if (value.operator === "contains" && value.left.kind !== "field") throw new QueryCompileError("contains() requires a relation field");
}

function validatePlan(schema: StoreSchema, relationName: string, plan: SelectionPlan): void {
  const relationMetadata = schema.relations[relationName];
  if (!relationMetadata) throw new QueryCompileError(`Unknown relation ${relationName}`);
  if (plan.after !== undefined) throw new QueryCompileError("Cursor paging is not implemented by the first SQLite query engine");
  if (plan.where) validatePredicate(schema, relationName, plan.where);
  for (const order of plan.orderBy) validateValue(schema, relationName, order.value);
  for (const [name, selected] of Object.entries(plan.select)) {
    if (selected.kind === "field") {
      field(schema, relationName, selected.field);
      continue;
    }
    if (selected.kind === "count") {
      relationship(schema, relationName, selected.relationship);
      continue;
    }
    if (selected.kind === "relationship") {
      const metadata = relationship(schema, relationName, selected.relationship);
      validatePlan(schema, metadata.target, selected.plan);
      if (metadata.cardinality === "many") {
        const target = schema.relations[metadata.target]!;
        const stableKey = selected.plan.keyBy ?? metadata.key ?? target.primaryKey;
        if (stableKey.length === 0) throw new QueryCompileError(`Repeated selection ${relationName}.${selected.relationship} has no stable key`);
        for (const key of stableKey) {
          field(schema, metadata.target, key);
          if (target.fields[key]!.nullable) throw new QueryCompileError(`Repeated selection ${relationName}.${selected.relationship} has nullable key field ${key}`);
        }
        if (selected.plan.keyBy) {
          const declared = metadata.key && metadata.key.join("\0") === stableKey.join("\0");
          const unique = target.uniqueKeys.some((key) => key.join("\0") === stableKey.join("\0"));
          if (!declared && !unique) throw new QueryCompileError(`Repeated selection ${relationName}.${selected.relationship} keyBy is not proved unique`);
        }
      }
      continue;
    }
    throw new QueryCompileError(`Selection ${name} is not a projected field, relationship, or aggregate`);
  }
}

function equalityFields(predicate: PredicateExpression | undefined): Set<string> {
  const result = new Set<string>();
  if (!predicate) return result;
  if (predicate.kind === "logical") {
    if (predicate.operator === "and") for (const operand of predicate.operands) for (const value of equalityFields(operand)) result.add(value);
    return result;
  }
  if (predicate.kind !== "comparison") return result;
  const own = (value: ValueExpression) => value.kind === "field" && (!value.scope || value.scope === "self");
  const constant = (value: ValueExpression) => value.kind !== "count" && !own(value);
  if (predicate.operator === "eq" && own(predicate.left) && constant(predicate.right)) {
    result.add((predicate.left as FieldExpression).field);
  }
  return result;
}

export function compileQuery<Result, Input>(handle: QueryHandle<Result, Input>, schema: StoreSchema): CompiledQuery<Result, Input> {
  validatePlan(schema, handle.plan.relation, handle.plan);
  const root = schema.relations[handle.plan.relation]!;
  const rootKey = handle.plan.keyBy ?? root.primaryKey;
  if (handle.plan.cardinality === "many") {
    if (rootKey.length === 0) throw new QueryCompileError(`Repeated query on ${root.name} has no stable key`);
    for (const key of rootKey) {
      field(schema, root.name, key);
      if (root.fields[key]!.nullable) throw new QueryCompileError(`Repeated query on ${root.name} has nullable key field ${key}`);
    }
    if (handle.plan.keyBy && !root.uniqueKeys.some((key) => key.join("\0") === rootKey.join("\0"))) {
      throw new QueryCompileError(`Repeated query on ${root.name} keyBy is not proved unique`);
    }
  }
  if (handle.plan.cardinality !== "many") {
    const constrained = equalityFields(handle.plan.where);
    const unique = root.uniqueKeys.some((key) => key.length > 0 && key.every((value) => constrained.has(value)));
    if (!unique) throw new QueryCompileError(`query.${handle.plan.cardinality} on ${root.name} is not constrained by a proved unique key`);
  }
  return { handle, plan: handle.plan, schema };
}

function runtimeValue(value: ValueExpression, row: Record<string, unknown>, context: ExecutionContext): unknown {
  return runtimeQueryValue(value, row, context);
}

function evaluatePredicate(value: PredicateExpression | undefined, row: Record<string, unknown>, context: ExecutionContext): boolean {
  return evaluateQueryPredicate(value, row, context);
}

function stableKey(schema: StoreSchema, relationName: string, plan: SelectionPlan, relationshipMetadata?: RelationshipMetadata): string[] {
  const relationMetadata = schema.relations[relationName]!;
  return plan.keyBy ?? relationshipMetadata?.key ?? relationMetadata.primaryKey;
}

function sortRows(
  rows: Record<string, unknown>[],
  relationName: string,
  plan: SelectionPlan,
  schema: StoreSchema,
  context: ExecutionContext,
  relationshipMetadata?: RelationshipMetadata,
): Record<string, unknown>[] {
  const orders = [...plan.orderBy];
  const orderedFields = new Set(orders.filter((order) => order.value.kind === "field").map((order) => (order.value as { field: string }).field));
  for (const key of stableKey(schema, relationName, plan, relationshipMetadata)) {
    if (!orderedFields.has(key)) orders.push({ kind: "order", id: -1, value: { kind: "field", id: -1, relation: relationName, field: key }, direction: "asc" });
  }
  return rows.sort((left, right) => {
    for (const order of orders) {
      const compared = compareQueryValues(runtimeValue(order.value, left, context), runtimeValue(order.value, right, context));
      if (compared !== 0) return order.direction === "asc" ? compared : -compared;
    }
    return 0;
  });
}

function compileRuntimeValue(
  value: ValueExpression,
  relationName: string,
  alias: string,
  schema: StoreSchema,
  context: ExecutionContext,
  parameters: unknown[],
): string {
  if (value.kind === "field") {
    if (!value.scope) return `${quote(alias)}.${quote(value.field)}`;
    const scoped = context.aliases.get(value.scope);
    if (scoped) return `${quote(scoped)}.${quote(value.field)}`;
    parameters.push(boundValue(value, context));
    return "?";
  }
  if (value.kind === "parameter") {
    parameters.push(parameterValue(context.input, value.path));
    return "?";
  }
  if (value.kind === "user") {
    parameters.push(context.user?.profile ?? null);
    return "?";
  }
  if (value.kind === "literal") {
    parameters.push(value.value);
    return "?";
  }
  return countSQL(value, relationName, alias, schema, context, parameters);
}

/** Compile a count's facts, where `self` is the counted row. */
function asSelf<T>(context: ExecutionContext, alias: string, work: () => T): T {
  const previous = context.aliases.get("self");
  context.aliases.set("self", alias);
  try { return work(); } finally {
    if (previous === undefined) context.aliases.delete("self");
    else context.aliases.set("self", previous);
  }
}

function boundValue(value: FieldExpression, context: ExecutionContext): unknown {
  const bound = context.bindings[value.scope!];
  if (!bound) throw new QueryCompileError(`No row is bound for ${value.relation}.${value.field}`);
  if (!(value.field in bound)) throw new QueryCompileError(`The row bound for ${value.relation} lacks ${value.field}`);
  return bound[value.field] ?? null;
}

/** A value known before the statement runs, or undefined when it comes from a row. */
function constantValue(value: ValueExpression, context: ExecutionContext): unknown {
  if (value.kind === "parameter") return parameterValue(context.input, value.path);
  if (value.kind === "user") return context.user?.profile ?? null;
  if (value.kind === "literal") return value.value;
  if (value.kind === "field" && value.scope && !context.aliases.has(value.scope)) return boundValue(value, context);
  return undefined;
}

function compilePredicateSQL(
  value: PredicateExpression,
  relationName: string,
  alias: string,
  schema: StoreSchema,
  context: ExecutionContext,
  parameters: unknown[],
): string {
  if (value.kind === "logical") {
    const separator = value.operator === "and" ? " and " : " or ";
    return `(${value.operands.map((operand) => compilePredicateSQL(operand, relationName, alias, schema, context, parameters)).join(separator)})`;
  }
  if (value.kind === "exists") return existsSQL(value, relationName, alias, schema, context, parameters);
  if (value.kind === "not") return `not coalesce(${compilePredicateSQL(value.operand, relationName, alias, schema, context, parameters)}, 0)`;
  if (value.kind === "some") return someSQL(value, relationName, alias, schema, context, parameters);
  const left = compileRuntimeValue(value.left, relationName, alias, schema, context, parameters);
  const rightValue = constantValue(value.right, context);
  if (value.operator === "eq" && rightValue === null) return `${left} is null`;
  const right = compileRuntimeValue(value.right, relationName, alias, schema, context, parameters);
  if (value.operator === "eq") return `${left} = ${right}`;
  return `instr(lower(${left}), lower(${right})) > 0`;
}

function existsSQL(
  value: ExistsExpression,
  relationName: string,
  alias: string,
  schema: StoreSchema,
  context: ExecutionContext,
  parameters: unknown[],
): string {
  if (value.scope) {
    // A join that starts from another row in scope: the block's own row, or a helper variable.
    const scoped = context.aliases.get(value.scope);
    if (!scoped) throw new QueryCompileError(`A path fact starts from a row outside the statement`);
    alias = scoped;
    relationName = value.relation;
  }
  const metadata = relationship(schema, relationName, value.relationship);
  if (value.keys && !value.where) {
    const keyed = keyedExistsSQL(value, metadata, alias, schema, context, parameters);
    if (keyed) return keyed;
  }
  // Named by depth, not by node id, so the SQL is the same however many queries were built before.
  const target = `${alias}_some`;
  let from = `${quote(metadata.target)} as ${quote(target)}`;
  let constraint: string;
  if (metadata.direct) {
    constraint = metadata.direct.map((pair) => `${quote(target)}.${quote(pair.target)} = ${quote(alias)}.${quote(pair.source)}`).join(" and ");
  } else {
    const through = metadata.through!;
    const link = `${target}_link`;
    from = `${quote(through.relation)} as ${quote(link)} join ${from} on ${through.target.map((pair) => `${quote(link)}.${quote(pair.through)} = ${quote(target)}.${quote(pair.target)}`).join(" and ")}`;
    constraint = through.source.map((pair) => `${quote(link)}.${quote(pair.through)} = ${quote(alias)}.${quote(pair.source)}`).join(" and ");
  }
  if (value.keys) {
    const key = schema.relations[metadata.target]!.primaryKey;
    constraint += ` and ${key.map((name, index) => keyEquality(`${quote(target)}.${quote(name)}`, value.keys![index]!, relationName, alias, schema, context, parameters)).join(" and ")}`;
  }
  if (value.where) constraint += ` and ${compilePredicateSQL(value.where, metadata.target, target, schema, context, parameters)}`;
  return `exists (select 1 from ${from} where ${constraint})`;
}

function keyEquality(
  column: string,
  value: ValueExpression,
  relationName: string,
  alias: string,
  schema: StoreSchema,
  context: ExecutionContext,
  parameters: unknown[],
): string {
  if (constantValue(value, context) === null) return "0";
  return `${column} = ${compileRuntimeValue(value, relationName, alias, schema, context, parameters)}`;
}

/** `has(key)` answered from the columns that hold the connection, without reading the target. */
function keyedExistsSQL(
  value: ExistsExpression,
  metadata: RelationshipMetadata,
  alias: string,
  schema: StoreSchema,
  context: ExecutionContext,
  parameters: unknown[],
): string | undefined {
  const key = schema.relations[metadata.target]!.primaryKey;
  const relationName = metadata.source;
  if (metadata.direct) {
    // A to-one held in this row's own columns: compare them.
    const pairs = key.map((name) => metadata.direct!.find((pair) => pair.target === name));
    if (pairs.some((pair) => !pair) || metadata.direct.length !== key.length) return undefined;
    return `(${pairs.map((pair, index) => keyEquality(`${quote(alias)}.${quote(pair!.source)}`, value.keys![index]!, relationName, alias, schema, context, parameters)).join(" and ")})`;
  }
  const through = metadata.through!;
  const pairs = key.map((name) => through.target.find((pair) => pair.target === name));
  if (pairs.some((pair) => !pair)) return undefined;
  const link = `${alias}_link`;
  const joined = through.source.map((pair) => `${quote(link)}.${quote(pair.through)} = ${quote(alias)}.${quote(pair.source)}`);
  const keyed = pairs.map((pair, index) => keyEquality(`${quote(link)}.${quote(pair!.through)}`, value.keys![index]!, relationName, alias, schema, context, parameters));
  return `exists (select 1 from ${quote(through.relation)} as ${quote(link)} where ${[...joined, ...keyed].join(" and ")})`;
}

function someSQL(
  value: SomeExpression,
  relationName: string,
  alias: string,
  schema: StoreSchema,
  context: ExecutionContext,
  parameters: unknown[],
): string {
  const helper = `${alias}_${value.scope.replace(/[^A-Za-z0-9]/g, "_")}`;
  const previous = context.aliases.get(value.scope);
  context.aliases.set(value.scope, helper);
  try {
    return `exists (select 1 from ${quote(value.relation)} as ${quote(helper)} where ${compilePredicateSQL(value.where, relationName, alias, schema, context, parameters)})`;
  } finally {
    if (previous === undefined) context.aliases.delete(value.scope);
    else context.aliases.set(value.scope, previous);
  }
}

function countSQL(
  value: CountExpression,
  relationName: string,
  alias: string,
  schema: StoreSchema,
  context: ExecutionContext,
  parameters: unknown[],
): string {
  const metadata = relationship(schema, relationName, value.relationship);
  const counted = alias.endsWith("counted") ? `${alias}_counted` : "counted";
  if (metadata.direct) {
    const target = quote(metadata.target);
    const predicates = metadata.direct.map((pair) => `${quote(counted)}.${quote(pair.target)} = ${quote(alias)}.${quote(pair.source)}`);
    if (value.where) predicates.push(asSelf(context, counted, () => compilePredicateSQL(value.where!, metadata.target, counted, schema, context, parameters)));
    return `(select count(*) from ${target} as ${quote(counted)} where ${predicates.join(" and ")})`;
  }
  const through = metadata.through!;
  const predicates = through.source.map((pair) => `${quote(counted)}.${quote(pair.through)} = ${quote(alias)}.${quote(pair.source)}`);
  if (!value.where) return `(select count(*) from ${quote(through.relation)} as ${quote(counted)} where ${predicates.join(" and ")})`;
  if (!inDatabase(schema, metadata.target)) throw new QueryCompileError(`A count over facts along ${relationName}.${value.relationship} must stay inside the database`);
  const target = `${counted}_target`;
  const join = through.target.map((pair) => `${quote(counted)}.${quote(pair.through)} = ${quote(target)}.${quote(pair.target)}`).join(" and ");
  predicates.push(asSelf(context, target, () => compilePredicateSQL(value.where!, metadata.target, target, schema, context, parameters)));
  return `(select count(*) from ${quote(through.relation)} as ${quote(counted)} join ${quote(metadata.target)} as ${quote(target)} on ${join} where ${predicates.join(" and ")})`;
}

function requiredFields(plan: SelectionPlan, relationName: string, schema: StoreSchema, additional: readonly string[] = []): string[] {
  const result = new Set<string>([...schema.relations[relationName]!.primaryKey, ...additional]);
  const visitValue = (value: ValueExpression) => {
    if (value.kind === "field" && (!value.scope || value.scope === "self")) result.add(value.field);
    if (value.kind === "count") for (const pair of relationship(schema, relationName, value.relationship).direct ?? relationship(schema, relationName, value.relationship).through!.source) result.add(pair.source);
  };
  const visitPredicate = (value: PredicateExpression) => {
    if (value.kind === "logical") value.operands.forEach(visitPredicate);
    else if (value.kind === "not") visitPredicate(value.operand);
    else if (value.kind === "some") return;
    else if (value.kind === "exists") {
      if (value.scope && value.scope !== "self") return;
      const metadata = relationship(schema, relationName, value.relationship);
      for (const pair of metadata.direct ?? metadata.through!.source) result.add(pair.source);
    } else { visitValue(value.left); visitValue(value.right); }
  };
  if (plan.where) visitPredicate(plan.where);
  for (const order of plan.orderBy) visitValue(order.value);
  for (const selected of Object.values(plan.select)) {
    if (selected.kind === "field" || selected.kind === "count") visitValue(selected);
    if (selected.kind === "relationship") {
      const metadata = relationship(schema, relationName, selected.relationship);
      for (const pair of metadata.direct ?? metadata.through!.source) result.add(pair.source);
    }
  }
  return [...result].sort();
}

function orderSQL(
  plan: SelectionPlan,
  relationName: string,
  alias: string,
  schema: StoreSchema,
  context: ExecutionContext,
  parameters: unknown[],
  relationshipMetadata?: RelationshipMetadata,
): string[] {
  const selectedCounts = new Map(Object.values(plan.select)
    .filter((selected): selected is CountExpression => selected.kind === "count")
    .map((selected) => [countIdentity(selected), selected]));
  const result = plan.orderBy.map((order) => {
    if (order.value.kind === "count") {
      const selected = selectedCounts.get(countIdentity(order.value)) ?? order.value;
      return `${quote(`__aggregate_${selected.id}`)} ${order.direction}`;
    }
    return `${compileRuntimeValue(order.value, relationName, alias, schema, context, parameters)} ${order.direction}`;
  });
  const orderedFields = new Set(plan.orderBy.filter((order) => order.value.kind === "field").map((order) => (order.value as { field: string }).field));
  for (const key of stableKey(schema, relationName, plan, relationshipMetadata)) {
    if (!orderedFields.has(key)) result.push(`${quote(alias)}.${quote(key)} asc`);
  }
  return result;
}

function selectionSQL(
  plan: SelectionPlan,
  relationName: string,
  alias: string,
  schema: StoreSchema,
  context: ExecutionContext,
  parameters: unknown[],
  additionalFields: readonly string[] = [],
): string[] {
  const result = requiredFields(plan, relationName, schema, additionalFields).map((name) => `${quote(alias)}.${quote(name)} as ${quote(name)}`);
  for (const selected of Object.values(plan.select)) {
    if (selected.kind === "count") result.push(`${countSQL(selected, relationName, alias, schema, context, parameters)} as ${quote(`__aggregate_${selected.id}`)}`);
  }
  const selectedCounts = new Set(Object.values(plan.select)
    .filter((selected): selected is CountExpression => selected.kind === "count")
    .map(countIdentity));
  for (const order of plan.orderBy) {
    if (order.value.kind === "count" && !selectedCounts.has(countIdentity(order.value))) {
      result.push(`${countSQL(order.value, relationName, alias, schema, context, parameters)} as ${quote(`__aggregate_${order.value.id}`)}`);
    }
  }
  return result;
}

function shareSelectedAggregates(rows: Record<string, unknown>[], plan: SelectionPlan): Record<string, unknown>[] {
  const selected = new Map(Object.values(plan.select)
    .filter((value): value is CountExpression => value.kind === "count")
    .map((value) => [countIdentity(value), value]));
  const aliases = plan.orderBy
    .filter((order): order is OrderExpression & { value: CountExpression } => order.value.kind === "count")
    .map((order) => ({ order: order.value, selected: selected.get(countIdentity(order.value)) }))
    .filter((value): value is { order: CountExpression; selected: CountExpression } => Boolean(value.selected));
  if (aliases.length === 0) return rows;
  return rows.map((row) => {
    const normalized = { ...row };
    for (const alias of aliases) normalized[`__aggregate_${alias.order.id}`] = row[`__aggregate_${alias.selected.id}`];
    return normalized;
  });
}

/** Two counts are the same aggregate when they count the same relationship under the same facts. */
function countIdentity(value: CountExpression): string {
  return value.where ? `${value.relationship}\0${JSON.stringify(value.where, (key, child) => key === "id" && typeof child === "number" ? undefined : child)}` : value.relationship;
}

/** The fields of other rows, by scope, that a plan's own predicates and counts read. */
export function scopedReads(plan: SelectionPlan): Array<{ scope: string; field: string }> {
  const reads = new Map<string, { scope: string; field: string }>();
  const local = new Set<string>(["self", ...(plan.scope ? [plan.scope] : [])]);
  const visitValue = (value: ValueExpression) => {
    if (value.kind === "field" && value.scope && !local.has(value.scope)) reads.set(`${value.scope}\0${value.field}`, { scope: value.scope, field: value.field });
    if (value.kind === "count" && value.where) visitPredicate(value.where);
  };
  const visitPredicate = (value: PredicateExpression) => {
    if (value.kind === "logical") value.operands.forEach(visitPredicate);
    else if (value.kind === "not") visitPredicate(value.operand);
    else if (value.kind === "some") {
      local.add(value.scope);
      visitPredicate(value.where);
    } else if (value.kind === "exists") {
      value.keys?.forEach(visitValue);
      if (value.where) visitPredicate(value.where);
    } else { visitValue(value.left); visitValue(value.right); }
  };
  if (plan.where) visitPredicate(plan.where);
  for (const order of plan.orderBy) visitValue(order.value);
  for (const selected of Object.values(plan.select)) if (selected.kind === "count") visitValue(selected);
  return [...reads.values()].sort((left, right) => `${left.scope}\0${left.field}`.localeCompare(`${right.scope}\0${right.field}`));
}

function tupleKey(values: readonly unknown[]): string {
  return JSON.stringify(values);
}

function dependencyFor(context: ExecutionContext, relation: string) {
  let dependency = context.databaseDependencies.get(relation);
  if (!dependency) {
    dependency = { rows: new Map(), matchAny: new Map() };
    context.databaseDependencies.set(relation, dependency);
  }
  return dependency;
}

function recordRows(context: ExecutionContext, schema: StoreSchema, relation: string, rows: readonly Record<string, unknown>[]): void {
  const fields = schema.relations[relation]!.primaryKey;
  const dependency = dependencyFor(context, relation);
  for (const row of rows) {
    const key = Object.fromEntries(fields.map((field) => [field, row[field]]));
    dependency.rows.set(tupleKey(fields.map((field) => row[field])), key);
  }
}

function recordMatches(context: ExecutionContext, relation: string, matches: readonly Record<string, unknown>[]): void {
  const dependency = dependencyFor(context, relation);
  for (const match of matches) dependency.matchAny.set(JSON.stringify(match), match);
}

function assertStableRows(
  rows: readonly Record<string, unknown>[],
  schema: StoreSchema,
  relationName: string,
  plan: SelectionPlan,
  relationshipMetadata?: RelationshipMetadata,
): void {
  const fields = stableKey(schema, relationName, plan, relationshipMetadata);
  const seen = new Set<string>();
  for (const row of rows) {
    const values = fields.map((field) => row[field]);
    if (values.some((value) => value === null || value === undefined)) throw new QueryCompileError(`Result from ${relationName} has a missing stable key`);
    const key = tupleKey(values);
    if (seen.has(key)) throw new QueryCompileError(`Result from ${relationName} has duplicate stable key ${key}`);
    seen.add(key);
  }
}

function uniqueTuples(rows: readonly Record<string, unknown>[], fields: readonly string[]): unknown[][] {
  const values = new Map<string, unknown[]>();
  for (const row of rows) {
    const tuple = fields.map((field) => row[field]);
    values.set(tupleKey(tuple), tuple);
  }
  return [...values.values()];
}

function tuplePredicate(alias: string, fields: readonly string[], tuples: readonly unknown[][], parameters: unknown[]): string {
  if (tuples.length === 0) return "0";
  return `(${tuples.map((tuple) => {
    parameters.push(...tuple);
    return `(${fields.map((field) => `${quote(alias)}.${quote(field)} = ?`).join(" and ")})`;
  }).join(" or ")})`;
}

function executeStatement(database: Database, sql: string, parameters: unknown[], context: ExecutionContext): Record<string, unknown>[] {
  const statement = { sql, parameters: [...parameters] };
  context.statements.push(statement);
  const explained = database.query(`explain query plan ${sql}`).all(...parameters as any[]) as Array<{ detail: string }>;
  context.queryPlans.push({ sql, details: explained.map((row) => row.detail) });
  return database.query(sql).all(...parameters as any[]) as Record<string, unknown>[];
}

function normalizeSQLiteRows(rows: Record<string, unknown>[], relation: RelationMetadata): Record<string, unknown>[] {
  const booleanFields = Object.values(relation.fields).filter((field) => field.type === "boolean").map((field) => field.name);
  if (booleanFields.length === 0) return rows;
  return rows.map((row) => {
    const normalized = { ...row };
    for (const field of booleanFields) {
      if (normalized[field] !== null && normalized[field] !== undefined) normalized[field] = Boolean(normalized[field]);
    }
    return normalized;
  });
}

function profileIDFromPredicate(predicate: PredicateExpression | undefined, context: ExecutionContext): string | undefined {
  if (!predicate) return undefined;
  if (predicate.kind === "logical") {
    if (predicate.operator !== "and") return undefined;
    for (const operand of predicate.operands) {
      const value = profileIDFromPredicate(operand, context);
      if (value) return value;
    }
    return undefined;
  }
  if (predicate.kind !== "comparison" || predicate.operator !== "eq" || predicate.left.kind !== "field" || predicate.left.field !== "id") return undefined;
  const value = runtimeValue(predicate.right, {}, context);
  return typeof value === "string" ? value : undefined;
}

async function resolveProfiles(
  resolver: ProfileResolver,
  ids: readonly string[],
  fields: readonly string[],
  context: ExecutionContext,
): Promise<Record<string, unknown>[]> {
  const uniqueIDs = [...new Set(ids)].sort();
  const batch = await resolver.resolve(uniqueIDs, fields);
  const requested = new Set(uniqueIDs);
  const returned = new Set<string>();
  for (const row of batch.rows) {
    const id = row.id;
    if (typeof id !== "string" || !requested.has(id)) throw new QueryCompileError("Profile resolver returned an unrequested or unidentified profile");
    if (returned.has(id)) throw new QueryCompileError(`Profile resolver returned duplicate profile ${id}`);
    returned.add(id);
  }
  for (const dependency of batch.dependencies) {
    if (!requested.has(dependency.profile) || dependency.tree !== dependency.profile || !dependency.ref) {
      throw new QueryCompileError("Profile resolver returned an invalid tree/ref dependency");
    }
    context.profileDependencies.set(`${dependency.tree}\0${dependency.ref}`, dependency);
  }
  for (const id of returned) {
    if (!batch.dependencies.some((dependency) => dependency.profile === id)) {
      throw new QueryCompileError(`Profile resolver omitted the tree/ref dependency for ${id}`);
    }
  }
  return [...batch.rows];
}

export class SQLiteQueryEngine implements AsyncDisposable {
  private readonly bindings = new WeakMap<QueryHandle<unknown, unknown>, ResolvedStorySource>();

  private constructor(
    readonly schema: StoreSchema,
    readonly databasePath: string,
    private readonly profiles: ProfileResolver,
    private readonly source: { tree: string; path: string },
  ) {}

  static async open(location: ResolvedDatabaseLocation, profiles: ProfileResolver): Promise<SQLiteQueryEngine> {
    if (!location.tree || !location.path) {
      throw new Error("A SQLite query engine requires the authoritative Overstory tree and store path");
    }
    const schema = await introspectStoreSchema(location);
    return new SQLiteQueryEngine(schema, location.databasePath, profiles, { tree: location.tree, path: location.path });
  }

  bind(handle: QueryHandle<unknown, unknown>, source: ResolvedStorySource): void {
    if (source.authoredPath !== handle.source.path) {
      throw new QueryCompileError("The resolved query source does not match its authored node() path");
    }
    this.assertSource(handle, source);
    this.bindings.set(handle, source);
  }

  private assertSource(handle: QueryHandle<unknown, unknown>, source: ResolvedStorySource): void {
    if (source.schemaFingerprint !== this.schema.fingerprint) {
      throw new QueryCompileError("The resolved query source schema is not active");
    }
    if (source.tree !== this.source.tree) {
      throw new QueryCompileError("The resolved query source belongs to another tree");
    }
    const parent = posix.dirname(source.path);
    if (parent !== this.source.path || posix.basename(source.path) !== handle.plan.relation) {
      throw new QueryCompileError("The resolved node() path does not name this SQLite store relation");
    }
  }

  subscribeProfiles(listener: (change: { profile: string; tree: string; ref: string }) => void): () => void {
    return this.profiles.subscribe?.(listener) ?? (() => undefined);
  }

  async execute<Result, Input>(
    handle: QueryHandle<Result, Input>,
    options: QueryExecutionOptions<Input> = {},
  ): Promise<QueryExecution<Result>> {
    const source = this.bindings.get(handle as QueryHandle<unknown, unknown>);
    if (!source) throw new QueryCompileError("The query's node() source was not resolved during activation");
    this.assertSource(handle as QueryHandle<unknown, unknown>, source);
    const compiled = compileQuery(handle, this.schema);
    const input = await validateQueryInput(handle.schema, options.input);
    const database = new Database(this.databasePath, { readonly: true, strict: true });
    const context: ExecutionContext = {
      database,
      input,
      user: options.user ?? null,
      statements: [],
      queryPlans: [],
      profileDependencies: new Map(),
      databaseDependencies: new Map(),
      bindings: { ...options.bindings },
      aliases: new Map(),
    };
    try {
      database.exec("begin");
      if (containsRequiredUser(compiled.plan) && !context.user) throw new QueryUserRequiredError();
      const raw = await this.rootRows(compiled.plan, context);
      const scopes = raw.map((row) => compiled.plan.scope ? { [compiled.plan.scope]: row } : {});
      if (compiled.plan.cardinality === "many" && isPortableNodePlan(compiled.plan)) {
        sortPortablePropertyRows(raw, this.schema.relations[compiled.plan.relation]!.primaryKey);
      }
      if (compiled.plan.cardinality === "many") assertStableRows(raw, this.schema, compiled.plan.relation, compiled.plan);
      const shaped = await this.shapeBatch(raw, compiled.plan.relation, compiled.plan, context, scopes);
      const result = finishCardinality(shaped, compiled.plan.cardinality, "row");
      database.exec("commit");
      return {
        result: result as Result,
        statements: context.statements,
        queryPlans: context.queryPlans,
        dependencies: {
          profiles: [...context.profileDependencies.values()].sort((left, right) => left.profile.localeCompare(right.profile)),
          database: Object.fromEntries([...context.databaseDependencies].sort(([left], [right]) => left.localeCompare(right)).map(([relation, value]) => [relation, {
            rows: [...value.rows.values()],
            matchAny: [...value.matchAny.values()],
          }])),
        },
        schemaFingerprint: this.schema.fingerprint,
      };
    } catch (error) {
      try { database.exec("rollback"); } catch {}
      throw error;
    } finally {
      database.close();
    }
  }

  private async rootRows(plan: QueryPlan, context: ExecutionContext): Promise<Record<string, unknown>[]> {
    const relationMetadata = this.schema.relations[plan.relation]!;
    const portable = isPortableNodePlan(plan);
    if (relationMetadata.source === "overstory-profile") {
      const id = profileIDFromPredicate(plan.where, context);
      if (!id) throw new QueryCompileError("A root profile-relation query must constrain id exactly");
      const fields = requiredFields(plan, plan.relation, this.schema);
      let rows = (await resolveProfiles(this.profiles, [id], fields, context)).filter((row) => evaluatePredicate(plan.where, row, context));
      rows = sortRows(rows, plan.relation, plan, this.schema, context);
      return rows.slice(0, plan.take ?? (plan.cardinality === "many" ? undefined : 2));
    }
    const alias = "root";
    const parameters: unknown[] = [];
    context.aliases = new Map([["self", alias], ...(plan.scope ? [[plan.scope, alias] as [string, string]] : [])]);
    const selections = selectionSQL(plan, plan.relation, alias, this.schema, context, parameters);
    const where = !portable && plan.where ? ` where ${compilePredicateSQL(plan.where, plan.relation, alias, this.schema, context, parameters)}` : "";
    const orders = portable ? [] : orderSQL(plan, plan.relation, alias, this.schema, context, parameters);
    const order = orders.length ? ` order by ${orders.join(", ")}` : "";
    const limit = portable ? undefined : plan.take ?? (plan.cardinality === "many" ? undefined : 2);
    const sql = `select ${selections.join(", ")} from ${quote(plan.relation)} as ${quote(alias)}${where}${order}${limit ? ` limit ${limit}` : ""}`;
    const rows = shareSelectedAggregates(normalizeSQLiteRows(executeStatement(context.database, sql, parameters, context), relationMetadata), plan);
    recordRows(context, this.schema, plan.relation, rows);
    return portable ? rows.filter((row) => evaluatePredicate(plan.where, row, context)) : rows;
  }

  private async shapeBatch(
    rows: Record<string, unknown>[],
    relationName: string,
    plan: SelectionPlan,
    context: ExecutionContext,
    scopes: Record<string, Record<string, unknown>>[] = rows.map(() => ({})),
  ): Promise<Record<string, unknown>[]> {
    const shaped = rows.map((row) => {
      const value: Record<string, unknown> = {};
      for (const [name, selected] of Object.entries(plan.select)) {
        if (selected.kind === "field" || selected.kind === "count") value[name] = runtimeValue(selected, row, context);
      }
      return value;
    });
    for (const [name, selected] of Object.entries(plan.select)) {
      if (selected.kind !== "relationship") continue;
      const metadata = relationship(this.schema, relationName, selected.relationship);
      const children = await this.boundRelationshipRows(rows, metadata, selected, context, scopes);
      const flattened: Record<string, unknown>[] = [];
      const flattenedScopes: Record<string, Record<string, unknown>>[] = [];
      const owners: number[] = [];
      for (let parent = 0; parent < children.length; parent++) {
        for (const child of children[parent] ?? []) {
          flattened.push(child);
          flattenedScopes.push(selected.plan.scope ? { ...scopes[parent], [selected.plan.scope]: child } : scopes[parent]!);
          owners.push(parent);
        }
      }
      const childValues = await this.shapeBatch(flattened, metadata.target, selected.plan, context, flattenedScopes);
      const grouped = rows.map(() => [] as Record<string, unknown>[]);
      childValues.forEach((child, index) => grouped[owners[index]!]!.push(child));
      grouped.forEach((values, parent) => {
        if (metadata.cardinality === "many") shaped[parent]![name] = values;
        else {
          if (values.length > 1) throw new QueryCompileError(`Relationship ${metadata.source}.${metadata.name} returned more than one row`);
          // A filtered to-one (a read rule hid the row) reads as null; an unfiltered one must exist.
          if (metadata.cardinality === "one" && values.length !== 1 && !selected.plan.where) throw new QueryCompileError(`Required relationship ${metadata.source}.${metadata.name} is missing`);
          shaped[parent]![name] = values[0] ?? null;
        }
      });
    }
    return shaped;
  }

  /**
   * A nested selection whose facts name an enclosing row runs once per distinct binding of
   * those rows (usually one: the row a page is about), not once per parent.
   */
  private async boundRelationshipRows(
    parents: Record<string, unknown>[],
    metadata: RelationshipMetadata,
    selected: RelationshipSelection,
    context: ExecutionContext,
    scopes: Record<string, Record<string, unknown>>[],
  ): Promise<Record<string, unknown>[][]> {
    const referenced = scopedReads(selected.plan).filter((read) => scopes.some((bound) => read.scope in bound));
    if (referenced.length === 0 || parents.length === 0) return this.relationshipRows(parents, metadata, selected, context);
    const partitions = new Map<string, number[]>();
    parents.forEach((_parent, index) => {
      const key = tupleKey(referenced.map((read) => scopes[index]![read.scope]?.[read.field] ?? null));
      partitions.set(key, [...(partitions.get(key) ?? []), index]);
    });
    const grouped = parents.map(() => [] as Record<string, unknown>[]);
    const outer = context.bindings;
    try {
      for (const indexes of partitions.values()) {
        const bound = scopes[indexes[0]!]!;
        context.bindings = { ...outer };
        for (const read of referenced) {
          if (!bound[read.scope]) throw new QueryCompileError(`No row is bound for ${read.scope}`);
          context.bindings[read.scope] = bound[read.scope]!;
        }
        const rows = await this.relationshipRows(indexes.map((index) => parents[index]!), metadata, selected, context);
        rows.forEach((children, position) => { grouped[indexes[position]!] = children; });
      }
    } finally {
      context.bindings = outer;
    }
    return grouped;
  }

  private async relationshipRows(
    parents: Record<string, unknown>[],
    metadata: RelationshipMetadata,
    selected: RelationshipSelection,
    context: ExecutionContext,
  ): Promise<Record<string, unknown>[][]> {
    if (parents.length === 0) return [];
    const target = this.schema.relations[metadata.target]!;
    const grouped = target.source === "overstory-profile"
      ? await this.profileRelationshipRows(parents, metadata, selected.plan, context)
      : this.sqliteRelationshipRows(parents, metadata, selected.plan, context);
    return grouped.map((rows) => {
      const ordered = target.source === "overstory-profile"
        ? sortRows(rows, metadata.target, selected.plan, this.schema, context, metadata)
        : rows;
      if (metadata.cardinality === "many") assertStableRows(ordered, this.schema, metadata.target, selected.plan, metadata);
      return ordered.slice(0, selected.plan.take);
    });
  }

  private sqliteRelationshipRows(
    parents: Record<string, unknown>[],
    metadata: RelationshipMetadata,
    plan: SelectionPlan,
    context: ExecutionContext,
  ): Record<string, unknown>[][] {
    const parameters: unknown[] = [];
    const alias = "related";
    let from = `${quote(metadata.target)} as ${quote(alias)}`;
    let constraint: string;
    let parentFields: string[];
    const extraFields: string[] = [];
    const parentAliases: string[] = [];
    if (metadata.direct) {
      parentFields = metadata.direct.map((pair) => pair.source);
      const targetFields = metadata.direct.map((pair) => pair.target);
      extraFields.push(...targetFields);
      constraint = tuplePredicate(alias, targetFields, uniqueTuples(parents, parentFields), parameters);
    } else {
      const through = metadata.through!;
      const link = "link";
      parentFields = through.source.map((pair) => pair.source);
      const throughParentFields = through.source.map((pair) => pair.through);
      const join = through.target.map((pair) => `${quote(link)}.${quote(pair.through)} = ${quote(alias)}.${quote(pair.target)}`).join(" and ");
      from += ` join ${quote(through.relation)} as ${quote(link)} on ${join}`;
      constraint = tuplePredicate(link, throughParentFields, uniqueTuples(parents, parentFields), parameters);
      throughParentFields.forEach((field, index) => parentAliases.push(`${quote(link)}.${quote(field)} as ${quote(`__parent_${index}`)}`));
    }
    context.aliases = new Map([["self", alias], ...(plan.scope ? [[plan.scope, alias] as [string, string]] : [])]);
    if (plan.where) constraint += ` and ${compilePredicateSQL(plan.where, metadata.target, alias, this.schema, context, parameters)}`;
    const selectionParameters: unknown[] = [];
    const selections = [...selectionSQL(plan, metadata.target, alias, this.schema, context, selectionParameters, extraFields), ...parentAliases];
    const orderParameters: unknown[] = [];
    const orders = orderSQL(plan, metadata.target, alias, this.schema, context, orderParameters, metadata);
    parameters.unshift(...selectionParameters);
    parameters.push(...orderParameters);
    const sql = `select ${selections.join(", ")} from ${from} where ${constraint}${orders.length ? ` order by ${orders.join(", ")}` : ""}`;
    const rows = shareSelectedAggregates(
      normalizeSQLiteRows(executeStatement(context.database, sql, parameters, context), this.schema.relations[metadata.target]!),
      plan,
    );
    recordRows(context, this.schema, metadata.target, rows);
    if (metadata.direct) {
      recordMatches(context, metadata.target, uniqueTuples(parents, parentFields).map((tuple) =>
        Object.fromEntries(metadata.direct!.map((pair, index) => [pair.target, tuple[index]]))));
    } else {
      recordMatches(context, metadata.through!.relation, uniqueTuples(parents, parentFields).map((tuple) =>
        Object.fromEntries(metadata.through!.source.map((pair, index) => [pair.through, tuple[index]]))));
    }
    const parentLookup = new Map<string, number[]>();
    parents.forEach((parent, index) => {
      const key = tupleKey(parentFields.map((field) => parent[field]));
      parentLookup.set(key, [...(parentLookup.get(key) ?? []), index]);
    });
    const grouped = parents.map(() => [] as Record<string, unknown>[]);
    for (const row of rows) {
      const key = metadata.direct
        ? tupleKey(metadata.direct.map((pair) => row[pair.target]))
        : tupleKey(metadata.through!.source.map((_pair, index) => row[`__parent_${index}`]));
      for (const parent of parentLookup.get(key) ?? []) grouped[parent]!.push(row);
    }
    return grouped;
  }

  private async profileRelationshipRows(
    parents: Record<string, unknown>[],
    metadata: RelationshipMetadata,
    plan: SelectionPlan,
    context: ExecutionContext,
  ): Promise<Record<string, unknown>[][]> {
    const links = parents.map(() => [] as string[]);
    if (metadata.direct) {
      parents.forEach((parent, index) => {
        const idPair = metadata.direct!.find((pair) => pair.target === "id");
        if (!idPair) throw new QueryCompileError(`Profile relationship ${metadata.source}.${metadata.name} must target id`);
        const value = parent[idPair.source];
        if (typeof value === "string") links[index]!.push(value);
      });
    } else {
      const through = metadata.through!;
      const idPair = through.target.find((pair) => pair.target === "id");
      if (!idPair) throw new QueryCompileError(`Profile relationship ${metadata.source}.${metadata.name} must target id`);
      const parameters: unknown[] = [];
      const parentFields = through.source.map((pair) => pair.source);
      const linkFields = through.source.map((pair) => pair.through);
      recordMatches(context, through.relation, uniqueTuples(parents, parentFields).map((tuple) =>
        Object.fromEntries(through.source.map((pair, index) => [pair.through, tuple[index]]))));
      const constraint = tuplePredicate("link", linkFields, uniqueTuples(parents, parentFields), parameters);
      const aliases = linkFields.map((field, index) => `${quote("link")}.${quote(field)} as ${quote(`__parent_${index}`)}`);
      const sql = `select ${[...aliases, `${quote("link")}.${quote(idPair.through)} as ${quote("__profile_id")}`].join(", ")} from ${quote(through.relation)} as ${quote("link")} where ${constraint}`;
      const rows = executeStatement(context.database, sql, parameters, context);
      const parentLookup = new Map<string, number[]>();
      parents.forEach((parent, index) => {
        const key = tupleKey(parentFields.map((field) => parent[field]));
        parentLookup.set(key, [...(parentLookup.get(key) ?? []), index]);
      });
      for (const row of rows) {
        const key = tupleKey(linkFields.map((_field, index) => row[`__parent_${index}`]));
        for (const parent of parentLookup.get(key) ?? []) if (typeof row.__profile_id === "string") links[parent]!.push(row.__profile_id);
      }
    }
    const ids = [...new Set(links.flat())];
    const fields = requiredFields(plan, metadata.target, this.schema);
    const profiles = await resolveProfiles(this.profiles, ids, fields, context);
    const byID = new Map(profiles.map((profile) => [String(profile.id), profile]));
    return links.map((values) => values
      .map((id) => byID.get(id))
      .filter((profile): profile is Record<string, unknown> => Boolean(profile))
      .filter((profile) => evaluatePredicate(plan.where, profile, context)));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    // Executions own short-lived read connections so concurrent subscriptions
    // cannot interleave statements within one SQLite snapshot.
  }
}
