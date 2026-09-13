import { expect, test } from "bun:test";
import { mkdtemp, realpath, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotDirectory } from "@arbor/fs";
import { hashObject } from "@arbor/wire";
import { FilesystemObjectSource } from "../../packages/arborsync/src/filesystem-object-source.ts";

const scope = { boundaries: new Map<string, string>(), exclusions: [] };

test("filesystem source verifies reads, retries duplicate hashes and creates no file mirror", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "arbor-source-")));
  try {
    const root = join(base, "files");
    await mkdir(root);
    await writeFile(join(root, "a.txt"), "original");
    await writeFile(join(root, "b.txt"), "original");
    await using source = new FilesystemObjectSource(root, join(base, "index.sqlite"), {
      exclusions: () => [], changed: () => {}, revalidationMs: 0,
    });
    const snapshot = await snapshotDirectory(root, scope.boundaries, [], undefined, source.index());
    expect(hashObject((await source.bytes(snapshot.root, scope))!)).toBe(snapshot.root);
    const hash = hashObject(new TextEncoder().encode("original"));
    await writeFile(join(root, "a.txt"), "modified");
    expect(new TextDecoder().decode(await source.bytes(hash, scope))).toBe("original");
    await rm(join(root, "b.txt"));
    expect(await source.bytes(hash, scope)).toBeUndefined();
    expect(await readdir(root)).toEqual(["a.txt"]);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("uncached revalidation coalesces, reports changed files and prunes vanished rows", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "arbor-source-")));
  try {
    const root = join(base, "files");
    await mkdir(root);
    const path = join(root, "a.txt");
    await writeFile(path, "before");
    const changed: string[] = [];
    await using source = new FilesystemObjectSource(root, join(base, "index.sqlite"), {
      exclusions: () => [], changed: (path) => changed.push(path), revalidationMs: 0,
    });
    await source.revalidate();
    await writeFile(path, "after");
    const audit = source.revalidate();
    expect(source.revalidate()).toBe(audit);
    await audit;
    expect(changed).toEqual([path]);
    const hash = hashObject(new TextEncoder().encode("after"));
    expect(new TextDecoder().decode(await source.bytes(hash, scope))).toBe("after");
    source.invalidate([path]);
    expect(await source.bytes(hash, scope)).toBeUndefined();
    await source.revalidate();
    await rm(path);
    await source.revalidate();
    expect(await source.bytes(hash, scope)).toBeUndefined();
  } finally { await rm(base, { recursive: true, force: true }); }
});
