import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveCanopy } from "@overstory/canopyd";
import { WireClient, WireHTTPError, decodeWireDirectory, encodeWireDirectory, hashObject, type CandidateUpdate, type WireDirectoryEntry } from "@overstory/protocol";
import { writeFile } from "node:fs/promises";

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
  await scenario(async ({ start, client, host, dir }) => {
    // The sidecar still answers; only its tree merge fails.
    const script = join(dir, "failing-merge.ts");
    const cli = new URL("../../../packages/canopyd-merge/src/cli.ts", import.meta.url).pathname;
    await writeFile(script, `import {run} from ${JSON.stringify(cli)};
      await run(process.argv.slice(2), { treeMerge: async () => { throw new Error("injected merge failure"); } });`);
    await start({ command: [process.execPath, script], timeoutMs: 30_000 });
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

test("an edit after a kept root choice leaves the deletion it declined unapplied", async () => {
  // The conflict lab's `kind`, `delete-edit`, `list-item` sequence: with an
  // entry-kind choice open, a delete/edit conflict becomes a root choice that
  // keeps the current tree. Its candidate's deletion is recorded but declined,
  // so the next traced edit must not have it enforced on the kept tree.
  await scenario(async ({ start, client, host }) => {
    await start();
    const tree = (await client().account()).account.community.id;
    const objects = new Map((await client().snapshot(tree, (await client().descriptor(tree)).tree.root)).objects);
    const put = (bytes: Uint8Array) => { const hash = hashObject(bytes); objects.set(hash, bytes); return hash; };
    const text = (hash: string) => new TextDecoder().decode(objects.get(hash)!);
    const directory = (entries: WireDirectoryEntry[]) =>
      put(encodeWireDirectory({ type: "directory", entries: entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))) }));
    const entries = (root: string) => decodeWireDirectory(objects.get(root)!).entries;
    const file = (root: string, name: string) => (entries(root).find(entry => entry.name === name) as { file: string }).file;
    const update = (candidate: string, trace: CandidateUpdate["trace"]): CandidateUpdate =>
      ({ change: crypto.randomUUID(), candidate, trace, resolves: [], deltas: [], objects: [...objects].map(([hash, bytes]) => ({ hash, bytes })) });
    const snapshot = (root: string, name: string, value: WireDirectoryEntry) =>
      update(directory([...entries(root).filter(entry => entry.name !== name), value]), null);
    const traced = (root: string, name: string, find: string, replacement: string) => {
      const object = file(root, name), source = Buffer.from(objects.get(object)!), at = source.indexOf(find);
      const next = put(Buffer.concat([source.subarray(0, at), Buffer.from(replacement), source.subarray(at + Buffer.byteLength(find))]));
      const candidate = directory([...entries(root).filter(entry => entry.name !== name), { name, file: next }]);
      return update(candidate, [{ before: root, after: candidate, operations: [{ key: "edit", kind: "editSource",
        source: { material: { kind: "basis", path: `/${name}`, object }, range: [at, at + Buffer.byteLength(find)] }, text: replacement }] }]);
    };
    const submit = async (base: string, candidate: CandidateUpdate) => {
      const result = (await client().submitUpdates(tree, { base, updates: [candidate] })).results[0]!;
      expect(result.outcome).toBe("accepted");
      for (const [hash, bytes] of (await client().snapshot(tree, result.update.root)).objects) objects.set(hash, bytes);
      return result.update;
    };
    const block = "- Once Rebecca is here\n  - Run\n  - Tips for each of the cleaners €40\n  - Groceries\n\n";
    const head = (await client().descriptor(tree)).tree;
    const kindBase = await submit(head.update, update(directory([...entries(head.root),
      { name: "Assets", file: put(new TextEncoder().encode("Assets is a file for now.\n")) },
      { name: "Errands.md", file: put(new TextEncoder().encode(`# Errands\n\n${block}Call the landlord.\n`)) },
      { name: "List.md", file: put(new TextEncoder().encode("- Milk\n- Eggs from the farm stand\n")) },
    ]), null));
    // An entry-kind choice: a file edited on one side, a folder on the other.
    await submit(kindBase.id, snapshot(kindBase.root, "Assets", { name: "Assets", file: put(new TextEncoder().encode("Assets, edited.\n")) }));
    const kind = await submit(kindBase.id, snapshot(kindBase.root, "Assets",
      { name: "Assets", directory: directory([{ name: "logo.txt", file: put(new TextEncoder().encode("logo\n")) }]) }));
    // A delete/edit of the same block, each traced from the same head.
    const edited = await submit(kind.id, traced(kind.root, "Errands.md", "€40", "€50"));
    const kept = await submit(kind.id, traced(kind.root, "Errands.md", block, ""));
    expect(kept.root).toBe(edited.root);
    const choices = await client().conflicts(tree, kept.id, kept.root);
    expect(choices.decisions.filter(decision => decision.kind === "directory").length).toBeGreaterThan(1);
    const later = await submit(kept.id, traced(kept.root, "List.md", "Eggs from the farm stand", "Eggs (a dozen)"));
    expect(text(file(later.root, "Errands.md"))).toContain("cleaners €50\n  - Groceries");
    expect(text(file(later.root, "List.md"))).toContain("Eggs (a dozen)");
    await host().canopy.verifyIntegrity();
  });
});
