import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildNetworkLocator, canonicalStableKey, generateArborID, pageIDStableKey, rowPathSegment, sha256 } from "@arbor/core";
import { serveCanopy } from "@arbor/canopy";
import { ProjectionProviderHost } from "@arbor/stores";
import { WireClient, applyTransitionPayload, WireUpdateConflict } from "@arbor/wire";
import {
  readAccountConfigGraph,
  snapshotAccountConfig,
} from "../../../packages/canopy/src/account-policy.ts";
import { snapshotDirectory } from "@arbor/fs";

const token = "owner-test-credential";
let dataRoot: string;
let running: Awaited<ReturnType<typeof serveCanopy>>;
let client: WireClient;

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "arbor-canopy-"));
  running = await serveCanopy({
    dataRoot,
    accounts: [{ handle: "owner", token, communityWriter: true }],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
  client = new WireClient(running.url, token);
});

afterAll(async () => {
  running.server.stop(true);
  await running.canopy[Symbol.asyncDispose]();
  await rm(dataRoot, { recursive: true, force: true });
});

async function currentConfig() {
  const account = await client.account();
  const current = await client.descriptor(account.account.configuration.id);
  const snapshot = await client.snapshot(current.tree.id, current.tree.root);
  const graph = readAccountConfigGraph({
    root: snapshot.root,
    objects: snapshot.objects,
  }, account.account.configuration.id);
  return { account, current, snapshot, graph };
}

async function submitConfiguration(
  current: Awaited<ReturnType<typeof currentConfig>>["current"],
  graph: Omit<ReturnType<typeof readAccountConfigGraph>, "sources">,
) {
  const snapshot = snapshotAccountConfig(graph);
  return client.submitUpdate(
    current.tree.id,
    current.tree.update,
    snapshot,
  );
}

async function readWatchFrames(url: string, count: number) {
  const abort = new AbortController();
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: abort.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  let source = "";
  while (source.split("\n\n").length <= count) {
    const chunk = await reader.read();
    if (chunk.done) break;
    source += new TextDecoder().decode(chunk.value, { stream: true });
  }
  abort.abort();
  return source.split("\n\n").slice(0, count).map((frame) => {
    const lines = frame.split("\n");
    const field = (name: string) => lines.filter((line) => line.startsWith(`${name}: `)).map((line) => line.slice(name.length + 2));
    return {
      id: field("id")[0],
      event: field("event")[0],
      data: JSON.parse(field("data").join("\n")) as { cursor: string; change: { transitions?: Array<{ update: { id: string } }> } & Record<string, unknown> },
    };
  });
}

async function snapshotWithCollectionFiles(path: string) {
  const stores = new ProjectionProviderHost();
  try {
    return await snapshotDirectory(path, new Map(), [], (directory, sourceName) =>
      stores.collectionFileDescriptor(directory, sourceName));
  } finally {
    await stores[Symbol.asyncDispose]();
  }
}

describe("governed account-configuration Canopy server", () => {
  test("accepts an append-only update string and trims an older prefix replay", async () => {
    const baseline = await currentConfig();
    const administrator = baseline.graph.account.admins[0]!;
    const graphOne = {
      account: baseline.graph.account,
      trees: baseline.graph.trees,
      devices: {
        ...baseline.graph.devices,
        [administrator]: { ...baseline.graph.devices[administrator]!, label: `Cumulative one ${crypto.randomUUID()}` },
      },
    };
    const graphTwo = {
      ...graphOne,
      devices: {
        ...graphOne.devices,
        [administrator]: { ...graphOne.devices[administrator]!, label: `Cumulative two ${crypto.randomUUID()}` },
      },
    };
    const snapshots = [snapshotAccountConfig(graphOne), snapshotAccountConfig(graphTwo)];
    const updates = snapshots.map((snapshot) => ({
      candidate: snapshot.root,
      ifMatch: "modelHash" as const,
      objects: [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })),
      deltas: [],
    }));
    const before = running.canopy.acceptedUpdates(baseline.current.tree.id).length;
    const response = await client.submitUpdates(baseline.current.tree.id, {
      base: baseline.current.tree.update,
      updates,
    });
    expect(response.results.map(({ outcome }) => outcome)).toEqual(["accepted", "accepted"]);
    expect(response.results[1]!.update.previousRoot).toBe(response.results[0]!.update.root);
    expect(response.observedThrough).toBe(response.results[1]!.update.id);
    expect(running.canopy.acceptedUpdates(baseline.current.tree.id)).toHaveLength(before + 2);

    const replay = await client.submitUpdates(baseline.current.tree.id, {
      base: baseline.current.tree.update,
      updates: updates.slice(0, 1),
    });
    expect(replay.results[0]!.update.id).toBe(response.results[0]!.update.id);
    expect(running.canopy.acceptedUpdates(baseline.current.tree.id)).toHaveLength(before + 2);
  });

  test("temporarily answers a legacy singular caller with the flattened result", async () => {
    const baseline = await currentConfig();
    const response = await fetch(`${running.url}/.arbor/trees/${baseline.current.tree.id}/updates`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        base: baseline.current.tree.update,
        candidate: baseline.current.tree.root,
        ifMatch: "modelHash",
        objects: [],
        deltas: [],
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.outcome).toBe("current");
    expect(body.results).toBeUndefined();
    expect(body.observedThrough).toBe(baseline.current.tree.update);
  });

  test("does not advertise a retained noncanonical ordinary root as a remote tree", async () => {
    const before = await client.account();
    const profileTree = before.account.profileTree!;
    const db = new Database(join(dataRoot, "canopy.sqlite3"));
    const boundary = db.query("SELECT path, parent_tree FROM boundaries WHERE tree_id = ?").get(profileTree) as {
      path: string;
      parent_tree: string | null;
    } | null;
    if (!boundary) throw new Error("Expected the account profile boundary");
    db.run("DELETE FROM boundaries WHERE tree_id = ?", [profileTree]);
    try {
      const account = await client.account();
      expect(account.account.profileURL).toBeNull();
      expect(account.account.writableProfiles.some((tree) => tree.id === profileTree)).toBe(false);
      expect((await client.list()).snapshot.some((tree) => tree.id === profileTree)).toBe(false);
    } finally {
      db.run("INSERT INTO boundaries (path, tree_id, parent_tree) VALUES (?, ?, ?)", [
        boundary.path,
        profileTree,
        boundary.parent_tree,
      ]);
      db.close();
    }
  });

  test("returns shared descriptor snapshots and authorizes immutable objects through a named tree", async () => {
    const account = await client.account();
    expect(account.observedThrough).toBeTruthy();
    expect(account.account.configuration).toMatchObject({
      kind: "account-configuration",
      access: "write",
      canonical: null,
    });
    const trees = await client.list();
    expect(trees.observedThrough).toBeTruthy();
    expect(trees.snapshot.some((tree) => tree.id === account.account.configuration.id)).toBe(true);
    const configuration = await client.descriptor(account.account.configuration.id);
    const snapshot = await client.snapshot(configuration.tree.id, configuration.tree.root);
    const bytes = await client.object(account.account.configuration.id, snapshot.root);
    expect(bytes.byteLength).toBeGreaterThan(0);
    const unrelated = account.account.community.root;
    await expect(client.object(account.account.configuration.id, unrelated)).rejects.toThrow("not-found");
    expect((await client.descriptor(account.account.configuration.id)).observedThrough).toBeTruthy();
  });

  test("serves deterministic current and historical snapshots without widening object reads", async () => {
    const baseline = await currentConfig();
    const treeID = baseline.current.tree.id;
    const snapshotURL = (root: string, tree = treeID) => `${running.url}/.arbor/trees/${tree}/snapshots/${root}`;
    const authenticated = { authorization: `Bearer ${token}` };

    const first = await fetch(snapshotURL(baseline.snapshot.root), { headers: authenticated });
    const firstBody = new Uint8Array(await first.arrayBuffer());
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("application/cbor");
    expect(first.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(first.headers.get("vary")).toBe("Authorization, Arbor-Access-Link");
    expect(first.headers.get("etag")).toBe(`"sha256:${sha256(firstBody)}"`);
    expect((await client.snapshot(treeID, baseline.snapshot.root)).objects).toEqual(baseline.snapshot.objects);
    expect((await fetch(`${running.url}/.arbor/trees/${treeID}/snapshot`, { headers: authenticated })).status).toBe(404);

    const administrator = baseline.graph.account.admins[0]!;
    const changed = {
      account: baseline.graph.account,
      trees: baseline.graph.trees,
      devices: {
        ...baseline.graph.devices,
        [administrator]: { ...baseline.graph.devices[administrator]!, label: "Historical snapshot test" },
      },
    };
    const advanced = await submitConfiguration(baseline.current, changed);
    if (advanced.outcome !== "accepted" && advanced.outcome !== "merged") throw new Error("Expected accepted configuration update");
    const advancedSnapshot = await client.snapshot(treeID, advanced.update.root);
    expect((await client.snapshot(treeID, baseline.snapshot.root)).objects).toEqual(baseline.snapshot.objects);

    const frames = await readWatchFrames(
      `${running.url}/.arbor/trees/${treeID}/watch?after=${baseline.current.observedThrough}`,
      1,
    );
    expect(frames[0]!.data.change.transitions?.at(-1)?.update.id).toBe(advanced.update.id);

    const arbitraryObject = [...baseline.snapshot.objects.keys()].find((hash) => hash !== baseline.snapshot.root)!;
    const communityTree = baseline.account.account.community.id;
    const hiddenResponses = await Promise.all([
      fetch(snapshotURL(baseline.snapshot.root, communityTree), { headers: authenticated }),
      fetch(snapshotURL(arbitraryObject), { headers: authenticated }),
      fetch(snapshotURL(baseline.snapshot.root), { headers: { authorization: "Bearer revoked-or-unknown" } }),
    ]);
    expect(hiddenResponses.map(({ status }) => status)).toEqual([404, 404, 404]);
    expect(await Promise.all(hiddenResponses.map((response) => response.text()))).toEqual(["Not found", "Not found", "Not found"]);

    const restored = await client.submitUpdate(treeID, advanced.update.id, baseline.snapshot);
    if (restored.outcome !== "accepted" && restored.outcome !== "merged") throw new Error("Expected restored configuration root");
    expect(restored.update.root).toBe(baseline.snapshot.root);
    expect(restored.update.id).not.toBe(baseline.current.tree.update);
    expect(running.canopy.acceptedUpdates(treeID).filter(({ root }) => root === baseline.snapshot.root).length).toBeGreaterThanOrEqual(2);
    const repeated = await fetch(snapshotURL(baseline.snapshot.root), { headers: authenticated });
    expect(new Uint8Array(await repeated.arrayBuffer())).toEqual(firstBody);
    expect(repeated.headers.get("etag")).toBe(first.headers.get("etag"));

    const historicalOnly = [...advancedSnapshot.objects.keys()].find((hash) => !baseline.snapshot.objects.has(hash))!;
    expect((await fetch(snapshotURL(advanced.update.root), { headers: authenticated })).status).toBe(200);
    expect((await fetch(`${running.url}/.arbor/trees/${treeID}/objects/${historicalOnly}`, { headers: authenticated })).status).toBe(404);

    const publicTree = baseline.account.account.community.id;
    const publicRoot = (await client.descriptor(publicTree)).tree.root;
    const anonymous = await fetch(snapshotURL(publicRoot, publicTree));
    const anonymousBody = new Uint8Array(await anonymous.arrayBuffer());
    expect(anonymous.status).toBe(200);
    expect(anonymous.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(anonymous.headers.get("vary")).toBe("Authorization, Arbor-Access-Link");
    const credentialed = await fetch(snapshotURL(publicRoot, publicTree), { headers: authenticated });
    expect(credentialed.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(await credentialed.arrayBuffer())).toEqual(anonymousBody);
    const linked = await fetch(snapshotURL(publicRoot, publicTree), { headers: { "Arbor-Access-Link": "present" } });
    expect(linked.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    const publicObject = await fetch(`${running.url}/.arbor/trees/${publicTree}/objects/${publicRoot}`);
    expect(publicObject.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(publicObject.headers.get("vary")).toBe("Authorization, Arbor-Access-Link");

    const database = new Database(join(dataRoot, "canopy.sqlite3"));
    database.transaction(() => {
      database.run("DELETE FROM observations WHERE update_id = ?", [advanced.update.id]);
      database.run("DELETE FROM accepted_updates WHERE id = ?", [advanced.update.id]);
    })();
    database.close();
    const pruned = await fetch(snapshotURL(advanced.update.root), { headers: authenticated });
    expect(pruned.status).toBe(404);
    expect(await pruned.text()).toBe("Not found");
  });

  test("replays consecutive accepted updates as one ordered transition batch", async () => {
    const baseline = await currentConfig();
    const administrator = baseline.graph.account.admins[0]!;
    const firstGraph = {
      account: baseline.graph.account,
      trees: baseline.graph.trees,
      devices: {
        ...baseline.graph.devices,
        [administrator]: { ...baseline.graph.devices[administrator]!, label: "Watch replay one" },
      },
    };
    const first = await submitConfiguration(baseline.current, firstGraph);
    if (first.outcome !== "accepted" && first.outcome !== "merged") throw new Error("Expected an accepted update");

    const afterFirst = await currentConfig();
    const secondGraph = {
      account: afterFirst.graph.account,
      trees: afterFirst.graph.trees,
      devices: {
        ...afterFirst.graph.devices,
        [administrator]: { ...afterFirst.graph.devices[administrator]!, label: "Watch replay two" },
      },
    };
    const second = await submitConfiguration(afterFirst.current, secondGraph);
    if (second.outcome !== "accepted" && second.outcome !== "merged") throw new Error("Expected an accepted update");

    const abort = new AbortController();
    const response = await fetch(
      `${running.url}/.arbor/trees/${baseline.current.tree.id}/watch?after=${baseline.current.tree.update}`,
      { headers: { authorization: `Bearer ${token}` }, signal: abort.signal },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let source = "";
    while (!source.includes("\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      source += new TextDecoder().decode(chunk.value, { stream: true });
    }
    abort.abort();
    const data = source.split("\n\n", 1)[0]!.split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    const event = JSON.parse(data) as {
      id?: string;
      cursor: string;
      change: { descriptor: { update: string; ref: string }; transitions: Array<{
        update: { id: string; previousRoot: string; root: string };
      }> };
    };
    expect(event.change.transitions.map(({ update }) => update.id)).toEqual([first.update.id, second.update.id]);
    expect(Number(event.change.transitions[1]!.update.id)).toBeGreaterThan(Number(event.change.transitions[0]!.update.id));
    expect(event.change.transitions[1]!.update.previousRoot).toBe(event.change.transitions[0]!.update.root);
    expect(event.cursor).toBe(second.update.id);
    expect(event.change.descriptor).toMatchObject({ update: second.update.id, root: second.update.root });
  });

  test("reserves a client-generated tree through YAML, then activates it idempotently", async () => {
    const { current, graph } = await currentConfig();
    const treeID = generateArborID("tr");
    const linkSecret = "shared-tree-link-secret";
    const administrator = graph.account.admins[0]!;
    const treePath = join(dataRoot, "new-shared-tree");
    const next = {
      account: graph.account,
      trees: {
        version: 1 as const,
        trees: {
          ...graph.trees.trees,
          [treeID]: {
            canonicalPath: "/~owner/new-shared-tree",
            access: [{
              subject: { kind: "link" as const, digest: `sha256:${sha256(linkSecret)}` as const },
              access: "read" as const,
            }],
          },
        },
      },
      devices: {
        ...graph.devices,
        [administrator]: {
          ...graph.devices[administrator]!,
          placements: {
            ...graph.devices[administrator]!.placements,
            [treeID]: { server: new URL(running.url).origin, path: treePath },
          },
        },
      },
    };
    const accepted = await submitConfiguration(current, next);
    expect(accepted.outcome).toBe("accepted");
    expect(running.canopy.get(treeID)).toBeNull();

    await mkdir(treePath);
    await writeFile(join(treePath, "note.md"), "---\nid: x7f3q2\n---\n\n# Activated\n");
    const initial = await snapshotDirectory(treePath);
    const activated = await client.submitUpdate(treeID, null, initial);
    expect(activated.outcome).toBe("accepted");
    expect(activated.update).toMatchObject({ tree: treeID, root: initial.root, previousRoot: null, kind: "initial" });
    expect(running.canopy.get(treeID)).toMatchObject({
      id: treeID,
      kind: "ordinary",
      canonicalPath: "/~owner/new-shared-tree",
      ref: initial.root,
    });
    const replayed = await client.submitUpdate(treeID, null, initial);
    expect(replayed.outcome).toBe("accepted");
    expect(replayed.update).toEqual(activated.update);
    expect((await client.access(treeID)).snapshot).toContainEqual({
      id: expect.any(String),
      subject: { kind: "link" },
      access: "read",
    });
    const refURL = `${running.url}/.arbor/trees/${treeID}`;
    expect((await fetch(refURL)).status).toBe(404);
    expect((await fetch(refURL, { headers: { "X-Arbor-Access": linkSecret } })).status).toBe(404);
    const linkResponse = await fetch(refURL, { headers: { "Arbor-Access-Link": linkSecret } });
    expect(linkResponse.status).toBe(200);
    expect(await linkResponse.json()).toMatchObject({ tree: { id: treeID, access: "read" } });
    const linkedSnapshot = await fetch(`${running.url}/.arbor/trees/${treeID}/snapshots/${initial.root}`, {
      headers: { "Arbor-Access-Link": linkSecret },
    });
    expect(linkedSnapshot.status).toBe(200);
    expect(linkedSnapshot.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(linkedSnapshot.headers.get("vary")).toBe("Authorization, Arbor-Access-Link");
    const keyedOldPath = buildNetworkLocator("/~owner/new-shared-tree/note", {
      stableKey: pageIDStableKey("x7f3q2"),
    });
    expect((await fetch(`${running.url}${keyedOldPath}`, {
      headers: { "Arbor-Access-Link": linkSecret },
    })).status).toBe(200);
    await rename(join(treePath, "note.md"), join(treePath, "renamed.md"));
    const beforeRename = await client.descriptor(treeID);
    await client.submitUpdate(
      treeID,
      beforeRename.tree.update,
      await snapshotDirectory(treePath),
    );
    const healed = await fetch(`${running.url}${keyedOldPath}`, {
      headers: { "Arbor-Access-Link": linkSecret },
      redirect: "manual",
    });
    expect(healed.status).toBe(308);
    expect(healed.headers.get("location")).toBe(buildNetworkLocator("/~owner/new-shared-tree/renamed", {
      stableKey: pageIDStableKey("x7f3q2"),
    }));
    const peoplePath = join(treePath, "people");
    await mkdir(peoplePath);
    await writeFile(join(peoplePath, "schema.ts"), `
      import { z } from "zod";
      export const schema = z.object({ id: z.string(), name: z.string(), email: z.string() });
      export const primaryKey = ["id"];
    `);
    await writeFile(join(peoplePath, "_store.json"), '[{"id":"alice","name":"Alice","email":"alice@example.test"}]\n');
    const beforeCollectionFile = await client.descriptor(treeID);
    await client.submitUpdate(
      treeID,
      beforeCollectionFile.tree.update,
      await snapshotWithCollectionFiles(treePath),
    );
    const rowKey = canonicalStableKey([["id", "alice"]]);
    const rowPath = rowPathSegment(rowKey);
    const people = await fetch(`${running.url}/~owner/new-shared-tree/people`, {
      headers: { "Arbor-Access-Link": linkSecret, accept: "text/html" },
    });
    const peopleHTML = await people.text();
    expect(people.status).toBe(200);
    expect(peopleHTML).toContain("Alice");
    expect(peopleHTML).toContain(`people/${rowPath};arbor-key=`);
    expect(peopleHTML).not.toContain("_store.json");
    expect(peopleHTML).not.toContain("schema.ts");
    const staleRow = buildNetworkLocator("/~owner/new-shared-tree/people/stale", {
      stableKey: rowKey,
      applicationQuery: "view=card",
    });
    const healedRow = await fetch(`${running.url}${staleRow}`, {
      headers: { "Arbor-Access-Link": linkSecret },
      redirect: "manual",
    });
    expect(healedRow.status).toBe(308);
    expect(healedRow.headers.get("location")).toBe(buildNetworkLocator(`/~owner/new-shared-tree/people/${rowPath}`, {
      stableKey: rowKey,
      applicationQuery: "view=card",
    }));
    const rowResponse = await fetch(`${running.url}${healedRow.headers.get("location")}`, {
      headers: { "Arbor-Access-Link": linkSecret, accept: "text/html" },
    });
    const rowHTML = await rowResponse.text();
    expect(rowResponse.status).toBe(200);
    expect(rowHTML).toContain("Alice");
    expect(rowHTML).toContain("alice@example.test");
    const rowMarkdown = await fetch(`${running.url}/~owner/new-shared-tree/people/${rowPath}`, {
      headers: { "Arbor-Access-Link": linkSecret, accept: "text/markdown" },
    });
    expect(rowMarkdown.status).toBe(200);
    expect(await rowMarkdown.text()).toContain('"email": "alice@example.test"');
    const bootstrap = await fetch(`${running.url}/~owner/new-shared-tree`, {
      headers: { accept: "text/html" },
    });
    const bootstrapSource = await bootstrap.text();
    expect(bootstrapSource).toContain('"Arbor-Access-Link": secret');
    expect(bootstrapSource).not.toContain("X-Arbor-Access");

    const mergeBase = await client.descriptor(treeID);
    const renamedPath = join(treePath, "renamed.md");
    const mergeBaseSource = await readFile(renamedPath, "utf8");
    await writeFile(renamedPath, `${mergeBaseSource}\nRemote line\n`);
    const remoteAccepted = await client.submitUpdate(
      treeID,
      mergeBase.tree.update,
      await snapshotWithCollectionFiles(treePath),
    );
    expect(remoteAccepted.outcome).toBe("accepted");
    if (remoteAccepted.outcome !== "accepted") throw new Error("Expected an accepted update");
    await writeFile(renamedPath, `${mergeBaseSource}\nCandidate line\n`);
    const merged = await client.submitUpdate(
      treeID,
      mergeBase.tree.update,
      await snapshotWithCollectionFiles(treePath),
    );
    expect(merged.outcome).toBe("merged");
    if (merged.outcome !== "merged") throw new Error("Expected a merged update");
    expect(running.canopy.acceptedTransition(merged.update.id)?.update).toMatchObject({
      id: merged.update.id,
      kind: "merged",
      previousRoot: remoteAccepted.update.root,
    });
    // The result carries the transition from the candidate to the accepted root.
    const mergedCandidate = await snapshotWithCollectionFiles(treePath);
    expect(merged.reconciliation).toBeDefined();
    const reconciled = applyTransitionPayload(mergedCandidate.objects, merged.reconciliation!);
    expect(reconciled.has(merged.update.root)).toBe(true);

    // A bytesHash match refuses any concurrent change and answers with the candidate as the draft.
    await writeFile(renamedPath, `${mergeBaseSource}\nExact line\n`);
    const exact = await snapshotWithCollectionFiles(treePath);
    const rejected = await client.submitUpdate(treeID, mergeBase.tree.update, exact, { ifMatch: "bytesHash" }).catch((error) => error);
    expect(rejected).toBeInstanceOf(WireUpdateConflict);
    expect((rejected as WireUpdateConflict).result.details.draft.root).toBe(exact.root);
    expect((rejected as WireUpdateConflict).result.details.conflicts).toEqual([{ path: "/", reason: "node-conflict" }]);
    // Resubmitted against the current update it is a plain acceptance.
    const latest = await client.descriptor(treeID);
    expect((await client.submitUpdate(treeID, latest.tree.update, exact, { ifMatch: "bytesHash" })).outcome).toBe("accepted");

    const changedPath = join(dataRoot, "incompatible-tree");
    await mkdir(changedPath);
    await writeFile(join(changedPath, "note.md"), "Different\n");
    await expect(client.submitUpdate(treeID, null, await snapshotDirectory(changedPath))).rejects.toThrow("conflict");

    const account = await client.account();
    expect(account.observedThrough).not.toBe(accepted.update.id);
  });

  test("replays accepted updates in order across tree activation", async () => {
    const baseline = await currentConfig();
    const administrator = baseline.graph.account.admins[0]!;
    const relabel = (graph: typeof baseline.graph, label: string) => ({
      account: graph.account,
      trees: graph.trees,
      devices: { ...graph.devices, [administrator]: { ...graph.devices[administrator]!, label } },
    });
    const first = await submitConfiguration(baseline.current, relabel(baseline.graph, "Log order one"));
    if (first.outcome !== "accepted" && first.outcome !== "merged") throw new Error("Expected an accepted update");

    const treeID = generateArborID("tr");
    const treePath = join(dataRoot, "log-order-tree");
    const afterFirst = await currentConfig();
    const declared = await submitConfiguration(afterFirst.current, {
      account: afterFirst.graph.account,
      trees: {
        version: 1 as const,
        trees: {
          ...afterFirst.graph.trees.trees,
          [treeID]: { canonicalPath: "/~owner/log-order-tree", access: [] },
        },
      },
      devices: {
        ...afterFirst.graph.devices,
        [administrator]: {
          ...afterFirst.graph.devices[administrator]!,
          placements: {
            ...afterFirst.graph.devices[administrator]!.placements,
            [treeID]: { server: new URL(running.url).origin, path: treePath },
          },
        },
      },
    });
    if (declared.outcome !== "accepted" && declared.outcome !== "merged") throw new Error("Expected an accepted update");
    await mkdir(treePath);
    await writeFile(join(treePath, "note.md"), "# Log order\n");
    await client.submitUpdate(treeID, null, await snapshotDirectory(treePath));
    const afterActivation = await currentConfig();
    const third = await submitConfiguration(afterActivation.current, relabel(afterActivation.graph, "Log order three"));
    if (third.outcome !== "accepted" && third.outcome !== "merged") throw new Error("Expected an accepted update");

    const frames = await readWatchFrames(
      `${running.url}/.arbor/trees/${baseline.current.tree.id}/watch?after=${baseline.current.observedThrough}`,
      1,
    );
    expect(frames.map((frame) => frame.event)).toEqual(["tree.update"]);
    expect(frames.every((frame) => frame.id === frame.data.cursor)).toBe(true);
    expect(frames[0]!.data.change.transitions!.map(({ update }) => update.id)).toEqual([
      first.update.id,
      declared.update.id,
      third.update.id,
    ]);
    expect(frames[0]!.id).toBe(third.update.id);
  });

  test("pairing adds a client-owned device file and deleting it atomically revokes its credential", async () => {
    const offer = await client.createPairing();
    const peerID = generateArborID("dv");
    const peerCredential = "peer-device-secret-kept-by-the-client";
    const claimed = await client.claimPairing(offer.id, offer.secret, {
      id: peerID,
      label: "Peer laptop",
      credentialDigest: `sha256:${sha256(peerCredential)}`,
    });
    expect(claimed.device).toMatchObject({ id: peerID, label: "Peer laptop", revokedAt: null });
    expect(JSON.stringify(claimed)).not.toContain(peerCredential);
    const peer = new WireClient(running.url, peerCredential);
    const peerAccount = await peer.account();
    expect(peerAccount.account.handle).toBe("owner");
    const peerConfiguration = await peer.descriptor(peerAccount.account.configuration.id);
    expect((await peer.snapshot(peerConfiguration.tree.id, peerConfiguration.tree.root)).root).toBe(peerConfiguration.tree.root);

    const { current, graph } = await currentConfig();
    expect(graph.devices[peerID]?.label).toBe("Peer laptop");
    expect(graph.account.admins).not.toContain(peerID);
    const { [peerID]: _removed, ...remainingDevices } = graph.devices;
    await submitConfiguration(current, {
      account: graph.account,
      trees: graph.trees,
      devices: remainingDevices,
    });
    await expect(new WireClient(running.url, peerCredential).account()).rejects.toThrow("unauthenticated");
    expect((await fetch(
      `${running.url}/.arbor/trees/${peerConfiguration.tree.id}/snapshots/${peerConfiguration.tree.root}`,
      { headers: { authorization: `Bearer ${peerCredential}` } },
    )).status).toBe(404);
    const retired = await client.createPairing();
    await expect(client.claimPairing(retired.id, retired.secret, {
      id: peerID,
      label: "Peer again",
      credentialDigest: `sha256:${sha256("new-secret")}`,
    })).rejects.toThrow("Retired");
  });

  test("rejects conflicting cursor sources on the shared SSE surface", async () => {
    const account = await client.account();
    const response = await fetch(
      `${running.url}/.arbor/trees/${account.account.configuration.id}/watch?after=one`,
      { headers: { authorization: `Bearer ${token}`, "last-event-id": "two" } },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid-request", retryable: false });
  });
});
