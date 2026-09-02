import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ARBOR_SYNC_STATE_VERSION,
  AmbiguousWorkspaceIdentityError,
  arborDataRoot,
  prepareArborDataRoot,
  workspaceIdentity,
  workspaceState,
} from "@arbor/stores";

const previousDataHome = process.env.ARBOR_DATA_HOME;
const temporary: string[] = [];

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporary.push(path);
  return path;
}

afterEach(async () => {
  if (previousDataHome === undefined) delete process.env.ARBOR_DATA_HOME;
  else process.env.ARBOR_DATA_HOME = previousDataHome;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Arbor private state", () => {
  test("a Wire format bump discards only rebuildable private state", async () => {
    const state = await temp("arbor-private-state-version-");
    process.env.ARBOR_DATA_HOME = state;
    await prepareArborDataRoot();

    const privateRoot = join(state, ".state");
    await mkdir(join(privateRoot, "refs"), { recursive: true });
    await mkdir(join(privateRoot, "sync"), { recursive: true });
    await mkdir(join(privateRoot, "workspaces", "one"), { recursive: true });
    await writeFile(join(privateRoot, "refs", "tree.json"), "{}\n");
    await writeFile(join(privateRoot, "sync", "tree.json"), "{}\n");
    await writeFile(join(privateRoot, "workspaces", "one", "index.json"), "{}\n");
    await writeFile(join(privateRoot, "device.json"), "keep\n");
    await writeFile(join(privateRoot, "version"), "2\n");

    await prepareArborDataRoot();

    await expect(stat(join(privateRoot, "refs"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(privateRoot, "sync"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(privateRoot, "workspaces", "one", "index.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(privateRoot, "device.json"), "utf8")).toBe("keep\n");
    expect(await readFile(join(privateRoot, "version"), "utf8")).toBe(`${ARBOR_SYNC_STATE_VERSION}\n`);
  });

  test("an explicit data home is used as-is and upgrades registry identity", async () => {
    const state = await temp("arbor-data-override-");
    process.env.ARBOR_DATA_HOME = state;
    await prepareArborDataRoot();
    expect(arborDataRoot()).toBe(state);

    const root = join(state, "root");
    const otherRoot = join(state, "other-root");
    await mkdir(root);
    await mkdir(otherRoot);
    const canonicalRoot = await realpath(root);
    const canonicalOtherRoot = await realpath(otherRoot);
    const legacyStateID = "legacy-state-id";
    await writeFile(join(state, "workspaces.json"), `${JSON.stringify({
      [canonicalRoot]: legacyStateID,
      [canonicalOtherRoot]: "other-legacy-state-id",
    })}\n`);

    const identity = await workspaceIdentity(root);
    expect(identity.stateID).toBe(legacyStateID);
    expect(identity.rootID).toStartWith("rt_");
    const registry = JSON.parse(await readFile(join(state, ".state", "workspaces.json"), "utf8"));
    expect(registry[canonicalRoot]).toMatchObject({
      stateID: legacyStateID,
      rootID: identity.rootID,
      path: canonicalRoot,
      device: expect.any(String),
      inode: expect.any(String),
    });
    expect(registry[canonicalOtherRoot]).toMatchObject({
      stateID: "other-legacy-state-id",
      path: canonicalOtherRoot,
      device: expect.any(String),
      inode: expect.any(String),
    });
    expect((await stat((await workspaceState(root)).directory)).mode & 0o777).toBe(0o700);
  });

  test("moves every known legacy private artifact beneath the reserved mount", async () => {
    const state = await temp("arbor-private-state-migration-");
    process.env.ARBOR_DATA_HOME = state;
    await mkdir(join(state, "system"));
    await mkdir(join(state, "sync"));
    await mkdir(join(state, "workspaces"));
    await mkdir(join(state, "LinkPreviews"));
    await mkdir(join(state, "Hunch Rehearsals"));
    await writeFile(join(state, "workspaces.json"), "{}\n");
    await writeFile(join(state, ".DS_Store"), "finder state");

    await prepareArborDataRoot();

    for (const name of [
      "system", "sync", "workspaces", "workspaces.json", "LinkPreviews", "Hunch Rehearsals", ".DS_Store",
    ]) {
      await expect(stat(join(state, name))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await stat(join(state, ".state", name))).toBeTruthy();
    }
  });

  test("removes an empty legacy cache directory when migrated state already exists", async () => {
    const state = await temp("arbor-private-state-empty-recreated-");
    process.env.ARBOR_DATA_HOME = state;
    await mkdir(join(state, ".state", "LinkPreviews"), { recursive: true });
    await writeFile(join(state, ".state", "LinkPreviews", "cached.json"), "{}\n");
    await mkdir(join(state, "LinkPreviews"));

    await prepareArborDataRoot();

    await expect(stat(join(state, "LinkPreviews"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(state, ".state", "LinkPreviews", "cached.json"), "utf8")).toBe("{}\n");
  });

  test("rejects a nonempty legacy cache collision without merging it", async () => {
    const state = await temp("arbor-private-state-nonempty-collision-");
    process.env.ARBOR_DATA_HOME = state;
    await mkdir(join(state, ".state", "LinkPreviews"), { recursive: true });
    await writeFile(join(state, ".state", "LinkPreviews", "migrated.json"), "{}\n");
    await mkdir(join(state, "LinkPreviews"));
    await writeFile(join(state, "LinkPreviews", "legacy.json"), "{}\n");

    await expect(prepareArborDataRoot()).rejects.toThrow("Private-state migration collision");
    expect(await readFile(join(state, "LinkPreviews", "legacy.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(state, ".state", "LinkPreviews", "migrated.json"), "utf8")).toBe("{}\n");
  });

  test("preserves private identity when a directory moves on one filesystem", async () => {
    const state = await temp("arbor-data-move-state-");
    const outer = await temp("arbor-data-move-root-");
    process.env.ARBOR_DATA_HOME = state;
    const before = join(outer, "before");
    const after = join(outer, "after");
    await mkdir(before);

    const first = await workspaceIdentity(before);
    await rename(before, after);
    const moved = await workspaceIdentity(after);
    const canonicalAfter = await realpath(after);

    expect(moved.rootID).toBe(first.rootID);
    expect(moved.stateID).toBe(first.stateID);
    const registry = JSON.parse(await readFile(join(state, ".state", "workspaces.json"), "utf8"));
    expect(registry[await realpath(outer).then((path) => join(path, "before"))]).toBeUndefined();
    expect(registry[canonicalAfter]).toMatchObject({ rootID: first.rootID, stateID: first.stateID });
  });

  test("does not mint a new identity when several prior paths match one move", async () => {
    const state = await temp("arbor-data-ambiguous-state-");
    const outer = await temp("arbor-data-ambiguous-root-");
    process.env.ARBOR_DATA_HOME = state;
    const moved = join(outer, "moved");
    await mkdir(moved);
    const info = await stat(moved);
    const fingerprint = { device: String(info.dev), inode: String(info.ino) };
    await writeFile(join(state, "workspaces.json"), `${JSON.stringify({
      [join(outer, "old-a")]: {
        stateID: "state-a",
        rootID: "rt_old_a",
        path: join(outer, "old-a"),
        ...fingerprint,
      },
      [join(outer, "old-b")]: {
        stateID: "state-b",
        rootID: "rt_old_b",
        path: join(outer, "old-b"),
        ...fingerprint,
      },
    })}\n`);

    await expect(workspaceIdentity(moved)).rejects.toBeInstanceOf(AmbiguousWorkspaceIdentityError);
    const registry = JSON.parse(await readFile(join(state, ".state", "workspaces.json"), "utf8"));
    expect(registry[moved]).toBeUndefined();
  });

  test("does not replace a malformed private registry", async () => {
    const state = await temp("arbor-data-malformed-state-");
    process.env.ARBOR_DATA_HOME = state;
    const root = join(state, "root");
    await mkdir(root);
    const malformed = "{ this is not JSON";
    await writeFile(join(state, "workspaces.json"), malformed);

    await expect(workspaceIdentity(root)).rejects.toBeInstanceOf(SyntaxError);
    expect(await readFile(join(state, ".state", "workspaces.json"), "utf8")).toBe(malformed);
  });
});
