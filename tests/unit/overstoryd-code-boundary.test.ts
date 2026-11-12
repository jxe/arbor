// Apps 015: overstoryd runs views and mutations by interpreting Beetle in process, and
// runs no authored JavaScript. Its closure has no compiler, React or QuickJS.

import { describe, expect, test } from "bun:test";
import { readdir, readFile, rm, writeFile, mkdtemp } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

const root = join(import.meta.dir, "../..");

/** Every module Bun resolves from an entrypoint, dynamic imports included, as repository-relative paths. */
async function closure(entrypoint: string): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), "story-exec-closure-"));
  try {
    const script = join(directory, "closure.ts");
    await writeFile(script, `
      const result = await Bun.build({ entrypoints: [${JSON.stringify(join(root, entrypoint))}], target: "bun", metafile: true, packages: "bundle" });
      if (!result.success) throw new Error(result.logs.map(String).join("\\n"));
      console.log(JSON.stringify(Object.keys(result.metafile.inputs)));
    `);
    const result = Bun.spawnSync([process.execPath, script], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return (JSON.parse(result.stdout.toString()) as string[]).map((path) => relative(root, join(root, path)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const EXECUTION = /node_modules\/(?:react|react-dom|typescript|esbuild|@babel|quickjs[^/]*|vite|sucrase)\//i;

describe("overstoryd runs no authored JavaScript", () => {
  test("its closure, from its command and its library, has Beetle's interpreter and no compiler, React or QuickJS", async () => {
    for (const entrypoint of ["packages/overstoryd/src/cli.ts", "packages/overstoryd/src/index.ts"]) {
      const modules = await closure(entrypoint);
      expect(modules.some((path) => path.startsWith("packages/beetle/src/eval.ts"))).toBe(true);
      expect(modules.filter((path) => EXECUTION.test(path)), entrypoint).toEqual([]);
    }
  }, 60_000);

  test("it names no module it can't see", async () => {
    // A computed dynamic import would hide from the closure above.
    for (const name of await readdir(join(root, "packages/overstoryd/src"), { recursive: true })) {
      if (!String(name).endsWith(".ts")) continue;
      const source = await readFile(join(root, "packages/overstoryd/src", String(name)), "utf8");
      expect(source.match(/\bimport\(\s*[^"'\s]/g) ?? [], String(name)).toEqual([]);
    }
  });
});
