const RELATION = Symbol.for("story.data.relation");
const SOURCE = Symbol.for("story.data.source");

export type QueryCardinality = "many" | "one" | "maybe";
export type Direction = "asc" | "desc";

export interface FieldExpression {
  kind: "field";
  id: number;
  relation: string;
  field: string;
  /**
   * Whose field this is, when it isn't the current row's. `self` is the row a
   * plan or a view's facts are about, a helper variable's scope is its own,
   * and any other scope names a row the caller binds (an enclosing row of a
   * view, read before this plan runs).
   */
  scope?: string;
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
  /** Count only the related rows that match (a count over facts). */
  where?: PredicateExpression;
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

/** Some row reached along `relationship` matches `where` (every row, when absent). */
export interface ExistsExpression {
  kind: "exists";
  id: number;
  relation: string;
  relationship: string;
  /** Start from this scope's row (the block's own row, or a helper variable) instead of the current one. */
  scope?: string;
  where?: PredicateExpression;
  /**
   * The reached row's key is exactly these values, in the target's key order (a view's
   * `has(row)`). A joined relationship answers this from its join table alone, so it
   * works for people too.
   */
  keys?: ValueExpression[];
}

export interface NotExpression {
  kind: "not";
  id: number;
  operand: PredicateExpression;
}

/** Some row of `relation`, called `scope`, matches `where`: a view's helper variable. */
export interface SomeExpression {
  kind: "some";
  id: number;
  relation: string;
  scope: string;
  where: PredicateExpression;
}

export type PredicateExpression = ComparisonExpression | LogicalExpression | ExistsExpression | NotExpression | SomeExpression;

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
  /** The scope this plan's rows bind for the predicates beneath it (a view's enclosing row). */
  scope?: string;
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

export interface NodeHandle {
  readonly path: string;
  readonly children: NodeSetHandle;
}

export interface NodeSetHandle<Row = Record<string, unknown>> {
  readonly __row?: Row;
  readonly [member: string]: unknown;
}

export interface QueryHandle<Result = unknown, Input = undefined> {
  readonly kind: "query";
  readonly source: NodeHandle;
  readonly plan: QueryPlan;
  readonly schema?: StandardSchemaV1<Input, Input>;
  readonly __result?: Result;
  readonly __input?: Input;
}

export interface MutationHandle<Result = unknown, Input = unknown> {
  readonly kind: "mutation";
  readonly source: NodeHandle;
  readonly schema: StandardSchemaV1<Input, Input>;
  readonly handler: (...args: any[]) => Result | Promise<Result>;
  readonly __result?: Result;
  readonly __input?: Input;
}

export type RowOf<Source> = Source extends NodeSetHandle<infer Row> ? Row : never;
export type ResultOf<Handle> = Handle extends QueryHandle<infer Result, any>
  ? Result
  : Handle extends { readonly kind: "view"; readonly body: (...args: any[]) => infer Output }
    ? Output
  : Handle extends MutationHandle<infer Result, any>
    ? Awaited<Result>
    : never;

export interface OverstoryUser {
  profile: string;
}

type SourceMethods = (relation: string, source: NodeHandle, name: "all" | "one") => unknown;
let sourceMethods: SourceMethods | undefined;

/** Views (views.ts) give a node source its `all` and `one`. */
export function registerSourceMethods(methods: SourceMethods): void {
  sourceMethods = methods;
}

/** A node's children as a source: its relation, its node, and the view methods `all` and `one`. */
function rowScope(relation: string, source?: NodeHandle): NodeSetHandle {
  return new Proxy({}, {
    get(_target, property) {
      if (property === RELATION) return relation;
      if (property === SOURCE) return source;
      if (source && sourceMethods && (property === "all" || property === "one")) return sourceMethods(relation, source, property);
      return undefined;
    },
  }) as unknown as NodeSetHandle;
}

function relationFromPath(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const relation = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (!relation || relation === "." || relation === "..") throw new Error("node() children require a named node path");
  return relation;
}

export function node(path: string): NodeHandle {
  if (!path || (!path.startsWith(".") && !path.startsWith("/") && !path.startsWith("overstory:"))) {
    throw new Error("node() requires a relative, logical, or overstory: path");
  }
  const handle = { path } as NodeHandle;
  Object.assign(handle, { children: rowScope(relationFromPath(path), handle) });
  return Object.freeze(handle);
}

/** The logical path `path` names from a module at `module`, or an error when it leaves the tree. */
export function logicalPathFrom(module: string, path: string): string {
  if (!path.startsWith(".") && !path.startsWith("/")) throw new Error("node() in a tree's code names a path in that tree");
  const parts = path.startsWith("/") ? [] : module.split("/").filter(Boolean).slice(0, -1);
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new Error(`node(${JSON.stringify(path)}) leaves its tree`);
      parts.pop();
    } else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

const nodesByModule = new Map<string, Set<string>>();

/**
 * `node()` as code loaded from a tree calls it: the path is resolved from the
 * defining module's own logical path, so an imported helper keeps its own
 * place, and the logical paths each module names are recorded under `key`.
 */
export function nodeIn(module: { key: string; path: string }, path: string): NodeHandle {
  const logical = logicalPathFrom(module.path, path);
  const names = nodesByModule.get(module.key) ?? new Set();
  names.add(logical);
  nodesByModule.set(module.key, names);
  return node(logical);
}

/** The logical paths `node()` named in the module loaded under `key`. */
export function nodesNamedIn(key: string): string[] {
  return [...nodesByModule.get(key) ?? []];
}

export function mutation<Result, Input>(
  source: NodeHandle,
  schema: StandardSchemaV1<Input, Input>,
  handler: (...args: any[]) => Result | Promise<Result>,
): MutationHandle<Result, Input> {
  return Object.freeze({ kind: "mutation" as const, source, schema, handler });
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

export function relationNameOf(relation: NodeSetHandle): string {
  return (relation as unknown as { [RELATION]: string })[RELATION];
}

export function sourceOf(relation: NodeSetHandle): NodeHandle | undefined {
  return (relation as unknown as { [SOURCE]: NodeHandle | undefined })[SOURCE];
}
