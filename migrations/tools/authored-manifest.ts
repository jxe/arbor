// Hash every file under the given placement paths into a manifest, or diff two
// manifests. Used to prove a migration did not rewrite authored files.
//   bun run migrations/tools/authored-manifest.ts write <manifest.json> <path>...
//   bun run migrations/tools/authored-manifest.ts diff <before.json> <after.json>
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const IGNORED = new Set([".git", ".state", "node_modules", ".DS_Store"]);

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

const [mode, a, b, ...rest] = process.argv.slice(2);
if (mode === "write" && a && b) {
  const manifest: Record<string, string> = {};
  for (const placement of [b, ...rest].map((p) => resolve(p))) {
    for await (const file of walk(placement)) {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(await readFile(file));
      manifest[`${placement}:${relative(placement, file)}`] = hasher.digest("hex");
    }
  }
  await writeFile(resolve(a), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ files: Object.keys(manifest).length }));
} else if (mode === "diff" && a && b) {
  const before = JSON.parse(await readFile(resolve(a), "utf8")) as Record<string, string>;
  const after = JSON.parse(await readFile(resolve(b), "utf8")) as Record<string, string>;
  const changed = Object.keys({ ...before, ...after }).filter((key) => before[key] !== after[key]).sort();
  console.log(JSON.stringify({ changed }, null, 2));
  process.exit(changed.length ? 1 : 0);
} else {
  console.error("usage: authored-manifest.ts write <manifest.json> <path>... | diff <before.json> <after.json>");
  process.exit(2);
}
