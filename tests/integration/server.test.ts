import { installAccountHome } from "../helpers/account-home.ts";
import { decodeCanonicalCBOR, encodeProtocolDirectory, ensureStorySyncAccess, ProtocolClient, readStorySyncAccess, storySyncAuthorization } from "@ovst/protocol";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { serveStorySyncControl, serveStorySync } from "@ovst/story-sync";
import { StorySyncRESTClient } from "../../packages/cli/src/daemon-client.ts";
import type { Workspace } from "@ovst/story-sync";
import { deviceClient, testAccount, testDevice } from "../helpers/devices.ts";
import { storySyncFetch } from "../helpers/story-sync-fetch.ts";

let root: string;
let state: string;
let base: string;
let client: StorySyncRESTClient;
let close: () => Promise<void>;
let activeWorkspace: Workspace;
let scope: string;

/** Every request here comes from the data home's own user. */
const fetch = (input: string, init?: RequestInit) => storySyncFetch(input, init);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "story-server-"));
  state = await mkdtemp(join(tmpdir(), "story-server-state-"));
  process.env.STORY_HOME = state;
  await writeFile(join(root, "page.md"), "Hello API\n");
  await mkdir(join(root, "data"));
  const database = new Database(join(root, "data", "_store.sqlite3"));
  database.exec("create table items (id text primary key, title text not null); insert into items values ('one', 'One')");
  database.close();
  const running = await serveStorySync(root, { port: 0 });
  activeWorkspace = running.workspace;
  scope = activeWorkspace.tree;
  base = running.url;
  client = new StorySyncRESTClient({ baseURL: base });
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

describe("story-sync REST v1", () => {
  test("identifies the running Story Sync instance and runtime kind", async () => {
    expect(await client.status()).toMatchObject({
      service: "story-sync",
      protocolVersion: "v1",
      runtimeKind: "foreground",
      instanceID: expect.any(String),
    });
  });

  test("answers only callers holding the data home's token, showing a browser nothing but the notice", async () => {
    await writeFile(join(root, "secret.md"), "Private\n");
    const bare = await globalThis.fetch(`${base}/v1/status`);
    expect(bare.status).toBe(401);
    expect(await bare.json()).toMatchObject({ error: "unauthenticated" });
    const other = await mkdtemp(join(tmpdir(), "story-server-other-home-"));
    try {
      const stranger = await ensureStorySyncAccess(other);
      for (const route of ["/v1/status", "/v1/trees", "/v1/accounts", "/v1/credential"]) {
        const response = await globalThis.fetch(`${base}${route}`, { headers: { authorization: storySyncAuthorization(stranger) } });
        expect(response.status, route).toBe(401);
      }
    } finally {
      await rm(other, { recursive: true, force: true });
    }
    const file = await globalThis.fetch(`${base}${root}/secret.md?raw`);
    expect(file.status).toBe(200);
    expect(await file.text()).toContain("Story web is being rebuilt");
    expect(await (await fetch(`${base}${root}/secret.md?raw`)).text()).toBe("Private\n");
    const status = await fetch(`${base}/v1/status`);
    expect(await status.json()).toMatchObject({ access: "token" });
    expect((await readStorySyncAccess())?.origin).toBe(base);
  });

  test("rejects DNS-rebound Host headers", async () => {
    const response = await fetch(`${base}/v1/status`, { headers: { host: "attacker.example" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid-request",
      message: "Story Sync accepts only loopback Host headers",
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
    const running = await serveStorySyncControl({ port: 0 });
    try {
      const controlClient = new StorySyncRESTClient({ baseURL: running.url });
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
    expect(await shell.text()).toContain("Story web is being rebuilt (Plan B)");
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

  // Security 002: a URL path is decoded once, where the request arrives.
  test("lists and serves a file whose name contains a percent sign", async () => {
    const bytes = new TextEncoder().encode("PERCENT-PNG");
    await writeFile(join(root, "Q3 100%.png"), bytes);
    await writeFile(join(root, "Q3 100%.md"), "Percent page\n");
    await writeFile(join(root, "a%2Fb.md"), "One file, one segment\n");

    const page = await activeWorkspace.nodes.children({ tree: scope, path: "/", stableKey: null });
    const listed = page.items.map((child) => child.ref.path);
    expect(listed).toContain("/Q3 100%.png");
    expect(listed).toContain("/Q3 100%");
    expect(listed).toContain("/a%2Fb");

    const served = await fetch(`${base}${root}/Q3%20100%25.png`);
    expect(served.status).toBe(200);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
    const literal = await fetch(`${base}${root}/a%252Fb?raw`);
    expect(literal.status).toBe(200);
    expect(await literal.text()).toContain("One file, one segment");
  });

  test("refuses an encoded traversal and a malformed encoding at the file route", async () => {
    // `%2e%2e%2f` is one URL segment, so no client or URL parser collapses it first.
    for (const path of [`${root}/%2e%2e%2fsecret.png`, `/render${root}/sub/%2e%2e%2f%2e%2e%2fsecret`, `${root}/bad%zz.png`]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(400);
      expect(await response.json(), path).toMatchObject({ error: "invalid-request" });
    }
    // A malformed or unsafe Referer names no scope; it is not an error.
    const referred = await fetch(`${base}/missing.png`, { headers: { referer: "not a url" } });
    expect(referred.status).toBe(200);
    expect(referred.headers.get("content-type")).toContain("text/html");
  });

});

describe("story-sync object route", () => {
  const validHash = (hex: string) => `sha256:${hex.repeat(64 / hex.length)}`;

  async function indexedSnapshot() {
    const { resolveSnapshot, snapshotDirectory } = await import("@ovst/fs");
    const { hashObject, decodeProtocolDirectory } = await import("@ovst/protocol");
    const snapshot = await resolveSnapshot(await snapshotDirectory(root, new Map(), [], undefined, activeWorkspace.objectIndex()));
    return { snapshot, hashObject, decodeProtocolDirectory };
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
    const { snapshot, hashObject, decodeProtocolDirectory } = await indexedSnapshot();
    const rootObject = decodeProtocolDirectory(snapshot.objects.get(snapshot.root)!);
    if (rootObject.type !== "directory") throw new Error("Expected a directory");
    const directoryHash = rootObject.entries.find((entry) => entry.name === "object-dir")!.directory!;
    for (const hash of [directoryHash, snapshot.root]) {
      const served = await client.object(scope, hash);
      expect(hashObject(served)).toBe(hash);
      expect(decodeProtocolDirectory(served).type).toBe("directory");
    }
  });

  test("serves objects held only by a pending local change", async () => {
    const { hashObject, encodeCandidateUpdateJSON } = await import("@ovst/protocol");
    const { snapshotJSON } = await import("@ovst/working-tree");
    const { ChangeLog } = await import("@ovst/working-tree/node");
    const { folderStateRoot } = await import("../../packages/story-sync/src/folder-sync.ts");
    const bytes = new TextEncoder().encode("pending-only-object");
    const hash = hashObject(bytes);
    const empty = encodeProtocolDirectory({ type: "directory", entries: [] }), emptyHash = hashObject(empty);
    const directory = encodeProtocolDirectory({ type: "directory", entries: [{ name: "pending.bin", file: hash }] }), directoryHash = hashObject(directory);
    const change = "folder-pending-object";
    const log = new ChangeLog(scope, folderStateRoot(scope));
    await log.retain({ change, tree: scope, basis: { kind: "accepted", root: emptyHash, update: "up_pending_fixture" },
      graph: snapshotJSON({ root: emptyHash, objects: new Map([[emptyHash, empty]]) }), sourcePath: null, document: null,
      candidate: snapshotJSON({ root: directoryHash, objects: new Map([[directoryHash, directory], [hash, bytes]]) }),
      update: encodeCandidateUpdateJSON({ change, candidate: directoryHash, trace: null, resolves: [], deltas: [],
        objects: [{ hash: directoryHash, bytes: directory }, { hash, bytes }].sort((a, b) => a.hash.localeCompare(b.hash)) }) });
    try {
      expect(await client.object(scope, hash)).toEqual(bytes);
    } finally {
      await log.discard(new Set([change]));
    }
    const gone = await fetch(`${base}/v1/objects/${encodeURIComponent(hash)}?tree=${encodeURIComponent(scope)}`);
    expect(gone.status).toBe(404);
  });

  test("serves no objects for a tree it has not placed, whatever origin is named", async () => {
    const hash = validHash("2f");
    const response = await fetch(`${base}/v1/objects/${encodeURIComponent(hash)}?tree=tr_unplaced&origin=${encodeURIComponent("http://127.0.0.1:9")}`);
    expect(response.status).toBe(404);
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

describe("story-sync bootstrap and credential routes", () => {
  const token = "bootstrap-route-owner";
  let sandbox: string;
  let home: string;
  let previousHome: string | undefined;
  let treeDir: string;
  let tree: string;
  let overstoryd: Awaited<ReturnType<typeof import("@ovst/overstoryd")["serveHost"]>>;
  let daemon: Awaited<ReturnType<typeof serveStorySync>>;
  let placedClient: StorySyncRESTClient;
  let placedBase: string;

  beforeAll(async () => {
    const { serveHost } = await import("@ovst/overstoryd");
    const { resolveSnapshot, snapshotDirectory } = await import("@ovst/fs");
    const { hostTree, readTreeConfig } = await import("../helpers/tree-config.ts");

    sandbox = await mkdtemp(join(tmpdir(), "story-bootstrap-route-"));
    home = join(sandbox, "home");
    treeDir = join(sandbox, "tree");
    await mkdir(home, { recursive: true });
    await mkdir(join(treeDir, "sub"), { recursive: true });
    await writeFile(join(treeDir, "_index.md"), "# Bootstrap tree\n");
    await writeFile(join(treeDir, "note.md"), "A note\n");
    await writeFile(join(treeDir, "photo.bin"), new Uint8Array([1, 2, 3, 4, 5]));
    await writeFile(join(treeDir, "sub", "child.md"), "Child\n");
    await writeFile(join(treeDir, "sub", "data.bin"), new Uint8Array([9, 8, 7]));

    overstoryd = await serveHost({
      dataRoot: join(sandbox, "overstoryd"),
      accounts: [testAccount("owner", token, { communityWriter: true })],
      publicOrigin: "http://127.0.0.1:0",
      hostname: "127.0.0.1",
      port: 0,
    });
    const owner = await deviceClient(overstoryd.url, token);
    const account = await owner.account();
    const profile = account.account.profileTree!;
    const device = Object.values((await readTreeConfig(owner, profile, "person")).values.devices!).find(device => device.administrator)!.id;
    tree = await hostTree(owner, await resolveSnapshot(await snapshotDirectory(treeDir)), { parent: { tree: profile, name: "bootstrap", kind: "person" } });

    previousHome = process.env.STORY_HOME;
    await installAccountHome(home, owner, device, testDevice(token).seed, { [treeDir]: tree });
    // A long fallback interval keeps the daemon from racing the stored-state tests below.
    daemon = await serveStorySync(treeDir, { port: 0, syncIntervalMs: 60_000 });
    placedBase = daemon.url;
    placedClient = new StorySyncRESTClient({ baseURL: placedBase });
    await placedClient.synchronizeNow();
    const descriptor = (await placedClient.trees()).snapshot.find((item) => item.id === tree);
    if (!descriptor?.root || !descriptor.update) throw new Error("Placed tree did not record its accepted base");
  });

  afterAll(async () => {
    daemon.server.stop(true);
    await daemon.service[Symbol.asyncDispose]();
    overstoryd.server.stop(true);
    await overstoryd.overstoryd[Symbol.asyncDispose]();
    if (previousHome === undefined) delete process.env.STORY_HOME;
    else process.env.STORY_HOME = previousHome;
    await rm(sandbox, { recursive: true, force: true });
  });

  test("resolves a raw tree locator", async () => {
    const current = await placedClient.resolve(`overstory://tree/${tree}/note`);
    expect(current.ref).toMatchObject({ tree, path: "/note" });
  });

  test("bootstraps a clean placed tree with a sparse spine", async () => {
    const { decodeSparseSnapshotBundle, decodeProtocolDirectory, hashObject } = await import("@ovst/protocol");
    const bootstrap = await placedClient.bootstrap(tree);
    // Page dates come from the host's entry metadata, never from the daemon's files.
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

    const spine = decodeSparseSnapshotBundle(bootstrap.spine);
    expect(spine.has(bootstrap.accepted.root as never)).toBe(true);
    const directories = [decodeProtocolDirectory(spine.get(bootstrap.accepted.root)!)];
    for (const entry of directories[0]!.entries) if (entry.directory) directories.push(decodeProtocolDirectory(spine.get(entry.directory)!));
    expect(directories).toHaveLength(2);
    const markdown = directories.flatMap(directory => directory.entries.filter(entry => entry.file && entry.name.endsWith(".md")).map(entry => new TextDecoder().decode(spine.get(entry.file!)!))).sort();
    expect(markdown).toEqual(["# Bootstrap tree\n", "A note\n", "Child\n"]);
    expect("files" in bootstrap).toBe(false);
    // Typed file entries are resolvable even when their payload is omitted.
    const photoHash = hashObject(new Uint8Array([1, 2, 3, 4, 5]));
    expect(spine.has(photoHash)).toBe(false);
    const root = decodeProtocolDirectory(spine.get(bootstrap.accepted.root as never)!);
    if (root.type !== "directory") throw new Error("Expected a directory root");
    expect(root.entries.find((entry) => entry.name === "photo.bin")?.file).toBe(photoHash);
    expect(hashObject(await placedClient.object(tree, photoHash))).toBe(photoHash);
  });

  test("bootstraps the accepted host root while the folder has an unpublished edit", async () => {
    const { decodeSparseSnapshotBundle, decodeProtocolDirectory } = await import("@ovst/protocol");
    const accepted = (await placedClient.bootstrap(tree)).accepted;
    await writeFile(join(treeDir, "note.md"), "Daemon-only pending edit\n");
    try {
      const bootstrap = await placedClient.bootstrap(tree);
      expect(bootstrap.accepted).toEqual(accepted);
      expect("pending" in bootstrap).toBe(false);
      expect("blocked" in bootstrap).toBe(false);
      const spine = decodeSparseSnapshotBundle(bootstrap.spine);
      const root = decodeProtocolDirectory(spine.get(accepted.root as never)!);
      const note = root.entries.find((entry) => entry.name === "note.md")?.file;
      expect(new TextDecoder().decode(spine.get(note!)!)).toBe("A note\n");
    } finally {
      await writeFile(join(treeDir, "note.md"), "A note\n");
    }
  });

  test("answers CBOR only, even to a caller that does not ask for it", async () => {
    const plain = await fetch(`${placedBase}/v1/bootstrap?tree=${tree}`);
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-type")).toBe("application/cbor");
    const value = decodeCanonicalCBOR(new Uint8Array(await plain.arrayBuffer())) as { spine?: unknown };
    expect(value.spine).toBeInstanceOf(Uint8Array);
  });

  test("answers 404 for an unplaced tree and 400 without tree scope", async () => {
    const missing = await fetch(`${placedBase}/v1/bootstrap?tree=tr_${"b".repeat(26)}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: "not-found" });
    const unscoped = await fetch(`${placedBase}/v1/bootstrap`);
    expect(unscoped.status).toBe(400);
    expect(await placedClient.bootstrap(scope).catch((error) => error.status)).toBe(404);
  });

  test("serves a session its device key opened over loopback, never the key, and 404s when absent", async () => {
    const { token: session } = await placedClient.credential();
    expect(session).toStartWith("ars_");
    expect(session).not.toBe(testDevice(token).seed);
    expect((await new ProtocolClient(overstoryd.url, session).account()).account.device?.id).toBe(testDevice(token).device);
    const absent = await fetch(`${placedBase}/v1/credential?configurationTree=tr_${"c".repeat(26)}`);
    expect(absent.status).toBe(404);
    expect(await absent.json()).toMatchObject({ error: "not-found" });
    const malformed = await fetch(`${placedBase}/v1/credential?configurationTree=nope`);
    expect(malformed.status).toBe(400);
  });
});
