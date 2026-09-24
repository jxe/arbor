import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveCanopy } from "@overstory/canopyd";
import { WireClient, WireHTTPError, decodeWireDirectory, encodeWireDirectory, hashObject, type CandidateUpdate } from "@overstory/protocol";
import type { MergeTool } from "../../../packages/canopyd/src/merge-tool.ts";

async function scenario(run: (context: {
  start: (mergeTool?: { command: string[]; timeoutMs: number }) => Promise<void>;
  client: () => WireClient;
  host: () => Awaited<ReturnType<typeof serveCanopy>>;
  dir: string;
}) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "arbor-merge-failure-"));
  let host: Awaited<ReturnType<typeof serveCanopy>> | undefined;
  const stop = async () => { if (host) { host.server.stop(true); await host.canopy[Symbol.asyncDispose](); host = undefined; } };
  try {
    await run({
      dir,
      start: async (mergeTool) => {
        await stop();
        host = await serveCanopy({ dataRoot: dir, publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
          accounts: [{ handle: "owner", token: "owner-token", communityWriter: true }], ...(mergeTool ? { mergeTool } : {}) });
      },
      client: () => new WireClient(host!.url, "owner-token"),
      host: () => host!,
    });
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
}

function editor(objects: Map<string, Uint8Array>) {
  return (root: string, text: string, name = "note.md"): CandidateUpdate => {
    const bytes = new TextEncoder().encode(text), file = hashObject(bytes); objects.set(file, bytes);
    const value = decodeWireDirectory(objects.get(root)!);
    value.entries = [...value.entries.filter(entry => entry.name !== name), { name, file }].sort((a,b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    const source = encodeWireDirectory(value), candidate = hashObject(source); objects.set(candidate, source);
    return { change: crypto.randomUUID(), candidate, objects: [...objects].map(([hash, bytes]) => ({ hash, bytes })), trace: null, resolves: [], deltas: [] };
  };
}

test("a failed tree merge accepts preserved alternatives, survives restart and permits further publication", async () => {
  await scenario(async ({ start, client, host }) => {
    // The worker still records merge states; only its tree merge fails.
    const failTreeMerges = () => {
      const tool = (host().canopy as unknown as { mergeTool: MergeTool }).mergeTool;
      const evaluate = tool.evaluate.bind(tool);
      tool.evaluate = (async (request: any, inputs: ReadonlyMap<string, Uint8Array>) => {
        if (request.kind === "tree" && !("change" in request.incoming)) throw new Error("injected merge failure");
        return evaluate(request, inputs);
      }) as typeof tool.evaluate;
    };
    await start(); failTreeMerges();
    const tree = (await client().account()).account.community.id;
    const head = (await client().descriptor(tree)).tree;
    const objects = new Map((await client().snapshot(tree, head.root)).objects);
    const edit = editor(objects);
    const submit = async (base: string, update: CandidateUpdate) => (await client().submitUpdates(tree, { base, updates: [update] })).results[0]!;
    const base = await submit(head.update, edit(head.root, "Base\n"));
    const first = await submit(base.update.id, edit(base.update.root, "Left\n"));
    const incoming = edit(base.update.root, "Right\n");
    const accepted = await submit(base.update.id, incoming);
    expect(accepted.outcome).toBe("accepted");
    expect(accepted.update.conflicted).toBe(true);
    expect(accepted.update.root).toBe(first.update.root);
    const inspection = await client().conflicts(tree, accepted.update.id, accepted.update.root);
    expect(inspection.decisions).toHaveLength(1);
    expect(inspection.decisions[0]!.kind).toBe("directory");
    const values = inspection.decisions[0]!.alternatives.map(a => a.value);
    expect(values).toContainEqual({ directory: first.update.root });
    expect(values).toContainEqual({ directory: incoming.candidate });
    expect((await submit(base.update.id, incoming)).update.id).toBe(accepted.update.id);
    for (const [hash, bytes] of (await client().snapshot(tree, accepted.update.root)).objects) objects.set(hash, bytes);
    const later = await submit(accepted.update.id, edit(accepted.update.root, "Continue syncing\n", "later.md"));
    expect(later.outcome).toBe("accepted");
    expect(later.update.conflicted).toBe(true);
    await start();
    expect((await client().descriptor(tree)).tree.update).toBe(later.update.id);
    expect(await client().conflicts(tree, accepted.update.id, accepted.update.root)).toEqual(inspection);
    await host().canopy.verifyIntegrity();
  });
});

test("an unavailable worker accepts nothing, retryably, and the retry succeeds once it returns", async () => {
  await scenario(async ({ start, client, dir }) => {
    await start();
    const tree = (await client().account()).account.community.id;
    const head = (await client().descriptor(tree)).tree;
    const objects = new Map((await client().snapshot(tree, head.root)).objects);
    const request = { base: head.update, updates: [editor(objects)(head.root, "Offline\n")] };
    await start({ command: [join(dir, "missing-merge-executable")], timeoutMs: 100 });
    const failure = await client().submitUpdates(tree, request).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(WireHTTPError);
    expect((failure as WireHTTPError).status).toBe(503);
    expect((await client().descriptor(tree)).tree.update).toBe(head.update);
    await start();
    const accepted = (await client().submitUpdates(tree, request)).results[0]!;
    expect(accepted.outcome).toBe("accepted");
    expect(accepted.update.root).toBe(request.updates[0]!.candidate);
  });
});
