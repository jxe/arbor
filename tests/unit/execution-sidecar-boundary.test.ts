// Apps 005 step 4: overstoryd runs no authored code. Its closure has no query
// evaluator, compiler, React or QuickJS; those live in the execution sidecar,
// which overstoryd only starts as a separate process.

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

const EXECUTION = /packages\/(?:apps-runtime|overstoryd-exec)\/|node_modules\/(?:react|react-dom|typescript|esbuild|@babel|quickjs[^/]*|vite)\//i;

describe("execution sidecar boundary", () => {
  test("overstoryd's closure, from its command and its library, has no evaluator, compiler, React or QuickJS", async () => {
    for (const entrypoint of ["packages/overstoryd/src/cli.ts", "packages/overstoryd/src/index.ts"]) {
      const modules = await closure(entrypoint);
      expect(modules.some((path) => path.startsWith("packages/overstoryd/src/collections.ts"))).toBe(true);
      expect(modules.filter((path) => EXECUTION.test(path)), entrypoint).toEqual([]);
    }
  }, 60_000);

  test("overstoryd depends on the contract, not the sidecar, and names no module it can't see", async () => {
    const manifest = JSON.parse(await readFile(join(root, "packages/overstoryd/package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies)).toContain("@ovst/exec-protocol");
    expect(Object.keys(manifest.dependencies)).not.toContain("@ovst/apps-runtime");
    expect(Object.keys(manifest.dependencies)).not.toContain("@ovst/overstoryd-exec");
    // A computed dynamic import would hide from the closure above.
    for (const name of await readdir(join(root, "packages/overstoryd/src"), { recursive: true })) {
      if (!String(name).endsWith(".ts")) continue;
      const source = await readFile(join(root, "packages/overstoryd/src", String(name)), "utf8");
      expect(source.match(/\bimport\(\s*[^"'\s]/g) ?? [], String(name)).toEqual([]);
    }
  });

  test("the sidecar is where the evaluator is, so the check above can see one", async () => {
    const modules = await closure("packages/overstoryd-exec/src/cli.ts");
    expect(modules.some((path) => path.startsWith("packages/apps-runtime/src/sqlite.ts"))).toBe(true);
  }, 60_000);

  test("the contract package holds no evaluator", async () => {
    const modules = await closure("packages/exec-protocol/src/index.ts");
    expect(modules.filter((path) => EXECUTION.test(path))).toEqual([]);
  }, 60_000);
});
