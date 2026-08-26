const NODE = Symbol.for("arbor.data.node");
const RELATION = Symbol.for("arbor.data.relation");
const DATABASE = Symbol.for("arbor.data.database");

export type QueryCardinality = "many" | "one" | "maybe";
export type Direction = "asc" | "desc";

export interface FieldExpression {
  kind: "field";
  id: number;
  relation: string;
  field: string;
}

export interface ParameterExpression {
  kind: "parameter";
  id: number;
  path: string[];
}

export interface UserExpression {
  kind: "user";
  id: number;
  field: "profile";
  required: boolean;
}

export interface LiteralExpression {
  kind: "literal";
  id: number;
  value: unknown;
}

export interface CountExpression {
  kind: "count";
  id: number;
  relation: string;
  relationship: string;
}

export type ValueExpression =
  | FieldExpression
  | ParameterExpression
  | UserExpression
  | LiteralExpression
  | CountExpression;

export interface ComparisonExpression {
  kind: "comparison";
  id: number;
  operator: "eq" | "contains";
  left: ValueExpression;
  right: ValueExpression;
}

export interface LogicalExpression {
  kind: "logical";
  id: number;
  operator: "and" | "or";
  operands: PredicateExpression[];
}

export type PredicateExpression = ComparisonExpression | LogicalExpression;

export interface OrderExpression {
  kind: "order";
  id: number;
  value: ValueExpression;
  direction: Direction;
}

export interface RelationshipSelection {
  kind: "relationship";
  id: number;
  relation: string;
  relationship: string;
  plan: SelectionPlan;
}

export type SelectionValue = ValueExpression | RelationshipSelection;
export type Selection = Record<string, SelectionValue>;

export interface SelectionPlan {
  where?: PredicateExpression;
  orderBy: OrderExpression[];
  take?: number;
  after?: unknown;
  keyBy?: string[];
  select: Selection;
}

export interface QueryPlan extends SelectionPlan {
  relation: string;
  cardinality: QueryCardinality;
}

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) =>
      | { value: Output; issues?: undefined }
      | { value?: undefined; issues: readonly { message: string; path?: readonly (PropertyKey | { key: PropertyKey })[] }[] }
      | Promise<
          | { value: Output; issues?: undefined }
          | { value?: undefined; issues: readonly { message: string; path?: readonly (PropertyKey | { key: PropertyKey })[] }[] }
        >;
  };
}

export interface DatabaseHandle {
  readonly path: string;
  readonly relations: Record<string, RelationHandle>;
}

export interface RelationHandle<Row = Record<string, unknown>> {
  readonly __row?: Row;
  pick<Keys extends keyof Row & string>(...fields: Keys[]): Pick<Row, Keys>;
  readonly [field: string]: unknown;
}

export interface QueryHandle<Result = unknown, Input = undefined> {
  readonly kind: "query";
  readonly database: DatabaseHandle;
  readonly plan: QueryPlan;
  readonly schema?: StandardSchemaV1<Input, Input>;
  readonly __result?: Result;
  readonly __input?: Input;
}

export interface MutationHandle<Result = unknown, Input = unknown> {
  readonly kind: "mutation";
  readonly database: DatabaseHandle;
  readonly schema: StandardSchemaV1<Input, Input>;
  readonly handler: (...args: any[]) => Result | Promise<Result>;
  readonly __result?: Result;
  readonly __input?: Input;
}

export type RowOf<Relation> = Relation extends RelationHandle<infer Row> ? Row : never;
export type ResultOf<Handle> = Handle extends QueryHandle<infer Result, any>
  ? Result
  : Handle extends MutationHandle<infer Result, any>
    ? Awaited<Result>
    : never;

export interface ArborUser {
  profile: string;
}

let nextNodeID = 1;
function nodeID(): number { return nextNodeID++; }

function tagged<T extends { kind: string }>(value: T): T {
  Object.defineProperty(value, NODE, { value, enumerable: false });
  return value;
}

export function dataNode(value: unknown): ValueExpression | PredicateExpression | OrderExpression | RelationshipSelection | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  return (value as { [NODE]?: ValueExpression | PredicateExpression | OrderExpression | RelationshipSelection })[NODE];
}

function literal(value: unknown): LiteralExpression {
  return tagged({ kind: "literal", id: nodeID(), value });
}

function valueExpression(value: unknown): ValueExpression {
  const node = dataNode(value);
  if (node && ["field", "parameter", "user", "literal", "count"].includes(node.kind)) return node as ValueExpression;
  return literal(value);
}

function predicate(operator: ComparisonExpression["operator"], left: ValueExpression, right: unknown): PredicateExpression {
  const result = tagged({ kind: "comparison", id: nodeID(), operator, left, right: valueExpression(right) } satisfies ComparisonExpression);
  return new Proxy(result, {
    get(target, property, receiver) {
      if (property === "or") return (...others: unknown[]) => logical("or", [target, ...others.map(predicateExpression)]);
      return Reflect.get(target, property, receiver);
    },
  });
}

function predicateExpression(value: unknown): PredicateExpression {
  const node = dataNode(value);
  if (!node || (node.kind !== "comparison" && node.kind !== "logical")) {
    throw new Error("A query predicate must be built from symbolic fields");
  }
  return node;
}

function logical(operator: LogicalExpression["operator"], operands: PredicateExpression[]): LogicalExpression {
  return tagged({ kind: "logical", id: nodeID(), operator, operands });
}

function member(relation: string, field: string): unknown {
  const fieldNode = tagged({ kind: "field", id: nodeID(), relation, field } satisfies FieldExpression);
  const callable = () => undefined;
  Object.defineProperty(callable, NODE, { value: fieldNode, enumerable: false });
  return new Proxy(callable, {
    apply(_target, _this, argumentsList) {
      return relationshipSelection(relation, field, argumentsList[0]);
    },
    get(target, property, receiver) {
      if (property === NODE) return fieldNode;
      if (property === "eq") return (right: unknown) => predicate("eq", fieldNode, right);
      if (property === "contains") return (right: unknown) => predicate("contains", fieldNode, right);
      if (property === "asc") return () => tagged({ kind: "order", id: nodeID(), value: fieldNode, direction: "asc" } satisfies OrderExpression);
      if (property === "desc") return () => tagged({ kind: "order", id: nodeID(), value: fieldNode, direction: "desc" } satisfies OrderExpression);
      if (property === "count") {
        const count = tagged({ kind: "count", id: nodeID(), relation, relationship: field } satisfies CountExpression);
        return new Proxy(count, {
          get(countTarget, countProperty, countReceiver) {
            if (countProperty === "asc") return () => tagged({ kind: "order", id: nodeID(), value: countTarget, direction: "asc" } satisfies OrderExpression);
            if (countProperty === "desc") return () => tagged({ kind: "order", id: nodeID(), value: countTarget, direction: "desc" } satisfies OrderExpression);
            return Reflect.get(countTarget, countProperty, countReceiver);
          },
        });
      }
      if (property === "then") return undefined;
      return Reflect.get(target, property, receiver);
    },
  });
}

function rowScope(relation: string, owner?: DatabaseHandle): RelationHandle {
  const target = {};
  return new Proxy(target, {
    get(_target, property) {
      if (property === RELATION) return relation;
      if (property === DATABASE) return owner;
      if (property === "pick") return (...fields: string[]) => Object.fromEntries(fields.map((field) => [field, member(relation, field)]));
      if (property === "then") return undefined;
      if (typeof property === "string") return member(relation, property);
      return undefined;
    },
  }) as unknown as RelationHandle;
}

function parameterProxy(path: string[] = []): unknown {
  const target = {};
  return new Proxy(target, {
    get(_target, property) {
      if (property === NODE) return tagged({ kind: "parameter", id: nodeID(), path } satisfies ParameterExpression);
      if (property === "then") return undefined;
      if (typeof property === "string") return parameterProxy([...path, property]);
      return undefined;
    },
  });
}

function userValue(required: boolean): unknown {
  const profile = tagged({ kind: "user", id: nodeID(), field: "profile", required } satisfies UserExpression);
  return new Proxy({}, {
    get(_target, property) {
      if (property === "profile") return profile;
      if (property === "required" && !required) return userValue(true);
      if (property === "then") return undefined;
      return undefined;
    },
  });
}

function normalizeSelection(value: unknown): Selection {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A query select must be an object");
  const result: Selection = {};
  for (const [key, candidate] of Object.entries(value)) {
    const node = dataNode(candidate);
    if (!node || !["field", "parameter", "user", "literal", "count", "relationship"].includes(node.kind)) {
      throw new Error(`Unsupported query selection at ${key}`);
    }
    result[key] = node as SelectionValue;
  }
  if (Object.keys(result).length === 0) throw new Error("A query select cannot be empty");
  return result;
}

function normalizeWhere(value: unknown): PredicateExpression | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return logical("and", value.map(predicateExpression));
  return predicateExpression(value);
}

function normalizeOrder(value: unknown): OrderExpression[] {
  if (value === undefined) return [];
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.map((candidate) => {
    const node = dataNode(candidate);
    if (!node) throw new Error("An order expression must use a symbolic field or aggregate");
    if (node.kind === "order") return node;
    if (node.kind === "field" || node.kind === "count") {
      return tagged({ kind: "order", id: nodeID(), value: node, direction: "asc" } satisfies OrderExpression);
    }
    throw new Error("An order expression must use a symbolic field or aggregate");
  });
}

function normalizePlan(relation: string, value: unknown): SelectionPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { orderBy: [], select: normalizeSelection(value) };
  }
  const record = value as Record<string, unknown>;
  const isControlled = ["where", "orderBy", "take", "after", "keyBy", "select"].some((key) => key in record);
  if (!isControlled) return { orderBy: [], select: normalizeSelection(value) };
  const invokeCallback = (candidate: unknown) => typeof candidate === "function" && !dataNode(candidate)
    ? candidate(rowScope(relation))
    : candidate;
  const selectValue = invokeCallback(record.select);
  const whereValue = invokeCallback(record.where);
  const orderValue = invokeCallback(record.orderBy);
  const take = record.take === undefined ? undefined : Number(record.take);
  if (take !== undefined && (!Number.isSafeInteger(take) || take < 1)) throw new Error("Query take must be a positive integer");
  return {
    where: normalizeWhere(whereValue),
    orderBy: normalizeOrder(orderValue),
    ...(take === undefined ? {} : { take }),
    ...(record.after === undefined ? {} : { after: record.after }),
    ...(record.keyBy === undefined ? {} : { keyBy: Array.isArray(record.keyBy) ? record.keyBy.map(String) : [String(record.keyBy)] }),
    select: normalizeSelection(selectValue),
  };
}

function relationshipSelection(relation: string, relationship: string, argument: unknown): RelationshipSelection {
  const targetRelation = `${relation}.${relationship}`;
  const value = typeof argument === "function" ? argument(rowScope(targetRelation)) : argument;
  return tagged({
    kind: "relationship",
    id: nodeID(),
    relation,
    relationship,
    plan: normalizePlan(targetRelation, value),
  });
}

export function database(path: string): DatabaseHandle {
  if (!path || !path.startsWith(".")) throw new Error("database() requires a local relative Arbor path");
  const handle = { path } as DatabaseHandle;
  const relations = new Proxy({}, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (typeof property !== "string") return undefined;
      return rowScope(property, handle);
    },
  }) as Record<string, RelationHandle>;
  Object.assign(handle, { relations });
  return Object.freeze(handle);
}

type Planner = (row: RelationHandle, context: { input: unknown; user: unknown }) => unknown;

function createQuery(cardinality: QueryCardinality, relation: RelationHandle, schemaOrPlanner: StandardSchemaV1 | Planner, possiblePlanner?: Planner): QueryHandle<any, any> {
  const actualRelation = (relation as unknown as { [RELATION]: string })[RELATION];
  const planner = possiblePlanner ?? schemaOrPlanner as Planner;
  const schema = possiblePlanner ? schemaOrPlanner as StandardSchemaV1 : undefined;
  const planned = planner(rowScope(actualRelation), { input: parameterProxy(), user: userValue(false) });
  const normalized = normalizePlan(actualRelation, planned);
  const databaseHandle = (relation as unknown as { [DATABASE]: DatabaseHandle })[DATABASE];
  return Object.freeze({
    kind: "query" as const,
    database: databaseHandle,
    plan: { ...normalized, relation: actualRelation, cardinality },
    ...(schema ? { schema } : {}),
  });
}

export const query = {
  many: (relation: RelationHandle, schemaOrPlanner: StandardSchemaV1 | Planner, planner?: Planner) => createQuery("many", relation, schemaOrPlanner, planner),
  one: (relation: RelationHandle, schemaOrPlanner: StandardSchemaV1 | Planner, planner?: Planner) => createQuery("one", relation, schemaOrPlanner, planner),
  maybe: (relation: RelationHandle, schemaOrPlanner: StandardSchemaV1 | Planner, planner?: Planner) => createQuery("maybe", relation, schemaOrPlanner, planner),
};

export function mutation<Result, Input>(
  databaseHandle: DatabaseHandle,
  schema: StandardSchemaV1<Input, Input>,
  handler: (...args: any[]) => Result | Promise<Result>,
): MutationHandle<Result, Input> {
  return Object.freeze({ kind: "mutation" as const, database: databaseHandle, schema, handler });
}

export class PublicMutationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PublicMutationError";
  }
}

export function publicError(code: string, message: string): PublicMutationError {
  return new PublicMutationError(code, message);
}

export function relationNameOf(relation: RelationHandle): string {
  return (relation as unknown as { [RELATION]: string })[RELATION];
}
