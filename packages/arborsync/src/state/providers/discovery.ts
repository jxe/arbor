import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnostic } from "@overstory/protocol";
import type { ProjectionDefinition, ProjectionProviderKind } from "@overstory/apps-runtime/collections";
const fixedStores = [
  ["_store.csv", "csv"],
  ["_store.json", "json"],
  ["_store.jsonl", "jsonl"],
  ["_store.sqlite3", "sqlite"],
  ["_store.postgres", "postgres"],
] as const satisfies readonly (readonly [string, ProjectionProviderKind])[];
const SCHEMA = "schema.cddl";
/** The retired executable schema; never interpreted (spec 06 §2.5). */
const LEGACY_SCHEMA = "schema.ts";

/** Inventory a directory once and select the single built-in provider that claims it. */
export async function detectProjection(directory: string): Promise<ProjectionDefinition | null> {
  const names = await readdir(directory);
  const schemaPath = names.includes(SCHEMA) ? join(directory, SCHEMA) : undefined;
  const legacySchema = names.includes(LEGACY_SCHEMA);
  const stores = fixedStores.filter(([name]) => names.includes(name));
  const markdownPaths = schemaPath || legacySchema
    ? names.filter((name) => name.endsWith(".md") && name !== "_index.md").map((name) => join(directory, name))
    : [];
  if (!schemaPath && !legacySchema && stores.length === 0) return null;
  const diagnostics: Diagnostic[] = [];
  if (stores.length + (markdownPaths.length ? 1 : 0) > 1) diagnostics.push({
    code: "mixed-collection-backing",
    message: "A collection must use exactly one of _store.csv, _store.json, _store.jsonl, _store.sqlite3, _store.postgres, or Markdown records.",
    path: directory,
    severity: "error",
  });
  const selected = stores[0];
  const database = selected?.[1] === "sqlite" || selected?.[1] === "postgres";
  if (legacySchema && (!database || schemaPath)) diagnostics.push(schemaPath ? {
    code: "ambiguous-collection-schema",
    message: "A collection has both schema.cddl and the retired schema.ts; remove schema.ts.",
    path: join(directory, LEGACY_SCHEMA),
    severity: "error",
  } : {
    code: "legacy-collection-schema",
    message: "schema.ts collection schemas are retired and never evaluated; convert this collection to schema.cddl.",
    path: join(directory, LEGACY_SCHEMA),
    severity: "error",
  });
  if (schemaPath && database) diagnostics.push({
    code: "mixed-collection-backing",
    message: "schema.cddl governs Markdown and collection-file rows; a database backing introspects its own schema.",
    path: schemaPath,
    severity: "error",
  });
  if (selected) {
    return {
      provider: selected[1],
      storePath: join(directory, selected[0]),
      ...(schemaPath && !database ? { schemaPath } : {}),
      diagnostics,
    };
  }
  return { provider: "markdown", markdownPaths, ...(schemaPath ? { schemaPath } : {}), diagnostics };
}
