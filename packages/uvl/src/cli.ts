#!/usr/bin/env bun
// uvl: check, format and show the plans of view sources (.view files and pages' view blocks).
//
//   uvl check [--root dir] file...   check; paths resolve within the tree at --root (default: .)
//   uvl fmt [--write] file...        print (or rewrite) in the conventional form
//   uvl plan [--root dir] file...    print each view's plan and each mutation's writes as JSON

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, join } from "node:path";
import { checkView, formatDiagnostic, formatPage, formatView, FormatError } from "./index.ts";

const [command, ...rest] = process.argv.slice(2);
let root = ".";
let write = false;
const files: string[] = [];
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i] === "--root") root = rest[++i] ?? ".";
  else if (rest[i] === "--write") write = true;
  else files.push(rest[i]!);
}

function usage(): never {
  console.error("usage: uvl check|plan [--root dir] file... | uvl fmt [--write] file...");
  process.exit(2);
}

if (!command || !files.length) usage();
const rootDir = resolve(root);
const read = (path: string) => {
  const file = join(rootDir, path);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
};
const logical = (file: string) => "/" + relative(rootDir, resolve(file)).split("\\").join("/");

let failed = false;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (command === "fmt") {
    try {
      const formatted = file.endsWith(".md") ? formatPage(text, formatView) : formatView(text);
      if (write) {
        if (formatted !== text) writeFileSync(file, formatted);
      } else process.stdout.write(formatted);
    } catch (error) {
      if (!(error instanceof FormatError)) throw error;
      console.error(`${file}: ${error.message}`);
      failed = true;
    }
    continue;
  }
  const path = logical(file);
  if (path.startsWith("/..")) {
    console.error(`${file} is outside the tree at ${rootDir}; pass --root`);
    process.exit(2);
  }
  const result = checkView(text, { path, read });
  for (const d of result.diagnostics) console.error(formatDiagnostic(file, d));
  if (result.diagnostics.length) failed = true;
  if (command === "plan") console.log(JSON.stringify({ path, views: result.views, mutations: result.mutations }, null, 2));
  else if (command !== "check") usage();
}
process.exit(failed ? 1 : 0);
