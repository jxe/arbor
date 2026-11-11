// The view-language conformance vectors, computed from packages/uvl/examples.
import { readdirSync, readFileSync, statSync, lstatSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { checkView } from "@ovst/uvl";

export const EXAMPLES = join(import.meta.dir, "../../packages/uvl/examples");

/** Every example file, by logical path within the examples tree. */
export function exampleFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const real = lstatSync(full).isSymbolicLink() ? realpathSync(full) : full;
      if (statSync(real).isDirectory()) visit(full);
      else if (/\.(view|md|usl)$/.test(name) && name !== "README.md") files["/" + relative(EXAMPLES, full)] = readFileSync(real, "utf8");
    }
  };
  visit(EXAMPLES);
  return files;
}

export function viewLanguageVectors() {
  const files = exampleFiles();
  const read = (path: string) => files[path];
  const cases = Object.keys(files)
    .filter((path) => !path.endsWith(".usl"))
    .map((path) => {
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
      "UVL, the view language (spec 4.1): each source's diagnostics (line, column, code), its views' plans and its mutations' writes, as packages/uvl checks them. `files` is the tree, by logical path; a case checks one source in it. Regenerate with `bun tests/support/regenerate-view-language.ts`.",
    files,
    cases,
  };
}
