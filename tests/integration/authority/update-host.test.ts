import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateArborID, sha256 } from "@arbor/core";
import { serveWireHost } from "@arbor/authority";
import { snapshotDirectory, WireClient } from "@arbor/wire";
import {
  readAccountConfigGraph,
  snapshotAccountConfig,
} from "../../../packages/authority/src/account-policy.ts";

const token = "owner-test-credential";
let dataRoot: string;
let running: Awaited<ReturnType<typeof serveWireHost>>;
let client: WireClient;

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "arbor-governed-authority-"));
  running = await serveWireHost({
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
  await running.authority[Symbol.asyncDispose]();
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

describe("governed account-configuration authority", () => {
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

  test("reserves a client-generated tree through YAML, then activates it idempotently", async () => {
    const { current, graph } = await currentConfig();
    const treeID = generateArborID("tr");
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
            access: [{ subject: { kind: "everyone" as const }, access: "read" as const }],
          },
        },
      },
      devices: {
        ...graph.devices,
        [administrator]: {
          ...graph.devices[administrator]!,
          placements: {
            ...graph.devices[administrator]!.placements,
            [treeID]: { authority: new URL(running.url).origin, path: treePath },
          },
        },
      },
    };
    const accepted = await submitConfiguration(current, next);
    expect(accepted.outcome).toBe("accepted");
    expect(running.authority.get(treeID)).toBeNull();

    await mkdir(treePath);
    await writeFile(join(treePath, "note.md"), "# Activated\n");
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
      subject: { kind: "everyone" },
      access: "read",
    });
    const changedPath = join(dataRoot, "incompatible-tree");
    await mkdir(changedPath);
    await writeFile(join(changedPath, "note.md"), "Different\n");
    await expect(client.activateTree(treeID, await snapshotDirectory(changedPath))).rejects.toThrow("tree-id-conflict");

    const account = await client.account();
    expect(account.observedThrough).not.toBe(accepted.observedThrough);
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
