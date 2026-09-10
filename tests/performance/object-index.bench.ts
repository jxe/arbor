import { expect } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "@arbor/arborsync";
import { resolveSnapshot, snapshotDirectory } from "@arbor/fs";

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
  const workspace = await Workspace.open(root, { objectRevalidationMs: 0 });
  const startupMs = performance.now() - startupStart;

  // The first walk fills the object index; the second is served from stat tuples.
  const coldStart = performance.now();
  const cold = await resolveSnapshot(await snapshotDirectory(root, new Map(), [], undefined, workspace.objectIndex()));
  const coldMs = performance.now() - coldStart;
  const warmStart = performance.now();
  const warm = await snapshotDirectory(root, new Map(), [], undefined, workspace.objectIndex());
  const warmMs = performance.now() - warmStart;
  expect(warm.root).toBe(cold.root);

  await Bun.write(join(root, "directory-0", "note-0.txt"), "newly visible orchard");
  const incrementalStart = performance.now();
  const changed = await snapshotDirectory(root, new Map(), [], undefined, workspace.objectIndex());
  const incrementalMs = performance.now() - incrementalStart;
  expect(changed.root).not.toBe(cold.root);
  await workspace[Symbol.asyncDispose]();

  const metrics = {
    files: 50_000,
    startupMs: Math.round(startupMs),
    coldWalkMs: Math.round(coldMs),
    warmWalkMs: Math.round(warmMs),
    incrementalWalkMs: Math.round(incrementalMs),
  };
  console.log(JSON.stringify(metrics));

  expect(startupMs).toBeLessThan(5_000);
  expect(warmMs).toBeLessThan(coldMs);
} finally {
  await rm(root, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
}
