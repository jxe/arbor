import { toJSONValue } from "@arbor/core";
import { canonicalCBORHash } from "@arbor/core";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { stableJSONString, revisionOf, rowPathSegment, stableKeyFromProperties } from "@arbor/core";
import type { Diagnostic, Hash, JSONValue } from "@arbor/core";
import { parseMarkdown } from "@arbor/editor";
import { commitPrepared, prepareAtomic, readRevision, removeIfExists } from "@arbor/fs";
import { replaceFileRollupRow } from "../file-rollup-writes.ts";
import { SchemaSandbox, type SchemaDescription } from "../schema.ts";
import { decodeFileRollupSource } from "./file-rollup-codec.ts";
import {
  type ProjectionProvider,
  decodeProviderCursor,
  encodeProviderCursor,
  ProjectionProviderError,
  representationFor,
  type LoadedProjectionSlice,
  type PreparedProviderPropertyWrite,
  type ProjectionDefinition,
  type ProjectionDescriptor,
  type ProjectionWriteTarget,
  type ProviderChildRecord,
} from "./types.ts";
interface LoadedFileProjection {
  description: SchemaDescription;
  rows: ProviderChildRecord[];
  revision: string;
  sourceRevision: string;
  modelDigest: string;
  diagnostics: Diagnostic[];
  identityRule?: { properties: string[] };
  editable: boolean;
}
export class FileProjectionDriver implements ProjectionProvider, AsyncDisposable {
  readonly kinds = ["csv", "json", "jsonl", "markdown"] as const;
  private commitTails = new Map<string, Promise<void>>();
  private snapshots = new Map<string, Promise<LoadedFileProjection>>();
  constructor(private schemas = new SchemaSandbox()) {}
  async describe(definition: ProjectionDefinition): Promise<ProjectionDescriptor> {
    const loaded = await this.load(definition);
    return {
      columns: loaded.description.columns,
      ...(loaded.identityRule ? { identityRule: loaded.identityRule } : {}),
      revision: loaded.revision,
      schemaRevision: loaded.description.revision,
      modelDigest: loaded.modelDigest,
      diagnostics: loaded.diagnostics,
      total: loaded.rows.length,
      editable: definition.provider === "markdown" && loaded.editable,
      representation: representationFor(definition.provider, loaded.modelDigest as Hash),
      ...(definition.provider === "markdown" ? { rowContent: "markdown" as const } : {}),
    };
  }
  async fileRollupDescriptor(definition: ProjectionDefinition, sourceName: string): Promise<{
    codec: "csv" | "json" | "jsonl";
    schema: Hash;
    scope: "children";
    modelDigest: Hash;
  } | null> {
    if (!definition.storePath || !definition.schemaPath || basename(definition.storePath) !== sourceName
      || !(definition.provider === "csv" || definition.provider === "json" || definition.provider === "jsonl")
      || definition.diagnostics.some((item) => item.severity === "error")) return null;
    const loaded = await this.load(definition);
    if (loaded.diagnostics.some((item) => item.severity === "error")) return null;
    return {
      codec: definition.provider,
      schema: loaded.description.revision as Hash,
      scope: "children",
      modelDigest: loaded.modelDigest as Hash,
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
        ? loaded.description.columns
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
        columns: loaded.description.columns,
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
    const description = await this.schemas.compile(definition.schemaPath);
    const validated = await this.schemas.validate(definition.schemaPath, properties);
    if (validated.diagnostics.length) throw new ProjectionProviderError("invalid-write", validated.diagnostics.map((item) => {
      const field = item.field ? `${item.field}: ` : "";
      return `${field}${item.message}`;
    }).join("; "));
    if (!validated.value || typeof validated.value !== "object" || Array.isArray(validated.value)) {
      throw new ProjectionProviderError("invalid-write", "Markdown collection properties must validate to an object");
    }
    const identityProperties = description.primaryKey ?? (description.columns.includes("id") ? ["id"] : null);
    return {
      properties: validated.value as Record<string, JSONValue>,
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
      throw new ProjectionProviderError("invalid-write", `${target.parentPath} is not a writable file rollup`);
    }
    const loaded = await this.load(definition);
    const current = loaded.rows.find((row) => target.stableKey
      ? row.stableKey === target.stableKey
      : row.path === target.path.slice(target.path.lastIndexOf("/") + 1));
    if (!current) throw new ProjectionProviderError("invalid-write", "No rollup row owns the supplied reference");
    if (current.revision !== basePropertiesRevision) {
      throw new ProjectionProviderError("stale-properties", "The row properties changed since they were read", current);
    }
    if (target.sourceRevision !== loaded.sourceRevision) {
      throw new ProjectionProviderError("stale-source", "The exact rollup source changed while the row write was being prepared");
    }
    if (!loaded.editable || !loaded.identityRule || !current.stableKey) {
      throw new ProjectionProviderError("invalid-write", "The complete rollup must be schema-valid with unique stable keys before it can be edited");
    }

    const validation = await this.schemas.validate(definition.schemaPath, properties);
    if (validation.diagnostics.length) throw new ProjectionProviderError("invalid-write", validation.diagnostics.map((item) => {
      const field = item.field ? `${item.field}: ` : "";
      return `${field}${item.message}`;
    }).join("; "));
    if (!validation.value || typeof validation.value !== "object" || Array.isArray(validation.value)) {
      throw new ProjectionProviderError("invalid-write", "Rollup properties must validate to an object");
    }
    const candidate = (toJSONValue(validation.value) ?? {}) as Record<string, JSONValue>;
    if (stableKeyFromProperties(loaded.identityRule.properties, candidate) !== current.stableKey) {
      throw new ProjectionProviderError("invalid-write", `Identity properties ${loaded.identityRule.properties.join(", ")} are immutable`);
    }

    const source = await readFile(definition.storePath, "utf8");
    if (revisionOf(source) !== loaded.sourceRevision) {
      throw new ProjectionProviderError("stale-source", "The exact rollup source changed while the row write was being prepared");
    }
    let temporaryPath: string | undefined;
    try {
      const output = stableJSONString(current.values) === stableJSONString(candidate)
        ? source
        : replaceFileRollupRow(definition.provider, source, current.key, candidate);
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
                throw new ProjectionProviderError("stale-source", "The exact rollup source changed before the prepared write could commit");
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
    const description = definition.schemaPath
      ? await this.schemas.compile(definition.schemaPath)
      : { jsonSchema: {}, columns: [], primaryKey: null, revision: revisionOf("") };
    const loaded = definition.provider === "csv" || definition.provider === "json" || definition.provider === "jsonl"
      ? await this.sourceRows(definition)
      : await this.markdownRows(definition);
    const identityProperties = description.primaryKey
      ?? (definition.provider === "markdown" && description.columns.includes("id") ? ["id"] : null);
    const identityRule = identityProperties ? { properties: identityProperties } : undefined;
    const validated = await Promise.all(loaded.rows.map(async (row, index) => {
      const result = definition.schemaPath
        ? await this.schemas.validate(definition.schemaPath, row.values)
        : { value: row.values, diagnostics: [] };
      const values = (result.value as Record<string, unknown> | undefined) ?? row.values;
      const stableKey = identityRule && result.diagnostics.length === 0
        ? stableKeyFromProperties(identityRule.properties, values) : null;
      const diagnostics = [...row.diagnostics, ...result.diagnostics];
      if (identityRule && !stableKey) diagnostics.push({
        code: "invalid-row-key", message: `Row does not have a valid ${identityRule.properties.join(", ")} stable key.`,
        path: definition.storePath ?? row.path, row: index, severity: "error",
      });
      return {
        ...row,
        path: definition.provider === "markdown" ? row.path : stableKey ? rowPathSegment(stableKey) : `~row-${index + 1}`,
        stableKey,
        revision: row.revision ?? revisionOf(stableJSONString(values)), values, diagnostics,
      } satisfies ProviderChildRecord;
    }));
    const counts = new Map<string, number>();
    for (const row of validated) if (row.stableKey) counts.set(row.stableKey, (counts.get(row.stableKey) ?? 0) + 1);
    const rows = validated.map((row, index) => !row.stableKey || counts.get(row.stableKey) === 1 ? row : ({
      ...row,
      path: definition.provider === "markdown" ? row.path : `~row-${index + 1}`,
      stableKey: null,
      diagnostics: [...row.diagnostics, {
        code: "duplicate-row-key", message: "The declared stable key is duplicated in this collection.",
        path: definition.storePath ?? row.path, row: index, severity: "error" as const,
      }],
    }));
    const revision = revisionOf(`${loaded.revision}\0${description.revision}\0${JSON.stringify({ columns: description.columns, primaryKey: identityProperties })}`);
    const modelDigest = canonicalCBORHash([...rows]
      .sort((left, right) => (left.stableKey ?? left.path).localeCompare(right.stableKey ?? right.path))
      .map((row) => ({ key: row.stableKey, path: row.path, properties: row.values })));
    return {
      description, rows, revision, sourceRevision: loaded.revision, modelDigest,
      diagnostics: [...definition.diagnostics, ...loaded.diagnostics],
      ...(identityRule ? { identityRule } : {}),
      editable: definition.provider === "markdown" || Boolean(identityRule
        && loaded.diagnostics.every((item) => item.severity !== "error")
        && rows.every((row) => row.diagnostics.every((item) => item.severity !== "error"))),
    };
  }

  private async sourceRows(definition: ProjectionDefinition): Promise<{ rows: ProviderChildRecord[]; revision: string; diagnostics: Diagnostic[] }> {
    const source = await readFile(definition.storePath!, "utf8");
    const decoded = decodeFileRollupSource(definition.provider as "csv" | "json" | "jsonl", source, definition.storePath!);
    return { ...decoded, revision: revisionOf(source) };
  }

  private async markdownRows(definition: ProjectionDefinition): Promise<{ rows: ProviderChildRecord[]; revision: string; diagnostics: Diagnostic[] }> {
    const rows = await Promise.all((definition.markdownPaths ?? []).sort().map(async (path) => {
      const source = await readFile(path, "utf8");
      const document = parseMarkdown(source);
      return {
        key: String(document.frontmatter.id ?? basename(path, ".md")), path: basename(path, ".md"),
        stableKey: null, revision: revisionOf(source), values: document.frontmatter, diagnostics: [],
      } satisfies ProviderChildRecord;
    }));
    return { rows, revision: revisionOf(rows.map((row) => `${row.path}:${row.revision}`).join("\n")), diagnostics: [] as Diagnostic[] };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await Promise.all(this.commitTails.values());
    await this.schemas[Symbol.asyncDispose]();
  }
}
