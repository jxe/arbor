import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decodeProtocolDirectory, encodeProtocolDirectory, hashObject, type ObjectHash } from "@overstory/protocol";
import { loadIgnorePolicy, membershipSkip, resolveSnapshot, snapshotDirectory, trackedEntries } from "@overstory/fs";
import { FolderSync, type FolderSyncHost } from "../../packages/arborsync/src/folder-sync.ts";

const tree = "tr_foldersyncinstalltestaaaaa";
const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });

/**
 * One folder that knows `v1` of `a.md`, a FolderSync over it, and the root the
 * host accepted with `v2`. `beforeVerify` runs just before the scan that proves
 * a write, as another program writing the folder would.
 */
async function fixture(beforeVerify?: (folder: string) => Promise<void>, options: { legacyFinderFile?: boolean } = {}) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "arbor-install-folder-")));
  const state = await realpath(await mkdtemp(join(tmpdir(), "arbor-install-state-")));
  cleanup.push(folder, state);
  await writeFile(join(folder, "a.md"), "v1\n");
  const known = await resolveSnapshot(await snapshotDirectory(folder));
  const objects = new Map<string, Uint8Array>(known.objects);
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "arbor-install-next-")));
  cleanup.push(scratch);
  await writeFile(join(scratch, "a.md"), "v2\n");
  if (options.legacyFinderFile) {
    // Snapshots leave Finder's file out now, so a legacy root is built by hand.
    await writeFile(join(folder, ".DS_Store"), "local finder");
  }
  let next = await resolveSnapshot(await snapshotDirectory(scratch));
  if (options.legacyFinderFile) {
    const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); next.objects.set(hash, bytes); return hash; };
    const top = decodeProtocolDirectory(next.objects.get(next.root)!);
    const root = put(encodeProtocolDirectory({ ...top, entries: [{ name: ".DS_Store", file: put(new TextEncoder().encode("old finder")) }, ...top.entries] }));
    next = { root, objects: next.objects };
  }
  for (const [hash, bytes] of next.objects) objects.set(hash, bytes);

  await Bun.write(join(state, "sync", "folder.json"), JSON.stringify({ root: known.root, basis: { kind: "accepted", root: known.root, update: "1" } }));
  let placement = { tree, ref: known.root, update: "1" } as never as ReturnType<FolderSyncHost["placement"]>;
  let scans = 0;
  const host: FolderSyncHost = {
    placement: () => placement,
    client: async () => { throw new Error("offline in this test"); },
    updateSyncMetadata: async (value) => { placement = value; },
    setSyncState: () => {},
    withWorkspaceIO: (run) => run(),
    scan: async (tracked, also) => {
      // The install scans once before writing and once to prove the write.
      if (++scans === 2) await beforeVerify?.(folder);
      const policy = await loadIgnorePolicy(folder);
      const skip = membershipSkip(policy, tracked ? trackedEntries(tracked.root, tracked.load) : null);
      return snapshotDirectory(folder, new Map(), [], undefined, undefined, async (path, isDirectory) =>
        await skip(path, isDirectory) || (also ? await also(path, isDirectory) : false));
    },
    root: folder,
    excludedMounts: () => [],
    objectBytes: async (hash: ObjectHash) => objects.get(hash),
    materialized: () => {},
    setDeclined: () => {},
  };
  const sync = new FolderSync(tree, state, host);
  const install = () => sync.install(
    { root: next.root, update: "2" },
    { root: next.root, object: async (hash) => objects.get(hash)!, snapshot: async () => next },
    { pending: false },
  );
  const knownRoot = async () => (JSON.parse(await readFile(join(state, "sync", "folder.json"), "utf8")) as { root: string }).root;
  return { folder, sync, install, knownRoot, known: known.root, next: next.root };
}

describe("installing an accepted root into a folder", () => {
  test("a clean write records the new root", async () => {
    const f = await fixture();
    await f.install();
    await f.sync.close();
    expect(await readFile(join(f.folder, "a.md"), "utf8")).toBe("v2\n");
    expect(await f.knownRoot()).toBe(f.next);
  });

  test("a folder another program changes during the write keeps that change and stays syncing", async () => {
    const f = await fixture(async (folder) => { await writeFile(join(folder, "b.md"), "written meanwhile\n"); });
    await f.install();
    await f.sync.close();
    expect(await readFile(join(f.folder, "a.md"), "utf8")).toBe("v2\n");
    expect(await readFile(join(f.folder, "b.md"), "utf8")).toBe("written meanwhile\n");
    // The folder still claims its old root, so the new content and b.md publish as local changes.
    expect(await f.knownRoot()).toBe(f.known);
  });

  test("a root that still holds Finder metadata installs without touching the local file", async () => {
    const f = await fixture(undefined, { legacyFinderFile: true });
    await f.install();
    await f.sync.close();
    expect(await readFile(join(f.folder, "a.md"), "utf8")).toBe("v2\n");
    expect(await readFile(join(f.folder, ".DS_Store"), "utf8")).toBe("local finder");
    // Recorded as accepted; the folder then publishes the root without it.
    expect(await f.knownRoot()).toBe(f.next);
  });

  test("a folder that still holds its old root after the write stops", async () => {
    const f = await fixture(async (folder) => { await writeFile(join(folder, "a.md"), "v1\n"); });
    await expect(f.install()).rejects.toThrow("The folder does not hold the accepted root it was given");
    await f.sync.close();
    expect(await f.knownRoot()).toBe(f.known);
  });
});
