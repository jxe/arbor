import { expect, test } from "bun:test";
import { mkdtemp, realpath, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIgnorePolicy, membershipSkip, snapshotDirectory, trackedEntries } from "@overstory/fs";
import { decodeProtocolDirectory, hashObject, type ObjectHash } from "@overstory/protocol";
import { FilesystemObjectSource, forTrackedLookup } from "../../packages/arborsync/src/filesystem-object-source.ts";

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

test("directories containing ignored files rebuild to the hash the folder scan produced", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "arbor-source-ignored-")));
  try {
    const root = join(base, "files");
    await mkdir(join(root, "nested", "cache"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "*.log\ncache/\n");
    await writeFile(join(root, "nested", "page.md"), "# Page\n");
    await writeFile(join(root, "nested", "tracked.log"), "tracked before its rule\n");
    await using source = new FilesystemObjectSource(root, join(base, "index.sqlite"), {
      exclusions: () => [], changed: () => {}, revalidationMs: 0,
    });
    // The root the folder last held: everything but the cache.
    const held = await snapshotDirectory(root, scope.boundaries, [], undefined, undefined, async (path) => path.startsWith("/nested/cache"));
    const load = async (hash: ObjectHash) => held.objects.get(hash)!.bytes();
    source.setTracked(async () => ({ root: held.root, load }));
    await writeFile(join(root, "nested", "untracked.log"), "never published\n");
    await writeFile(join(root, "nested", "cache", "blob"), "generated\n");

    const policy = await loadIgnorePolicy(root);
    const scanned = await snapshotDirectory(root, scope.boundaries, [], undefined, source.index(), membershipSkip(policy, trackedEntries(held.root, load)));
    expect(scanned.root).toBe(held.root);
    const nested = decodeProtocolDirectory(await scanned.objects.get(scanned.root)!.bytes());
    const nestedHash = nested.type === "directory" ? nested.entries.find((entry) => entry.name === "nested")!.directory! : undefined;
    // A rebuild from disk, whole or of one directory, follows the same membership.
    expect(hashObject((await source.bytes(scanned.root, scope))!)).toBe(scanned.root);
    expect(hashObject((await source.bytes(nestedHash!, scope))!)).toBe(nestedHash!);
    // Inside a tracked lookup the rebuild never consults the tracked root, and still serves from rows alone.
    let consulted = 0;
    source.setTracked(async () => { consulted++; return { root: held.root, load }; });
    expect(hashObject((await forTrackedLookup(() => source.bytes(scanned.root, scope)))!)).toBe(scanned.root);
    expect(consulted).toBe(0);
    await source.revalidate();
    expect(consulted).toBe(1);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("a changed ignore file drops directory rows beneath its directory", async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "arbor-source-rows-")));
  try {
    const root = join(base, "files");
    await mkdir(join(root, "a", "b"), { recursive: true });
    await mkdir(join(root, "ab"), { recursive: true });
    await writeFile(join(root, "a", "b", "x.txt"), "x");
    await writeFile(join(root, "ab", "y.txt"), "y");
    await using source = new FilesystemObjectSource(root, join(base, "index.sqlite"), {
      exclusions: () => [], changed: () => {}, revalidationMs: 0,
    });
    const snapshot = await snapshotDirectory(root, scope.boundaries, [], undefined, source.index());
    const directory = decodeProtocolDirectory(await snapshot.objects.get(snapshot.root)!.bytes());
    const hashes = directory.type === "directory" ? Object.fromEntries(directory.entries.map((entry) => [entry.name, entry.directory!])) : {};
    source.invalidateDirectories(join(root, "a"));
    // Rows at and beneath a/ are gone, so those hashes are no longer served; ab/ is untouched.
    expect(await source.bytes(hashes.a!, scope)).toBeUndefined();
    expect(hashObject((await source.bytes(hashes.ab!, scope))!)).toBe(hashes.ab!);
  } finally { await rm(base, { recursive: true, force: true }); }
});
