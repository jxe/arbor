import { canonicalJSONString, semanticRequestDigest, sha256, type Hash, type MutationCallRequest, type MutationCallRuntime, type MutationHandleRef, type MutationResultReceipt } from "@arbor/core";
import { Database } from "bun:sqlite";
import {
  PublicMutationError,
  relationNameOf,
  type ArborUser,
  type MutationHandle,
  type NodeSetHandle,
  type StandardSchemaV1,
} from "./authoring.ts";
import type { FieldMetadata, RelationMetadata, StoreSchema } from "./schema.ts";
import { SQLiteStoreBroker } from "./observer.ts";

export interface MutationPublicErrorValue {
  code: string;
  message: string;
  retryable: boolean;
  issues?: readonly { message: string; path?: readonly unknown[] }[];
}

export class MutationCallError extends Error {
  constructor(readonly value: MutationPublicErrorValue, readonly cause?: unknown) {
    super(value.message);
    this.name = "MutationCallError";
  }
}

export interface MutationManyOptions {
  orderBy?: Array<[field: string, direction: "asc" | "desc"]>;
}

export interface OrderedRelationOptions {
  within: Record<string, unknown>;
  key: string;
  order: string;
}

function quote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function relationFor(schema: StoreSchema, handle: NodeSetHandle): RelationMetadata {
  const name = relationNameOf(handle);
  const relation = schema.relations[name];
  if (!relation || relation.source !== "sqlite") throw new Error(`Relation ${name} is not a writable SQLite relation`);
  return relation;
}

function normalizeValue(field: FieldMetadata, value: unknown): unknown {
  if (value === null) {
    if (!field.nullable) throw new TypeError(`${field.name} cannot be null`);
    return null;
  }
  if (value === undefined) throw new TypeError(`${field.name} cannot be undefined`);
  if (field.type === "string" && typeof value !== "string") throw new TypeError(`${field.name} must be a string`);
  if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new TypeError(`${field.name} must be a finite number`);
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new TypeError(`${field.name} must be a boolean`);
    return value ? 1 : 0;
  }
  if (field.type === "bytes" && !(value instanceof Uint8Array)) throw new TypeError(`${field.name} must be bytes`);
  return value;
}

function normalizedRecord(
  relation: RelationMetadata,
  value: Record<string, unknown>,
  options: { partial?: boolean } = {},
): Record<string, unknown> {
  const entries = Object.entries(value);
  for (const [field] of entries) if (!relation.fields[field]) throw new TypeError(`Unknown field ${relation.name}.${field}`);
  if (!options.partial) {
    for (const field of Object.values(relation.fields)) {
      if (!field.nullable && !field.hasDefault && !(field.name in value)) throw new TypeError(`Missing required field ${relation.name}.${field.name}`);
    }
  }
  return Object.fromEntries(entries.map(([name, fieldValue]) => [name, normalizeValue(relation.fields[name]!, fieldValue)]));
}

function whereClause(relation: RelationMetadata, where: Record<string, unknown>, parameters: unknown[]): string {
  const normalized = normalizedRecord(relation, where, { partial: true });
  const entries = Object.entries(normalized);
  if (entries.length === 0) throw new TypeError(`A ${relation.name} predicate cannot be empty`);
  return entries.map(([field, value]) => {
    if (value === null) return `${quote(field)} is null`;
    parameters.push(value);
    return `${quote(field)} = ?`;
  }).join(" and ");
}

function normalizeRows(rows: Record<string, unknown>[], relation: RelationMetadata): Record<string, unknown>[] {
  const booleans = Object.values(relation.fields).filter((field) => field.type === "boolean");
  return rows.map((row) => {
    const result = { ...row };
    for (const field of booleans) if (result[field.name] !== null && result[field.name] !== undefined) result[field.name] = Boolean(result[field.name]);
    return result;
  });
}

function provedUnique(relation: RelationMetadata, where: Record<string, unknown>): boolean {
  const fields = new Set(Object.keys(where));
  return relation.uniqueKeys.some((key) => key.length > 0 && key.every((field) => fields.has(field)));
}

export class SQLiteMutationTransaction {
  constructor(private readonly database: Database, readonly schema: StoreSchema) {}

  one(relationHandle: NodeSetHandle, where: Record<string, unknown>): Record<string, unknown> | null {
    const relation = relationFor(this.schema, relationHandle);
    if (!provedUnique(relation, where)) throw new TypeError(`tx.one on ${relation.name} requires a proved unique key`);
    const parameters: unknown[] = [];
    const sql = `select ${Object.keys(relation.fields).map(quote).join(", ")} from ${quote(relation.name)} where ${whereClause(relation, where, parameters)} limit 2`;
    const rows = normalizeRows(this.database.query(sql).all(...parameters as any[]) as Record<string, unknown>[], relation);
    if (rows.length > 1) throw new Error(`tx.one on ${relation.name} returned more than one row`);
    return rows[0] ?? null;
  }

  many(relationHandle: NodeSetHandle, where: Record<string, unknown>, options: MutationManyOptions = {}): Record<string, unknown>[] {
    const relation = relationFor(this.schema, relationHandle);
    const parameters: unknown[] = [];
    const predicate = whereClause(relation, where, parameters);
    const orders = (options.orderBy ?? []).map(([field, direction]) => {
      if (!relation.fields[field]) throw new TypeError(`Unknown order field ${relation.name}.${field}`);
      if (direction !== "asc" && direction !== "desc") throw new TypeError(`Invalid order direction for ${relation.name}.${field}`);
      return `${quote(field)} ${direction}`;
    });
    const sql = `select ${Object.keys(relation.fields).map(quote).join(", ")} from ${quote(relation.name)} where ${predicate}${orders.length ? ` order by ${orders.join(", ")}` : ""}`;
    return normalizeRows(this.database.query(sql).all(...parameters as any[]) as Record<string, unknown>[], relation);
  }

  insert(relationHandle: NodeSetHandle, value: Record<string, unknown>): void {
    const relation = relationFor(this.schema, relationHandle);
    const normalized = normalizedRecord(relation, value);
    const fields = Object.keys(normalized);
    if (fields.length === 0) this.database.query(`insert into ${quote(relation.name)} default values`).run();
    else this.database.query(`insert into ${quote(relation.name)} (${fields.map(quote).join(", ")}) values (${fields.map(() => "?").join(", ")})`)
      .run(...Object.values(normalized) as any[]);
  }

  update(relationHandle: NodeSetHandle, where: Record<string, unknown>, patch: Record<string, unknown>): number {
    const relation = relationFor(this.schema, relationHandle);
    const normalized = normalizedRecord(relation, patch, { partial: true });
    const fields = Object.keys(normalized);
    if (fields.length === 0) throw new TypeError(`An update to ${relation.name} cannot be empty`);
    if (fields.some((field) => relation.primaryKey.includes(field))) throw new TypeError(`An update cannot replace the primary key of ${relation.name}`);
    const parameters = Object.values(normalized);
    const predicate = whereClause(relation, where, parameters);
    return Number(this.database.query(`update ${quote(relation.name)} set ${fields.map((field) => `${quote(field)} = ?`).join(", ")} where ${predicate}`)
      .run(...parameters as any[]).changes);
  }

  upsert(
    relationHandle: NodeSetHandle,
    key: Record<string, unknown>,
    values: { create: Record<string, unknown>; update: Record<string, unknown> },
  ): "inserted" | "updated" {
    if (this.one(relationHandle, key)) {
      this.update(relationHandle, key, values.update);
      return "updated";
    }
    this.insert(relationHandle, values.create);
    return "inserted";
  }

  delete(relationHandle: NodeSetHandle, key: Record<string, unknown>): number {
    const relation = relationFor(this.schema, relationHandle);
    if (!provedUnique(relation, key)) throw new TypeError(`tx.delete on ${relation.name} requires a proved unique key`);
    return this.deleteWhere(relationHandle, key);
  }

  deleteWhere(relationHandle: NodeSetHandle, where: Record<string, unknown>): number {
    const relation = relationFor(this.schema, relationHandle);
    const parameters: unknown[] = [];
    const predicate = whereClause(relation, where, parameters);
    return Number(this.database.query(`delete from ${quote(relation.name)} where ${predicate}`).run(...parameters as any[]).changes);
  }

  ordered(relationHandle: NodeSetHandle, options: OrderedRelationOptions) {
    const relation = relationFor(this.schema, relationHandle);
    const within = normalizedRecord(relation, options.within, { partial: true });
    if (Object.keys(within).length === 0) throw new TypeError(`An ordered ${relation.name} partition cannot be empty`);
    const keyField = relation.fields[options.key];
    const orderField = relation.fields[options.order];
    if (!keyField) throw new TypeError(`Unknown ordered key ${relation.name}.${options.key}`);
    if (!orderField || orderField.type !== "number") throw new TypeError(`Ordered position ${relation.name}.${options.order} must be numeric`);
    const identity = new Set([...Object.keys(within), options.key]);
    if (!relation.uniqueKeys.some((key) => key.every((field) => identity.has(field)))) {
      throw new TypeError(`Ordered key ${relation.name}.${options.key} is not unique within the partition`);
    }
    const rows = () => this.many(relationHandle, within, { orderBy: [[options.order, "asc"], [options.key, "asc"]] });
    const rewrite = (orderedKeys: unknown[]) => {
      const current = rows();
      const minimum = Math.min(0, ...current.map((row) => Number(row[options.order])));
      current.forEach((row, index) => this.update(relationHandle, { ...within, [options.key]: row[options.key] }, { [options.order]: minimum - current.length - index - 1 }));
      orderedKeys.forEach((key, index) => this.update(relationHandle, { ...within, [options.key]: key }, { [options.order]: index }));
    };
    return {
      append: (value: Record<string, unknown>) => {
        if (!(options.key in value)) throw new TypeError(`Ordered append requires ${options.key}`);
        if (this.one(relationHandle, { ...within, [options.key]: value[options.key] })) throw new TypeError("The ordered key is already present");
        const current = rows();
        const position = current.length === 0 ? 0 : Math.max(...current.map((row) => Number(row[options.order]))) + 1;
        this.insert(relationHandle, { ...within, ...value, [options.order]: position });
        rewrite([...current.map((row) => row[options.key]), value[options.key]]);
      },
      replace: (keys: unknown[]) => {
        const distinct = new Set(keys.map((key) => canonicalJSONString(key)));
        if (distinct.size !== keys.length) throw new TypeError("Ordered replacement contains duplicate keys");
        const current = rows();
        const existing = new Set(current.map((row) => canonicalJSONString(row[options.key])));
        if (keys.length !== current.length || keys.some((key) => !existing.has(canonicalJSONString(key)))) {
          throw new TypeError("Ordered replacement must contain every current key exactly once");
        }
        rewrite(keys);
      },
      remove: (key: unknown) => {
        this.delete(relationHandle, { ...within, [options.key]: key });
        rewrite(rows().map((row) => row[options.key]));
      },
    };
  }
}

async function validateInput<Input>(schema: StandardSchemaV1<Input, Input>, input: unknown): Promise<Input> {
  const result = await schema["~standard"].validate(input);
  if (result.issues) {
    throw new MutationCallError({
      code: "invalid-input",
      message: "Mutation input is invalid",
      retryable: false,
      issues: result.issues.map((issue) => ({ message: issue.message, path: issue.path })),
    });
  }
  return result.value;
}

function deterministicUUID(seed: string): string {
  const value = sha256(seed);
  const variant = ((Number.parseInt(value[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-${variant}${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

interface StoredReceipt {
  request_digest: Hash;
  mutation_now: string;
  observed_through: string;
  result_json: string;
}

export class SQLiteMutationBroker {
  constructor(
    readonly schema: StoreSchema,
    readonly store: SQLiteStoreBroker,
    private readonly options: {
      now?: () => Date;
      diagnostic?: (error: unknown) => void;
    } = {},
  ) {}

  async execute<Result, Input>(
    handle: MutationHandle<Result, Input>,
    call: { scope: string; handle: MutationHandleRef; mutationID: string; input: unknown; user: ArborUser | null },
  ): Promise<MutationResultReceipt<Result>> {
    if (!call.scope || !call.mutationID) throw new MutationCallError({ code: "invalid-request", message: "A mutation identity is required", retryable: false });
    const input = await validateInput(handle.schema, call.input);
    const inputJSON = canonicalJSONString(input);
    const handleJSON = canonicalJSONString(call.handle);
    if (typeof inputJSON !== "string" || typeof handleJSON !== "string") {
      throw new MutationCallError({ code: "invalid-input", message: "Mutation input must be canonical JSON", retryable: false });
    }
    const requestDigest = semanticRequestDigest({ version: "mutation-call-v1", handle: call.handle, input });
    const subject = call.user?.profile ?? "anonymous";
    const mutationNow = (this.options.now?.() ?? new Date()).toISOString();
    try {
      const committed = await this.store.transactionAsync(async (database, control) => {
        const stored = database.query("select request_digest, mutation_now, observed_through, result_json from __arbor_mutation_receipts where scope = ? and subject = ? and mutation_id = ?")
          .get(call.scope, subject, call.mutationID) as StoredReceipt | null;
        if (stored) {
          if (stored.request_digest !== requestDigest) {
            throw new MutationCallError({ code: "conflict", message: "The mutation identity was already used for different intent", retryable: false });
          }
          return {
            receipt: {
              mutationID: call.mutationID,
              requestDigest: stored.request_digest,
              observedThrough: stored.observed_through,
              result: JSON.parse(stored.result_json) as Result,
            },
            replayed: true,
          };
        }
        const tx = new SQLiteMutationTransaction(database, this.schema);
        const idCounts = new Map<string, number>();
        const id = (label: string) => {
          if (!label) throw new TypeError("Generated IDs require a non-empty label");
          const index = idCounts.get(label) ?? 0;
          idCounts.set(label, index + 1);
          return deterministicUUID(`${call.scope}\0${call.mutationID}\0${requestDigest}\0${call.user?.profile ?? ""}\0${label}\0${index}`);
        };
        const result = await handle.handler({ user: call.user, tx, id, now: mutationNow }, input) as Result;
        const resultJSON = canonicalJSONString(result);
        if (typeof resultJSON !== "string") throw new TypeError("Mutation results must be canonical JSON");
        const observedThrough = control.reserveCursor();
        database.query("insert into __arbor_mutation_receipts(scope, subject, mutation_id, request_digest, handle_json, input_json, mutation_now, observed_through, result_json) values (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .run(call.scope, subject, call.mutationID, requestDigest, handleJSON, inputJSON, mutationNow, observedThrough, resultJSON);
        return { receipt: { mutationID: call.mutationID, requestDigest, observedThrough, result }, replayed: false };
      });
      return committed.result.receipt;
    } catch (error) {
      if (error instanceof MutationCallError) throw error;
      if (error instanceof PublicMutationError) {
        throw new MutationCallError({ code: error.code, message: error.message, retryable: false }, error);
      }
      (this.options.diagnostic ?? ((failure) => console.error("Arbor mutation failed", failure)))(error);
      throw new MutationCallError({ code: "internal-error", message: "The mutation could not be completed", retryable: true }, error);
    }
  }
}

function refKey(ref: MutationHandleRef): string {
  return `${ref.tree}\0${ref.module}\0${ref.export}\0${ref.version}`;
}

export class RegisteredMutationRuntime implements MutationCallRuntime {
  private readonly handles = new Map<string, MutationHandle<unknown, unknown>>();

  constructor(
    readonly document: MutationCallRequest["document"],
    readonly broker: SQLiteMutationBroker,
    entries: readonly { ref: MutationHandleRef; handle: MutationHandle<unknown, unknown> }[],
  ) {
    for (const entry of entries) this.handles.set(refKey(entry.ref), entry.handle);
  }

  call(request: MutationCallRequest, context: { user: ArborUser | null }): Promise<MutationResultReceipt> {
    if (canonicalJSONString(request.document) !== canonicalJSONString(this.document)) {
      throw new MutationCallError({ code: "conflict", message: "The mounted document version is not active", retryable: false });
    }
    const handle = this.handles.get(refKey(request.handle));
    if (!handle) throw new MutationCallError({ code: "not-found", message: "The mutation handle or version is not active", retryable: false });
    return this.broker.execute(handle, {
      scope: request.document.tree,
      handle: request.handle,
      mutationID: request.mutationID,
      input: request.input,
      user: context.user,
    });
  }
}
