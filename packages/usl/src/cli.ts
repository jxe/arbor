#!/usr/bin/env bun
// usl check <file.usl>...   prints diagnostics; exits 1 if any.
// usl show <file.usl>       prints each model's resolved fields and storage.

import { readFileSync } from "node:fs";
import { compileUsl, formatDiagnostic, type ResolvedField } from "./index.ts";

const [command, ...paths] = process.argv.slice(2);
if ((command !== "check" && command !== "show") || paths.length === 0) {
  console.error("usage: usl check <file.usl>... | usl show <file.usl>");
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
