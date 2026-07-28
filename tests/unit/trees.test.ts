import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deleteTreePlacement,
  loadTreeRegistry,
  saveLocalTreePlacement,
  treesFilePath,
} from "@arbor/stores";

const previousDataHome = process.env.ARBOR_DATA_HOME;
const temporary: string[] = [];

async function state(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "arbor-trees-"));
  temporary.push(path);
  process.env.ARBOR_DATA_HOME = path;
  return path;
}

afterEach(async () => {
  if (previousDataHome === undefined) delete process.env.ARBOR_DATA_HOME;
  else process.env.ARBOR_DATA_HOME = previousDataHome;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("trees.yaml", () => {
  test("creates an empty user-only registry on first load", async () => {
    const home = await state();

    expect((await loadTreeRegistry()).placements).toEqual([]);
    expect(await readFile(treesFilePath(), "utf8")).toBe("{}\n");
    expect((await stat(treesFilePath())).mode & 0o777).toBe(0o600);
    expect(await readdir(home)).toEqual(["trees.yaml"]);
  });

  test("stores path-keyed local objects and preserves comments and order", async () => {
    const home = await state();
    const first = join(home, "first");
    const second = join(home, "second");
    await mkdir(first);
    await mkdir(second);
    await writeFile(treesFilePath(), `# My trees\n${first}:\n  # Keep this source local\n  source: local\n`);

    await saveLocalTreePlacement(first);
    await saveLocalTreePlacement(second);
    const source = await readFile(treesFilePath(), "utf8");
    expect(source).toContain("# My trees");
    expect(source).toContain("# Keep this source local");
    expect(source).toContain(`"${first}"`);
    expect(source.indexOf(first)).toBeLessThan(source.indexOf(second));
    expect(source).toContain(`"${second}"`);
    expect((await loadTreeRegistry()).placements).toEqual([
      { path: first, source: "local" },
      { path: second, source: "local" },
    ]);
    expect((await readdir(home)).some((name) => name.includes(".arbor-write-"))).toBe(false);
  });

  test("retains a valid empty mapping after deleting the last placement", async () => {
    const home = await state();
    const root = join(home, "root");
    await mkdir(root);
    await saveLocalTreePlacement(root);
    await deleteTreePlacement(root);
    expect(await readFile(treesFilePath(), "utf8")).toBe("{}\n");
  });

  test("rejects scalar and incomplete shared-tree entries", async () => {
    const home = await state();
    const local = join(home, "local");
    const shared = join(home, "shared");
    const named = join(home, "named");
    await writeFile(treesFilePath(), [
      `${JSON.stringify(local)}: local`,
      `${JSON.stringify(shared)}:`,
      `  source: "arbor://tree/tr_example/notes"`,
      `  revision: tip`,
      `  access: read`,
      `${JSON.stringify(named)}:`,
      `  source: "arbor://library.meaningalignment.org/essays/drift"`,
      `  overlay: "local:annotations/drift"`,
      "",
    ].join("\n"));

    const snapshot = await loadTreeRegistry();
    expect(snapshot.placements).toEqual([]);
    expect(snapshot.diagnostics.map((item) => item.code)).toEqual([
      "invalid-tree-placement",
      "invalid-tree-placement",
      "invalid-tree-source",
    ]);
  });

  test("requires canonical absolute paths", async () => {
    await state();
    await expect(saveLocalTreePlacement("relative/path")).rejects.toThrow("canonical and absolute");
  });
});
