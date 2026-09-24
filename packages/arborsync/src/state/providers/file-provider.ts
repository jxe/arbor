import { toJSONValue, stableJSONString, revisionOf, stableKeyFromProperties, parseMarkdown } from "@overstory/protocol";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Diagnostic, Hash, JSONValue } from "@overstory/protocol";
import { commitPrepared, prepareAtomic, readRevision, removeIfExists } from "@overstory/fs";
import { replaceCollectionFileRow } from "../collection-file-writes.ts";
import {
  CollectionSchemaCache,
  collectionChildSetHash,
  decodeCollectionFileSource,
  logicalChildName,
  validateRow,
  valueDiagnostic,
  type CollectionSchema,
} from "@overstory/collection-schema";
import {
  type ProjectionProvider,
  decodeProviderCursor,
  encodeProviderCursor,
  ProjectionProviderError,
  backingFor,
  type LoadedProjectionSlice,
  type PreparedProviderPropertyWrite,
  type ProjectionDefinition,
  type ProjectionDescriptor,
  type ProjectionWriteTarget,
  type ProviderChildRecord,
} from "@overstory/apps-runtime/collections";
/** The schema facts a projection needs; an unschematized collection has none of them. */
type SchemaView = Pick<CollectionSchema, "columns" | "primaryKey" | "childName" | "revision"> & { schema: CollectionSchema | null };
const NO_SCHEMA: SchemaView = { columns: [], primaryKey: null, childName: { from: "primaryKey" }, revision: revisionOf("") as CollectionSchema["revision"], schema: null };

function invalidWrite(diagnostics: ReturnType<typeof validateRow>): ProjectionProviderError {
  return new ProjectionProviderError("invalid-write", diagnostics.map((item) => `${item.path ? `${item.path.slice(1).replaceAll("/", ".")}: ` : ""}${item.message}`).join("; "));
}

interface LoadedFileProjection {
  description: SchemaView;
  rows: ProviderChildRecord[];
  revision: string;
  sourceRevision: string;
  childSetHash: string;
  diagnostics: Diagnostic[];
  identityRule?: { properties: string[] };
  editable: boolean;
}
export class FileProjectionDriver implements ProjectionProvider, AsyncDisposable {
  readonly kinds = ["csv", "json", "jsonl", "markdown"] as const;
  private commitTails = new Map<string, Promise<void>>();
  private snapshots = new Map<string, Promise<LoadedFileProjection>>();
  constructor(private schemas = new CollectionSchemaCache()) {}
  private async compile(path: string): Promise<CollectionSchema> {
    return this.schemas.compile(new Uint8Array(await readFile(path)));
  }
  async describe(definition: ProjectionDefinition): Promise<ProjectionDescriptor> {
    const loaded = await this.load(definition);
    return {
      columns: [...loaded.description.columns],
      ...(loaded.identityRule ? { identityRule: loaded.identityRule } : {}),
      revision: loaded.revision,
      schemaRevision: loaded.description.revision,
      diagnostics: loaded.diagnostics,
      total: loaded.rows.length,
      editable: definition.provider === "markdown" && loaded.editable,
      backing: backingFor(definition.provider, loaded.childSetHash as Hash),
      ...(definition.provider === "markdown" ? { rowContent: "markdown" as const } : {}),
    };
  }
  async collectionFileDescriptor(definition: ProjectionDefinition, sourceName: string): Promise<{
    format: "csv" | "json" | "jsonl";
    schemaFingerprint: Hash;
    childSetHash: Hash;
  } | null> {
    if (!definition.storePath || !definition.schemaPath || basename(definition.storePath) !== sourceName
      || !(definition.provider === "csv" || definition.provider === "json" || definition.provider === "jsonl")
      || definition.diagnostics.some((item) => item.severity === "error")) return null;
    const loaded = await this.load(definition);
    if (!loaded.editable || loaded.diagnostics.some((item) => item.severity === "error")) return null;
    return {
      format: definition.provider,
      schemaFingerprint: loaded.description.revision as Hash,
      childSetHash: loaded.childSetHash as Hash,
    };
  }
  async page(
    definition: ProjectionDefinition,
    treePath: string,
    cursor: string | null,
    limit: number,
  ): Promise<LoadedProjectionSlice> {
    const loaded = await this.load(definition);
    const safeLimit = Math.max(1, Math.min(limit, 500));
    const allKeyed = Boolean(loaded.identityRule) && loaded.rows.every((row) => row.stableKey !== null);
    const mode = allKeyed ? "keyset" : "offset";
    const query = `${definition.provider}:${treePath}`;
    const decoded = decodeProviderCursor(cursor, query, loaded.revision, mode);
    const ordered = allKeyed
      ? [...loaded.rows].sort((left, right) => left.stableKey! < right.stableKey! ? -1 : left.stableKey! > right.stableKey! ? 1 : 0)
      : loaded.rows;
    const start = mode === "keyset" && decoded
      ? ordered.findIndex((row) => row.stableKey! > decoded.after!)
      : decoded?.offset ?? 0;
    const safeStart = start < 0 ? ordered.length : start;
    const rows = ordered.slice(safeStart, safeStart + safeLimit);
    const hasMore = safeStart + rows.length < ordered.length;
    const nextCursor = !hasMore ? null : mode === "keyset"
      ? encodeProviderCursor({ version: 1, query, revision: loaded.revision, mode, after: rows.at(-1)!.stableKey! })
      : encodeProviderCursor({ version: 1, query, revision: loaded.revision, mode, offset: safeStart + rows.length });
    return {
      path: treePath,
      columns: loaded.description.columns.length
        ? [...loaded.description.columns]
        : [...new Set(rows.flatMap((row) => Object.keys(row.values)))],
      ...(loaded.identityRule ? { identityRule: loaded.identityRule } : {}),
      rows,
      nextCursor,
      revision: loaded.revision,
      sourceRevision: loaded.sourceRevision,
      schemaRevision: loaded.description.revision,
      diagnostics: loaded.diagnostics,
      editable: loaded.editable,
      ...(definition.provider === "markdown" ? { rowContent: "markdown" as const } : {}),
    };
  }
  async resolve(
    definition: ProjectionDefinition,
    treePath: string,
    ref: { path: string; stableKey: string | null },
  ): Promise<{ row: ProviderChildRecord; page: LoadedProjectionSlice } | null> {
    const loaded = await this.load(definition);
    const segment = ref.path.slice(ref.path.lastIndexOf("/") + 1);
    const row = ref.stableKey !== null
      ? loaded.rows.find((candidate) => candidate.stableKey === ref.stableKey)
      : loaded.rows.find((candidate) => candidate.path === segment);
    if (!row) return null;
    return {
      row,
      page: {
        path: treePath,
        columns: [...loaded.description.columns],
        ...(loaded.identityRule ? { identityRule: loaded.identityRule } : {}),
        rows: [row],
        nextCursor: null,
        revision: loaded.revision,
        sourceRevision: loaded.sourceRevision,
        schemaRevision: loaded.description.revision,
        diagnostics: loaded.diagnostics,
        editable: loaded.editable,
        ...(definition.provider === "markdown" ? { rowContent: "markdown" as const } : {}),
      },
    };
  }

  async prepareMarkdown(
    definition: ProjectionDefinition,
    properties: Record<string, JSONValue>,
  ): Promise<{ properties: Record<string, JSONValue>; identityRule?: { properties: string[] } }> {
    if (definition.provider !== "markdown" || !definition.schemaPath) {
      throw new ProjectionProviderError("invalid-write", "This is not a schema-governed Markdown collection");
    }
    if (definition.diagnostics.some((item) => item.severity === "error")) {
      throw new ProjectionProviderError("invalid-write", definition.diagnostics.map((item) => item.message).join("; "));
    }
    const description = await this.compile(definition.schemaPath);
    const diagnostics = validateRow(description, properties);
    if (diagnostics.length) throw invalidWrite(diagnostics);
    const identityProperties = description.primaryKey ? [...description.primaryKey] : description.columns.includes("id") ? ["id"] : null;
    return {
      properties,
      ...(identityProperties ? { identityRule: { properties: identityProperties } } : {}),
    };
  }

  rowStorage(definition: ProjectionDefinition): "physical" | "provider" {
    return definition.provider === "markdown" ? "physical" : "provider";
  }
  async prepareWrite(
    definition: ProjectionDefinition,
    target: ProjectionWriteTarget,
    basePropertiesRevision: string,
    properties: Record<string, JSONValue>,
    _mutation?: { scope: string; id: string },
  ): Promise<PreparedProviderPropertyWrite> {
    if (!definition.storePath || !definition.schemaPath
      || !(definition.provider === "csv" || definition.provider === "json" || definition.provider === "jsonl")) {
      throw new ProjectionProviderError("invalid-write", `${target.parentPath} is not a writable collection file`);
    }
    const loaded = await this.load(definition);
    const current = loaded.rows.find((row) => target.stableKey
      ? row.stableKey === target.stableKey
      : row.path === target.path.slice(target.path.lastIndexOf("/") + 1));
    if (!current) throw new ProjectionProviderError("invalid-write", "No collection-file row owns the supplied reference");
    if (current.revision !== basePropertiesRevision) {
      throw new ProjectionProviderError("stale-properties", "The row properties changed since they were read", current);
    }
    if (target.sourceRevision !== loaded.sourceRevision) {
      throw new ProjectionProviderError("stale-source", "The exact collection-file source changed while the row write was being prepared");
    }
    if (!loaded.editable || !loaded.identityRule || !current.stableKey) {
      throw new ProjectionProviderError("invalid-write", "The complete collection file must be schema-valid with unique stable keys before it can be edited");
    }

    const diagnostics = validateRow(loaded.description.schema!, properties);
    if (diagnostics.length) throw invalidWrite(diagnostics);
    const candidate = (toJSONValue(properties) ?? {}) as Record<string, JSONValue>;
    if (stableKeyFromProperties(loaded.identityRule.properties, candidate) !== current.stableKey) {
      throw new ProjectionProviderError("invalid-write", `Identity properties ${loaded.identityRule.properties.join(", ")} are immutable`);
    }

    const source = await readFile(definition.storePath, "utf8");
    if (revisionOf(source) !== loaded.sourceRevision) {
      throw new ProjectionProviderError("stale-source", "The exact collection-file source changed while the row write was being prepared");
    }
    let temporaryPath: string | undefined;
    try {
      const output = stableJSONString(current.values) === stableJSONString(candidate)
        ? source
        : replaceCollectionFileRow(definition.provider, source, current.key, candidate);
      temporaryPath = await prepareAtomic(definition.storePath, output);
      const prepared = await this.load({ ...definition, storePath: temporaryPath });
      const preparedRow = prepared.rows.find((row) => row.stableKey === current.stableKey);
      const expectedRows = loaded.rows.map((row) => row.stableKey === current.stableKey
        ? { key: row.stableKey, path: row.path, properties: candidate }
        : { key: row.stableKey, path: row.path, properties: (toJSONValue(row.values) ?? {}) as Record<string, JSONValue> });
      const actualRows = prepared.rows.map((row) => ({
        key: row.stableKey,
        path: row.path,
        properties: (toJSONValue(row.values) ?? {}) as Record<string, JSONValue>,
      }));
      if (!prepared.editable || !preparedRow
        || stableJSONString(expectedRows) !== stableJSONString(actualRows)
        || stableJSONString(preparedRow.values) !== stableJSONString(candidate)) {
        throw new ProjectionProviderError("invalid-write", "The exact-source edit did not round-trip to the complete candidate collection");
      }
      const finalTemporaryPath = temporaryPath;
      const storePath = definition.storePath;
      let completed = false;
      return {
        durability: "host-journal",
        path: `${target.parentPath === "/" ? "" : target.parentPath}/${preparedRow.path}`,
        stableKey: current.stableKey,
        revision: preparedRow.revision!,
        properties: candidate,
        commit: async () => {
          const previous = this.commitTails.get(storePath) ?? Promise.resolve();
          const commit = previous.then(async () => {
            try {
              const exact = await readRevision(storePath);
              if (exact.revision !== loaded.sourceRevision) {
                throw new ProjectionProviderError("stale-source", "The exact collection-file source changed before the prepared write could commit");
              }
              await commitPrepared(finalTemporaryPath, storePath);
              completed = true;
              this.invalidate(dirname(storePath));
              return {
                path: `${target.parentPath === "/" ? "" : target.parentPath}/${preparedRow.path}`,
                stableKey: current.stableKey!,
                revision: preparedRow.revision!,
                properties: candidate,
              };
            } catch (error) {
              await removeIfExists(finalTemporaryPath);
              throw error;
            }
          });
          const settled = commit.then(() => undefined, () => undefined);
          this.commitTails.set(storePath, settled);
          void settled.finally(() => {
            if (this.commitTails.get(storePath) === settled) this.commitTails.delete(storePath);
          });
          return commit;
        },
        abort: async () => { if (!completed) await removeIfExists(finalTemporaryPath); },
      };
    } catch (error) {
      if (temporaryPath) await removeIfExists(temporaryPath);
      if (error instanceof ProjectionProviderError) throw error;
      throw new ProjectionProviderError("invalid-write", error instanceof Error ? error.message : String(error));
    }
  }

  private async load(definition: ProjectionDefinition): Promise<LoadedFileProjection> {
    const key = await this.snapshotKey(definition);
    const existing = this.snapshots.get(key);
    if (existing) {
      this.snapshots.delete(key);
      this.snapshots.set(key, existing);
      return existing;
    }
    const value = this.loadUncached(definition);
    this.snapshots.set(key, value);
    while (this.snapshots.size > 32) this.snapshots.delete(this.snapshots.keys().next().value!);
    void value.catch(() => { if (this.snapshots.get(key) === value) this.snapshots.delete(key); });
    return value;
  }

  private async snapshotKey(definition: ProjectionDefinition): Promise<string> {
    const paths = [definition.schemaPath, definition.storePath, ...(definition.markdownPaths ?? [])]
      .filter((path): path is string => Boolean(path));
    const states = await Promise.all([...new Set(paths)].sort().map(async (path) => {
      try { return { path, revision: revisionOf(await readFile(path)) }; }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          return { path, missing: true };
        }
        throw error;
      }
    }));
    return `${dirname(definition.storePath ?? definition.schemaPath ?? definition.markdownPaths?.[0] ?? "/")}\0${revisionOf(stableJSONString(states))}`;
  }

  private invalidate(directory: string): void {
    for (const key of this.snapshots.keys()) if (key.startsWith(`${directory}\0`)) this.snapshots.delete(key);
  }

  private async loadUncached(definition: ProjectionDefinition): Promise<LoadedFileProjection> {
    const schema = definition.schemaPath ? await this.compile(definition.schemaPath) : null;
    const description: SchemaView = schema ? { ...schema, schema } : NO_SCHEMA;
    // Rows arrive validated (and, for CSV, converted by their declared types);
    // validation never changes a value, so the parsed values are the properties.
    const loaded = definition.provider === "csv" || definition.provider === "json" || definition.provider === "jsonl"
      ? await this.sourceRows(definition, schema)
      : await this.markdownRows(definition, schema);
    const fileValid = loaded.diagnostics.every((item) => item.severity !== "error");
    const identityProperties = description.primaryKey
      ? [...description.primaryKey]
      : definition.provider === "markdown" && description.columns.includes("id") ? ["id"] : null;
    const identityRule = identityProperties ? { properties: identityProperties } : undefined;
    const validated = loaded.rows.map((row, index) => {
      const values = row.values;
      const stableKey = identityRule && fileValid && row.diagnostics.length === 0
        ? stableKeyFromProperties(identityRule.properties, values) : null;
      const diagnostics = [...row.diagnostics];
      if (identityRule && !stableKey) diagnostics.push({
        code: "invalid-row-key", message: `Row does not have a valid ${identityRule.properties.join(", ")} stable key.`,
        path: definition.storePath ?? row.path, row: index, severity: "error",
      });
      const properties = (toJSONValue(values) ?? {}) as Record<string, JSONValue>;
      let path = definition.provider === "markdown" ? row.path : `~row-${index + 1}`;
      if (definition.provider !== "markdown" && stableKey) {
        try {
          path = logicalChildName(description, properties, stableKey);
        } catch (error) {
          diagnostics.push({
            code: "invalid-child-name",
            message: error instanceof Error ? error.message : String(error),
            path: definition.storePath ?? row.path,
            row: index,
            severity: "error",
          });
        }
      }
      return {
        ...row,
        path,
        stableKey,
        revision: row.revision ?? revisionOf(stableJSONString(values)), values, diagnostics,
      } satisfies ProviderChildRecord;
    });
    const counts = new Map<string, number>();
    for (const row of validated) if (row.stableKey) counts.set(row.stableKey, (counts.get(row.stableKey) ?? 0) + 1);
    const keyedRows = validated.map((row, index) => !row.stableKey || counts.get(row.stableKey) === 1 ? row : ({
      ...row,
      path: definition.provider === "markdown" ? row.path : `~row-${index + 1}`,
      stableKey: null,
      diagnostics: [...row.diagnostics, {
        code: "duplicate-row-key", message: "The declared stable key is duplicated in this collection.",
        path: definition.storePath ?? row.path, row: index, severity: "error" as const,
      }],
    }));
    const nameCounts = new Map<string, number>();
    if (definition.provider !== "markdown") {
      for (const row of keyedRows) nameCounts.set(row.path, (nameCounts.get(row.path) ?? 0) + 1);
    }
    const rows = keyedRows.map((row, index) => definition.provider === "markdown" || nameCounts.get(row.path) === 1 ? row : ({
      ...row,
      path: `~row-${index + 1}`,
      stableKey: null,
      diagnostics: [...row.diagnostics, {
        code: "duplicate-child-name", message: "The schema-derived child name is duplicated in this collection.",
        path: definition.storePath ?? row.path, row: index, severity: "error" as const,
      }],
    }));
    const revision = revisionOf(`${loaded.revision}\0${description.revision}\0${JSON.stringify({ columns: description.columns, primaryKey: identityProperties })}`);
    const childSetHash = collectionChildSetHash(rows.map((row) => ({ key: row.stableKey, name: row.path, properties: row.values })));
    return {
      description, rows, revision, sourceRevision: loaded.revision, childSetHash,
      diagnostics: [...definition.diagnostics, ...loaded.diagnostics],
      ...(identityRule ? { identityRule } : {}),
      editable: definition.provider === "markdown" || Boolean(identityRule
        && loaded.diagnostics.every((item) => item.severity !== "error")
        && rows.every((row) => row.diagnostics.every((item) => item.severity !== "error"))),
    };
  }

  private async sourceRows(
    definition: ProjectionDefinition,
    schema: CollectionSchema | null,
  ): Promise<{ rows: ProviderChildRecord[]; revision: string; diagnostics: Diagnostic[] }> {
    const source = await readFile(definition.storePath!, "utf8");
    const decoded = decodeCollectionFileSource(definition.provider as "csv" | "json" | "jsonl", source, definition.storePath!, schema ?? undefined);
    return { ...decoded, revision: revisionOf(source) };
  }

  private async markdownRows(
    definition: ProjectionDefinition,
    schema: CollectionSchema | null,
  ): Promise<{ rows: ProviderChildRecord[]; revision: string; diagnostics: Diagnostic[] }> {
    const rows = await Promise.all((definition.markdownPaths ?? []).sort().map(async (path, index) => {
      const source = await readFile(path, "utf8");
      const document = parseMarkdown(source);
      return {
        key: String(document.frontmatter.id ?? basename(path, ".md")), path: basename(path, ".md"),
        stableKey: null, revision: revisionOf(source), values: document.frontmatter,
        diagnostics: schema ? validateRow(schema, document.frontmatter).map((item) => valueDiagnostic(item, path, index)) : [],
      } satisfies ProviderChildRecord;
    }));
    return { rows, revision: revisionOf(rows.map((row) => `${row.path}:${row.revision}`).join("\n")), diagnostics: [] as Diagnostic[] };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await Promise.all(this.commitTails.values());
    this.schemas.clear();
  }
}
