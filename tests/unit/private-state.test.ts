import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AmbiguousWorkspaceIdentityError,
  arborDataRoot,
  prepareArborDataRoot,
  relocateArborDataRoot,
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
  test("relocates a legacy home and leaves a compatibility symlink", async () => {
    const outer = await temp("arbor-data-home-");
    const legacy = join(outer, "Legacy", "Arbor");
    const target = join(outer, ".arbor");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "workspaces.json"), "{}\n");

    expect(await relocateArborDataRoot(target, legacy)).toEqual([]);
    expect(await readFile(join(target, "workspaces.json"), "utf8")).toBe("{}\n");
    expect((await lstat(target)).mode & 0o777).toBe(0o700);
    expect((await lstat(legacy)).isSymbolicLink()).toBe(true);
    expect(await readlink(legacy)).toBe(target);
  });

  test("uses the new home without merging a populated legacy home", async () => {
    const outer = await temp("arbor-data-conflict-");
    const legacy = join(outer, "Legacy", "Arbor");
    const target = join(outer, ".arbor");
    await mkdir(legacy, { recursive: true });
    await mkdir(target);
    await writeFile(join(legacy, "old"), "old");
    await writeFile(join(target, "new"), "new");

    const diagnostics = await relocateArborDataRoot(target, legacy);
    expect(diagnostics.map((item) => item.code)).toContain("legacy-data-home-conflict");
    expect(await readFile(join(legacy, "old"), "utf8")).toBe("old");
    expect(await readFile(join(target, "new"), "utf8")).toBe("new");
  });

  test("an explicit data home bypasses default relocation and upgrades registry identity", async () => {
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
    const registry = JSON.parse(await readFile(join(state, "workspaces.json"), "utf8"));
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
    const registry = JSON.parse(await readFile(join(state, "workspaces.json"), "utf8"));
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
    const registry = JSON.parse(await readFile(join(state, "workspaces.json"), "utf8"));
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
    expect(await readFile(join(state, "workspaces.json"), "utf8")).toBe(malformed);
  });
});
