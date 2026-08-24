import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { ArborService, serveArborControl } from "@arbor/arbord";
import { browseTarget, isReservedProfile, placedRemotePath } from "../../../packages/cli/src/index.ts";
import { sha256 } from "@arbor/core";
import { communityCredentialName, CommunityConfigStore } from "@arbor/stores";
import { serveWireHost, WireAuthority } from "@arbor/authority";
import { snapshotDirectory, WireClient } from "@arbor/wire";

const ownerToken = "community-owner-device";
let sandbox: string;
let host: Awaited<ReturnType<typeof serveWireHost>>;
let owner: WireClient;
let aliceToken: string;

async function waitFor(read: () => Promise<boolean>, timeout = 4_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await read()) return;
    await Bun.sleep(50);
  }
  throw new Error("Timed out waiting for community sync");
}

async function profileFolder(
  name: string,
  type: "person" | "group",
  members: string[] = [],
): Promise<string> {
  const path = join(sandbox, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "_index.md"), [
    "---",
    `type: ${type}`,
    ...(type === "group" ? ["members:", ...members.map((member) => `  - ${member}`)] : []),
    "---",
    "",
    `# ${name}`,
    "",
  ].join("\n"));
  return path;
}

async function authorCommunity(
  members: string[],
  boundaries: Array<{ handle: string; tree: string }>,
): Promise<void> {
  const path = await profileFolder("community-source", "group", members);
  const boundaryMap = new Map(boundaries.map((boundary) => [join(path, `~${boundary.handle}`), boundary.tree]));
  const community = await owner.ref(host.authority.community().id);
  await owner.submitUpdate(
    community.id,
    { root: community.ref, update: community.update! },
    await snapshotDirectory(path, boundaryMap),
  );
}

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "arbor-community-hosting-"));
  host = await serveWireHost({
    dataRoot: join(sandbox, "host"),
    publicOrigin: "http://127.0.0.1:0",
    community: { handle: "garden", name: "Garden" },
    accounts: [{ handle: "owner", token: ownerToken, name: "Owner", communityWriter: true }],
    hostname: "127.0.0.1",
    port: 0,
  });
  owner = new WireClient(host.url, ownerToken);
});

afterAll(async () => {
  host.server.stop(true);
  await host.authority[Symbol.asyncDispose]();
  await rm(sandbox, { recursive: true, force: true });
});

describe("community-mounted profiles and sharing", () => {
  test("claims an authored reservation once and disables a removed claimed member", async () => {
    const ownerProfile = host.authority.boundary("/~owner")!;
    const aliceURL = `arbor://${new URL(host.url).host}/~alice`;
    const bobURL = `arbor://${new URL(host.url).host}/~bob`;
    await authorCommunity(
      [`arbor://${new URL(host.url).host}/~owner`, aliceURL, bobURL, "arbor://other.example/~mallory"],
      [{ handle: "owner", tree: ownerProfile.id }],
    );
    const pendingPage = await fetch(`${host.url}/~alice`);
    expect(pendingPage.status).toBe(200);
    expect(pendingPage.headers.get("x-arbor-profile-state")).toBe("reserved");
    const pendingSource = await pendingPage.text();
    expect(pendingSource).toContain("Open it in Arbor");
    expect(pendingSource).toContain(`${host.url}/~alice`);
    expect(await isReservedProfile(browseTarget(`${host.url}/~alice`))).toBe(true);
    await expect(new WireClient(host.url).claim("mallory", await snapshotDirectory(await profileFolder("mallory-source", "person"))))
      .rejects.toThrow("not reserved");
    const aliceSource = await profileFolder("alice-source", "person");
    const snapshot = await snapshotDirectory(aliceSource);
    const attempts = await Promise.allSettled([
      new WireClient(host.url).claim("alice", snapshot),
      new WireClient(host.url).claim("alice", snapshot),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const failed = attempts.find((attempt) => attempt.status === "rejected") as PromiseRejectedResult;
    expect(String(failed.reason)).toContain("already-claimed");
    const claimed = (attempts.find((attempt) => attempt.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<WireClient["claim"]>>>).value;
    expect(await isReservedProfile(browseTarget(`${host.url}/~alice`))).toBe(false);
    aliceToken = claimed.accountToken;
    expect(claimed.tree.canonicalPath).toBe("/~alice");
    expect(host.authority.boundary("/~alice")?.id).toBe(claimed.tree.id);
    const claimedPage = await fetch(`${host.url}/~alice`);
    expect(await claimedPage.text()).not.toContain("/~alice/_index.md");

    await authorCommunity(
      [`arbor://${new URL(host.url).host}/~owner`],
      [
        { handle: "owner", tree: ownerProfile.id },
        { handle: "alice", tree: claimed.tree.id },
      ],
    );
    await expect(new WireClient(host.url).claim("bob", await snapshotDirectory(await profileFolder("bob-source", "person"))))
      .rejects.toThrow("not reserved");
    expect((await fetch(`${host.url}/.arbor/account`, {
      headers: { authorization: `Bearer ${claimed.accountToken}` },
    })).status).toBe(401);
    expect(host.authority.boundary("/~alice")?.id).toBe(claimed.tree.id);
  });

  test("promotes nested content in place with longest-prefix and isolated access", async () => {
    const aliceTree = host.authority.boundary("/~alice")!;
    await authorCommunity(
      [
        `arbor://${new URL(host.url).host}/~owner`,
        `arbor://${new URL(host.url).host}/~alice`,
      ],
      [
        { handle: "owner", tree: host.authority.boundary("/~owner")!.id },
        { handle: "alice", tree: aliceTree.id },
      ],
    );
    const alice = new WireClient(host.url, aliceToken);

    const editorsPath = await profileFolder(
      "editors-source",
      "group",
      [`arbor://${new URL(host.url).host}/~alice`],
    );
    await mkdir(join(editorsPath, "handbook"));
    await writeFile(join(editorsPath, "handbook", "welcome.md"), "---\nid: pg_welcome\n---\n\n# Welcome\n");
    await writeFile(join(editorsPath, "news.md"), "# News\n");
    const editors = await owner.create("/~editors", await snapshotDirectory(editorsPath), {
      kind: "group-profile",
      publicAccess: "read",
    });
    await expect(alice.submitUpdate(
      editors.id,
      { root: editors.ref, update: editors.update! },
      await snapshotDirectory(editorsPath),
    ))
      .rejects.toThrow("Not found");
    expect((await fetch(`${host.url}/~editors/handbook/welcome.md`)).status).toBe(200);
    expect((await owner.resolve("/~editors/handbook/welcome.md")).id).toBe(editors.id);

    const handbook = await owner.create(
      "/~editors/handbook",
      await snapshotDirectory(join(editorsPath, "handbook")),
      { publicAccess: "read" },
    );
    const stable = await fetch(`${host.url}/~editors/handbook/welcome.md`);
    expect(stable.status).toBe(200);
    expect(await stable.text()).toContain("<h1>Welcome</h1>");
    expect(await fetch(`${host.url}/~editors/handbook/welcome.md`, { headers: { accept: "text/markdown" } }).then((response) => response.text()))
      .toContain("pg_welcome");
    expect((await owner.resolve("/~editors/handbook/welcome.md")).id).toBe(handbook.id);
    expect((await owner.resolve("/~editors/news.md")).id).toBe(editors.id);
    expect((await owner.ref(handbook.id)).id).toBe(handbook.id);

    await owner.setPublicAccess(handbook.id, "none");
    expect((await fetch(`${host.url}/~editors/handbook/welcome.md`)).status).toBe(404);
    expect((await fetch(`${host.url}/~editors/news.md`)).status).toBe(200);
    expect((await alice.list()).some((tree) => tree.id === handbook.id)).toBe(false);
    expect((await owner.list()).find((tree) => tree.id === handbook.id)?.access).toBe("write");
    await owner.setAccess(
      handbook.id,
      { kind: "profile", locator: `arbor://${new URL(host.url).host}/~editors` },
      "read",
    );
    expect((await alice.ref(handbook.id)).id).toBe(handbook.id);
    expect((await alice.list()).find((tree) => tree.id === handbook.id)?.access).toBe("read");
    const groupEntry = (await owner.access(handbook.id)).find((entry) => entry.locator?.endsWith("/~editors"))!;
    expect(groupEntry).toMatchObject({ kind: "profile", access: "read" });
    await owner.revokeAccess(handbook.id, groupEntry.id);
    await expect(alice.ref(handbook.id)).rejects.toThrow("Not found");
    const linkSecret = "one-use-link-secret";
    await owner.setAccess(handbook.id, { kind: "link", digest: `sha256:${sha256(linkSecret)}` }, "read");
    expect((await fetch(`${host.url}/~editors/handbook/welcome.md`, {
      headers: { "x-arbor-access": linkSecret },
    })).status).toBe(200);
    const linkEntry = (await owner.access(handbook.id)).find((entry) => entry.kind === "link")!;
    await owner.revokeAccess(handbook.id, linkEntry.id);
    expect((await fetch(`${host.url}/~editors/handbook/welcome.md`, {
      headers: { "x-arbor-access": linkSecret },
    })).status).toBe(404);

    const currentEditors = host.authority.get(editors.id)!;
    const currentEditorsUpdate = host.authority.currentUpdate(editors.id)!;
    const replacement = await snapshotDirectory(editorsPath);
    const conflict = await fetch(`${host.url}/.arbor/trees/${editors.id}/updates`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        base: { root: currentEditors.ref, update: currentEditorsUpdate.id },
        candidate: replacement.root,
        objects: [...replacement.objects].map(([hash, bytes]) => ({
          hash,
          bytes: Buffer.from(bytes).toString("base64"),
        })),
      }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "reserved-boundary", path: "/~editors/handbook" });
    await expect(owner.create("/~strangers/handbook", replacement)).rejects.toThrow("beneath an administered profile");
  });

  test("projects an external folder as a virtual profile child without copying it", async () => {
    const state = join(sandbox, "local-state");
    process.env.ARBOR_DATA_HOME = state;
    const profilePath = join(sandbox, "local-owner-profile");
    const externalPath = join(sandbox, "external-atlas");
    await Promise.all([profilePath, externalPath].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(externalPath, "note.md"), "# External atlas\n");
    const original = await realpath(externalPath);
    const service = await ArborService.openControl();
    try {
      await service.executeMutation({
        mutationID: "connect-owner",
        operations: [{ op: "connectCommunity", origin: host.url, accountToken: ownerToken }],
      });
      const profile = host.authority.boundary("/~owner")!;
      await service.executeMutation({
        mutationID: "place-owner-profile",
        operations: [{ op: "placeTree", tree: profile.id, path: profilePath }],
      });
      expect(await placedRemotePath(browseTarget(`${host.url}/~owner`), service)).toBe(await realpath(profilePath));
      const stalePlacement = service.trees.placementFor(profile.id)!;
      if (stalePlacement.source === "local") throw new Error("Expected a shared owner placement");
      await service.trees.applySharedPlacement({ ...stalePlacement, access: "read" });
      await service.executeMutation({
        mutationID: "reconnect-owner",
        operations: [{ op: "connectCommunity", origin: host.url, accountToken: ownerToken }],
      });
      const reconnectedPlacement = service.trees.placementFor(profile.id)!;
      expect(reconnectedPlacement.source === "local" ? undefined : reconnectedPlacement.access).toBe("write");
      const promoted = await service.executeMutation({
        mutationID: "share-external-atlas",
        operations: [{
          op: "promoteTree",
          path: externalPath,
          canonicalPath: "/~owner/atlas",
          audience: {
            kind: "rules",
            rules: [
              { subject: { kind: "everyone" }, access: "read" },
              { subject: { kind: "profile", locator: `${host.url}/~editors` }, access: "write" },
            ],
          },
        }],
      });
      const atlasTree = promoted.effects.find((effect) => effect.tree?.startsWith("tr_"))!.tree!;
      const initialAccess = await owner.access(atlasTree);
      expect(initialAccess).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "everyone", access: "read" }),
        expect.objectContaining({ kind: "profile", locator: expect.stringContaining("/~editors"), access: "write" }),
      ]));
      const rawLinkSecret = "must-not-enter-durable-state";
      await service.executeMutation({
        mutationID: "safe-link-secret",
        operations: [{
          op: "setTreeAccess",
          tree: atlasTree,
          subject: { kind: "link", secret: rawLinkSecret },
          access: "read",
        }],
      });
      expect(await realpath(externalPath)).toBe(original);
      expect(await readdir(profilePath)).not.toContain("atlas");
      expect((await service.children({ tree: profile.id, path: "/" })).items.map((item) => item.name)).toContain("atlas");
      expect((await service.snapshot({ tree: profile.id, path: "/atlas/note" })).document?.bodySource)
        .toContain("External atlas");
      expect(await readFile(join(externalPath, "note.md"), "utf8")).toBe("# External atlas\n");
      await expect(service.executeMutation({
        mutationID: "replace-reserved-atlas",
        operations: [{ op: "createDirectory", tree: profile.id, path: "/atlas" }],
      })).rejects.toMatchObject({ code: "reserved-boundary" });
      const durableText = async (directory: string): Promise<string> => {
        let text = "";
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) text += await durableText(path);
          else if (/\.(?:json|md|yaml)$/.test(entry.name)) text += await readFile(path, "utf8");
        }
        return text;
      };
      expect(await durableText(state)).not.toContain(rawLinkSecret);
      await expect(service.executeMutation({
        mutationID: "trash-reserved-atlas",
        operations: [{ op: "trash", refs: [{ tree: profile.id, path: "/atlas" }] }],
      })).rejects.toMatchObject({ code: "reserved-boundary" });

      const profileIndex = join(profilePath, "_index.md");
      const beforeDiskEdit = await readFile(profileIndex, "utf8");
      await writeFile(profileIndex, beforeDiskEdit.replace(/^# .+$/m, "# Owner changed on disk")
        + "\nWelcome, **friends**.\n\n- One\n- Two\n");
      const control = await serveArborControl({ port: 0 });
      try {
        let published = "";
        for (let attempt = 0; attempt < 40; attempt += 1) {
          published = await fetch(`${host.url}/~owner/_index.md`).then((response) => response.text());
          if (published.includes("Owner changed on disk")) break;
          await Bun.sleep(100);
        }
        expect(published).toContain("Owner changed on disk");
        const profileHTML = await fetch(`${host.url}/~owner`).then((response) => response.text());
        expect(profileHTML).toContain("<h1>Owner changed on disk</h1>");
        expect(profileHTML).toContain("Welcome, <strong>friends</strong>.");
        expect(profileHTML).toContain("href=\"/~owner/atlas\"");
        const remoteProfile = await control.service.remoteSnapshot(`${host.url}/~owner`);
        expect(remoteProfile).toMatchObject({ kind: "directory", writable: false, name: "Owner changed on disk" });
        expect(remoteProfile.document?.bodySource).toContain("Welcome, **friends**.");
        expect(remoteProfile.children?.map((child) => child.name)).toContain("atlas");
        const remoteNote = await control.service.remoteSnapshot(`${host.url}/~owner/atlas/note`);
        expect(remoteNote).toMatchObject({ kind: "markdown", writable: false });
        expect(remoteNote.document?.bodySource).toContain("External atlas");
      } finally {
        control.server.stop(true);
        await control.service[Symbol.asyncDispose]();
      }

      await Bun.secrets.delete({
        service: "org.arbor.community-account",
        name: communityCredentialName(state),
      });
      expect((await service.snapshot({ tree: "system", path: "/community" })).document?.frontmatter)
        .toMatchObject({ connected: true, credentialAvailable: false });
      await expect(service.executeMutation({
        mutationID: "missing-community-credential",
        operations: [{ op: "setTreeAccess", tree: atlasTree, subject: { kind: "everyone" }, access: "none" }],
      })).rejects.toMatchObject({ code: "credential-unavailable" });
      await service.executeMutation({
        mutationID: "restore-community-credential",
        operations: [{ op: "connectCommunity", origin: host.url, accountToken: ownerToken }],
      });
      expect((await service.snapshot({ tree: "system", path: "/community" })).document?.frontmatter)
        .toMatchObject({ connected: true, credentialAvailable: true });
    } finally {
      await service[Symbol.asyncDispose]();
      await new CommunityConfigStore().remove();
    }
  });

  test("composes an unrelated tree into the reader's layout without changing its parent", async () => {
    const state = join(sandbox, "composition-state");
    process.env.ARBOR_DATA_HOME = state;
    const parentPath = join(sandbox, "composition-owner");
    await mkdir(parentPath, { recursive: true });
    const readingSource = await profileFolder("reading-group-source", "group");
    await writeFile(join(readingSource, "welcome.md"), "# Reading room\n");
    const reading = await owner.create("/~reading-room", await snapshotDirectory(readingSource), {
      kind: "group-profile",
      publicAccess: "read",
    });
    const ownerProfile = host.authority.boundary("/~owner")!;
    const service = await ArborService.openControl();
    try {
      await service.executeMutation({
        mutationID: "composition-connect",
        operations: [{ op: "connectCommunity", origin: host.url, accountToken: ownerToken }],
      });
      await service.executeMutation({
        mutationID: "composition-place-parent",
        operations: [{ op: "placeTree", tree: ownerProfile.id, path: parentPath }],
      });
      const parentLayoutBefore = service.trees.compositionFor(ownerProfile.id);
      const parentSnapshotBefore = await snapshotDirectory(
        parentPath,
        parentLayoutBefore.boundaries,
        parentLayoutBefore.excludedRoots,
      );
      const mountPath = join(parentPath, "reading");
      await service.executeMutation({
        mutationID: "composition-place-child",
        operations: [{ op: "placeTree", tree: reading.id, path: mountPath }],
      });

      expect((await service.children({ tree: ownerProfile.id, path: "/" })).items.map((item) => item.name)).toContain("reading");
      expect((await service.snapshot({ tree: ownerProfile.id, path: "/reading/welcome" })).tree).toBe(reading.id);
      await expect(service.executeMutation({
        mutationID: "composition-replace-mount",
        operations: [{ op: "createDirectory", tree: ownerProfile.id, path: "/reading" }],
      })).rejects.toMatchObject({ code: "reserved-boundary" });
      const layout = service.trees.compositionFor(ownerProfile.id);
      expect(layout.excludedRoots).toEqual([await realpath(mountPath)]);
      expect((await snapshotDirectory(parentPath, layout.boundaries, layout.excludedRoots)).root).toBe(parentSnapshotBefore.root);

      await writeFile(join(mountPath, "local-only.md"), "# Local child edit\n");
      expect((await snapshotDirectory(parentPath, layout.boundaries, layout.excludedRoots)).root).toBe(parentSnapshotBefore.root);
      await writeFile(
        join(mountPath, "owner-link.md"),
        `# Link from reading\n\n[Owner](arbor://tree/${ownerProfile.id}/)\n`,
      );
      let backlinks: Awaited<ReturnType<typeof service.backlinksPage>>["entries"] = [];
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await Bun.sleep(25);
        backlinks = (await service.backlinksPage({ tree: ownerProfile.id, path: "/" })).entries;
        if (backlinks.some((entry) => entry.ref.tree === reading.id)) break;
      }
      expect(backlinks).toEqual(expect.arrayContaining([
        expect.objectContaining({ ref: expect.objectContaining({ tree: reading.id, path: "/owner-link" }) }),
      ]));
      expect((await service.searchPage(ownerProfile.id, "Local child edit")).results).toHaveLength(0);
      expect((await service.searchPage(reading.id, "Local child edit")).results).toEqual(expect.arrayContaining([
        expect.objectContaining({ tree: reading.id, path: "/local-only" }),
      ]));
      await service.executeMutation({
        mutationID: "composition-remove-child",
        operations: [{ op: "removeTreePlacement", path: await realpath(mountPath) }],
      });
      expect(await readFile(join(mountPath, "local-only.md"), "utf8")).toContain("Local child edit");
    } finally {
      await service[Symbol.asyncDispose]();
      await new CommunityConfigStore().remove();
    }
  });

  test("adopts an advanced parent ref when nested placement already makes local content identical", async () => {
    const state = join(sandbox, "nested-ref-reconciliation-state");
    process.env.ARBOR_DATA_HOME = state;
    const parentPath = join(sandbox, "nested-ref-reconciliation-parent");
    const parentSource = await profileFolder("nested-ref-reconciliation-source", "group");
    await writeFile(join(parentSource, "parent.md"), "# Parent\n");
    const childSource = join(sandbox, "nested-ref-reconciliation-child");
    await mkdir(childSource, { recursive: true });
    await writeFile(join(childSource, "child.md"), "# Child\n");

    const parent = await owner.create(
      "/~nested-ref-reconciliation",
      await snapshotDirectory(parentSource),
      { kind: "group-profile", publicAccess: "none" },
    );
    const staleParentRef = parent.ref;
    const child = await owner.create(
      "/~nested-ref-reconciliation/nested",
      await snapshotDirectory(childSource),
      { publicAccess: "none" },
    );
    const currentParent = await owner.ref(parent.id);
    expect(currentParent.ref).not.toBe(staleParentRef);

    let setup: ArborService | undefined;
    let syncing: ArborService | undefined;
    try {
      setup = await ArborService.openControl({ autoSync: false });
      await setup.executeMutation({
        mutationID: "nested-ref-connect",
        operations: [{ op: "connectCommunity", origin: host.url, accountToken: ownerToken }],
      });
      await setup.executeMutation({
        mutationID: "nested-ref-place-parent",
        operations: [{ op: "placeTree", tree: parent.id, path: parentPath }],
      });
      await setup.executeMutation({
        mutationID: "nested-ref-place-child",
        operations: [{ op: "placeTree", tree: child.id, path: join(parentPath, "nested") }],
      });

      const parentPlacement = setup.trees.placementFor(parent.id)!;
      if (parentPlacement.source === "local") throw new Error("Expected a shared parent placement");
      await setup.trees.applySharedPlacement({ ...parentPlacement, ref: staleParentRef });
      const layout = setup.trees.compositionFor(parent.id);
      const canonicalParentPath = await realpath(parentPath);
      expect([...layout.boundaries]).toEqual([[join(canonicalParentPath, "nested"), child.id]]);
      const localParent = await snapshotDirectory(canonicalParentPath, layout.boundaries, layout.excludedRoots);
      expect(localParent.root).toBe(currentParent.ref);
      expect(setup.trees.placementFor(parent.id)).toMatchObject({ ref: staleParentRef });

      await setup[Symbol.asyncDispose]();
      setup = undefined;
      syncing = await ArborService.openControl({ autoSync: true });
      await waitFor(async () => {
        const placement = syncing!.trees.placementFor(parent.id);
        return placement?.source !== "local" && placement?.ref === currentParent.ref;
      });
      expect((await syncing.snapshot({ tree: "system", path: `/trees/${parent.id}` })).document?.frontmatter.sync)
        .toBe("idle");
    } finally {
      await setup?.[Symbol.asyncDispose]();
      await syncing?.[Symbol.asyncDispose]();
      await new CommunityConfigStore().remove();
    }
  });

  test("persists remote visits and serves their cached read-only copy while offline", async () => {
    const state = join(sandbox, "visited-state");
    process.env.ARBOR_DATA_HOME = state;
    const remote = await serveWireHost({
      dataRoot: join(sandbox, "visited-host"),
      publicOrigin: "http://127.0.0.1:0",
      community: { handle: "visitors", name: "Visitors" },
      accounts: [{ handle: "owner", token: "visited-owner", name: "Owner", communityWriter: true }],
      hostname: "127.0.0.1",
      port: 0,
    });
    const service = await ArborService.openControl();
    const locator = `${remote.url}/~owner`;
    try {
      const online = await service.remoteSnapshot(locator);
      expect(online.enclosingTree?.placement).toBe("remote");
      expect((await service.children({ tree: "system", path: "/visited" })).items).toHaveLength(1);
      const addedPath = join(sandbox, "visited-added-to-workspace");
      await service.executeMutation({
        mutationID: "visited-add-to-workspace",
        operations: [{
          op: "placeTree",
          tree: online.enclosingTree!.id,
          path: addedPath,
          endpoint: new URL(locator).origin,
          canonical: online.enclosingTree!.httpURL,
        }],
      });
      expect((await service.snapshot({ tree: online.enclosingTree!.id, path: "/" })).enclosingTree?.osPath)
        .toBe(await realpath(addedPath));
      remote.server.stop(true);
      const cached = await service.remoteSnapshot(locator);
      expect(cached.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "cached-remote-visit" }),
      ]));
    } finally {
      remote.server.stop(true);
      await remote.authority[Symbol.asyncDispose]();
      await service[Symbol.asyncDispose]();
    }
  });

  test("coalesces a sibling Markdown body with its directory in remote snapshots", async () => {
    const state = join(sandbox, "sibling-remote-state");
    process.env.ARBOR_DATA_HOME = state;
    const source = join(sandbox, "sibling-remote-source");
    await mkdir(join(source, "guide"), { recursive: true });
    await writeFile(join(source, "guide.md"), "---\nid: guide-page\n---\n\n# Remote guide\n\nVisible sibling body.\n");
    await writeFile(join(source, "guide", "chapter.md"), "# Chapter\n");
    await owner.create("/~owner/sibling-remote", await snapshotDirectory(source), { publicAccess: "read" });

    const service = await ArborService.openControl();
    try {
      const snapshot = await service.remoteSnapshot(`${host.url}/~owner/sibling-remote/guide`);
      expect(snapshot.bodyState).toBe("stored");
      expect(snapshot.bodyOrigin).toBe("sibling");
      expect(snapshot.document?.frontmatter.id).toBe("guide-page");
      expect(snapshot.document?.bodySource).toContain("Visible sibling body.");
      expect(snapshot.children?.map((child) => child.name)).toEqual(["chapter"]);
    } finally {
      await service[Symbol.asyncDispose]();
      await new CommunityConfigStore().remove();
    }
  });
});

test("a fresh claim-first authority reserves and grants its first community writer", async () => {
  const authority = await WireAuthority.open(join(sandbox, "claim-first-host"), {
    handle: "garden",
    name: "Garden",
    accounts: [],
    communityHost: "garden.example",
    firstWriter: { handle: "joe" },
  });
  try {
    expect(authority.isReservedHandle("joe")).toBe(true);
    const source = await profileFolder("claim-first-joe", "person");
    const claimed = await authority.claim("joe", await snapshotDirectory(source));
    expect(claimed.tree.canonicalPath).toBe("/~joe");
    expect(authority.canWrite(claimed.account, authority.community().id)).toBe(true);
    const replacementToken = `arb_${"a".repeat(64)}`;
    authority.resetAccountToken("joe", replacementToken);
    expect(authority.accountByToken(claimed.token)).toBeNull();
    expect(authority.accountByToken(replacementToken)?.id).toBe(claimed.account.id);
    await expect(authority.claim("joe", await snapshotDirectory(source))).rejects.toThrow("already claimed");
  } finally {
    await authority[Symbol.asyncDispose]();
  }
});

test("migrates the legacy owner/slug/publication authority into the owner profile namespace", async () => {
  const dataRoot = join(sandbox, "legacy-host");
  const source = await profileFolder("legacy-content", "group");
  await writeFile(join(source, "legacy.md"), "# Legacy\n");
  const snapshot = await snapshotDirectory(source);
  await mkdir(dataRoot, { recursive: true });
  const db = new Database(join(dataRoot, "authority.sqlite3"), { create: true });
  db.run("CREATE TABLE trees (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, ref TEXT NOT NULL, publication TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE reflog (tree_id TEXT NOT NULL, ref TEXT NOT NULL, previous_ref TEXT, changed_at INTEGER NOT NULL)");
  db.run("INSERT INTO trees VALUES ('tr_legacytree', 'legacy', ?, 'public-read', ?)", [snapshot.root, Date.now()]);
  db.close();
  for (const [hash, bytes] of snapshot.objects) {
    const path = join(dataRoot, "objects", hash.slice(7, 9), hash.slice(9));
    await mkdir(join(dataRoot, "objects", hash.slice(7, 9)), { recursive: true });
    await writeFile(path, bytes);
  }
  const migrated = await serveWireHost({
    dataRoot,
    publicOrigin: "http://127.0.0.1:0",
    accounts: [{ handle: "owner", token: "migrated-owner", communityWriter: true }],
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    expect(migrated.authority.boundary("/~owner/legacy")).toMatchObject({
      id: "tr_legacytree",
      publicAccess: "read",
    });
    expect((await fetch(`${migrated.url}/~owner/legacy/legacy.md`)).status).toBe(200);
  } finally {
    migrated.server.stop(true);
    await migrated.authority[Symbol.asyncDispose]();
  }
});

test("upgrades pre-updates authority state once without changing identity, refs, access, credentials, or output", async () => {
  const dataRoot = join(sandbox, "pre-updates-host");
  const token = "pre-updates-owner-token";
  const options: Parameters<typeof serveWireHost>[0] = {
    dataRoot,
    publicOrigin: "http://127.0.0.1:0",
    accounts: [{ handle: "owner", token, communityWriter: true }],
    hostname: "127.0.0.1",
    port: 0,
  };
  const comparableTrees = (authority: WireAuthority) => authority.list().map((tree) => ({
    id: tree.id,
    canonicalPath: tree.canonicalPath,
    parentTree: tree.parentTree,
    kind: tree.kind,
    ref: tree.ref,
    publicAccess: tree.publicAccess,
  }));
  const comparableAccess = (authority: WireAuthority) => Object.fromEntries(authority.list().map((tree) => [
    tree.id,
    authority.accessEntries(tree.id),
  ]));
  const comparableHistory = (authority: WireAuthority) => Object.fromEntries(authority.list().map((tree) => [
    tree.id,
    authority.acceptedUpdates(tree.id).map((update) => ({
      root: update.root,
      previousRoot: update.previousRoot,
      kind: update.kind,
    })),
  ]));
  const profileSource = async (running: Awaited<ReturnType<typeof serveWireHost>>) => {
    const response = await fetch(`${running.url}/~owner`, { headers: { accept: "text/markdown" } });
    expect(response.status).toBe(200);
    return response.text();
  };

  const before = await serveWireHost(options);
  const beforeTrees = comparableTrees(before.authority);
  const beforeAccess = comparableAccess(before.authority);
  const beforeHistory = comparableHistory(before.authority);
  const beforeAccount = before.authority.accountByToken(token)!;
  const beforeSource = await profileSource(before);
  before.server.stop(true);
  await before.authority[Symbol.asyncDispose]();

  const old = new Database(join(dataRoot, "authority.sqlite3"));
  old.run("CREATE TABLE update_replays (legacy INTEGER)");
  old.run("DROP TABLE pairings");
  old.run("DROP TABLE devices");
  old.run("DROP TABLE accepted_updates");
  old.close();

  const upgraded = await serveWireHost(options);
  expect(comparableTrees(upgraded.authority)).toEqual(beforeTrees);
  expect(comparableAccess(upgraded.authority)).toEqual(beforeAccess);
  expect(comparableHistory(upgraded.authority)).toEqual(beforeHistory);
  expect(upgraded.authority.accountByToken(token)).toMatchObject({
    id: beforeAccount.id,
    handle: beforeAccount.handle,
    profileTree: beforeAccount.profileTree,
  });
  expect(await profileSource(upgraded)).toBe(beforeSource);
  const upgradedAccount = upgraded.authority.accountByToken(token)!;
  const firstDevices = upgraded.authority.devices(upgradedAccount);
  expect(firstDevices).toHaveLength(1);
  const firstUpdateIDs = Object.fromEntries(upgraded.authority.list().map((tree) => [
    tree.id,
    upgraded.authority.acceptedUpdates(tree.id).map((update) => update.id),
  ]));
  upgraded.server.stop(true);
  await upgraded.authority[Symbol.asyncDispose]();

  const restarted = await serveWireHost(options);
  try {
    expect(comparableTrees(restarted.authority)).toEqual(beforeTrees);
    expect(comparableAccess(restarted.authority)).toEqual(beforeAccess);
    expect(comparableHistory(restarted.authority)).toEqual(beforeHistory);
    expect(await profileSource(restarted)).toBe(beforeSource);
    const restartedAccount = restarted.authority.accountByToken(token)!;
    expect(restartedAccount.id).toBe(beforeAccount.id);
    expect(restarted.authority.devices(restartedAccount).map((device) => device.id)).toEqual(firstDevices.map((device) => device.id));
    expect(Object.fromEntries(restarted.authority.list().map((tree) => [
      tree.id,
      restarted.authority.acceptedUpdates(tree.id).map((update) => update.id),
    ]))).toEqual(firstUpdateIDs);
  } finally {
    restarted.server.stop(true);
    await restarted.authority[Symbol.asyncDispose]();
  }
});
