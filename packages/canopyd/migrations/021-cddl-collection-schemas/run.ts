// Migration 021: convert retired schema.ts collections in authored working
// trees to declarative schema.cddl. It is the only place a legacy schema is
// evaluated: this offline process imports the trusted, authored schema.ts with
// the checkout's Zod, which ships in no runtime package. See README.md.
//
//   bun run packages/canopyd/migrations/021-cddl-collection-schemas/run.ts --dry-run <directory…>
//   bun run packages/canopyd/migrations/021-cddl-collection-schemas/run.ts --backup <new-dir> <directory…>
//   bun run packages/canopyd/migrations/021-cddl-collection-schemas/run.ts --rollback <backup-dir>
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  compileCollectionSchema,
  CollectionSchemaError,
  decodeCollectionFileSource,
  logicalChildName,
  validateRow,
  type CollectionSchema,
} from "../../../collection-schema/src/index.ts";
import { parseMarkdown, revisionOf, stableJSONString, stableKeyFromProperties, type JSONValue } from "../../../protocol/src/index.ts";

const STORES = ["_store.csv", "_store.json", "_store.jsonl"] as const;
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".arbor", ".build"]);
const UNSUPPORTED_ZOD = /\.(transform|refine|superRefine|preprocess|pipe|catch|default|prefault|check|overwrite|brand|readonly)\s*\(/;

export type CollectionStatus = "converted" | "already-converted" | "resumed" | "would-convert" | "blocked";

export interface CollectionReport {
  directory: string;
  backing: "csv" | "json" | "jsonl" | "markdown";
  status: CollectionStatus;
  rows: number;
  blockers: string[];
  /** Where the exact original schema.ts was copied before conversion. */
  backup?: string;
  schemaHash?: string;
}

export interface ConversionReport {
  version: 1;
  dryRun: boolean;
  collections: CollectionReport[];
}

interface LegacySchema {
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  jsonSchema: Record<string, unknown>;
  primaryKey: string[] | null;
  childName: { from: "primaryKey" } | { from: "property"; property: string };
}

/** Evaluate one trusted schema.ts exactly as the retired sandbox did: same Zod, same exports. */
async function evaluateLegacy(source: string): Promise<LegacySchema> {
  if (/\b(?:node:|bun:|https?:|fs|child_process|process\.|fetch\s*\(|import\s*\()/.test(source.replace(/from\s+["']zod["']/g, ""))) {
    throw new Error("schema.ts may import only zod and cannot use I/O globals");
  }
  const zod = Bun.resolveSync("zod", import.meta.dir);
  const directory = await mkdtemp(join(tmpdir(), "arbor-legacy-schema-"));
  try {
    const path = join(directory, "schema.ts");
    await writeFile(path, source.replace(/from\s*["']zod["']/g, `from ${JSON.stringify(zod)}`));
    const module = await import(path) as Record<string, unknown>;
    const { z } = await import(zod) as { z: { toJSONSchema(schema: unknown): Record<string, unknown> } };
    if (!module.schema) throw new Error("schema.ts must export `const schema = z.object(...)`");
    return {
      schema: module.schema as LegacySchema["schema"],
      jsonSchema: z.toJSONSchema(module.schema),
      primaryKey: (module.primaryKey as string[] | undefined) ? [...(module.primaryKey as string[])] : null,
      childName: (module.childName as LegacySchema["childName"] | undefined) ?? { from: "primaryKey" },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const SAFE = Number.MAX_SAFE_INTEGER;
const decimal = (value: number) => Number.isInteger(value) ? `${value}.0` : String(value);

/** Translate the JSON Schema Zod reports into the profile, or name why it cannot be. */
function cddlType(schema: Record<string, unknown>, path: string, blockers: string[], indent: string): string {
  for (const key of ["default", "pattern", "format", "minLength", "maxLength", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "maxItems", "uniqueItems", "not", "allOf", "$ref"]) {
    if (key in schema) blockers.push(`${path || "row"}: ${key} has no collection schema equivalent`);
  }
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    return ((schema.anyOf ?? schema.oneOf) as Record<string, unknown>[]).map((item) => cddlType(item, path, blockers, indent)).join(" / ");
  }
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map((item) => JSON.stringify(item)).join(" / ");
  switch (schema.type) {
    case "string": return "tstr";
    case "boolean": return "bool";
    case "null": return "null";
    case "integer": {
      const min = typeof schema.minimum === "number" ? schema.minimum : -SAFE;
      const max = typeof schema.maximum === "number" ? schema.maximum : SAFE;
      if (min === -SAFE && max === SAFE) return "int";
      if (min === 0 && max === SAFE) return "uint";
      return `${min}..${max}`;
    }
    case "number": {
      const min = schema.minimum, max = schema.maximum;
      if (min === undefined && max === undefined) return "number";
      if (typeof min === "number" && typeof max === "number") return `${decimal(min)}..${decimal(max)}`;
      blockers.push(`${path}: a one-sided number bound has no collection schema equivalent`);
      return "number";
    }
    case "array": {
      const items = (schema.items ?? {}) as Record<string, unknown>;
      return `[${schema.minItems === 1 ? "+" : "*"} ${cddlType(items, `${path}/items`, blockers, indent)}]`;
    }
    case "object": return cddlMap(schema, path, blockers, indent);
    default:
      blockers.push(`${path || "row"}: ${JSON.stringify(schema)} has no collection schema equivalent`);
      return "tstr";
  }
}

function cddlMap(schema: Record<string, unknown>, path: string, blockers: string[], indent: string): string {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
  const inner = `${indent}  `;
  const members = Object.entries(properties).map(([name, value]) => {
    const key = /^[A-Za-z_@][A-Za-z0-9_@]*$/.test(name) ? name : JSON.stringify(name);
    return `${inner}${required.has(name) ? "" : "? "}${key}: ${cddlType(value, `${path}/${name}`, blockers, inner)},`;
  });
  return members.length ? `{\n${members.join("\n")}\n${indent}}` : "{}";
}

export function legacyToCDDL(legacy: LegacySchema, blockers: string[]): string {
  const lines = ["; Converted from schema.ts by migration 021.", "overstory-schema-version = 1"];
  if (legacy.primaryKey) lines.push(`overstory-primary-key = [${legacy.primaryKey.map((field) => JSON.stringify(field)).join(", ")}]`);
  if (legacy.childName.from === "property") lines.push(`overstory-child-name = ${JSON.stringify(legacy.childName.property)}`);
  return `${lines.join("\n")}\n\nrow = ${cddlMap(legacy.jsonSchema, "", blockers, "")}\n`;
}

interface Row { valid: boolean; key: string | null; name: string; properties: string }

function rowsFrom(values: Array<{ values: unknown; valid: boolean; name: string }>, primaryKey: string[] | null, childName: CollectionSchema["childName"], markdown: boolean): Row[] {
  return values.map((row) => {
    const properties = (row.values ?? {}) as Record<string, JSONValue>;
    const key = row.valid && primaryKey ? stableKeyFromProperties(primaryKey, properties) : null;
    let name = row.name;
    if (!markdown && key) {
      try { name = logicalChildName({ childName }, properties, key); } catch { name = "invalid-name"; }
    }
    return { valid: row.valid, key, name, properties: row.valid ? stableJSONString(properties) : "" };
  });
}

/** Legacy and declarative interpretations of the same exact rows. */
async function compareRows(directory: string, backing: CollectionReport["backing"], legacy: LegacySchema, schema: CollectionSchema): Promise<{ rows: number; blockers: string[] }> {
  const legacyRows: Array<{ values: unknown; valid: boolean; name: string }> = [];
  const nextRows: Array<{ values: unknown; valid: boolean; name: string }> = [];
  const parse = (value: unknown) => {
    const result = legacy.schema.safeParse(value);
    return { values: result.success ? result.data : null, valid: result.success };
  };
  if (backing === "markdown") {
    for (const name of (await readdir(directory)).filter((item) => item.endsWith(".md") && item !== "_index.md").sort()) {
      const frontmatter = parseMarkdown(await readFile(join(directory, name), "utf8")).frontmatter;
      legacyRows.push({ ...parse(frontmatter), name: basename(name, ".md") });
      nextRows.push({ values: frontmatter, valid: validateRow(schema, frontmatter).length === 0, name: basename(name, ".md") });
    }
  } else {
    const source = await readFile(join(directory, `_store.${backing}`), "utf8");
    // Without a schema the codec returns the source's own values (CSV cells as
    // text), which is exactly what the retired sandbox validated.
    const raw = decodeCollectionFileSource(backing, source, `_store.${backing}`);
    raw.rows.forEach((row, index) => legacyRows.push({ ...(row.diagnostics.length ? { values: null, valid: false } : parse(row.values)), name: `~row-${index + 1}` }));
    const decoded = decodeCollectionFileSource(backing, source, `_store.${backing}`, schema);
    const fileValid = decoded.diagnostics.length === 0;
    decoded.rows.forEach((row, index) => nextRows.push({ values: row.values, valid: fileValid && row.diagnostics.length === 0, name: `~row-${index + 1}` }));
  }
  const identity = legacy.primaryKey ?? (backing === "markdown" && "id" in ((legacy.jsonSchema.properties ?? {}) as object) ? ["id"] : null);
  const before = rowsFrom(legacyRows, identity, legacy.childName, backing === "markdown");
  const after = rowsFrom(nextRows, identity, schema.childName, backing === "markdown");
  const blockers: string[] = [];
  if (before.length !== after.length) blockers.push(`row count changes from ${before.length} to ${after.length}`);
  before.forEach((row, index) => {
    const next = after[index];
    if (!next) return;
    if (row.valid !== next.valid) blockers.push(`row ${index + 1} is ${row.valid ? "valid" : "invalid"} under schema.ts but ${next.valid ? "valid" : "invalid"} under schema.cddl`);
    else if (row.key !== next.key) blockers.push(`row ${index + 1} changes stable key`);
    else if (row.name !== next.name) blockers.push(`row ${index + 1} changes logical name`);
    else if (row.properties !== next.properties) blockers.push(`row ${index + 1} changes properties (schema.ts normalized, stripped, or defaulted them)`);
  });
  return { rows: before.length, blockers };
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function writeAtomically(path: string, text: string | Uint8Array): Promise<void> {
  const temporary = `${path}.migration-021-${process.pid}`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

async function convertCollection(directory: string, dryRun: boolean, backup: Backup | null): Promise<CollectionReport | null> {
  const names = await readdir(directory);
  const hasLegacy = names.includes("schema.ts");
  const hasCDDL = names.includes("schema.cddl");
  const store = STORES.find((name) => names.includes(name));
  const backing: CollectionReport["backing"] = store ? store.slice("_store.".length) as CollectionReport["backing"] : "markdown";
  if (!hasLegacy) {
    if (!hasCDDL) return null;
    try {
      compileCollectionSchema(new Uint8Array(await readFile(join(directory, "schema.cddl"))));
      return { directory, backing, status: "already-converted", rows: 0, blockers: [] };
    } catch (error) {
      return { directory, backing, status: "blocked", rows: 0, blockers: [`schema.cddl is invalid: ${String(error)}`] };
    }
  }
  const legacyBytes = await readFile(join(directory, "schema.ts"));
  const report: CollectionReport = { directory, backing, status: "blocked", rows: 0, blockers: [] };
  const source = legacyBytes.toString("utf8");
  const unsupported = UNSUPPORTED_ZOD.exec(source);
  if (unsupported) report.blockers.push(`.${unsupported[1]}() changes or refines values; write the replacement schema.cddl by hand`);
  let legacy: LegacySchema;
  try {
    legacy = await evaluateLegacy(source);
  } catch (error) {
    report.blockers.push(`schema.ts does not evaluate to a collection schema: ${error instanceof Error ? error.message : String(error)}`);
    return report;
  }
  const cddl = legacyToCDDL(legacy, report.blockers);
  let schema: CollectionSchema;
  try {
    schema = compileCollectionSchema(cddl);
  } catch (error) {
    report.blockers.push(`the translated schema.cddl is rejected: ${error instanceof CollectionSchemaError ? error.message : String(error)}`);
    return report;
  }
  report.schemaHash = schema.revision;
  const compared = await compareRows(directory, backing, legacy, schema);
  report.rows = compared.rows;
  report.blockers.push(...compared.blockers);
  if (hasCDDL) {
    // An interrupted run wrote schema.cddl but kept schema.ts; resume only onto identical bytes.
    const existing = await readFile(join(directory, "schema.cddl"), "utf8");
    if (existing !== cddl) report.blockers.push("schema.cddl already exists with different content; resolve the ambiguity by hand");
  }
  if (report.blockers.length) return report;
  if (dryRun || !backup) return { ...report, status: "would-convert" };
  // Order: back up the exact bytes, write schema.cddl, then remove schema.ts.
  // An interruption leaves both files, which the next run resumes.
  const saved = await backup.save(directory, legacyBytes, schema.revision);
  if (!hasCDDL) await writeAtomically(join(directory, "schema.cddl"), cddl);
  await rm(join(directory, "schema.ts"));
  return { ...report, backup: saved, status: hasCDDL ? "resumed" : "converted" };
}

interface BackupEntry { directory: string; file: string; legacySchemaHash: string; schemaHash: string }

/** Exact schema.ts copies outside the converted trees, for matched-version rollback. */
class Backup {
  private constructor(readonly root: string, private readonly entries: BackupEntry[]) {}

  static async open(root: string): Promise<Backup> {
    await mkdir(root, { recursive: true });
    const manifest = join(root, "manifest.json");
    const entries = await exists(manifest) ? (JSON.parse(await readFile(manifest, "utf8")) as { entries: BackupEntry[] }).entries : [];
    return new Backup(root, entries);
  }

  async save(directory: string, bytes: Uint8Array, schemaHash: string): Promise<string> {
    const existing = this.entries.find((entry) => entry.directory === directory && entry.legacySchemaHash === revisionOf(bytes));
    const file = existing?.file ?? join(this.root, `${String(this.entries.length).padStart(4, "0")}-schema.ts`);
    if (!existing) {
      await writeAtomically(file, bytes);
      this.entries.push({ directory, file, legacySchemaHash: revisionOf(bytes), schemaHash });
      await writeAtomically(join(this.root, "manifest.json"), `${JSON.stringify({ version: 1, entries: this.entries }, null, 2)}\n`);
    }
    return file;
  }

  list(): readonly BackupEntry[] {
    return this.entries;
  }
}

async function collectionDirectories(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && (entry.name === "schema.ts" || entry.name === "schema.cddl"))) found.push(directory);
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !SKIPPED_DIRECTORIES.has(entry.name)) await walk(join(directory, entry.name));
    }
  };
  await walk(root);
  return found.sort();
}

export async function convertTrees(roots: string[], options: { dryRun: true } | { dryRun: false; backup: string }): Promise<ConversionReport> {
  const backup = options.dryRun ? null : await Backup.open(options.backup);
  const collections: CollectionReport[] = [];
  for (const root of roots) {
    for (const directory of await collectionDirectories(root)) {
      const report = await convertCollection(directory, options.dryRun, backup);
      if (report) collections.push(report);
    }
  }
  return { version: 1, dryRun: options.dryRun, collections };
}

/** Matched-version rollback: restore the exact schema.ts of every collection a backup holds. */
export async function rollback(backupRoot: string): Promise<Array<{ directory: string; restored: boolean; reason?: string }>> {
  const backup = await Backup.open(backupRoot);
  const results: Array<{ directory: string; restored: boolean; reason?: string }> = [];
  for (const entry of backup.list()) {
    const cddlPath = join(entry.directory, "schema.cddl");
    if (await exists(join(entry.directory, "schema.ts"))) { results.push({ directory: entry.directory, restored: true, reason: "schema.ts is present" }); continue; }
    if (!(await exists(cddlPath)) || revisionOf(await readFile(cddlPath)) !== entry.schemaHash) {
      results.push({ directory: entry.directory, restored: false, reason: "schema.cddl is missing or changed after conversion" });
      continue;
    }
    const bytes = new Uint8Array(await readFile(entry.file));
    if (revisionOf(bytes) !== entry.legacySchemaHash) { results.push({ directory: entry.directory, restored: false, reason: "the backup copy is damaged" }); continue; }
    await writeAtomically(join(entry.directory, "schema.ts"), bytes);
    await rm(cddlPath);
    results.push({ directory: entry.directory, restored: true });
  }
  return results;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const usage = () => {
    console.error("usage: run.ts --dry-run <directory…> | --backup <dir> <directory…> | --rollback <backup-dir>");
    process.exit(2);
  };
  if (args[0] === "--rollback") {
    if (!args[1]) usage();
    const results = await rollback(args[1]!);
    console.log(JSON.stringify({ rollback: results }));
    process.exit(results.every((item) => item.restored) ? 0 : 1);
  }
  const dryRun = args[0] === "--dry-run";
  const backup = args[0] === "--backup" ? args[1] : undefined;
  const roots = args.slice(dryRun ? 1 : 2);
  if ((!dryRun && !backup) || !roots.length) usage();
  const report = await convertTrees(roots, dryRun ? { dryRun: true } : { dryRun: false, backup: backup! });
  console.log(JSON.stringify(report));
  process.exit(report.collections.some((item) => item.status === "blocked") ? 1 : 0);
}
