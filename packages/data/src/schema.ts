import { readFile, realpath } from "node:fs/promises";
import { canonicalCBORHash } from "@arbor/core";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import { stableJSONString } from "@arbor/core";

export type FieldType = "string" | "number" | "boolean" | "bytes" | "unknown";

export interface FieldMetadata {
  name: string;
  type: FieldType;
  nullable: boolean;
  declaredType: string;
  hasDefault: boolean;
}

export interface ForeignKeyMetadata {
  fields: string[];
  target: string;
  targetFields: string[];
}

export interface RelationMetadata {
  name: string;
  source: "sqlite" | "arbor-profile";
  fields: Record<string, FieldMetadata>;
  primaryKey: string[];
  uniqueKeys: string[][];
  indexes: Array<{ fields: string[]; unique: boolean }>;
  foreignKeys: ForeignKeyMetadata[];
}

export interface DirectRelationship {
  source: string;
  target: string;
}

export interface ThroughSourceRelationship {
  source: string;
  through: string;
}

export interface ThroughTargetRelationship {
  through: string;
  target: string;
}

export interface RelationshipMetadata {
  source: string;
  name: string;
  target: string;
  cardinality: "one" | "maybe" | "many";
  key?: string[];
  direct?: DirectRelationship[];
  through?: {
    relation: string;
    source: ThroughSourceRelationship[];
    target: ThroughTargetRelationship[];
  };
}

export interface StoreSchema {
  version: 1;
  relations: Record<string, RelationMetadata>;
  relationships: Record<string, RelationshipMetadata>;
  fingerprint: string;
}

interface RelationshipDeclaration {
  version: 1;
  virtualRelations?: Record<string, {
    source: "arbor-profile";
    primaryKey: string[];
    fields: Record<string, { type: FieldType; nullable?: boolean }>;
  }>;
  relationships: Record<string, {
    target: string;
    cardinality: "one" | "maybe" | "many";
    key?: string[];
    direct?: DirectRelationship[];
    through?: {
      relation: string;
      source: ThroughSourceRelationship[];
      target: ThroughTargetRelationship[];
    };
  }>;
}

export interface TreeBoundary {
  root: string;
  tree: string;
}

export interface ResolvedDatabaseLocation {
  directory: string;
  databasePath: string;
  schemaPath: string;
  relationshipsPath: string;
  tree?: string;
  path?: string;
}

export interface ResolvedArborSource {
  authoredPath: string;
  tree: string;
  path: string;
  schemaFingerprint: string;
}

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function logicalPath(root: string, candidate: string): string {
  const child = relative(resolve(root), candidate);
  return child === "" ? "/" : `/${child.split(sep).join("/")}`;
}

/** Resolve an authored database path from its importing module, honoring the longest nested tree boundary. */
export async function resolveDatabaseLocation(
  importingModulePath: string,
  specifier: string,
  boundaries: readonly TreeBoundary[] = [],
): Promise<ResolvedDatabaseLocation> {
  if (!isAbsolute(importingModulePath)) throw new Error("The importing module path must be absolute");
  if (!specifier.startsWith(".")) throw new Error("arbor() accepts only local relative paths for SQLite store binding");
  const unresolved = resolve(dirname(importingModulePath), specifier);
  const directory = await realpath(unresolved);
  const boundary = boundaries
    .filter((candidate) => inside(resolve(candidate.root), directory))
    .sort((left, right) => resolve(right.root).length - resolve(left.root).length)[0];
  return {
    directory,
    databasePath: join(directory, "_store.sqlite3"),
    schemaPath: join(directory, "schema.sql"),
    relationshipsPath: join(directory, "relationships.json"),
    ...(boundary ? { tree: boundary.tree, path: logicalPath(boundary.root, directory) } : {}),
  };
}

/** Resolve one compiler-authored Arbor source to a tree/path before provider activation. */
export async function resolveArborSource(
  importingModulePath: string,
  specifier: string,
  boundaries: readonly TreeBoundary[],
  schemaFingerprint: string,
  options: { virtualLeaf?: boolean } = {},
): Promise<ResolvedArborSource> {
  if (!isAbsolute(importingModulePath)) throw new Error("The importing module path must be absolute");
  if (!specifier.startsWith(".")) {
    throw new Error("This SQLite activation path requires a compiler-resolved local relative arbor() source");
  }
  const unresolved = resolve(dirname(importingModulePath), specifier);
  const physical = await realpath(options.virtualLeaf ? dirname(unresolved) : unresolved);
  const boundary = boundaries
    .filter((candidate) => inside(resolve(candidate.root), physical))
    .sort((left, right) => resolve(right.root).length - resolve(left.root).length)[0];
  if (!boundary) throw new Error(`arbor(${JSON.stringify(specifier)}) does not resolve inside a declared tree boundary`);
  const parentPath = logicalPath(boundary.root, physical);
  const path = options.virtualLeaf
    ? `${parentPath === "/" ? "" : parentPath}/${basename(unresolved)}`
    : parentPath;
  return { authoredPath: specifier, tree: boundary.tree, path, schemaFingerprint };
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqliteType(declared: string): FieldType {
  const normalized = declared.trim().toLowerCase();
  if (normalized.includes("bool")) return "boolean";
  if (normalized.includes("int") || normalized.includes("real") || normalized.includes("floa") || normalized.includes("doub") || normalized.includes("num")) return "number";
  if (normalized.includes("blob")) return "bytes";
  if (normalized.includes("char") || normalized.includes("clob") || normalized.includes("text") || normalized === "") return "string";
  return "unknown";
}

export function inspectSQLite(database: Database): Record<string, RelationMetadata> {
  const tables = database.query(
    "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not glob '__arbor_*' order by name",
  ).all() as Array<{ name: string }>;
  const result: Record<string, RelationMetadata> = {};
  for (const { name } of tables) {
    const columns = database.query(`pragma table_info(${identifier(name)})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }>;
    const fields = Object.fromEntries(columns.map((column) => [column.name, {
      name: column.name,
      type: sqliteType(column.type),
      nullable: column.notnull === 0 && column.pk === 0,
      declaredType: column.type,
      hasDefault: column.dflt_value !== null,
    } satisfies FieldMetadata]));
    const primaryKey = columns.filter((column) => column.pk > 0).sort((left, right) => left.pk - right.pk).map((column) => column.name);
    const indexes = database.query(`pragma index_list(${identifier(name)})`).all() as Array<{ name: string; unique: number }>;
    const indexMetadata = indexes
      .map((index) => ({
        unique: index.unique === 1,
        fields: (database.query(`pragma index_info(${identifier(index.name)})`).all() as Array<{ seqno: number; name: string }>)
        .sort((left, right) => left.seqno - right.seqno)
        .map((column) => column.name),
      }))
      .filter((index) => index.fields.length > 0)
      .sort((left, right) => Number(right.unique) - Number(left.unique) || left.fields.join("\0").localeCompare(right.fields.join("\0")));
    const uniqueKeys = indexMetadata.filter((index) => index.unique).map((index) => index.fields);
    if (primaryKey.length > 0 && !uniqueKeys.some((key) => key.join("\0") === primaryKey.join("\0"))) uniqueKeys.unshift(primaryKey);
    const foreignRows = database.query(`pragma foreign_key_list(${identifier(name)})`).all() as Array<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
    }>;
    const grouped = new Map<number, typeof foreignRows>();
    for (const row of foreignRows) grouped.set(row.id, [...(grouped.get(row.id) ?? []), row]);
    const foreignKeys = [...grouped.values()].map((rows) => ({
      fields: rows.sort((left, right) => left.seq - right.seq).map((row) => row.from),
      target: rows[0]!.table,
      targetFields: rows.sort((left, right) => left.seq - right.seq).map((row) => row.to),
    }));
    result[name] = { name, source: "sqlite", fields, primaryKey, uniqueKeys, indexes: indexMetadata, foreignKeys };
  }
  return result;
}

/**
 * Introspect a standalone SQLite database without requiring authored query
 * relationship metadata. Generic node providers use this for ordinary SQLite
 * files; executable-document databases normally use introspectStoreSchema so
 * schema.sql and relationships.json are validated as well.
 */
export function introspectSQLiteDatabase(source: string | Database): StoreSchema {
  const database = typeof source === "string"
    ? new Database(source, { readonly: true, strict: true })
    : source;
  const owned = typeof source === "string";
  try {
    const relations = inspectSQLite(database);
    const definitions = sqliteDefinitions(database);
    const fingerprintInput = { version: 1, relations, relationships: {}, definitions };
    return {
      version: 1,
      relations,
      relationships: {},
      fingerprint: canonicalCBORHash(fingerprintInput),
    };
  } finally {
    if (owned) database.close();
  }
}

function sameSQLiteShape(left: Record<string, RelationMetadata>, right: Record<string, RelationMetadata>): boolean {
  const shape = (relations: Record<string, RelationMetadata>) => Object.fromEntries(Object.entries(relations).map(([name, relation]) => [name, {
    fields: Object.fromEntries(Object.entries(relation.fields).map(([field, metadata]) => [field, {
      type: metadata.type,
      nullable: metadata.nullable,
      declaredType: metadata.declaredType.toLowerCase(),
      hasDefault: metadata.hasDefault,
    }])),
    primaryKey: relation.primaryKey,
    uniqueKeys: relation.uniqueKeys,
    indexes: relation.indexes,
    foreignKeys: relation.foreignKeys,
  }]));
  return stableJSONString(shape(left)) === stableJSONString(shape(right));
}

function sqliteDefinitions(database: Database): Record<string, string> {
  const rows = database.query(
    "select type, name, sql from sqlite_master where sql is not null and name not like 'sqlite_%' and name not glob '__arbor_*' order by type, name",
  ).all() as Array<{ type: string; name: string; sql: string }>;
  return Object.fromEntries(rows.map((row) => [
    `${row.type}:${row.name}`,
    row.sql.replaceAll(/\s+/g, " ").trim().toLowerCase(),
  ]));
}

function validateRelationship(relation: RelationshipMetadata, relations: Record<string, RelationMetadata>): void {
  const source = relations[relation.source];
  const target = relations[relation.target];
  if (!source) throw new Error(`Relationship ${relation.source}.${relation.name} has an unknown source relation`);
  if (!target) throw new Error(`Relationship ${relation.source}.${relation.name} has an unknown target relation`);
  if ((relation.direct ? 1 : 0) + (relation.through ? 1 : 0) !== 1) {
    throw new Error(`Relationship ${relation.source}.${relation.name} must declare exactly one direct or through path`);
  }
  if (relation.direct) {
    for (const pair of relation.direct) {
      if (!source.fields[pair.source]) throw new Error(`Relationship ${relation.source}.${relation.name} references unknown field ${relation.source}.${pair.source}`);
      if (!target.fields[pair.target]) throw new Error(`Relationship ${relation.source}.${relation.name} references unknown field ${relation.target}.${pair.target}`);
    }
    if (relation.cardinality !== "many") {
      const targetFields = new Set(relation.direct.map((pair) => pair.target));
      if (!target.uniqueKeys.some((key) => key.every((field) => targetFields.has(field)))) {
        throw new Error(`Singular relationship ${relation.source}.${relation.name} does not target a unique key`);
      }
    }
  }
  if (relation.through) {
    const through = relations[relation.through.relation];
    if (!through) throw new Error(`Relationship ${relation.source}.${relation.name} has an unknown through relation`);
    for (const pair of relation.through.source) {
      if (!source.fields[pair.source] || !through.fields[pair.through]) throw new Error(`Relationship ${relation.source}.${relation.name} has an invalid source-through field`);
    }
    for (const pair of relation.through.target) {
      if (!through.fields[pair.through] || !target.fields[pair.target]) throw new Error(`Relationship ${relation.source}.${relation.name} has an invalid through-target field`);
    }
    if (relation.cardinality !== "many") {
      const sourceFields = new Set(relation.through.source.map((pair) => pair.through));
      const targetFields = new Set(relation.through.target.map((pair) => pair.target));
      if (!through.uniqueKeys.some((key) => key.every((field) => sourceFields.has(field)))
        || !target.uniqueKeys.some((key) => key.every((field) => targetFields.has(field)))) {
        throw new Error(`Singular relationship ${relation.source}.${relation.name} is not proved unique through ${through.name}`);
      }
    }
  }
  const key = relation.key ?? target.primaryKey;
  if (relation.cardinality === "many" && key.length === 0) throw new Error(`Relationship ${relation.source}.${relation.name} has no stable key`);
  for (const field of key) {
    if (!target.fields[field]) throw new Error(`Relationship ${relation.source}.${relation.name} has unknown key field ${field}`);
    if (target.fields[field]!.nullable) throw new Error(`Relationship ${relation.source}.${relation.name} has nullable key field ${field}`);
  }
}

export async function introspectStoreSchema(
  location: Pick<ResolvedDatabaseLocation, "databasePath" | "schemaPath" | "relationshipsPath">,
  fixtureDatabase?: Database,
): Promise<StoreSchema> {
  const [schemaSQL, declarationSource] = await Promise.all([
    readFile(location.schemaPath, "utf8"),
    readFile(location.relationshipsPath, "utf8"),
  ]);
  const declaration = JSON.parse(declarationSource) as RelationshipDeclaration;
  if (declaration.version !== 1 || !declaration.relationships) throw new Error("relationships.json must declare version 1 and relationships");

  const authored = new Database(":memory:");
  authored.exec("pragma foreign_keys = on");
  authored.exec(schemaSQL);
  const authoredRelations = inspectSQLite(authored);
  const authoredDefinitions = sqliteDefinitions(authored);
  authored.close();

  const fixture = fixtureDatabase ?? new Database(location.databasePath, { readonly: true, strict: true });
  const fixtureRelations = inspectSQLite(fixture);
  const fixtureDefinitions = sqliteDefinitions(fixture);
  if (!fixtureDatabase) fixture.close();
  if (!sameSQLiteShape(authoredRelations, fixtureRelations)
    || stableJSONString(authoredDefinitions) !== stableJSONString(fixtureDefinitions)) {
    throw new Error("_store.sqlite3 does not match schema.sql");
  }

  const relations = { ...fixtureRelations };
  for (const [name, virtual] of Object.entries(declaration.virtualRelations ?? {})) {
    if (relations[name]) throw new Error(`Virtual relation ${name} collides with a SQLite table`);
    relations[name] = {
      name,
      source: virtual.source,
      fields: Object.fromEntries(Object.entries(virtual.fields).map(([field, metadata]) => [field, {
        name: field,
        type: metadata.type,
        nullable: metadata.nullable ?? false,
        declaredType: metadata.type,
        hasDefault: false,
      }])),
      primaryKey: virtual.primaryKey,
      uniqueKeys: [virtual.primaryKey],
      indexes: [{ fields: virtual.primaryKey, unique: true }],
      foreignKeys: [],
    };
  }

  const relationships: Record<string, RelationshipMetadata> = {};
  for (const [qualifiedName, value] of Object.entries(declaration.relationships)) {
    const split = qualifiedName.lastIndexOf(".");
    if (split <= 0 || split === qualifiedName.length - 1) throw new Error(`Invalid relationship name ${qualifiedName}`);
    const relationship: RelationshipMetadata = {
      source: qualifiedName.slice(0, split),
      name: qualifiedName.slice(split + 1),
      ...value,
    };
    validateRelationship(relationship, relations);
    relationships[qualifiedName] = relationship;
  }

  const fingerprintInput = { version: 1, schemaSQL, relations, relationships };
  return { version: 1, relations, relationships, fingerprint: canonicalCBORHash(fingerprintInput) };
}
