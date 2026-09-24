import { installAccountHome } from "../helpers/account-home.ts";
import { encodeWireDirectory } from "@overstory/protocol";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { serveArborSyncControl, serveArborSync } from "@overstory/arborsync";
import { ArborSyncRESTClient } from "@overstory/arborsync-client";
import type { Workspace } from "@overstory/arborsync";

let root: string;
let state: string;
let base: string;
let client: ArborSyncRESTClient;
let close: () => Promise<void>;
let activeWorkspace: Workspace;
let scope: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "arbor-server-"));
  state = await mkdtemp(join(tmpdir(), "arbor-server-state-"));
  process.env.ARBOR_DATA_HOME = state;
  await writeFile(join(root, "page.md"), "Hello API\n");
  await mkdir(join(root, "data"));
  const database = new Database(join(root, "data", "_store.sqlite3"));
  database.exec("create table items (id text primary key, title text not null); insert into items values ('one', 'One')");
  database.close();
  const running = await serveArborSync(root, { port: 0 });
  activeWorkspace = running.workspace;
  scope = activeWorkspace.tree;
  base = running.url;
  client = new ArborSyncRESTClient({ baseURL: base });
  close = async () => {
    running.server.stop(true);
    await running.workspace[Symbol.asyncDispose]();
  };
});

afterAll(async () => {
  await close();
  await rm(root, { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
});

describe("arborsync REST v1", () => {
  test("identifies the running Arbor Sync instance and runtime kind", async () => {
    expect(await client.status()).toMatchObject({
      service: "arborsync",
      protocolVersion: "v1",
      runtimeKind: "foreground",
      instanceID: expect.any(String),
    });
  });

  test("rejects DNS-rebound Host headers", async () => {
    const response = await fetch(`${base}/v1/status`, { headers: { host: "attacker.example" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid-request",
      message: "Arbor Sync accepts only loopback Host headers",
    });
  });

  test("offers an explicit synchronization boundary to attached clients", async () => {
    expect(await client.synchronizeNow()).toEqual({ synchronized: true });
    const invalid = await fetch(`${base}/v1/sync`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ configurationTree: "not-a-tree" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "invalid-request" });
  });

  test("no longer serves the editor path: node, mutation, and admission routes are gone", async () => {
    for (const route of [
      `/v1/node?tree=${encodeURIComponent(scope)}&path=%2Fpage`,
      `/v1/children?tree=${encodeURIComponent(scope)}&path=%2F`,
      `/v1/search?tree=${encodeURIComponent(scope)}&q=hello`,
      `/v1/file?tree=${encodeURIComponent(scope)}&path=%2Fpage.md`,
    ]) {
      const response = await fetch(`${base}${route}`);
      expect(response.status, route).toBe(405);
      expect(await response.json()).toMatchObject({ error: "unsupported-operation", retryable: false });
    }
    for (const route of ["/v1/mutations", "/v1/documents/admit", "/v1/assets", "/v1/imports"]) {
      const response = await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status, route).toBe(405);
      expect(await response.json()).toMatchObject({ error: "unsupported-operation" });
    }
  });

  test("serves the control surface without a local browsing session", async () => {
    const running = await serveArborSyncControl({ port: 0 });
    try {
      const controlClient = new ArborSyncRESTClient({ baseURL: running.url });
      expect(await controlClient.status()).toMatchObject({ runtimeKind: "persistent" });
      expect((await controlClient.trees()).snapshot).toBeArray();
      const response = await fetch(`${running.url}/v1/node?tree=system&path=%2Fdiagnostics`);
      expect(response.status).toBe(405);
    } finally {
      running.server.stop(true);
      await running.service[Symbol.asyncDispose]();
    }
  });

  test("removes the unversioned, collection, and node APIs and serves the rebuild notice at app routes", async () => {
    const legacy = await fetch(`${base}/v/tree/renamed`);
    expect(legacy.status).toBe(405);
    expect((await legacy.json() as any).error).toBe("unsupported-operation");

    const collection = await fetch(`${base}/v1/collection?tree=${encodeURIComponent(scope)}&path=%2F&stableKey=`);
    expect(collection.status).toBe(405);
    expect((await collection.json() as any).error).toBe("unsupported-operation");

    const shell = await fetch(`${base}/render/renamed`);
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-type")).toContain("text/html");
    expect(await shell.text()).toContain("Arbor web is being rebuilt (Plan B)");
  });

  test("serves ordinary-file bytes at OS-shaped logical routes with ETag, range, and ?raw", async () => {
    const bytes = new TextEncoder().encode("PNGDATA-0123456789");
    await writeFile(join(root, "photo.png"), bytes);
    await writeFile(join(root, "rawdoc.md"), "Raw surface\n");

    const direct = await fetch(`${base}${root}/photo.png`);
    expect(direct.status).toBe(200);
    expect(direct.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await direct.arrayBuffer())).toEqual(bytes);
    const etag = direct.headers.get("etag")!;
    expect(etag).toMatch(/^".+"$/);

    const conditional = await fetch(`${base}${root}/photo.png`, { headers: { "if-none-match": etag } });
    expect(conditional.status).toBe(304);

    const range = await fetch(`${base}${root}/photo.png`, { headers: { range: "bytes=3-6" } });
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(`bytes 3-6/${bytes.byteLength}`);
    expect(await range.text()).toBe("DATA");

    // The /render spelling serves the same bytes so authored relative
    // references keep resolving under the app's route prefix.
    const prefixed = await fetch(`${base}/render${root}/photo.png`);
    expect(prefixed.status).toBe(200);
    expect(prefixed.headers.get("etag")).toBe(etag);

    // Document-shaped routes stay on the browsing surface unless ?raw.
    const app = await fetch(`${base}/render${root}/rawdoc`);
    expect(app.headers.get("content-type")).toContain("text/html");
    const raw = await fetch(`${base}${root}/rawdoc?raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toContain("text/markdown");
    expect(await raw.text()).toContain("Raw surface");
  });

});

describe("arborsync object route", () => {
  const validHash = (hex: string) => `sha256:${hex.repeat(64 / hex.length)}`;

  async function indexedSnapshot() {
    const { resolveSnapshot, snapshotDirectory } = await import("@overstory/fs");
    const { hashObject, decodeWireDirectory } = await import("@overstory/protocol");
    const snapshot = await resolveSnapshot(await snapshotDirectory(root, new Map(), [], undefined, activeWorkspace.objectIndex()));
    return { snapshot, hashObject, decodeWireDirectory };
  }

  test("serves a file object from the index with an immutable ETag", async () => {
    const bytes = new TextEncoder().encode("object-route-file-bytes");
    await writeFile(join(root, "object-route.bin"), bytes);
    const { snapshot, hashObject } = await indexedSnapshot();
    const hash = hashObject(bytes);
    expect(snapshot.objects.has(hash)).toBe(true);

    const response = await fetch(`${base}/v1/objects/${encodeURIComponent(hash)}?tree=${encodeURIComponent(scope)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("etag")).toBe(`"${hash}"`);
    expect(response.headers.get("cache-control")).toBe("private, immutable, max-age=31536000");
    const served = new Uint8Array(await response.arrayBuffer());
    expect(hashObject(served)).toBe(hash);
    expect(await client.object(scope, hash)).toEqual(served);
  });

  test("serves a directory object re-encoded from its children rows", async () => {
    await mkdir(join(root, "object-dir"), { recursive: true });
    await writeFile(join(root, "object-dir", "leaf.md"), "leaf\n");
    await writeFile(join(root, "object-dir", "leaf.bin"), "binary-leaf");
    const { snapshot, hashObject, decodeWireDirectory } = await indexedSnapshot();
    const rootObject = decodeWireDirectory(snapshot.objects.get(snapshot.root)!);
    if (rootObject.type !== "directory") throw new Error("Expected a directory");
    const directoryHash = rootObject.entries.find((entry) => entry.name === "object-dir")!.directory!;
    for (const hash of [directoryHash, snapshot.root]) {
      const served = await client.object(scope, hash);
      expect(hashObject(served)).toBe(hash);
      expect(decodeWireDirectory(served).type).toBe("directory");
    }
  });

  test("serves objects held only by the stored pending update body", async () => {
    const { hashObject } = await import("@overstory/protocol");
    const { pendingFromSnapshot, savePendingTreeUpdate, clearPendingTreeUpdate } = await import("@overstory/client");
    const bytes = new TextEncoder().encode("pending-only-object");
    const hash = hashObject(bytes);
    await savePendingTreeUpdate(scope, pendingFromSnapshot(null, { root: hash, objects: new Map([[hash, bytes]]) }));
    try {
      expect(await client.object(scope, hash)).toEqual(bytes);
    } finally {
      await clearPendingTreeUpdate(scope);
    }
    const gone = await fetch(`${base}/v1/objects/${encodeURIComponent(hash)}?tree=${encodeURIComponent(scope)}`);
    expect(gone.status).toBe(404);
  });

  test("fetches through to Canopy for an unplaced tree named by origin", async () => {
    const { serveCanopy } = await import("@overstory/canopyd");
    const { WireClient, hashObject } = await import("@overstory/protocol");
    const { resolveSnapshot, snapshotDirectory } = await import("@overstory/fs");
    const canopyRoot = await mkdtemp(join(tmpdir(), "arbor-object-canopy-"));
    const token = "object-route-owner";
    const canopy = await serveCanopy({
      dataRoot: join(canopyRoot, "canopy"),
      accounts: [{ handle: "owner", token, communityWriter: true }],
      publicOrigin: "http://127.0.0.1:0",
      hostname: "127.0.0.1",
      port: 0,
    });
    try {
      const owner = new WireClient(canopy.url, token);
      const account = await owner.account();
      const communityTree = account.account.community.id;
      const community = await owner.descriptor(communityTree);
      const source = join(canopyRoot, "community");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "_index.md"), "---\ntype: group\n---\n# Community\n");
      const remoteOnly = new TextEncoder().encode("only-on-canopy");
      await writeFile(join(source, "remote-only.bin"), remoteOnly);
      const boundaries = new Map([[join(source, "~owner"), account.account.profileTree!]]);
      await owner.submitUpdate(communityTree, community.tree.update, await resolveSnapshot(await snapshotDirectory(source, boundaries)));
      // The local copy is gone; the daemon has no placement for this tree.
      await rm(join(source, "remote-only.bin"));
      const hash = hashObject(remoteOnly);

      const served = await client.object(communityTree, hash, canopy.url);
      expect(hashObject(served)).toBe(hash);
      const response = await fetch(`${base}/v1/objects/${encodeURIComponent(hash)}?tree=${encodeURIComponent(communityTree)}&origin=${encodeURIComponent(canopy.url)}`);
      expect(response.headers.get("etag")).toBe(`"${hash}"`);

      // Fetched bytes are retained by hash, so a repeat needs no origin.
      expect(await client.object(communityTree, hash)).toEqual(served);
      const unknown = await fetch(`${base}/v1/objects/${validHash("1e")}?tree=${encodeURIComponent(communityTree)}&origin=${encodeURIComponent(canopy.url)}`);
      expect(unknown.status).toBe(404);
    } finally {
      canopy.server.stop(true);
      await canopy.canopy[Symbol.asyncDispose]();
      await rm(canopyRoot, { recursive: true, force: true });
    }
  });

  test("answers 404 for unavailable objects and 400 for malformed hashes", async () => {
    const missing = await fetch(`${base}/v1/objects/${validHash("0f")}?tree=${encodeURIComponent(scope)}`);
    expect(missing.status).toBe(404);
    expect((await missing.json() as any).error).toBe("not-found");

    const malformed = await fetch(`${base}/v1/objects/sha256:nothex?tree=${encodeURIComponent(scope)}`);
    expect(malformed.status).toBe(400);
    expect((await malformed.json() as any).error).toBe("invalid-request");

    const unscoped = await fetch(`${base}/v1/objects/${validHash("0f")}`);
    expect(unscoped.status).toBe(400);
  });
});

describe("arborsync bootstrap and credential routes", () => {
  const token = "bootstrap-route-owner";
  let sandbox: string;
  let home: string;
  let previousHome: string | undefined;
  let treeDir: string;
  let tree: string;
  let canopy: Awaited<ReturnType<typeof import("@overstory/canopyd")["serveCanopy"]>>;
  let daemon: Awaited<ReturnType<typeof serveArborSync>>;
  let placedClient: ArborSyncRESTClient;
  let placedBase: string;

  beforeAll(async () => {
    const { serveCanopy } = await import("@overstory/canopyd");
    const { WireClient } = await import("@overstory/protocol");
    const { resolveSnapshot, snapshotDirectory } = await import("@overstory/fs");
    const { generateArborID } = await import("@overstory/protocol");
    const { readAccountConfigGraphV2, snapshotAccountConfigV2 } = await import("../../packages/canopyd/src/account-policy-v2.ts");

    sandbox = await mkdtemp(join(tmpdir(), "arbor-bootstrap-route-"));
    home = join(sandbox, "home");
    treeDir = join(sandbox, "tree");
    await mkdir(home, { recursive: true });
    await mkdir(join(treeDir, "sub"), { recursive: true });
    await writeFile(join(treeDir, "_index.md"), "# Bootstrap tree\n");
    await writeFile(join(treeDir, "note.md"), "A note\n");
    await writeFile(join(treeDir, "photo.bin"), new Uint8Array([1, 2, 3, 4, 5]));
    await writeFile(join(treeDir, "sub", "child.md"), "Child\n");
    await writeFile(join(treeDir, "sub", "data.bin"), new Uint8Array([9, 8, 7]));

    canopy = await serveCanopy({
      dataRoot: join(sandbox, "canopy"),
      accounts: [{ handle: "owner", token, communityWriter: true }],
      publicOrigin: "http://127.0.0.1:0",
      hostname: "127.0.0.1",
      port: 0,
    });
    const owner = new WireClient(canopy.url, token);
    const account = await owner.account();
    const configurationTree = account.account.configuration.id;
    const configuration = await owner.descriptor(configurationTree);
    const configurationSnapshot = await owner.snapshot(configurationTree, configuration.tree.root);
    const graph = readAccountConfigGraphV2({ root: configurationSnapshot.root, objects: configurationSnapshot.objects }, configurationTree);
    const device = Object.values(graph.devices).find(device => device.administrator)!.id;
    tree = generateArborID("tr");
    await owner.submitUpdate(configurationTree, configuration.tree.update, snapshotAccountConfigV2({
      account: graph.account,
      resources: { ...graph.resources, [tree]: { canonical: `${canopy.url}/~owner/bootstrap`, access: [] } },
      devices: graph.devices,
    }));
    await owner.submitUpdate(tree, null, await resolveSnapshot(await snapshotDirectory(treeDir)));

    previousHome = process.env.ARBOR_DATA_HOME;
    await installAccountHome(home, owner, device, token, { [treeDir]: tree });
    // A long fallback interval keeps the daemon from racing the stored-state tests below.
    daemon = await serveArborSync(treeDir, { port: 0, syncIntervalMs: 60_000 });
    placedBase = daemon.url;
    placedClient = new ArborSyncRESTClient({ baseURL: placedBase, retryDelay: async () => {} });
    await placedClient.synchronizeNow();
    const descriptor = (await placedClient.trees()).snapshot.find((item) => item.id === tree);
    if (!descriptor?.root || !descriptor.update) throw new Error("Placed tree did not record its accepted base");
  });

  afterAll(async () => {
    daemon.server.stop(true);
    await daemon.service[Symbol.asyncDispose]();
    canopy.server.stop(true);
    await canopy.canopy[Symbol.asyncDispose]();
    if (previousHome === undefined) delete process.env.ARBOR_DATA_HOME;
    else process.env.ARBOR_DATA_HOME = previousHome;
    await rm(sandbox, { recursive: true, force: true });
  });

  async function folderSnapshot() {
    const { resolveSnapshot, snapshotDirectory } = await import("@overstory/fs");
    return resolveSnapshot(await snapshotDirectory(treeDir));
  }

  test("bootstraps a clean placed tree with a sparse spine", async () => {
    const { decodeSparseSnapshotBundle, decodeWireDirectory, hashObject } = await import("@overstory/protocol");
    const bootstrap = await placedClient.bootstrap(tree);
    // Page dates come from Canopy's entry metadata, never from the daemon's files.
    expect("modifiedAtByPath" in bootstrap).toBe(false);
    const descriptor = (await placedClient.trees()).snapshot.find((item) => item.id === tree)!;
    expect(bootstrap.tree.id).toBe(tree);
    expect("sync" in bootstrap.tree).toBe(false);
    expect("root" in bootstrap.tree).toBe(false);
    expect("update" in bootstrap.tree).toBe(false);
    expect("conflicted" in bootstrap.tree).toBe(false);
    expect("reviewableConflict" in bootstrap.tree).toBe(false);
    expect(bootstrap.accepted).toEqual({ root: descriptor.root!, update: descriptor.update!, cursor: descriptor.update! });
    expect(typeof bootstrap.observedThrough).toBe("string");

    const spine = decodeSparseSnapshotBundle(Buffer.from(bootstrap.spine, "base64"));
    expect(spine.has(bootstrap.accepted.root as never)).toBe(true);
    const directories = [decodeWireDirectory(spine.get(bootstrap.accepted.root)!)];
    for (const entry of directories[0]!.entries) if (entry.directory) directories.push(decodeWireDirectory(spine.get(entry.directory)!));
    expect(directories).toHaveLength(2);
    const markdown = directories.flatMap(directory => directory.entries.filter(entry => entry.file && entry.name.endsWith(".md")).map(entry => new TextDecoder().decode(spine.get(entry.file!)!))).sort();
    expect(markdown).toEqual(["# Bootstrap tree\n", "A note\n", "Child\n"]);
    expect("files" in bootstrap).toBe(false);
    // Typed file entries are resolvable even when their payload is omitted.
    const photoHash = hashObject(new Uint8Array([1, 2, 3, 4, 5]));
    expect(spine.has(photoHash)).toBe(false);
    const root = decodeWireDirectory(spine.get(bootstrap.accepted.root as never)!);
    if (root.type !== "directory") throw new Error("Expected a directory root");
    expect(root.entries.find((entry) => entry.name === "photo.bin")?.file).toBe(photoHash);
    expect(hashObject(await placedClient.object(tree, photoHash))).toBe(photoHash);
  });

  test("bootstraps the accepted Canopy root while the folder has a pending edit", async () => {
    const { pendingFromSnapshot, savePendingTreeUpdate, clearPendingTreeUpdate } = await import("@overstory/client");
    const { decodeSparseSnapshotBundle, decodeWireDirectory } = await import("@overstory/protocol");
    const accepted = (await placedClient.bootstrap(tree)).accepted;
    await writeFile(join(treeDir, "note.md"), "Daemon-only pending edit\n");
    await savePendingTreeUpdate(tree, pendingFromSnapshot(accepted.update, await folderSnapshot()));
    try {
      const bootstrap = await placedClient.bootstrap(tree);
      expect(bootstrap.accepted).toEqual(accepted);
      expect("pending" in bootstrap).toBe(false);
      expect("blocked" in bootstrap).toBe(false);
      const spine = decodeSparseSnapshotBundle(Buffer.from(bootstrap.spine, "base64"));
      const root = decodeWireDirectory(spine.get(accepted.root as never)!);
      const note = root.entries.find((entry) => entry.name === "note.md")?.file;
      expect(new TextDecoder().decode(spine.get(note!)!)).toBe("A note\n");
    } finally {
      await writeFile(join(treeDir, "note.md"), "A note\n");
      await clearPendingTreeUpdate(tree);
    }
  });

  test("daemon conflict state does not block an accepted-root bootstrap", async () => {
    const { saveTreeConflict, clearTreeConflict } = await import("@overstory/client");
    const { decodeSparseSnapshotBundle } = await import("@overstory/protocol");
    const accepted = (await placedClient.bootstrap(tree)).accepted;
    await saveTreeConflict(tree, {
      error: "conflict",
      message: "fixture conflict",
      retryable: false,
      tree,
      details: {
        kind: "server-update",
        completed: [],
        failedIndex: 0,
        current: { id: accepted.update, tree, root: accepted.root as never, previous: null, conflicted: false, acceptedAt: 0, subject: null },
        base: accepted.root as never,
        candidate: accepted.root as never,
        draft: { root: accepted.root as never, objects: [], deltas: [] },
        conflicts: [],
      },
    });
    try {
      const bootstrap = await placedClient.bootstrap(tree);
      expect(bootstrap.accepted).toEqual(accepted);
      expect("blocked" in bootstrap).toBe(false);
      expect(decodeSparseSnapshotBundle(Buffer.from(bootstrap.spine, "base64")).size).toBe(5);
      expect("files" in bootstrap).toBe(false);
    } finally {
      await clearTreeConflict(tree);
    }
  });

  test("stale daemon pending state does not block an accepted-root bootstrap", async () => {
    const { pendingFromSnapshot, savePendingTreeUpdate, clearPendingTreeUpdate } = await import("@overstory/client");
    const { hashObject } = await import("@overstory/protocol");
    const snapshot = await folderSnapshot();
    const accepted = (await placedClient.bootstrap(tree)).accepted;
    // Stale base: the chain no longer starts at the accepted update.
    await savePendingTreeUpdate(tree, pendingFromSnapshot("stale-update", snapshot));
    try {
      const bootstrap = await placedClient.bootstrap(tree);
      expect(bootstrap.accepted).toEqual(accepted);
      expect("blocked" in bootstrap).toBe(false);
    } finally {
      await clearPendingTreeUpdate(tree);
    }
    // Right base, but the last candidate is not the folder root.
    const bytes = encodeWireDirectory({ type: "directory", entries: [] });
    await savePendingTreeUpdate(tree, pendingFromSnapshot(accepted.update, { root: hashObject(bytes), objects: new Map([[hashObject(bytes), bytes]]) }));
    try {
      const bootstrap = await placedClient.bootstrap(tree);
      expect(bootstrap.accepted).toEqual(accepted);
      expect("blocked" in bootstrap).toBe(false);
    } finally {
      await clearPendingTreeUpdate(tree);
    }
  });

  test("answers 404 for an unplaced tree and 400 without tree scope", async () => {
    const missing = await fetch(`${placedBase}/v1/bootstrap?tree=tr_${"b".repeat(26)}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "not-found" });
    const unscoped = await fetch(`${placedBase}/v1/bootstrap`);
    expect(unscoped.status).toBe(400);
    expect(await placedClient.bootstrap(scope).catch((error) => error.status)).toBe(404);
  });

  test("serves the shared account credential over loopback and 404s when absent", async () => {
    expect(await placedClient.credential()).toEqual({ token });
    const absent = await fetch(`${placedBase}/v1/credential?configurationTree=tr_${"c".repeat(26)}`);
    expect(absent.status).toBe(404);
    expect(await absent.json()).toMatchObject({ error: "not-found" });
    const malformed = await fetch(`${placedBase}/v1/credential?configurationTree=nope`);
    expect(malformed.status).toBe(400);
  });
});
