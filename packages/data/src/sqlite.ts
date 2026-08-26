import { Database } from "bun:sqlite";
import type {
  ArborUser,
  CountExpression,
  OrderExpression,
  PredicateExpression,
  QueryHandle,
  QueryPlan,
  RelationshipSelection,
  SelectionPlan,
  SelectionValue,
  StandardSchemaV1,
  ValueExpression,
} from "./authoring.ts";
import type {
  RelationMetadata,
  RelationshipMetadata,
  ResolvedDatabaseLocation,
  StoreSchema,
} from "./schema.ts";
import { introspectStoreSchema } from "./schema.ts";

export interface ProfileResolver {
  resolve(ids: readonly string[], fields: readonly string[]): Promise<{
    rows: readonly Record<string, unknown>[];
    dependencies: readonly ProfileDependency[];
  }>;
}

export interface ProfileDependency {
  profile: string;
  tree: string;
  ref: string;
}

export interface QueryExecutionOptions<Input = unknown> {
  input?: Input;
  user?: ArborUser | null;
}

export interface ExecutedStatement {
  sql: string;
  parameters: unknown[];
}

export interface QueryExecution<Result> {
  result: Result;
  statements: ExecutedStatement[];
  queryPlans: Array<{ sql: string; details: string[] }>;
  dependencies: { profiles: ProfileDependency[] };
  schemaFingerprint: string;
}

export class QueryCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryCompileError";
  }
}

export class QueryInputError extends Error {
  constructor(readonly issues: readonly { message: string; path?: readonly unknown[] }[]) {
    super(issues.map((issue) => issue.message).join("; ") || "Invalid query input");
    this.name = "QueryInputError";
  }
}

export class QueryUserRequiredError extends Error {
  constructor() {
    super("This query requires an Arbor user");
    this.name = "QueryUserRequiredError";
  }
}

interface ExecutionContext {
  input: unknown;
  user: ArborUser | null;
  statements: ExecutedStatement[];
  queryPlans: Array<{ sql: string; details: string[] }>;
  profileDependencies: Map<string, ProfileDependency>;
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
  if (value.kind === "field") field(schema, relation, value.field);
  if (value.kind === "count") relationship(schema, relation, value.relationship);
}

function validatePredicate(schema: StoreSchema, relation: string, value: PredicateExpression): void {
  if (value.kind === "logical") {
    if (value.operands.length === 0) throw new QueryCompileError("A logical predicate cannot be empty");
    for (const operand of value.operands) validatePredicate(schema, relation, operand);
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
  if (predicate.operator === "eq" && predicate.left.kind === "field" && predicate.right.kind !== "field" && predicate.right.kind !== "count") {
    result.add(predicate.left.field);
  }
  return result;
}

function containsRequiredUser(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if ((value as { kind?: string }).kind === "user" && (value as { required?: boolean }).required) return true;
  if (Array.isArray(value)) return value.some(containsRequiredUser);
  return Object.entries(value).some(([key, child]) => key !== "schema" && containsRequiredUser(child));
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

function parameterValue(input: unknown, path: readonly string[]): unknown {
  let value = input;
  for (const part of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function runtimeValue(value: ValueExpression, row: Record<string, unknown>, context: ExecutionContext): unknown {
  if (value.kind === "field") return row[value.field];
  if (value.kind === "parameter") return parameterValue(context.input, value.path);
  if (value.kind === "user") return context.user?.[value.field] ?? null;
  if (value.kind === "literal") return value.value;
  return row[`__aggregate_${value.id}`];
}

function evaluatePredicate(value: PredicateExpression | undefined, row: Record<string, unknown>, context: ExecutionContext): boolean {
  if (!value) return true;
  if (value.kind === "logical") {
    return value.operator === "and"
      ? value.operands.every((operand) => evaluatePredicate(operand, row, context))
      : value.operands.some((operand) => evaluatePredicate(operand, row, context));
  }
  const left = runtimeValue(value.left, row, context);
  const right = runtimeValue(value.right, row, context);
  if (value.operator === "eq") return left === right;
  return String(left ?? "").toLocaleLowerCase().includes(String(right ?? "").toLocaleLowerCase());
}

function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  const leftBytes = new TextEncoder().encode(String(left));
  const rightBytes = new TextEncoder().encode(String(right));
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
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
      const compared = compareValues(runtimeValue(order.value, left, context), runtimeValue(order.value, right, context));
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
  if (value.kind === "field") return `${quote(alias)}.${quote(value.field)}`;
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
  return countSQL(value, relationName, alias, schema);
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
  const left = compileRuntimeValue(value.left, relationName, alias, schema, context, parameters);
  const rightValue = value.right.kind === "parameter"
    ? parameterValue(context.input, value.right.path)
    : value.right.kind === "user"
      ? context.user?.profile ?? null
      : value.right.kind === "literal"
        ? value.right.value
        : undefined;
  if (value.operator === "eq" && rightValue === null) return `${left} is null`;
  const right = compileRuntimeValue(value.right, relationName, alias, schema, context, parameters);
  if (value.operator === "eq") return `${left} = ${right}`;
  return `instr(lower(${left}), lower(${right})) > 0`;
}

function countSQL(value: CountExpression, relationName: string, alias: string, schema: StoreSchema): string {
  const metadata = relationship(schema, relationName, value.relationship);
  if (metadata.direct) {
    const target = quote(metadata.target);
    const predicates = metadata.direct.map((pair) => `${quote("counted")}.${quote(pair.target)} = ${quote(alias)}.${quote(pair.source)}`);
    return `(select count(*) from ${target} as ${quote("counted")} where ${predicates.join(" and ")})`;
  }
  const through = metadata.through!;
  const predicates = through.source.map((pair) => `${quote("counted")}.${quote(pair.through)} = ${quote(alias)}.${quote(pair.source)}`);
  return `(select count(*) from ${quote(through.relation)} as ${quote("counted")} where ${predicates.join(" and ")})`;
}

function requiredFields(plan: SelectionPlan, relationName: string, schema: StoreSchema, additional: readonly string[] = []): string[] {
  const result = new Set<string>([...schema.relations[relationName]!.primaryKey, ...additional]);
  const visitValue = (value: ValueExpression) => {
    if (value.kind === "field") result.add(value.field);
    if (value.kind === "count") for (const pair of relationship(schema, relationName, value.relationship).direct ?? relationship(schema, relationName, value.relationship).through!.source) result.add(pair.source);
  };
  const visitPredicate = (value: PredicateExpression) => {
    if (value.kind === "logical") value.operands.forEach(visitPredicate);
    else { visitValue(value.left); visitValue(value.right); }
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
    .map((selected) => [selected.relationship, selected]));
  const result = plan.orderBy.map((order) => {
    if (order.value.kind === "count") {
      const selected = selectedCounts.get(order.value.relationship) ?? order.value;
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
  additionalFields: readonly string[] = [],
): string[] {
  const result = requiredFields(plan, relationName, schema, additionalFields).map((name) => `${quote(alias)}.${quote(name)} as ${quote(name)}`);
  for (const selected of Object.values(plan.select)) {
    if (selected.kind === "count") result.push(`${countSQL(selected, relationName, alias, schema)} as ${quote(`__aggregate_${selected.id}`)}`);
  }
  const selectedCounts = new Set(Object.values(plan.select)
    .filter((selected): selected is CountExpression => selected.kind === "count")
    .map((selected) => selected.relationship));
  for (const order of plan.orderBy) {
    if (order.value.kind === "count" && !selectedCounts.has(order.value.relationship)) {
      result.push(`${countSQL(order.value, relationName, alias, schema)} as ${quote(`__aggregate_${order.value.id}`)}`);
    }
  }
  return result;
}

function shareSelectedAggregates(rows: Record<string, unknown>[], plan: SelectionPlan): Record<string, unknown>[] {
  const selected = new Map(Object.values(plan.select)
    .filter((value): value is CountExpression => value.kind === "count")
    .map((value) => [value.relationship, value]));
  const aliases = plan.orderBy
    .filter((order): order is OrderExpression & { value: CountExpression } => order.value.kind === "count")
    .map((order) => ({ order: order.value, selected: selected.get(order.value.relationship) }))
    .filter((value): value is { order: CountExpression; selected: CountExpression } => Boolean(value.selected));
  if (aliases.length === 0) return rows;
  return rows.map((row) => {
    const normalized = { ...row };
    for (const alias of aliases) normalized[`__aggregate_${alias.order.id}`] = row[`__aggregate_${alias.selected.id}`];
    return normalized;
  });
}

function tupleKey(values: readonly unknown[]): string {
  return JSON.stringify(values);
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

async function validatedInput<Input>(schema: StandardSchemaV1<Input, Input> | undefined, input: unknown): Promise<Input | undefined> {
  if (!schema) {
    if (input !== undefined) throw new QueryInputError([{ message: "This query does not accept input" }]);
    return undefined;
  }
  const result = await schema["~standard"].validate(input);
  if (result.issues) throw new QueryInputError(result.issues);
  return result.value;
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
  if (predicate.operator !== "eq" || predicate.left.kind !== "field" || predicate.left.field !== "id") return undefined;
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
  private constructor(
    readonly schema: StoreSchema,
    private readonly database: Database,
    private readonly profiles: ProfileResolver,
  ) {}

  static async open(location: ResolvedDatabaseLocation, profiles: ProfileResolver): Promise<SQLiteQueryEngine> {
    const schema = await introspectStoreSchema(location);
    const database = new Database(location.databasePath, { readonly: true, strict: true });
    return new SQLiteQueryEngine(schema, database, profiles);
  }

  async execute<Result, Input>(
    handle: QueryHandle<Result, Input>,
    options: QueryExecutionOptions<Input> = {},
  ): Promise<QueryExecution<Result>> {
    const compiled = compileQuery(handle, this.schema);
    const input = await validatedInput(handle.schema, options.input);
    const context: ExecutionContext = {
      input,
      user: options.user ?? null,
      statements: [],
      queryPlans: [],
      profileDependencies: new Map(),
    };
    if (containsRequiredUser(compiled.plan) && !context.user) throw new QueryUserRequiredError();
    const raw = await this.rootRows(compiled.plan, context);
    if (compiled.plan.cardinality === "many") assertStableRows(raw, this.schema, compiled.plan.relation, compiled.plan);
    const shaped = await this.shapeBatch(raw, compiled.plan.relation, compiled.plan, context);
    let result: unknown;
    if (compiled.plan.cardinality === "many") result = shaped;
    else {
      if (shaped.length > 1) throw new QueryCompileError(`query.${compiled.plan.cardinality} returned more than one row`);
      if (compiled.plan.cardinality === "one" && shaped.length !== 1) throw new QueryCompileError("query.one returned no row");
      result = shaped[0] ?? null;
    }
    return {
      result: result as Result,
      statements: context.statements,
      queryPlans: context.queryPlans,
      dependencies: { profiles: [...context.profileDependencies.values()].sort((left, right) => left.profile.localeCompare(right.profile)) },
      schemaFingerprint: this.schema.fingerprint,
    };
  }

  private async rootRows(plan: QueryPlan, context: ExecutionContext): Promise<Record<string, unknown>[]> {
    const relationMetadata = this.schema.relations[plan.relation]!;
    if (relationMetadata.source === "arbor-profile") {
      const id = profileIDFromPredicate(plan.where, context);
      if (!id) throw new QueryCompileError("A root arbor_profiles query must constrain id exactly");
      const fields = requiredFields(plan, plan.relation, this.schema);
      let rows = (await resolveProfiles(this.profiles, [id], fields, context)).filter((row) => evaluatePredicate(plan.where, row, context));
      rows = sortRows(rows, plan.relation, plan, this.schema, context);
      return rows.slice(0, plan.take ?? (plan.cardinality === "many" ? undefined : 2));
    }
    const alias = "root";
    const parameters: unknown[] = [];
    const selections = selectionSQL(plan, plan.relation, alias, this.schema);
    const where = plan.where ? ` where ${compilePredicateSQL(plan.where, plan.relation, alias, this.schema, context, parameters)}` : "";
    const orders = orderSQL(plan, plan.relation, alias, this.schema, context, parameters);
    const order = orders.length ? ` order by ${orders.join(", ")}` : "";
    const limit = plan.take ?? (plan.cardinality === "many" ? undefined : 2);
    const sql = `select ${selections.join(", ")} from ${quote(plan.relation)} as ${quote(alias)}${where}${order}${limit ? ` limit ${limit}` : ""}`;
    return shareSelectedAggregates(normalizeSQLiteRows(executeStatement(this.database, sql, parameters, context), relationMetadata), plan);
  }

  private async shapeBatch(
    rows: Record<string, unknown>[],
    relationName: string,
    plan: SelectionPlan,
    context: ExecutionContext,
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
      const children = await this.relationshipRows(rows, metadata, selected, context);
      const flattened: Record<string, unknown>[] = [];
      const owners: number[] = [];
      for (let parent = 0; parent < children.length; parent++) {
        for (const child of children[parent] ?? []) {
          flattened.push(child);
          owners.push(parent);
        }
      }
      const childValues = await this.shapeBatch(flattened, metadata.target, selected.plan, context);
      const grouped = rows.map(() => [] as Record<string, unknown>[]);
      childValues.forEach((child, index) => grouped[owners[index]!]!.push(child));
      grouped.forEach((values, parent) => {
        if (metadata.cardinality === "many") shaped[parent]![name] = values;
        else {
          if (values.length > 1) throw new QueryCompileError(`Relationship ${metadata.source}.${metadata.name} returned more than one row`);
          if (metadata.cardinality === "one" && values.length !== 1) throw new QueryCompileError(`Required relationship ${metadata.source}.${metadata.name} is missing`);
          shaped[parent]![name] = values[0] ?? null;
        }
      });
    }
    return shaped;
  }

  private async relationshipRows(
    parents: Record<string, unknown>[],
    metadata: RelationshipMetadata,
    selected: RelationshipSelection,
    context: ExecutionContext,
  ): Promise<Record<string, unknown>[][]> {
    if (parents.length === 0) return [];
    const target = this.schema.relations[metadata.target]!;
    const grouped = target.source === "arbor-profile"
      ? await this.profileRelationshipRows(parents, metadata, selected.plan, context)
      : this.sqliteRelationshipRows(parents, metadata, selected.plan, context);
    return grouped.map((rows) => {
      const ordered = target.source === "arbor-profile"
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
    if (plan.where) constraint += ` and ${compilePredicateSQL(plan.where, metadata.target, alias, this.schema, context, parameters)}`;
    const selections = [...selectionSQL(plan, metadata.target, alias, this.schema, extraFields), ...parentAliases];
    const orders = orderSQL(plan, metadata.target, alias, this.schema, context, parameters, metadata);
    const sql = `select ${selections.join(", ")} from ${from} where ${constraint}${orders.length ? ` order by ${orders.join(", ")}` : ""}`;
    const rows = shareSelectedAggregates(
      normalizeSQLiteRows(executeStatement(this.database, sql, parameters, context), this.schema.relations[metadata.target]!),
      plan,
    );
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
      const constraint = tuplePredicate("link", linkFields, uniqueTuples(parents, parentFields), parameters);
      const aliases = linkFields.map((field, index) => `${quote("link")}.${quote(field)} as ${quote(`__parent_${index}`)}`);
      const sql = `select ${[...aliases, `${quote("link")}.${quote(idPair.through)} as ${quote("__profile_id")}`].join(", ")} from ${quote(through.relation)} as ${quote("link")} where ${constraint}`;
      const rows = executeStatement(this.database, sql, parameters, context);
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
    this.database.close();
  }
}
