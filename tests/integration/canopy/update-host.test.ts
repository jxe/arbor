import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildNetworkLocator, canonicalStableKey, generateArborID, pageIDStableKey, rowPathSegment, sha256 } from "@arbor/core";
import { serveCanopy } from "@arbor/canopy";
import { ProjectionProviderHost } from "@arbor/stores";
import { snapshotDirectory, WireClient } from "@arbor/wire";
import {
  readAccountConfigGraph,
  snapshotAccountConfig,
} from "../../../packages/canopy/src/account-policy.ts";

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
  const current = await client.currentSnapshot(account.account.configuration.id);
  const graph = readAccountConfigGraph({
    root: current.snapshot.root,
    objects: new Map(current.snapshot.objects.map(({ hash, bytes }) => [hash, bytes])),
  }, account.account.configuration.id);
  return { account, current, graph };
}

async function submitConfiguration(
  current: Awaited<ReturnType<typeof currentConfig>>["current"],
  graph: Omit<ReturnType<typeof readAccountConfigGraph>, "sources">,
) {
  const snapshot = snapshotAccountConfig(graph);
  return client.submitUpdate(
    current.tree.id,
    { root: current.tree.ref, update: current.tree.update },
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

async function snapshotWithRollups(path: string) {
  const stores = new ProjectionProviderHost();
  try {
    return await snapshotDirectory(path, new Map(), [], (directory, sourceName) =>
      stores.fileRollupDescriptor(directory, sourceName));
  } finally {
    await stores[Symbol.asyncDispose]();
  }
}

describe("governed account-configuration Canopy server", () => {
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
    const configuration = await client.currentSnapshot(account.account.configuration.id);
    const bytes = await client.object(account.account.configuration.id, configuration.snapshot.root);
    expect(bytes.byteLength).toBeGreaterThan(0);
    const unrelated = account.account.community.ref;
    await expect(client.object(account.account.configuration.id, unrelated)).rejects.toThrow("not-found");
    expect((await client.ref(account.account.configuration.id)).observedThrough).toBeTruthy();
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
        update: { id: string; sequence: number; previousRoot: string; root: string };
      }> };
    };
    expect(event.change.transitions.map(({ update }) => update.id)).toEqual([first.update.id, second.update.id]);
    expect(event.change.transitions[1]!.update.sequence).toBe(event.change.transitions[0]!.update.sequence + 1);
    expect(event.change.transitions[1]!.update.previousRoot).toBe(event.change.transitions[0]!.update.root);
    expect(event.cursor).toBe(second.update.id);
    expect(event.change.descriptor).toMatchObject({ update: second.update.id, ref: second.update.root });
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
            kind: "shared-subtree" as const,
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
    const activated = await client.activateTree(treeID, initial);
    expect(activated.snapshot).toMatchObject({
      id: treeID,
      kind: "shared-subtree",
      canonical: { path: "/~owner/new-shared-tree" },
      ref: initial.root,
    });
    expect(await client.activateTree(treeID, initial)).toEqual(activated);
    expect((await client.access(treeID)).snapshot).toContainEqual({
      id: expect.any(String),
      subject: { kind: "link" },
      access: "read",
    });
    const refURL = `${running.url}/.arbor/trees/${treeID}/ref`;
    expect((await fetch(refURL)).status).toBe(404);
    expect((await fetch(refURL, { headers: { "X-Arbor-Access": linkSecret } })).status).toBe(404);
    const linkResponse = await fetch(refURL, { headers: { "Arbor-Access-Link": linkSecret } });
    expect(linkResponse.status).toBe(200);
    expect(await linkResponse.json()).toMatchObject({ snapshot: { id: treeID, access: "read" } });
    const keyedOldPath = buildNetworkLocator("/~owner/new-shared-tree/note", {
      stableKey: pageIDStableKey("x7f3q2"),
    });
    expect((await fetch(`${running.url}${keyedOldPath}`, {
      headers: { "Arbor-Access-Link": linkSecret },
    })).status).toBe(200);
    await rename(join(treePath, "note.md"), join(treePath, "renamed.md"));
    const beforeRename = await client.ref(treeID);
    await client.submitUpdate(
      treeID,
      { root: beforeRename.snapshot.ref, update: beforeRename.snapshot.update },
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
    const beforeRollup = await client.ref(treeID);
    await client.submitUpdate(
      treeID,
      { root: beforeRollup.snapshot.ref, update: beforeRollup.snapshot.update },
      await snapshotWithRollups(treePath),
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

    const mergeBase = await client.currentSnapshot(treeID);
    const renamedPath = join(treePath, "renamed.md");
    const mergeBaseSource = await readFile(renamedPath, "utf8");
    await writeFile(renamedPath, `${mergeBaseSource}\nRemote line\n`);
    const remoteAccepted = await client.submitUpdate(
      treeID,
      { root: mergeBase.tree.ref, update: mergeBase.tree.update },
      await snapshotWithRollups(treePath),
    );
    expect(remoteAccepted.outcome).toBe("accepted");
    if (remoteAccepted.outcome !== "accepted") throw new Error("Expected an accepted update");
    await writeFile(renamedPath, `${mergeBaseSource}\nCandidate line\n`);
    const merged = await client.submitUpdate(
      treeID,
      { root: mergeBase.tree.ref, update: mergeBase.tree.update },
      await snapshotWithRollups(treePath),
    );
    expect(merged.outcome).toBe("merged");
    if (merged.outcome !== "merged") throw new Error("Expected a merged update");
    expect(running.canopy.acceptedTransition(merged.update.id)?.update).toMatchObject({
      id: merged.update.id,
      kind: "merged",
      previousRoot: remoteAccepted.update.root,
    });

    const changedPath = join(dataRoot, "incompatible-tree");
    await mkdir(changedPath);
    await writeFile(join(changedPath, "note.md"), "Different\n");
    await expect(client.activateTree(treeID, await snapshotDirectory(changedPath))).rejects.toThrow("tree-id-conflict");

    const account = await client.account();
    expect(account.observedThrough).not.toBe(accepted.observedThrough);
  });

  test("replays accepted updates and activation events in log order", async () => {
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
          [treeID]: { kind: "shared-subtree" as const, canonicalPath: "/~owner/log-order-tree", access: [] },
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
    await client.activateTree(treeID, await snapshotDirectory(treePath));
    const afterActivation = await currentConfig();
    const third = await submitConfiguration(afterActivation.current, relabel(afterActivation.graph, "Log order three"));
    if (third.outcome !== "accepted" && third.outcome !== "merged") throw new Error("Expected an accepted update");

    const frames = await readWatchFrames(
      `${running.url}/.arbor/trees/${baseline.current.tree.id}/watch?after=${baseline.current.observedThrough}`,
      3,
    );
    expect(frames.map((frame) => frame.event)).toEqual(["tree.ref", "tree.activation", "tree.ref"]);
    expect(frames.every((frame) => frame.id === frame.data.cursor)).toBe(true);
    expect(frames[0]!.data.change.transitions!.map(({ update }) => update.id)).toEqual([first.update.id, declared.update.id]);
    expect(frames[1]!.data.change).toEqual({ tree: treeID, status: "active" });
    expect(frames[2]!.data.change.transitions!.map(({ update }) => update.id)).toEqual([third.update.id]);
    expect(frames[2]!.id).toBe(third.update.id);
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
    expect((await new WireClient(running.url, peerCredential).account()).account.handle).toBe("owner");

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
