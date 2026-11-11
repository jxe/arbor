// The Beetle conformance vectors, computed from packages/beetle/examples.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { checkView } from "@ovst/beetle";

export const EXAMPLES = join(import.meta.dir, "../../packages/beetle/examples");

/** Every example file, by logical path within the examples tree. */
export function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) visit(full);
      else if (/\.(beetle|md)$/.test(name) && name !== "README.md") files["/" + relative(EXAMPLES, full)] = readFileSync(full, "utf8");
    }
  };
  visit(EXAMPLES);
  return files;
}

export function beetleVectors() {
  const files = exampleFiles();
  const read = (path: string) => files[path];
  const cases = Object.keys(files).map((path) => {
    const result = checkView(files[path]!, { path, read });
    return {
      path,
      diagnostics: result.diagnostics.map((d) => ({ line: d.line, column: d.column, code: d.code, ...(d.path ? { path: d.path } : {}) })),
      views: result.views,
      mutations: result.mutations,
    };
  });
  return {
    description:
      "Beetle (spec 1.5): each file's diagnostics (line, column, code), its views' plans, and its mutations' writes, let names and public errors, as packages/beetle checks them. `files` is the tree, by logical path; a case checks one file in it. Regenerate with `bun tests/support/regenerate-beetle.ts`.",
    files,
    cases,
  };
}
