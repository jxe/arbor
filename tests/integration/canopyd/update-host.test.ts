import { IntentError } from "../../../packages/canopyd-merge/src/intent-model.ts";
import { ObjectStore } from "@overstory/object-store";
import { afterAll, beforeAll, describe, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildNetworkLocator, canonicalStableKey, generateArborID, pageIDStableKey, rowPathSegment, sha256, WireClient, applyTransitionPayload, WireUpdateConflict, WireUnsupportedOperation, decodeCandidateUpdateJSON, decodeAcceptedTransitionJSON } from "@overstory/protocol";
import { serveCanopy } from "@overstory/canopyd";
import type { AcceptedTransitionJSON } from "../../../packages/protocol/src/updates/json.ts";
import { AcceptedUpdateStore } from "../../../packages/canopyd/src/updates/store.ts";
import { ProjectionProviderHost } from "@overstory/arborsync/state";
import {
  readAccountConfigGraphV2,
  snapshotAccountConfigV2,
} from "../../../packages/canopyd/src/account-policy-v2.ts";
import { resolveSnapshot, snapshotDirectory } from "@overstory/fs";
const NO_ENTRY_CHANGES = { set: [], removed: [] };

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
  const graph = readAccountConfigGraphV2({
    root: snapshot.root,
    objects: snapshot.objects,
  }, account.account.configuration.id);
  return { account, current, snapshot, graph };
}

async function submitConfiguration(
  current: Awaited<ReturnType<typeof currentConfig>>["current"],
  graph: Omit<ReturnType<typeof readAccountConfigGraphV2>, "sources">,
) {
  const snapshot = snapshotAccountConfigV2(graph);
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
      data: JSON.parse(field("data").join("\n")) as { cursor: string; change: { transitions?: AcceptedTransitionJSON[] } & Record<string, unknown> },
    };
  });
}

async function snapshotWithCollectionFiles(path: string) {
  const stores = new ProjectionProviderHost();
  try {
    return await resolveSnapshot(await snapshotDirectory(path, new Map(), [], (directory, sourceName) =>
      stores.collectionFileDescriptor(directory, sourceName)));
  } finally {
    await stores[Symbol.asyncDispose]();
  }
}

describe("governed account-configuration Canopy server", () => {
  test("evaluation time exhaustion is retryable, not an invalid request", async () => {
    const baseline = await currentConfig();
    const count = running.canopy.acceptedUpdates(baseline.current.tree.id).length;
    const submit = spyOn(running.canopy, "submitUpdate").mockRejectedValue(new IntentError("limit", "Evaluation time budget exceeded"));
    try {
      const response = await fetch(`${running.url}/.arbor/trees/${baseline.current.tree.id}/updates`, {
        method: "POST", headers: {authorization: `Bearer ${token}`, "content-type": "application/json"},
        body: JSON.stringify({base: baseline.current.tree.update, updates: [{change: crypto.randomUUID(), candidate: baseline.current.tree.root, trace: null, resolves: [], objects: [], deltas: []}]}),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({error: "internal-error", retryable: true, message: "Evaluation time budget exceeded"});
      expect(running.canopy.acceptedUpdates(baseline.current.tree.id)).toHaveLength(count);
    } finally { submit.mockRestore(); }
  });

  test("accepted prefix transport deltas are not reconstructed again", async () => {
    const baseline = await currentConfig();
    const administrator = Object.values(baseline.graph.devices).find(device => device.administrator)!.id;
    const candidate = (label: string) => snapshotAccountConfigV2({ ...baseline.graph,
      devices: { ...baseline.graph.devices, [administrator]: { ...baseline.graph.devices[administrator]!, label } },
    });
    const element = (snapshot: ReturnType<typeof candidate>) => ({
      change: crypto.randomUUID(), candidate: snapshot.root, trace: null, resolves: [], deltas: [],
      objects: [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })),
    });
    const first = element(candidate("Batch prefix " + crypto.randomUUID()));
    const second = element(candidate("Batch suffix " + crypto.randomUUID()));
    const accepted = await client.submitUpdates(baseline.current.tree.id, { base: baseline.current.tree.update, updates: [first] });
    const reconstruction = spyOn(ObjectStore.prototype, "reconstructDeltas");
    try {
      const result = await client.submitUpdates(baseline.current.tree.id, { base: baseline.current.tree.update, updates: [first, second] });
      expect(result.results[0]!.update.id).toBe(accepted.results[0]!.update.id);
      expect(result.results[1]!.update.root).toBe(second.candidate);
      expect(reconstruction).toHaveBeenCalledTimes(1);
    } finally { reconstruction.mockRestore(); }
  });

  test("accepts an append-only update string and trims an older prefix replay", async () => {
    const baseline = await currentConfig();
    const administrator = Object.values(baseline.graph.devices).find(device => device.administrator)!.id;
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
    const snapshots = [snapshotAccountConfigV2(graphOne), snapshotAccountConfigV2(graphTwo)];
    const updates = snapshots.map((snapshot) => ({ change: crypto.randomUUID(), trace: null,
      candidate: snapshot.root,
      resolves: [],
      objects: [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })),
      deltas: [],
    }));
    const before = running.canopy.acceptedUpdates(baseline.current.tree.id).length;
    const response = await client.submitUpdates(baseline.current.tree.id, {
      base: baseline.current.tree.update,
      updates,
    });
    expect(response.results.map(({ outcome }) => outcome)).toEqual(["accepted", "accepted"]);
    expect(response.results[1]!.update.previous?.root).toBe(response.results[0]!.update.root);
    expect(response.observedThrough).toBe(response.results[1]!.update.id);
    expect(running.canopy.acceptedUpdates(baseline.current.tree.id)).toHaveLength(before + 2);

    const replay = await client.submitUpdates(baseline.current.tree.id, {
      base: baseline.current.tree.update,
      updates: updates.slice(0, 1),
    });
    expect(replay.results[0]!.update.id).toBe(response.results[0]!.update.id);
    expect(running.canopy.acceptedUpdates(baseline.current.tree.id)).toHaveLength(before + 2);
  });

  test("exact-state guards reject same-root advancement but historical retries precede guards", async () => {
    const baseline = await currentConfig();
    const administrator = Object.values(baseline.graph.devices).find(device => device.administrator)!.id;
    const candidate = snapshotAccountConfigV2({
      ...baseline.graph,
      devices: {...baseline.graph.devices, [administrator]: {...baseline.graph.devices[administrator]!, label: `Guarded ${crypto.randomUUID()}`}},
    });
    const request = {base:baseline.current.tree.update,updates:[{
      change:crypto.randomUUID(),candidate:candidate.root,trace:null,resolves:[],ifCurrent:baseline.current.tree.update,
      objects:[...candidate.objects].map(([hash,bytes])=>({hash,bytes})),deltas:[],
    }]};
    const first = await client.submitUpdates(baseline.current.tree.id,request);
    const restored = await client.submitUpdate(baseline.current.tree.id,first.results[0]!.update.id,baseline.snapshot);
    expect(restored.update.root).toBe(baseline.current.tree.root);
    expect(restored.update.id).not.toBe(baseline.current.tree.update);
    const count = running.canopy.acceptedUpdates(baseline.current.tree.id).length;
    const rejected = await client.submitUpdates(baseline.current.tree.id,{
      ...request,updates:[{...request.updates[0]!,change:crypto.randomUUID()}],
    }).catch(error=>error);
    expect(rejected).toBeInstanceOf(WireUpdateConflict);
    expect(rejected.result.message).toContain("ifCurrent");
    const replay = await client.submitUpdates(baseline.current.tree.id,request);
    expect(replay.results[0]!.update.id).toBe(first.results[0]!.update.id);
    expect((await client.descriptor(baseline.current.tree.id)).tree.update).toBe(restored.update.id);
    expect(running.canopy.acceptedUpdates(baseline.current.tree.id)).toHaveLength(count);
  });

  test.each([false, true])("a later accepted digest proves a no-op prefix (activation=%s)", async (activation) => {
    const baseline = await currentConfig();
    const administrator = Object.values(baseline.graph.devices).find(device => device.administrator)!.id;
    const candidate = snapshotAccountConfigV2({...baseline.graph,devices:{...baseline.graph.devices,
      [administrator]:{...baseline.graph.devices[administrator]!,label:`After no-op ${crypto.randomUUID()}`}}});
    const request = {base:activation ? null : baseline.current.tree.update,updates:[{
      change:crypto.randomUUID(),candidate:baseline.snapshot.root,trace:null,resolves:[],
      ...(activation ? {} : {ifCurrent:baseline.current.tree.update}),objects:[],deltas:[],
    },{
      change:crypto.randomUUID(),candidate:candidate.root,trace:null,resolves:[],
      objects:[...candidate.objects].map(([hash,bytes])=>({hash,bytes})),deltas:[],
    }]};
    const response = await client.submitUpdates(baseline.current.tree.id,request);
    expect(response.results.map(r=>r.outcome)).toEqual(["unchanged","accepted"]);
    const count = running.canopy.acceptedUpdates(baseline.current.tree.id).length;
    const replay = await client.submitUpdates(baseline.current.tree.id,request);
    expect(replay.results.map(r=>r.outcome)).toEqual(["unchanged","accepted"]);
    expect(replay.results[1]!.update.id).toBe(response.results[1]!.update.id);
    expect(running.canopy.acceptedUpdates(baseline.current.tree.id)).toHaveLength(count);
  });

  test("unsupported operations reject a complete batch before its valid prefix changes authority", async () => {
    const baseline = await currentConfig();
    const administrator = Object.values(baseline.graph.devices).find(device => device.administrator)!.id;
    const snapshot = snapshotAccountConfigV2({
      ...baseline.graph,
      devices: { ...baseline.graph.devices, [administrator]: { ...baseline.graph.devices[administrator]!, label: "Must not be accepted" } },
    });
    const first = { change: crypto.randomUUID(), trace: null, candidate: snapshot.root, resolves: [], objects: [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes: Buffer.from(bytes).toString("base64") })), deltas: [] };
    // A governed configuration tree accepts no authored evidence at all, so a
    // perfectly well-formed trace is the unsupported form here.
    const second = { ...first, change: crypto.randomUUID(), trace: [{ before: baseline.current.tree.root, after: snapshot.root, operations: [
      { key: "edit", kind: "editSource", source: { material: { kind: "basis", path: "/devices.yaml", object: baseline.current.tree.root } }, text: "" },
    ] }] };
    const count = running.canopy.acceptedUpdates(baseline.current.tree.id).length;
    const response = await fetch(`${running.url}/.arbor/trees/${baseline.current.tree.id}/updates`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ base: baseline.current.tree.update, updates: [first, second] }),
    });
    await expect(client.submitUpdates(baseline.current.tree.id, { base: baseline.current.tree.update, updates: [decodeCandidateUpdateJSON(first), decodeCandidateUpdateJSON(second)] })).rejects.toBeInstanceOf(WireUnsupportedOperation);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "unsupported-operation", retryable: false });
    expect(await client.descriptor(baseline.current.tree.id)).toEqual(baseline.current);
    expect(running.canopy.acceptedUpdates(baseline.current.tree.id)).toHaveLength(count);
  });

  test("rejects the retired singular request shape", async () => {
    const baseline = await currentConfig();
    const response = await fetch(`${running.url}/.arbor/trees/${baseline.current.tree.id}/updates`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ change: crypto.randomUUID(), trace: null,
        base: baseline.current.tree.update,
        candidate: baseline.current.tree.root,
        resolves: [],
        objects: [],
        deltas: [],
      }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as Record<string, unknown>;
    expect(body.error).toBe("invalid-request");
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
    // The object route is gated on tree read alone: a retained object from
    // another readable tree is served by hash, while an unknown hash is not.
    const otherTree = account.account.community.root;
    expect((await client.object(account.account.configuration.id, otherTree)).byteLength).toBeGreaterThan(0);
    const unknown = `sha256:${sha256(new TextEncoder().encode(`never stored ${crypto.randomUUID()}`))}`;
    await expect(client.object(account.account.configuration.id, unknown)).rejects.toThrow("not-found");
    expect((await client.descriptor(account.account.configuration.id)).observedThrough).toBeTruthy();
  });

  test("serves deterministic current and historical snapshots and retained-root objects", async () => {
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

    const administrator = Object.values(baseline.graph.devices).find(device => device.administrator)!.id;
    const changed = {
      account: baseline.graph.account,
      trees: baseline.graph.trees,
      devices: {
        ...baseline.graph.devices,
        [administrator]: { ...baseline.graph.devices[administrator]!, label: "Historical snapshot test" },
      },
    };
    const advanced = await submitConfiguration(baseline.current, changed);
    if (advanced.outcome !== "accepted") throw new Error("Expected accepted configuration update");
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
    if (restored.outcome !== "accepted") throw new Error("Expected restored configuration root");
    expect(restored.update.root).toBe(baseline.snapshot.root);
    expect(restored.update.id).not.toBe(baseline.current.tree.update);
    expect(running.canopy.acceptedUpdates(treeID).filter(({ root }) => root === baseline.snapshot.root).length).toBeGreaterThanOrEqual(2);
    const repeated = await fetch(snapshotURL(baseline.snapshot.root), { headers: authenticated });
    expect(new Uint8Array(await repeated.arrayBuffer())).toEqual(firstBody);
    expect(repeated.headers.get("etag")).toBe(first.headers.get("etag"));

    const historicalOnly = [...advancedSnapshot.objects.keys()].find((hash) => !baseline.snapshot.objects.has(hash))!;
    const objectURL = `${running.url}/.arbor/trees/${treeID}/objects/${historicalOnly}`;
    expect((await fetch(snapshotURL(advanced.update.root), { headers: authenticated })).status).toBe(200);
    const historicalObject = await fetch(objectURL, { headers: authenticated });
    const historicalBytes = new Uint8Array(await historicalObject.arrayBuffer());
    expect(historicalObject.status).toBe(200);
    expect(`sha256:${sha256(historicalBytes)}`).toBe(historicalOnly);
    expect(Array.from(historicalBytes)).toEqual(Array.from(advancedSnapshot.objects.get(historicalOnly)!));
    expect((await fetch(objectURL)).status).toBe(404);
    expect((await fetch(objectURL, { headers: { authorization: "Bearer revoked-or-unknown" } })).status).toBe(404);
    // Read access to any tree serves any retained object by hash.
    expect((await fetch(`${running.url}/.arbor/trees/${communityTree}/objects/${historicalOnly}`, { headers: authenticated })).status).toBe(200);

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
    // The object itself stays readable until the object store compacts it away:
    // the object route is gated on tree read, not on accepted-update retention.
    expect((await fetch(objectURL, { headers: authenticated })).status).toBe(200);
  });

  test("coalesces consecutive accepted updates without a capability parameter", async () => {
    const baseline = await currentConfig();
    const administrator = Object.values(baseline.graph.devices).find(device => device.administrator)!.id;
    const firstGraph = {
      account: baseline.graph.account,
      trees: baseline.graph.trees,
      devices: {
        ...baseline.graph.devices,
        [administrator]: { ...baseline.graph.devices[administrator]!, label: "Watch replay one" },
      },
    };
    const first = await submitConfiguration(baseline.current, firstGraph);
    if (first.outcome !== "accepted") throw new Error("Expected an accepted update");

    const afterFirst = await currentConfig();
    const secondGraph = {
      account: afterFirst.graph.account,
      trees: afterFirst.graph.trees,
      devices: { ...afterFirst.graph.devices, [administrator]: { ...afterFirst.graph.devices[administrator]!, label: "Watch replay two" } },
    };
    const second = await submitConfiguration(afterFirst.current, secondGraph);
    if (second.outcome !== "accepted") throw new Error("Expected an accepted update");

    const database = new Database(join(dataRoot, "canopy.sqlite3"));
    database.run("UPDATE observations SET cursor = 'observation-batch' WHERE update_id = ?", [second.update.id]);
    database.close();
    const abort = new AbortController();
    const response = await fetch(
      `${running.url}/.arbor/trees/${baseline.current.tree.id}/watch?after=${baseline.current.observedThrough}`,
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
        update: { id: string; previous: { id: string; root: string }; root: string };
        from: { id: string; root: string };
      }> };
    };
    expect(event.change.transitions.map(({ update }) => update.id)).toEqual([second.update.id]);
    expect(event.change.transitions[0]!.from).toEqual({id: baseline.current.tree.update, root: baseline.current.tree.root});
    expect(event.change.transitions[0]!.update.previous).toEqual({id: first.update.id, root: first.update.root});
    expect(event.cursor).toBe("observation-batch");
    expect(event.cursor).not.toBe(second.update.id);
    const replayAbort = new AbortController();
    for await (const decoded of client.watch(baseline.current.tree.id, baseline.current.observedThrough, { signal: replayAbort.signal })) {
      expect(decoded.cursor).toBe("observation-batch");
      if (decoded.kind === "tree.update") expect(decoded.descriptor.update).toBe(second.update.id);
      else throw new Error("Expected accepted transition replay");
      replayAbort.abort();
      break;
    }
    expect(event.change.descriptor).toMatchObject({ update: second.update.id, root: second.update.root });
  });

  test("reserves a client-generated tree through YAML, then activates it idempotently", async () => {
    const { current, graph } = await currentConfig();
    const treeID = generateArborID("tr");
    const linkSecret = "shared-tree-link-secret";
    const treePath = join(dataRoot, "new-shared-tree");
    const next = {
      account: graph.account,
      trees: {
          ...graph.trees,
          [treeID]: {
            canonical: `${running.url}/~owner/new-shared-tree`,
            access: [{
              subject: { kind: "link" as const, digest: `sha256:${sha256(linkSecret)}` as const },
              access: "read" as const,
            }],
          },
      },
      devices: graph.devices,
    };
    const accepted = await submitConfiguration(current, next);
    expect(accepted.outcome).toBe("accepted");
    expect(running.canopy.get(treeID)).toBeNull();

    await mkdir(treePath);
    await writeFile(join(treePath, "note.md"), "---\nid: x7f3q2\n---\n\n# Activated\n");
    const initial = await resolveSnapshot(await snapshotDirectory(treePath));
    const unsupported = await fetch(`${running.url}/.arbor/trees/${treeID}/updates`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      // An activation carries exact bytes only; any authored evidence, however
      // well formed, is unsupported.
      body: JSON.stringify({ base: null, updates: [{ change: crypto.randomUUID(), trace: [{ before: initial.root, after: initial.root, operations: [
        { key: "edit", kind: "editSource", source: { material: { kind: "basis", path: "/note.md", object: initial.root } }, text: "" },
      ] }], candidate: initial.root, resolves: [], objects: [], deltas: [] }] }),
    });
    expect(unsupported.status).toBe(422);
    expect(running.canopy.get(treeID)).toBeNull();
    const activationChange = crypto.randomUUID();
    const activated = await client.submitUpdate(treeID, null, initial, { change: activationChange });
    expect(activated.outcome).toBe("accepted");
    expect(activated.update).toMatchObject({ tree: treeID, root: initial.root, previous: null, conflicted: false });
    expect(running.canopy.get(treeID)).toMatchObject({
      id: treeID,
      kind: "ordinary",
      canonicalPath: "/~owner/new-shared-tree",
      ref: initial.root,
    });
    const replayed = await client.submitUpdate(treeID, null, initial, { change: activationChange });
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
      await resolveSnapshot(await snapshotDirectory(treePath)),
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
    expect(merged.outcome).toBe("accepted");
    if (merged.outcome !== "accepted") throw new Error("Expected a merged update");
    expect(running.canopy.acceptedTransition(merged.update.id)?.update).toMatchObject({
      id: merged.update.id,
            previous: { id: remoteAccepted.update.id, root: remoteAccepted.update.root },
    });
    // The result carries the transition from the candidate to the accepted root.
    const mergedCandidate = await snapshotWithCollectionFiles(treePath);
    expect(merged.reconciliation).toBeDefined();
    const reconciled = applyTransitionPayload(mergedCandidate.objects, merged.reconciliation!);
    expect(reconciled.has(merged.update.root)).toBe(true);

    // A bytesHash match refuses any concurrent change and answers with the candidate as the draft.
    await writeFile(renamedPath, `${mergeBaseSource}\nExact line\n`);
    const exact = await snapshotWithCollectionFiles(treePath);
    const rejected = await client.submitUpdate(treeID, mergeBase.tree.update, exact, { ifCurrent: mergeBase.tree.update }).catch((error) => error);
    expect(rejected).toBeInstanceOf(WireUpdateConflict);
    expect((rejected as WireUpdateConflict).result.details.draft.root).toBe(exact.root);
    expect((rejected as WireUpdateConflict).result.details.conflicts).toEqual([{ path: "/", reason: "node-conflict" }]);
    // Resubmitted against the current update it is a plain acceptance.
    const latest = await client.descriptor(treeID);
    expect((await client.submitUpdate(treeID, latest.tree.update, exact, { ifCurrent: latest.tree.update })).outcome).toBe("accepted");

    const changedPath = join(dataRoot, "incompatible-tree");
    await mkdir(changedPath);
    await writeFile(join(changedPath, "note.md"), "Different\n");
    await expect(client.submitUpdate(treeID, null, await resolveSnapshot(await snapshotDirectory(changedPath)))).rejects.toThrow("conflict");

    const account = await client.account();
    expect(account.observedThrough).not.toBe(accepted.update.id);
  });

  test("coalesces accepted updates across another tree activation", async () => {
    const baseline = await currentConfig();
    const administrator = Object.values(baseline.graph.devices).find(device => device.administrator)!.id;
    const relabel = (graph: typeof baseline.graph, label: string) => ({
      account: graph.account,
      trees: graph.trees,
      devices: { ...graph.devices, [administrator]: { ...graph.devices[administrator]!, label } },
    });
    const first = await submitConfiguration(baseline.current, relabel(baseline.graph, "Log order one"));
    if (first.outcome !== "accepted") throw new Error("Expected an accepted update");

    const treeID = generateArborID("tr");
    const treePath = join(dataRoot, "log-order-tree");
    const afterFirst = await currentConfig();
    const declared = await submitConfiguration(afterFirst.current, {
      account: afterFirst.graph.account,
      trees: {
          ...afterFirst.graph.trees,
          [treeID]: { canonical: `${running.url}/~owner/log-order-tree`, access: [] },
      },
      devices: afterFirst.graph.devices,
    });
    if (declared.outcome !== "accepted") throw new Error("Expected an accepted update");
    await mkdir(treePath);
    await writeFile(join(treePath, "note.md"), "# Log order\n");
    await client.submitUpdate(treeID, null, await resolveSnapshot(await snapshotDirectory(treePath)));
    const afterActivation = await currentConfig();
    const third = await submitConfiguration(afterActivation.current, relabel(afterActivation.graph, "Log order three"));
    if (third.outcome !== "accepted") throw new Error("Expected an accepted update");

    const frames = await readWatchFrames(
      `${running.url}/.arbor/trees/${baseline.current.tree.id}/watch?after=${baseline.current.observedThrough}`,
      1,
    );
    expect(frames.map((frame) => frame.event)).toEqual(["tree.update"]);
    expect(frames.every((frame) => frame.id === frame.data.cursor)).toBe(true);
    expect(frames[0]!.data.change.transitions!.map(({ update }) => update.id)).toEqual([
      third.update.id,
    ]);
    expect(frames[0]!.id).toBe(third.update.id);
  });

  test("pairing adds a devices.yaml entry and deleting it atomically revokes its credential", async () => {
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
    const peerWatchPromise = fetch(
      `${running.url}/.arbor/trees/${peerConfiguration.tree.id}/watch?after=${peerConfiguration.observedThrough}`,
      { headers: { authorization: `Bearer ${peerCredential}` } },
    );
    await Bun.sleep(25);

    const { current, graph } = await currentConfig();
    expect(graph.devices[peerID]?.label).toBe("Peer laptop");
    expect(graph.devices[peerID]?.administrator).toBe(false);
    const { [peerID]: _removed, ...remainingDevices } = graph.devices;
    await submitConfiguration(current, {
      account: graph.account,
      trees: graph.trees,
      devices: remainingDevices,
    });
    const peerWatch = await peerWatchPromise;
    expect(peerWatch.status).toBe(200);
    const peerWatchReader = peerWatch.body!.getReader();
    const revokedFrame = await Promise.race([
      peerWatchReader.read(),
      Bun.sleep(2_000).then(() => { throw new Error("Revoked watch did not close"); }),
    ]);
    expect(new TextDecoder().decode(revokedFrame.value)).toContain("Authorization was revoked");
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
  test("large watch backlogs use bounded reads and coalesce appends before capture", async () => {
    const baseline = await currentConfig();
    const tree = baseline.current.tree.id;
    const root = baseline.current.tree.root;
    const db = new Database(join(dataRoot,"canopy.sqlite3"));
    const store = new AcceptedUpdateStore(db);
    const ids: string[] = [];
    const append = () => {
      const update=store.insert({entryChanges:NO_ENTRY_CHANGES,tree,root,previousRoot:root,kind:"accepted",acceptedAt:Date.now(),transition:{objects:[],deltas:[]}});
      ids.push(update.id);
    };
    for(let i=0;i<130;i++) append();
    const original = running.canopy.observationPage.bind(running.canopy);
    const sizes: number[]=[];
    running.canopy.observationPage = (id,after) => {
      const page=original(id,after); sizes.push(page.length);
      if(sizes.length===1) append(); // Arrives after the replay's first page was read.
      return page;
    };
    try {
      const frames=await readWatchFrames(`${running.url}/.arbor/trees/${tree}/watch?after=${baseline.current.observedThrough}`,1);
      expect(frames.flatMap(frame=>frame.data.change.transitions!.map(t=>t.update.id))).toEqual([ids.at(-1)!]);
      expect(frames[0]!.data.change.transitions![0]!.from?.id).toBe(baseline.current.tree.update);
      expect(frames.map(frame=>frame.data.change.transitions!.length)).toEqual([1]);
      expect(sizes.every(size=>size<=64)).toBe(true);
      expect(frames.at(-1)!.id).toBe(running.canopy.observedThrough(tree));
    } finally {running.canopy.observationPage=original; db.close();}
  });

  test("default client catch-up reconstructs net content and retains the actual predecessor", async () => {
    const baseline = await currentConfig();
    const tree = baseline.current.tree.id;
    const admin = Object.values(baseline.graph.devices).find(device => device.administrator)!.id;
    let current = baseline;
    for (const label of ["net intermediate", "net destination"]) {
      await submitConfiguration(current.current, {...current.graph,
        devices: {...current.graph.devices, [admin]: {...current.graph.devices[admin]!, label}}});
      current = await currentConfig();
    }
    const abort = new AbortController();
    try {
      const iterator = client.watch(tree, baseline.current.observedThrough, {signal: abort.signal});
      const event = (await iterator.next()).value!;
      if (event.kind !== "tree.update") throw new Error("Expected net update");
      expect(event.transitions).toHaveLength(1);
      const transition = event.transitions[0]!;
      expect(transition.from).toEqual({id: baseline.current.tree.update, root: baseline.snapshot.root});
      expect(transition.update.previous!.id).not.toBe(transition.from!.id);
      const result = applyTransitionPayload(baseline.snapshot.objects, transition);
      expect(result.get(current.snapshot.root)).toEqual(current.snapshot.objects.get(current.snapshot.root));
      for (const [hash, bytes] of current.snapshot.objects) expect(result.get(hash)).toEqual(bytes);
      expect(event.cursor).toBe(current.current.observedThrough);
      expect(transition.requestDigest).toBeDefined();
    } finally { abort.abort(); }
  });

  test("appends during net construction follow the captured destination", async () => {
    const baseline = await currentConfig(), tree = baseline.current.tree.id, root = baseline.current.tree.root;
    const db = new Database(join(dataRoot,"canopy.sqlite3")), store = new AcceptedUpdateStore(db);
    for (let i=0;i<3;i++) store.insert({entryChanges:NO_ENTRY_CHANGES,tree,root,previousRoot:root,kind:"accepted",acceptedAt:Date.now(),transition:{objects:[],deltas:[]}});
    const original = running.canopy.netAcceptedTransition.bind(running.canopy);
    let appended: string | undefined;
    running.canopy.netAcceptedTransition = async (...args) => {
      const net = await original(...args);
      appended = store.insert({entryChanges:NO_ENTRY_CHANGES,tree,root,previousRoot:root,kind:"accepted",acceptedAt:Date.now(),transition:{objects:[],deltas:[]}}).id;
      return net;
    };
    try {
      const frames = await readWatchFrames(`${running.url}/.arbor/trees/${tree}/watch?after=${baseline.current.observedThrough}`,2);
      const first = decodeAcceptedTransitionJSON(frames[0]!.data.change.transitions![0]);
      const second = decodeAcceptedTransitionJSON(frames[1]!.data.change.transitions![0]);
      expect(first.from?.id).toBe(baseline.current.tree.update);
      expect(second.update.previous?.id).toBe(first.update.id);
      expect(second.update.id).toBe(appended!);
    } finally {running.canopy.netAcceptedTransition=original;db.close();}
  });

  test("net catch-up skips intermediate payloads and preserves accepted history", async () => {
    const baseline=await currentConfig();
    const tree=baseline.current.tree.id, root=baseline.current.tree.root;
    const db=new Database(join(dataRoot,"canopy.sqlite3")), store=new AcceptedUpdateStore(db);
    for(let i=0;i<513;i++) store.insert({entryChanges:NO_ENTRY_CHANGES,tree,root,previousRoot:root,kind:"accepted",acceptedAt:Date.now(),transition:{objects:[],deltas:[]}});
    const original=running.canopy.acceptedTransition.bind(running.canopy);
    let loaded=0;
    running.canopy.acceptedTransition=(...args)=>{loaded++;return original(...args);};
    try {
      const [frame]=await readWatchFrames(`${running.url}/.arbor/trees/${tree}/watch?after=${baseline.current.observedThrough}`,1);
      expect(frame!.event).toBe("tree.update");
      expect(frame!.data.change.transitions).toHaveLength(1);
      expect(frame!.data.change.transitions![0]!.update.previous!.id).not.toBe(baseline.current.tree.update);
      expect(loaded).toBe(0);
      const current=await client.descriptor(tree);
      expect(frame!.id).toBe(current.observedThrough);
      expect((await client.snapshot(tree,current.tree.root)).root).toBe(root);
      expect(store.list(tree).length).toBeGreaterThanOrEqual(514);
    } finally {running.canopy.acceptedTransition=original;db.close();}
  });

  test("net catch-up omits byte-heavy intermediate payloads", async () => {
    const baseline=await currentConfig(), tree=baseline.current.tree.id, root=baseline.current.tree.root;
    const db=new Database(join(dataRoot,"canopy.sqlite3")), store=new AcceptedUpdateStore(db);
    const bytes=new Uint8Array(400_000);
    const hash=`sha256:${sha256(bytes)}`;
    try {
      for(let i=0;i<16;i++) store.insert({entryChanges:NO_ENTRY_CHANGES,tree,root,previousRoot:root,kind:"accepted",acceptedAt:Date.now(),transition:{objects:[{hash,bytes}],deltas:[]}});
      const [frame]=await readWatchFrames(`${running.url}/.arbor/trees/${tree}/watch?after=${baseline.current.observedThrough}`,1);
      expect(frame!.event).toBe("tree.update");
      expect(frame!.data.change.transitions).toHaveLength(1);
      expect(frame!.data.change.transitions![0]!.objects).toEqual([]);
    } finally {db.close();}
  });

});
