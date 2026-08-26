import { expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "@arbor/arborsync";
import { WorkspaceIndex, workspaceStateDirectory } from "@arbor/stores";

const root = await mkdtemp(join(tmpdir(), "arbor-performance-tree-"));
const state = await mkdtemp(join(tmpdir(), "arbor-performance-state-"));

try {
  process.env.ARBOR_DATA_HOME = state;
  for (let directoryIndex = 0; directoryIndex < 200; directoryIndex += 1) {
    const directory = join(root, `directory-${directoryIndex}`);
    await mkdir(directory);
    await Promise.all(Array.from({ length: 250 }, (_, fileIndex) =>
      Bun.write(join(directory, `note-${fileIndex}.txt`), `orchard ${directoryIndex} ${fileIndex}`),
    ));
  }

  const startupStart = performance.now();
  const workspace = await Workspace.open(root);
  const startupMs = performance.now() - startupStart;

  const searchStart = performance.now();
  const results = workspace.search("orchard");
  const searchMs = performance.now() - searchStart;
  await workspace[Symbol.asyncDispose]();

  const changedPath = join(root, "directory-0", "note-0.txt");
  await Bun.write(changedPath, "newly visible orchard");
  const workspaceState = await workspaceStateDirectory(root);
  const index = new WorkspaceIndex(root, join(workspaceState, "index.sqlite"));
  const incrementalStart = performance.now();
  await index.updateAbsolute(changedPath);
  const incrementalMs = performance.now() - incrementalStart;

  const metrics = {
    files: 50_000,
    startupMs: Math.round(startupMs),
    incrementalMs: Number(incrementalMs.toFixed(2)),
    searchMs: Number(searchMs.toFixed(2)),
    results: results.length,
  };
  console.log(JSON.stringify(metrics));

  expect(startupMs).toBeLessThan(5_000);
  expect(incrementalMs).toBeLessThan(200);
  expect(searchMs).toBeLessThan(100);
  index.close();
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
}
