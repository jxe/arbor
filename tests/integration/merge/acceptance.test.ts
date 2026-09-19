import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveCanopy } from "@arbor/canopy";
import { WireClient, decodeWireDirectory, encodeWireDirectory, hashObject, type CandidateUpdate } from "@arbor/wire";

test("worker failure accepts preserved alternatives, survives restart and permits further publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arbor-merge-failure-"));
  const start = () => serveCanopy({ dataRoot: dir, publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
    accounts: [{ handle: "owner", token: "owner-token", communityWriter: true }],
    mergeTool: { command: [join(dir, "missing-merge-executable")], timeoutMs: 100 },
  });
  let host = await start();
  try {
    let client = new WireClient(host.url, "owner-token");
    const tree = (await client.account()).account.community.id;
    const head = (await client.descriptor(tree)).tree;
    const initial = await client.snapshot(tree, head.root);
    const objects = new Map(initial.objects);
    function edit(root: string, text: string, name = "note.md"): CandidateUpdate {
      const bytes = new TextEncoder().encode(text), file = hashObject(bytes); objects.set(file, bytes);
      const value = decodeWireDirectory(objects.get(root)!);
      value.entries = [...value.entries.filter(entry => entry.name !== name), { name, file }].sort((a,b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
      const source = encodeWireDirectory(value), candidate = hashObject(source); objects.set(candidate, source);
      return { change: crypto.randomUUID(), candidate, objects: [...objects].map(([hash, bytes]) => ({ hash, bytes })), trace: null, resolves: [], deltas: [] };
    }
    const submit = async (base: string, update: CandidateUpdate) => (await client.submitUpdates(tree, { base, updates: [update] })).results[0]!;
    const base = await submit(head.update, edit(head.root, "Base\n"));
    const first = await submit(base.update.id, edit(base.update.root, "Left\n"));
    const incoming = edit(base.update.root, "Right\n");
    const accepted = await submit(base.update.id, incoming);
    expect(accepted.outcome).toBe("accepted");
    expect(accepted.update.conflicted).toBe(true);
    const inspection = await client.conflicts(tree, accepted.update.id, accepted.update.root);
    expect(inspection.decisions).toHaveLength(1);
    expect(inspection.decisions[0]!.kind).toBe("directory");
    const values = inspection.decisions[0]!.alternatives.map(a => a.value);
    expect(values).toContainEqual({ directory: first.update.root });
    expect(values).toContainEqual({ directory: incoming.candidate });
    expect((await submit(base.update.id, incoming)).update.id).toBe(accepted.update.id);
    for (const [hash, bytes] of (await client.snapshot(tree, accepted.update.root)).objects) objects.set(hash, bytes);
    const later = await submit(accepted.update.id, edit(accepted.update.root, "Continue syncing\n", "later.md"));
    expect(later.outcome).toBe("accepted");
    expect(later.update.conflicted).toBe(true);
    host.server.stop(true); await host.canopy[Symbol.asyncDispose]();
    host = await start(); client = new WireClient(host.url, "owner-token");
    expect((await client.descriptor(tree)).tree.update).toBe(later.update.id);
    expect(await client.conflicts(tree, accepted.update.id, accepted.update.root)).toEqual(inspection);
    await host.canopy.verifyIntegrity();
  } finally {
    host.server.stop(true); await host.canopy[Symbol.asyncDispose]();
    await rm(dir, { recursive: true, force: true });
  }
});
