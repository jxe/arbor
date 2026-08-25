import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveWireHost } from "@arbor/authority";
import { decodeWireObject, resolveWireLogicalNode, snapshotDirectory, WireClient, WireUpdateConflict } from "@arbor/wire";

const token = "owner-test-token";
let dataRoot: string;
let source: string;
let running: Awaited<ReturnType<typeof serveWireHost>>;
let client: WireClient;

async function start() {
  running = await serveWireHost({
    dataRoot,
    accounts: [{ handle: "owner", token, communityWriter: true }],
    publicOrigin: "http://127.0.0.1:0",
    hostname: "127.0.0.1",
    port: 0,
  });
  client = new WireClient(running.url, token);
}

beforeAll(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "arbor-wire-authority-"));
  source = await mkdtemp(join(tmpdir(), "arbor-wire-source-"));
  await mkdir(join(source, "nested"));
  await writeFile(join(source, "note.md"), [
    "# First",
    "",
    "A **read-only** Arbor page with [a safe link](https://example.com).",
    "",
    "- one",
    "- two",
    "",
    "<script>alert('not executable')</script>",
    "",
  ].join("\n"));
  await mkdir(join(source, "section"));
  await writeFile(join(source, "section.md"), "---\nid: section-page\n---\n\n# Section body\n\nSibling prose.\n");
  await writeFile(join(source, "section", "child.md"), "# Child\n");
  await writeFile(join(source, "nested", "secret.md"), "not inherited\n");
  await start();
});

afterAll(async () => {
  running.server.stop(true);
  await running.authority[Symbol.asyncDispose]();
  await rm(dataRoot, { recursive: true, force: true });
  await rm(source, { recursive: true, force: true });
});

describe("personal wire authority", () => {
  test("creates one private tree tip and isolates nested boundaries", async () => {
    const initial = await snapshotDirectory(source, new Map([[join(source, "nested"), "tr_independent"]]));
    const tree = await client.create("/~owner/notes", initial);
    expect(tree.id).toMatch(/^tr_/);
    expect((await client.ref(tree.id)).ref).toBe(initial.root);
    expect((await fetch(`${running.url}/~owner/notes`)).status).toBe(404);
    expect((await fetch(`${running.url}/.arbor/objects/${initial.root}`)).status).toBe(404);

    await client.setPublicAccess(tree.id, "read");
    const page = await fetch(`${running.url}/~owner/notes`);
    expect(page.status).toBe(200);
    const directoryHTML = await page.text();
    expect(directoryHTML).toContain("class=\"arbor-document\"");
    expect(directoryHTML).toContain("href=\"/~owner/notes/note\"");
    expect(directoryHTML).not.toContain(">nested<");
    const markdown = await fetch(`${running.url}/~owner/notes/note`);
    expect(markdown.status).toBe(200);
    const markdownHTML = await markdown.text();
    expect(markdownHTML).toContain("<h1>First</h1>");
    expect(markdownHTML).toContain("<strong>read-only</strong>");
    expect(markdownHTML).toContain("<li><span>one</span>");
    expect(markdownHTML).toContain("&lt;script&gt;alert");
    expect(markdownHTML).not.toContain("<script>alert");
    const section = await fetch(`${running.url}/~owner/notes/section`);
    expect(section.status).toBe(200);
    const sectionHTML = await section.text();
    expect(sectionHTML).toContain("<h1>Section body</h1>");
    expect(sectionHTML).toContain("Sibling prose.");
    expect(sectionHTML).toContain("href=\"/~owner/notes/section/child\"");
    const sectionSource = await fetch(`${running.url}/~owner/notes/section`, {
      headers: { accept: "text/markdown" },
    });
    expect(await sectionSource.text()).toBe("---\nid: section-page\n---\n\n# Section body\n\nSibling prose.\n");
    expect((await fetch(`${running.url}/~owner/notes/nested/secret.md`)).status).toBe(404);
    expect((await fetch(`${running.url}/.arbor/objects/${initial.root}`)).status).toBe(200);
  });

  test("atomically accepts idempotent updates and rejects corrupt objects", async () => {
    const tree = (await client.list()).find((item) => item.canonicalPath === "/~owner/notes")!;
    expect(typeof tree.update).toBe("string");
    await writeFile(join(source, "note.md"), "# Second\n");
    const next = await snapshotDirectory(source, new Map([[join(source, "nested"), "tr_independent"]]));
    const accepted = await client.submitUpdate(tree.id, { root: tree.ref, update: tree.update! }, next);
    expect(accepted.outcome).toBe("accepted");
    const replayed = await client.submitUpdate(tree.id, { root: tree.ref, update: tree.update! }, next);
    expect(replayed).toEqual(accepted);
    const bundled = await client.submitUpdate(
      tree.id,
      { root: tree.ref, update: tree.update! },
      next,
      { returnSnapshot: true },
    );
    expect(bundled.snapshot?.root).toBe(next.root);
    expect(bundled.snapshot?.objects.map(({ hash }) => hash).sort()).toEqual([...next.objects.keys()].sort());
    const conditional = await client.submitUpdate(
      tree.id,
      { root: tree.ref, update: tree.update! },
      next,
      { returnSnapshot: "if-result-differs" },
    );
    expect(conditional.snapshot).toBeUndefined();
    expect((await client.ref(tree.id)).ref).toBe(next.root);
    expect(running.authority.acceptedUpdates(tree.id).filter((item) => item.root === next.root)).toHaveLength(1);

    const corrupt = await fetch(`${running.url}/.arbor/trees`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        canonicalPath: "/~owner/corrupt",
        root: next.root,
        objects: [{ hash: next.root, bytes: Buffer.from("wrong").toString("base64") }],
      }),
    });
    expect(corrupt.status).toBe(400);
    expect((await fetch(`${running.url}/.arbor/trees/${tree.id}/push`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    })).status).toBe(404);
  });

  test("reconstructs a sparse candidate from a retained-base file patch", async () => {
    const folder = await mkdtemp(join(tmpdir(), "arbor-file-patch-"));
    try {
      const before = "# Patch\n\nBefore\n";
      const after = "# Patch\n\nAfter\n";
      await writeFile(join(folder, "note.md"), before);
      const baseSnapshot = await snapshotDirectory(folder);
      const tree = await client.create("/~owner/file-patch", baseSnapshot);
      await writeFile(join(folder, "note.md"), after);
      const candidate = await snapshotDirectory(folder);
      const baseRoot = decodeWireObject(baseSnapshot.objects.get(baseSnapshot.root)!);
      const candidateRoot = decodeWireObject(candidate.objects.get(candidate.root)!);
      if (baseRoot.type !== "directory" || candidateRoot.type !== "directory") throw new Error("Expected directory roots");
      const baseFile = baseRoot.entries.find((entry) => entry.name === "note.md")?.hash!;
      const resultFile = candidateRoot.entries.find((entry) => entry.name === "note.md")?.hash!;
      const offset = new TextEncoder().encode(before.slice(0, before.indexOf("Before"))).byteLength;
      const request = (replacement: string, base = tree.ref, update = tree.update!, candidateRootHash = candidate.root) => ({
        base: { root: base, update },
        candidate: candidateRootHash,
        objects: [{
          hash: candidate.root,
          bytes: Buffer.from(candidate.objects.get(candidate.root)!).toString("base64"),
        }],
        filePatches: [{
          base: baseFile,
          result: resultFile,
          edits: [{ offset, length: 6, bytes: Buffer.from(replacement).toString("base64") }],
        }],
      });
      const submit = (body: unknown) => fetch(`${running.url}/.arbor/trees/${tree.id}/updates`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      const wrong = await submit(request("Wrong"));
      expect(wrong.status).toBe(400);
      expect(await wrong.json()).toMatchObject({ error: "invalid-request", message: expect.stringContaining("result hash mismatch") });
      expect(running.authority.acceptedUpdates(tree.id)).toHaveLength(1);

      const unreferenced = await submit({
        ...request("After"),
        candidate: tree.ref,
        objects: [],
      });
      expect(unreferenced.status).toBe(400);
      expect(await unreferenced.json()).toMatchObject({
        error: "invalid-request",
        message: expect.stringContaining("not reachable from candidate"),
      });

      const accepted = await submit(request("After"));
      expect(accepted.status).toBe(201);
      expect(await accepted.json()).toMatchObject({ outcome: "accepted", update: { root: candidate.root } });
      expect(decodeWireObject(await running.authority.object(resultFile))).toEqual({
        type: "file",
        bytes: new TextEncoder().encode(after),
      });
      expect(await running.authority.object(baseFile)).toBeDefined();

      const current = await client.ref(tree.id);
      const unreachable = await submit(request("After", current.ref, current.update!, current.ref));
      expect(unreachable.status).toBe(400);
      expect(await unreachable.json()).toMatchObject({
        error: "invalid-request",
        message: expect.stringContaining("not reachable from retained base"),
      });
      expect(running.authority.acceptedUpdates(tree.id)).toHaveLength(2);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  test("allows anonymous accepted updates only in public-write mode and survives restart", async () => {
    const tree = (await client.list()).find((item) => item.canonicalPath === "/~owner/notes")!;
    await client.setPublicAccess(tree.id, "write");
    const base = await client.ref(tree.id);
    await writeFile(join(source, "third.md"), "third\n");
    const next = await snapshotDirectory(source, new Map([[join(source, "nested"), "tr_independent"]]));
    const response = await fetch(`${running.url}/.arbor/trees/${tree.id}/updates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        base: { root: base.ref, update: base.update },
        candidate: next.root,
        objects: [...next.objects].map(([hash, bytes]) => ({ hash, bytes: Buffer.from(bytes).toString("base64") })),
      }),
    });
    expect(response.status).toBe(201);

    running.server.stop(true);
    await running.authority[Symbol.asyncDispose]();
    await start();
    const restored = (await client.list()).find((item) => item.id === tree.id)!;
    expect(restored.ref).toBe(next.root);
    expect(restored.publicAccess).toBe("write");
  });

  test("serializes concurrent updates and request-digest replays transactionally", async () => {
    const folder = await mkdtemp(join(tmpdir(), "arbor-update-race-"));
    try {
      await writeFile(join(folder, "note.md"), "# Race\n\nBase\n");
      const baseSnapshot = await snapshotDirectory(folder);
      const tree = await client.create("/~owner/race", baseSnapshot);
      const alreadyCurrent = await client.submitUpdate(
        tree.id,
        { root: tree.ref, update: tree.update! },
        baseSnapshot,
      );
      expect(alreadyCurrent.outcome).toBe("current");
      expect(running.authority.acceptedUpdates(tree.id)).toHaveLength(1);

      await writeFile(join(folder, "note.md"), "# Race\n\nBase\nCandidate A\n");
      const candidateA = await snapshotDirectory(folder);
      await writeFile(join(folder, "note.md"), "# Race\n\nBase\nCandidate B\n");
      const candidateB = await snapshotDirectory(folder);
      const concurrent = await Promise.all([
        client.submitUpdate(tree.id, { root: tree.ref, update: tree.update! }, candidateA),
        client.submitUpdate(tree.id, { root: tree.ref, update: tree.update! }, candidateB),
      ]);
      expect(concurrent.map((result) => result.outcome).sort()).toEqual(["accepted", "merged"]);
      expect(running.authority.acceptedUpdates(tree.id)).toHaveLength(3);
      const raced = await client.ref(tree.id);
      const unchangedCandidate = await client.submitUpdate(
        tree.id,
        { root: tree.ref, update: tree.update! },
        baseSnapshot,
      );
      expect(unchangedCandidate.outcome).toBe("current");
      expect(running.authority.acceptedUpdates(tree.id)).toHaveLength(3);
      const logical = await resolveWireLogicalNode(raced.ref, "/note", (hash) => running.authority.object(hash));
      expect(logical?.object.type).toBe("file");
      if (!logical || logical.object.type !== "file") throw new Error("Expected raced Markdown file");
      const racedSource = new TextDecoder().decode(logical.object.bytes);
      expect(racedSource).toContain("Candidate A\n");
      expect(racedSource).toContain("Candidate B\n");

      await writeFile(join(folder, "note.md"), `${racedSource}Exact replay\n`);
      const exactCandidate = await snapshotDirectory(folder);
      const beforeExact = running.authority.acceptedUpdates(tree.id).length;
      const exact = await Promise.all([
        client.submitUpdate(tree.id, { root: raced.ref, update: raced.update! }, exactCandidate),
        client.submitUpdate(tree.id, { root: raced.ref, update: raced.update! }, exactCandidate),
      ]);
      expect(exact[1]).toEqual(exact[0]);
      const envelopeIndependentReplay = await fetch(`${running.url}/.arbor/trees/${tree.id}/updates`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          base: { root: raced.ref, update: raced.update! },
          candidate: exactCandidate.root,
          objects: [],
        }),
      });
      expect(envelopeIndependentReplay.status).toBe(201);
      expect(await envelopeIndependentReplay.json()).toEqual(exact[0]);
      expect(running.authority.acceptedUpdates(tree.id)).toHaveLength(beforeExact + 1);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  test("merges additive Markdown updates while keeping accepted history internal", async () => {
    const baseFolder = await mkdtemp(join(tmpdir(), "arbor-merge-base-"));
    const remoteFolder = await mkdtemp(join(tmpdir(), "arbor-merge-remote-"));
    const candidateFolder = await mkdtemp(join(tmpdir(), "arbor-merge-candidate-"));
    try {
      await writeFile(join(baseFolder, "note.md"), "# Note\n\nBase\n");
      await writeFile(join(remoteFolder, "note.md"), "# Note\n\nBase\nRemote\n");
      await writeFile(join(candidateFolder, "note.md"), "# Note\n\nBase\nCandidate\n");
      const baseSnapshot = await snapshotDirectory(baseFolder);
      const tree = await client.create("/~owner/merge", baseSnapshot, { publicAccess: "read" });
      const remoteSnapshot = await snapshotDirectory(remoteFolder);
      await client.submitUpdate(tree.id, { root: tree.ref, update: tree.update! }, remoteSnapshot);
      const candidateSnapshot = await snapshotDirectory(candidateFolder);
      const merged = await client.submitUpdate(
        tree.id,
        { root: tree.ref, update: tree.update! },
        candidateSnapshot,
        { returnSnapshot: "if-result-differs" },
      );
      expect(merged.outcome).toBe("merged");
      expect(merged.snapshot?.root).toBe(merged.outcome === "current" ? merged.current.root : merged.update.root);
      const accepted = merged.outcome === "current" ? merged.current : merged.update;
      const logical = await resolveWireLogicalNode(accepted.root, "/note", (hash) => running.authority.object(hash));
      expect(logical?.object.type).toBe("file");
      if (!logical || logical.object.type !== "file") throw new Error("Expected merged Markdown file");
      const source = new TextDecoder().decode(logical.object.bytes);
      expect(source).toContain("Remote\n");
      expect(source).toContain("Candidate\n");
      expect(running.authority.acceptedUpdates(tree.id).map((update) => update.kind)).toEqual(["initial", "accepted", "merged"]);

      expect((await fetch(`${running.url}/.arbor/trees/${tree.id}/updates`, {
        headers: { authorization: `Bearer ${token}` },
      })).status).toBe(405);

      expect((await fetch(`${running.url}/.arbor/objects/${tree.ref}`)).status).toBe(404);
      expect((await fetch(`${running.url}/.arbor/objects/${tree.ref}`, {
        headers: { authorization: `Bearer ${token}` },
      })).status).toBe(404);
    } finally {
      await rm(baseFolder, { recursive: true, force: true });
      await rm(remoteFolder, { recursive: true, force: true });
      await rm(candidateFolder, { recursive: true, force: true });
    }
  });

  test("returns complete client-owned conflict drafts without adding failed history", async () => {
    const baseFolder = await mkdtemp(join(tmpdir(), "arbor-conflict-base-"));
    const remoteFolder = await mkdtemp(join(tmpdir(), "arbor-conflict-remote-"));
    const candidateFolder = await mkdtemp(join(tmpdir(), "arbor-conflict-candidate-"));
    try {
      await writeFile(join(baseFolder, "asset.bin"), new Uint8Array([0]));
      await writeFile(join(remoteFolder, "asset.bin"), new Uint8Array([1]));
      await writeFile(join(candidateFolder, "asset.bin"), new Uint8Array([2]));
      const baseSnapshot = await snapshotDirectory(baseFolder);
      const tree = await client.create("/~owner/conflict", baseSnapshot);
      const remoteSnapshot = await snapshotDirectory(remoteFolder);
      await client.submitUpdate(tree.id, { root: tree.ref, update: tree.update! }, remoteSnapshot);
      const candidateSnapshot = await snapshotDirectory(candidateFolder);
      let conflict: WireUpdateConflict | undefined;
      try {
        await client.submitUpdate(
          tree.id,
          { root: tree.ref, update: tree.update! },
          candidateSnapshot,
          { returnSnapshot: "if-result-differs" },
        );
      } catch (error) {
        if (error instanceof WireUpdateConflict) conflict = error;
        else throw error;
      }
      expect(conflict?.result.conflicts).toEqual([{ path: "/asset.bin", reason: "binary-conflict" }]);
      expect(conflict?.result.currentSnapshot?.root).toBe(remoteSnapshot.root);
      expect(conflict?.result.draft.objects.some(({ hash }) => hash === conflict?.result.draft.root)).toBe(true);
      expect(conflict?.result.draft.objects.length).toBeGreaterThanOrEqual(2);
      expect(running.authority.acceptedUpdates(tree.id)).toHaveLength(2);
      await expect(running.authority.object(candidateSnapshot.root)).rejects.toThrow();
      await expect(running.authority.object(conflict!.result.draft.root)).rejects.toThrow();

      await expect(client.submitUpdate(
        tree.id,
        { root: tree.ref, update: tree.update! },
        candidateSnapshot,
        { returnSnapshot: true },
      )).rejects.toEqual(conflict);
      expect(running.authority.acceptedUpdates(tree.id)).toHaveLength(2);
    } finally {
      await rm(baseFolder, { recursive: true, force: true });
      await rm(remoteFolder, { recursive: true, force: true });
      await rm(candidateFolder, { recursive: true, force: true });
    }
  });

  test("pairs distinct device credentials, records provenance, and revokes them", async () => {
    const offer = await client.createPairing();
    expect(offer.confirmationCode).toMatch(/^\d{6}$/);
    const claim = await client.claimPairing(offer.id, offer.secret, "Swift test device");
    await expect(client.claimPairing(offer.id, offer.secret, "Duplicate device")).rejects.toThrow("already used");
    const devices = await client.devices();
    expect(devices.filter((device) => device.revokedAt === null)).toHaveLength(2);

    const paired = new WireClient(running.url, claim.deviceToken);
    const folder = await mkdtemp(join(tmpdir(), "arbor-device-update-"));
    try {
      await writeFile(join(folder, "device.md"), "one\n");
      const initial = await snapshotDirectory(folder);
      const tree = await paired.create("/~owner/device-provenance", initial);
      await writeFile(join(folder, "device.md"), "two\n");
      const next = await snapshotDirectory(folder);
      const accepted = await paired.submitUpdate(tree.id, { root: tree.ref, update: tree.update! }, next);
      expect(accepted.outcome).toBe("accepted");
      const update = accepted.outcome === "current" ? accepted.current : accepted.update;
      expect(update.subject).toBe(`device:${claim.device.id}`);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }

    const revoked = await client.revokeDevice(claim.device.id);
    expect(revoked.revokedAt).not.toBeNull();
    await expect(paired.devices()).rejects.toThrow("authentication");
  });

  test("bounds unavailable-authority requests", async () => {
    const stalled = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        await new Promise(() => {});
        return new Response();
      },
    });
    const started = performance.now();
    try {
      await expect(new WireClient(stalled.url.origin, undefined, { timeoutMs: 50 }).list())
        .rejects.toMatchObject({ name: "WireTransportError" });
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      stalled.stop(true);
    }
  });

  test("fails health when a reachable immutable object is corrupt", async () => {
    const tree = (await client.list()).find((item) => item.canonicalPath === "/~owner/notes")!;
    const root = decodeWireObject(await running.authority.object(tree.ref));
    expect(root.type).toBe("directory");
    if (root.type !== "directory") throw new Error("Expected directory root");
    const target = root.entries.find((entry) => entry.hash)?.hash!;
    const objectPath = join(dataRoot, "objects", target.slice(7, 9), target.slice(9));
    await writeFile(objectPath, "truncated");

    const health = await fetch(`${running.url}/.arbor/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({
      error: "internal-error",
      message: "Authority integrity check failed",
      retryable: true,
    });
  });
});
