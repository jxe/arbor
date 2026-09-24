import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

const root = join(import.meta.dir, "../..");
const QUICKJS = /quickjs/i;

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

/**
 * Every module Bun resolves from these entrypoints, as repository-relative
 * paths. Each entrypoint is a separately shipped process, so each is bundled
 * alone, in a fresh Bun process outside the test runner.
 */
async function resolvedClosure(entrypoints: string[]): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), "arbor-closure-"));
  try {
    const script = join(directory, "closure.ts");
    await writeFile(script, `
      const closure = new Set();
      for (const entrypoint of ${JSON.stringify(entrypoints.map((path) => join(root, path)))}) {
        const result = await Bun.build({ entrypoints: [entrypoint], target: "bun", metafile: true });
        if (!result.success) throw new Error(result.logs.map(String).join("\\n"));
        for (const path of Object.keys(result.metafile.inputs)) closure.add(path);
      }
      console.log(JSON.stringify([...closure]));
    `);
    const result = Bun.spawnSync([process.execPath, script], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return (JSON.parse(result.stdout.toString()) as string[]).map((path) => relative(root, join(root, path)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("collection schema package boundary", () => {
  test("no workspace manifest or the lockfile names QuickJS", async () => {
    const manifests = [join(root, "package.json"), ...(await readdir(join(root, "packages"))).map((name) => join(root, "packages", name, "package.json"))]
      .filter((path) => existsSync(path));
    for (const path of manifests) expect(await readFile(path, "utf8"), path).not.toMatch(QUICKJS);
    expect(await readFile(join(root, "bun.lock"), "utf8")).not.toMatch(QUICKJS);
    expect(existsSync(join(root, "node_modules/quickjs-emscripten"))).toBe(false);
  });

  test("the pure package executes no code and reaches no filesystem, network, or runtime code generation", async () => {
    const manifest = JSON.parse(await readFile(join(root, "packages/collection-schema/package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["@overstory/protocol", "csv-parse"]);
    for (const path of await sourceFiles(join(root, "packages/collection-schema/src"))) {
      const source = await readFile(path, "utf8");
      expect(source, path).not.toMatch(/from "(?:node:|bun:|@overstory\/(?!protocol))/);
      expect(source, path).not.toMatch(/\b(?:eval|Function|fetch|Bun\.build|import)\s*\(/);
    }
    const closure = await resolvedClosure(["packages/collection-schema/src/index.ts"]);
    expect(closure.filter((path) => !/^(?:packages\/(?:collection-schema|protocol)\/|node_modules\/.*(?:csv-parse|@noble\/hashes|yaml)\/)/.test(path))).toEqual([]);
  });

  test("the resolved import closures of canopyd, the merge worker, and Arbor Sync exclude QuickJS", async () => {
    const closure = await resolvedClosure([
      "packages/canopyd/src/cli.ts",
      "packages/canopyd-merge/src/cli.ts",
      "packages/tree-merge/src/index.ts",
      "packages/arborsync/src/cli.ts",
      "packages/cli/src/index.ts",
    ]);
    expect(closure.some((path) => path.startsWith("packages/collection-schema/"))).toBe(true);
    expect(closure.filter((path) => QUICKJS.test(path))).toEqual([]);
    expect(closure.filter((path) => path.startsWith("packages/apps-runtime/src/collections/") && !path.endsWith("types.ts") && !path.endsWith("index.ts"))).toEqual([]);
  });

  test("collection acceptance, projection, merge, and local reads run with QuickJS unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "arbor-runtime-fixture-"));
    // The fixture lives outside the checkout, so it names package sources by path.
    const module = (path: string) => JSON.stringify(join(root, "packages", path));
    try {
      await writeFile(join(directory, "block-engine.ts"), [
        "Bun.plugin({",
        '  name: "quickjs-unavailable",',
        "  setup(build) {",
        '    build.onResolve({ filter: /^quickjs-emscripten/ }, () => ({ path: "quickjs", namespace: "unavailable" }));',
        '    build.onLoad({ filter: /.*/, namespace: "unavailable" }, () => ({ contents: "throw new Error(\\"QuickJS is unavailable in this fixture\\");", loader: "js" }));',
        "  },",
        "});",
        "",
      ].join("\n"));
      const collection = join(directory, "people");
      await Bun.write(join(collection, "schema.cddl"), 'overstory-schema-version = 1\noverstory-primary-key = ["id"]\nrow = { id: tstr, count: uint }\n');
      await Bun.write(join(collection, "_store.csv"), "id,count\n001,1\n002,2\n");
      await writeFile(join(directory, "exercise.ts"), `
        import { ProjectionProviderHost } from ${module("arborsync/src/state/index.ts")};
        import { resolveSnapshot, snapshotDirectory } from ${module("fs/src/index.ts")};
        import { mergeWireTrees } from ${module("tree-merge/src/index.ts")};
        import { decodeWireCollectionFile } from ${module("collection-schema/src/index.ts")};
        import { decodeWireDirectory } from ${module("protocol/src/index.ts")};
        import { WireProjection } from ${module("canopyd/src/projection.ts")};
        import ${module("canopyd/src/index.ts")};
        const providers = new ProjectionProviderHost();
        const snapshot = await resolveSnapshot(await snapshotDirectory(${JSON.stringify(directory)}, new Map(), [${JSON.stringify(join(directory, "block-engine.ts"))}, ${JSON.stringify(join(directory, "exercise.ts"))}], (dir, name) => providers.collectionFileDescriptor(dir, name)));
        const load = async (hash) => snapshot.objects.get(hash);
        const rootObject = decodeWireDirectory(snapshot.objects.get(snapshot.root));
        const people = decodeWireDirectory(snapshot.objects.get(rootObject.entries.find((entry) => entry.name === "people").directory));
        const descriptor = people.childrenSource;
        const rows = decodeWireCollectionFile(descriptor, snapshot.objects.get(people.entries.find((e) => e.name === descriptor.source).file), snapshot.objects.get(people.entries.find((e) => e.name === "schema.cddl").file)).rows;
        const projected = await new WireProjection({ root: snapshot.root, load }).resolve("/people/002");
        const merged = await mergeWireTrees(snapshot.root, snapshot.root, snapshot.root, load);
        await providers[Symbol.asyncDispose]();
        console.log(JSON.stringify({ rows: rows.map((row) => row.properties), projected: projected.kind, conflicts: merged.conflicts.length }));
      `);
      const result = Bun.spawnSync([process.execPath, "--preload", join(directory, "block-engine.ts"), join(directory, "exercise.ts")], {
        cwd: root, stdout: "pipe", stderr: "pipe",
      });
      expect(result.stderr.toString()).toBe("");
      expect(JSON.parse(result.stdout.toString().trim())).toEqual({
        rows: [{ id: "001", count: 1 }, { id: "002", count: 2 }],
        projected: "collection-file-row",
        conflicts: 0,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
