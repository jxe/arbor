#!/usr/bin/env bun
// usl check <file.usl>...                       diagnostics; exits 1 if any
// usl show <file.usl>                           each model's resolved fields and storage
// usl sql sqlite|postgres <file.usl>            idempotent setup SQL
// usl types <file.usl>                          TypeScript row types
// usl verify <file.usl> <store> [--backend b]   does the store implement the schema?
//   <store> is a .sqlite3 file, a postgres:// URL (?schema=name), or a folder of data files.

import { readFileSync } from "node:fs";
import { compileUsl, formatDiagnostic, layoutOf, setupSql, typeDeclarations, type ResolvedField } from "./index.ts";
import { STORE_BACKENDS, UnknownStoreError, verifyStore } from "./verify/index.ts";

const USAGE = `usage:
  usl check <file.usl>...
  usl show <file.usl>...
  usl sql sqlite|postgres <file.usl>
  usl types <file.usl>
  usl verify <file.usl> <store> [--backend ${STORE_BACKENDS.map((b) => b.name).join("|")}]`;

const [command, ...paths] = process.argv.slice(2);

/** Compiles one schema, or prints its diagnostics and exits. */
function compiled(path: string) {
  const result = compileUsl(readFileSync(path, "utf8"));
  if (result.diagnostics.length > 0) {
    for (const d of result.diagnostics) console.error(formatDiagnostic(path, d));
    process.exit(1);
  }
  return result;
}

if (command === "sql" && (paths[0] === "sqlite" || paths[0] === "postgres") && paths[1]) {
  process.stdout.write(setupSql(layoutOf(compiled(paths[1])), paths[0]));
  process.exit(0);
}
if (command === "types" && paths[0]) {
  process.stdout.write(typeDeclarations(layoutOf(compiled(paths[0]))));
  process.exit(0);
}
if (command === "verify" && paths[0] && paths[1]) {
  const backendAt = paths.indexOf("--backend");
  const backend = backendAt >= 0 ? paths[backendAt + 1] : undefined;
  try {
    const diagnostics = await verifyStore(compiled(paths[0]), paths[1], backend);
    for (const d of diagnostics) console.log(`${d.severity}: ${d.code}: ${d.message}`);
    const errors = diagnostics.filter((d) => d.severity === "error").length;
    console.log(errors === 0 ? `${paths[1]} implements ${paths[0]}` : `${errors} error${errors === 1 ? "" : "s"}`);
    process.exit(errors === 0 ? 0 : 1);
  } catch (error) {
    if (!(error instanceof UnknownStoreError)) throw error;
    console.error(error.message);
    process.exit(2);
  }
}
if ((command !== "check" && command !== "show") || paths.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

let failed = false;
for (const path of paths) {
  const result = compileUsl(readFileSync(path, "utf8"));
  for (const d of result.diagnostics) console.log(formatDiagnostic(path, d));
  failed ||= result.diagnostics.length > 0;
  if (command === "check" && result.diagnostics.length === 0) console.log(`${path}: ok`);
  if (command !== "show") continue;
  const arity = (f: ResolvedField) => (f.arity === "many" ? "[]" : f.arity === "optional" ? "?" : "");
  for (const model of result.models) {
    if (model.name === "Person" && model.fields.length === 0) continue;
    const storage = model.storage ? `, stored ${model.storage.kind === "fold" ? `folded into ${model.storage.into}` : "as its own table"}` : "";
    console.log(`\n${model.name} (${model.rows}, keyed by ${model.key.join(" + ")}${storage})`);
    for (const f of model.fields) {
      const origin = f.origin === "declared" ? "" : `   ← ${f.origin}`;
      console.log(`  ${f.name.padEnd(14)} ${f.type}${arity(f)}${f.ordered ? " @ordered" : ""}${origin}`);
    }
  }
  if (result.connections.length > 0) console.log("\nConnections");
  for (const c of result.connections) {
    const s = c.storage;
    const where =
      s.kind === "column" ? `column ${s.on}.${s.field}` : s.kind === "array" ? `array ${s.on}.${s.field} (SQLite: ${s.sqlite})` : s.kind;
    console.log(`  ${c.ends[0]} <-> ${c.ends[1]}: ${where}`);
  }
}
process.exit(failed ? 1 : 0);
