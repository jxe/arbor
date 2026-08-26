import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "@arbor/arborsync";

let root: string;
let state: string;
let workspace: Workspace;
const previousDataHome = process.env.ARBOR_DATA_HOME;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "arbor-shallow-search-"));
  state = await mkdtemp(join(tmpdir(), "arbor-shallow-search-state-"));
  process.env.ARBOR_DATA_HOME = state;
  await writeFile(
    join(root, "Reference.md"),
    "---\nid: stdu7s\n---\n# 📁 Reference\n\n[Recipes](Recipes.md)\n",
  );
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "nested", "Deep.md"), "# Deep page\n");
  workspace = await Workspace.open(root, { discovery: "shallow" });
});

afterAll(async () => {
  await workspace[Symbol.asyncDispose]();
  if (previousDataHome === undefined) delete process.env.ARBOR_DATA_HOME;
  else process.env.ARBOR_DATA_HOME = previousDataHome;
  await Promise.all([root, state].map((path) => rm(path, { recursive: true, force: true })));
});

describe("shallow workspace search", () => {
  test("indexes top-level page titles without recursively scanning descendants", () => {
    const reference = workspace.search("ref");
    expect(reference).toContainEqual(expect.objectContaining({
      path: "/Reference",
      title: "Reference",
    }));
    expect(workspace.search("deep")).toEqual([]);
  });
});
