import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ProjectionProviderHost } from "@arbor/stores";
import { serveCanopy } from "@arbor/canopy";
import { WireClient, WireUpdateConflict, decodeWireDirectory, encodeWireDirectory, hashObject,
  type CandidateUpdate, type WireDirectory, type WireDirectoryEntry } from "@arbor/wire";

let dir: string, running: Awaited<ReturnType<typeof serveCanopy>>, client: WireClient;
let tree: string, base: string, root: string, objects: Map<string, Uint8Array>;
const token = "snapshot-owner";
async function start() {
  running = await serveCanopy({ dataRoot: dir, accounts: [{ handle: "owner", token, communityWriter: true }],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
  client = new WireClient(running.url, token);
}
async function stop() { running.server.stop(true); await running.canopy[Symbol.asyncDispose](); }
function file(text: string) { const bytes = new TextEncoder().encode(text), hash = hashObject(bytes); objects.set(hash, bytes); return hash; }
function directory(value: WireDirectory) {
  value.entries.sort((a,b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const bytes = encodeWireDirectory(value), hash = hashObject(bytes); objects.set(hash, bytes); return hash;
}
function change(basis: string, entries: Record<string, Omit<WireDirectoryEntry, "name"> | null>): string {
  const value = decodeWireDirectory(objects.get(basis)!);
  for (const [name, entry] of Object.entries(entries)) {
    value.entries = value.entries.filter(e => e.name !== name);
    if (entry) value.entries.push({ name, ...entry } as WireDirectoryEntry);
  }
  return directory(value);
}
function snapshot(candidate: string): CandidateUpdate {
  return { change: crypto.randomUUID(), candidate, operations: null, resolves: [], deltas: [],
    objects: [...objects].map(([hash, bytes]) => ({ hash, bytes })) };
}
async function submit(update: CandidateUpdate, basis = base) {
  return (await client.submitUpdates(tree, { base: basis, updates: [update] })).results[0]!.update;
}
async function remember(acceptedRoot: string) {
  for (const [hash, bytes] of (await client.snapshot(tree, acceptedRoot)).objects) objects.set(hash, bytes);
}
function at(acceptedRoot: string, name: string) { return decodeWireDirectory(objects.get(acceptedRoot)!).entries.find(e => e.name === name); }
function guard(state: string, decision: Awaited<ReturnType<WireClient["conflicts"]>>["decisions"][number]) {
  return { state, conflict: decision.id, alternatives: decision.alternatives.map(a => a.id) };
}
beforeEach(async () => {
  dir = await mkdtemp(`${tmpdir()}/arbor-snapshot-accept-`); await start();
  tree = (await client.account()).account.community.id;
  const descriptor = await client.descriptor(tree), initial = await client.snapshot(tree, descriptor.tree.root);
  objects = new Map(initial.objects);
  root = change(initial.root, { "asset.bin": { file: file("original\0") }, "note.md": { file: file("Base\n") } });
  base = (await submit(snapshot(root), descriptor.tree.update)).id;
});
afterEach(async () => { await stop(); await rm(dir, { recursive: true, force: true }); });

test.each(["binary", "delete-edit", "kind", "nested"])("snapshot %s overlap creates accepted alternatives without prior decisions", async kind => {
  const nested = directory({ type: "directory", entries: [{ name: "child.bin", file: file("child") }] });
  const leftValue = kind === "kind" || kind === "nested" ? { directory: nested } : { file: file("left\0") };
  const rightValue = kind === "delete-edit" ? null : kind === "nested"
    ? { directory: directory({ type: "directory", entries: [{ name: "child.bin", file: file("other") }] }) } : { file: file("right\0") };
  if (kind === "nested") { root = change(root, { "asset.bin": { directory: directory({ type: "directory", entries: [{ name: "child.bin", file: file("before") }] }) } }); base = (await submit(snapshot(root))).id; }
  const left = snapshot(change(root, { "asset.bin": leftValue })), right = snapshot(change(root, { "asset.bin": rightValue }));
  const first = await submit(left), accepted = await submit(right);
  expect(accepted.conflicted).toBe(true); expect(accepted.root).toBe(first.root); expect(accepted.id).not.toBe(first.id);
  const watch = client.watch(tree, first.id, { signal: AbortSignal.timeout(3_000) });
  const observed = await watch.next(); await watch.return(undefined);
  expect(observed.value?.kind).toBe("tree.update");
  if (observed.value?.kind === "tree.update") expect(observed.value.transitions.at(-1)!.update).toMatchObject({ id: accepted.id, conflicted: true });
  const page = await client.conflicts(tree, accepted.id, accepted.root), decision = page.decisions[0]!;
  expect(page.decisions).toHaveLength(1); expect(decision.alternatives).toHaveLength(2);
  expect(decision.alternatives.flatMap(a => a.contributions)).toEqual(expect.arrayContaining([
    { change: left.change, operation: null }, { change: right.change, operation: null },
  ]));
  const request = { base, updates: [right] };
  await stop(); await start();
  expect((await client.submitUpdates(tree, request)).results[0]!.update.id).toBe(accepted.id);
  expect(await client.conflicts(tree, accepted.id, accepted.root)).toEqual(page);
  const resolved = await submit({ ...snapshot(right.candidate), resolves: [guard(accepted.id, decision)] }, accepted.id);
  expect(resolved.conflicted).toBe(false); expect(resolved.root).toBe(right.candidate);
  await running.canopy.verifyIntegrity();
});

test("an unresolved binary choice preserves successful Markdown rule output and its objects", async () => {
  const left = snapshot(change(root, { "asset.bin": { file: file("left") }, "note.md": { file: file("Base\nLeft\n") } }));
  const right = snapshot(change(root, { "asset.bin": { file: file("right") }, "note.md": { file: file("Base\nRight\n") } }));
  await submit(left); const accepted = await submit(right); await remember(accepted.root);
  expect((await client.conflicts(tree, accepted.id, accepted.root)).decisions).toHaveLength(1);
  const text = new TextDecoder().decode(objects.get(at(accepted.root, "note.md")!.file!));
  expect(text).toContain("Left\n"); expect(text).toContain("Right\n");
  await running.canopy.verifyIntegrity();
});

test("snapshot suffixes retain hidden attribution and unrelated accepted additions across replay", async () => {
  const peer = snapshot(change(root, { "asset.bin": { file: file("peer") }, "peer.txt": { file: file("keep peer") } }));
  await submit(peer);
  const first = snapshot(change(root, { "asset.bin": { file: file("local") } }));
  const second = snapshot(change(first.candidate, { "asset.bin": { file: file("local continued") }, "new.txt": { file: file("new") } }));
  const request = { base, updates: [first, second] }, response = await client.submitUpdates(tree, request);
  const accepted = response.results[1]!.update; await remember(accepted.root);
  expect(at(accepted.root, "peer.txt")?.file).toBe(file("keep peer")); expect(at(accepted.root, "new.txt")?.file).toBe(file("new"));
  const decisions = (await client.conflicts(tree, accepted.id, accepted.root)).decisions;
  expect(decisions).toHaveLength(1);
  expect(decisions[0]!.alternatives.map(a => a.value)).toContainEqual({ file: file("local continued") });
  await stop(); await start();
  expect(await client.submitUpdates(tree, request)).toEqual(response);
  await running.canopy.verifyIntegrity();
});

async function collection(basis: string, name: string) {
  const local = await mkdtemp(`${tmpdir()}/arbor-snapshot-collection-`), stores = new ProjectionProviderHost();
  try {
    const source = `import { z } from "zod"; export const schema = z.object({ id: z.string(), ${name}: z.string() }); export const primaryKey = ["id"];`;
    await writeFile(`${local}/schema.ts`, source); await writeFile(`${local}/_store.json`, "[]");
    const value = decodeWireDirectory(objects.get(basis)!);
    value.entries = value.entries.filter(e => e.name === "_index.md");
    value.entries.push({ name: "_store.json", file: file("[]") }, { name: "schema.ts", file: file(source) });
    value.childrenSource = { version: 1, type: "collection-file", source: "_store.json", schemaSource: "schema.ts",
      ...((await stores.collectionFileDescriptor(local, "_store.json"))!) };
    return directory(value);
  } finally { await stores[Symbol.asyncDispose](); await rm(local, { recursive: true, force: true }); }
}

test("root directory metadata has an inspectable whole-directory choice, continued edits and guarded resolution", async () => {
  tree = (await client.account()).account.profileTree!;
  const initial = await client.descriptor(tree); root = initial.tree.root; base = initial.tree.update;
  await remember(root);
  const left = snapshot(await collection(root, "left")), right = snapshot(await collection(root, "right"));
  await submit(left); const accepted = await submit(right);
  expect(accepted.conflicted).toBe(true);
  const decision = (await client.conflicts(tree, accepted.id, accepted.root)).decisions[0]!;
  expect(decision.kind).toBe("directory"); expect(decision.alternatives.every(a => a.placement === undefined)).toBe(true);
  expect(decision.alternatives.map(a => a.value)).toEqual(expect.arrayContaining([{ directory: left.candidate }, { directory: right.candidate }]));
  const hidden = decision.alternatives.find(a => "directory" in a.value && a.value.directory === right.candidate)!;
  await expect(client.object(tree, right.candidate)).rejects.toThrow();
  const hiddenRead = await fetch(`${running.url}/.arbor/trees/${tree}/conflicts/${decision.id}/alternatives/${hidden.id}/objects/${right.candidate}?state=${accepted.id}`,
    { headers: { authorization: `Bearer ${token}` } });
  expect(hiddenRead.status).toBe(200); expect(hashObject(new Uint8Array(await hiddenRead.arrayBuffer()))).toBe(right.candidate);
  const body = new TextDecoder().decode(objects.get(at(accepted.root, "_index.md")!.file!)) + "Continued\n";
  const continued = await submit(snapshot(change(accepted.root, { "_index.md": { file: file(body) } })), accepted.id);
  expect(continued.conflicted).toBe(true); await remember(continued.root);
  expect(at(continued.root, "_index.md")?.file).toBe(file(body));
  await expect(submit({ ...snapshot(right.candidate), resolves: [guard(accepted.id, decision)] }, continued.id)).rejects.toBeInstanceOf(WireUpdateConflict);
  const latest = (await client.conflicts(tree, continued.id, continued.root)).decisions[0]!;
  const resolved = await submit({ ...snapshot(right.candidate), resolves: [guard(continued.id, latest)] }, continued.id);
  expect(resolved.root).toBe(right.candidate); expect(resolved.conflicted).toBe(false);
  await stop(); await start(); await running.canopy.verifyIntegrity();
});


test("root choices retain coupled child decisions and hidden directory successors across restart", async () => {
  tree = (await client.account()).account.profileTree!;
  const initial = await client.descriptor(tree); root = initial.tree.root; base = initial.tree.update;
  await remember(root);
  const body = new TextDecoder().decode(objects.get(at(root, "_index.md")!.file!));
  // Divergent frontmatter edits force a child decision before metadata changes.
  const bodyFor = (title: string) => body.replace("---\n", `---\ntitle: ${title}\n`);
  const left = snapshot(change(root, { "_index.md": { file: file(bodyFor("Left")) } }));
  const right = snapshot(change(root, { "_index.md": { file: file(bodyFor("Right")) } }));
  await submit(left); const childState = await submit(right); await remember(childState.root);
  expect(childState.conflicted).toBe(true);
  const first = snapshot(await collection(childState.root, "choice"));
  const second = snapshot(change(first.candidate, { "_index.md": { file: file(bodyFor("Hidden")) } }));
  const request = { base: childState.id, updates: [first, second] };
  const response = await client.submitUpdates(tree, request), accepted = response.results[1]!.update;
  const page = await client.conflicts(tree, accepted.id, accepted.root);
  expect(page.decisions).toHaveLength(2);
  const parent = page.decisions.find(d => d.kind === "directory")!, child = page.decisions.find(d => d.kind === "entry")!;
  expect(parent.dependencies).toEqual([child.id]); expect(child.dependencies).toEqual([parent.id]);
  expect(parent.alternatives.map(a => a.value)).toContainEqual({ directory: second.candidate });
  await expect(submit({ ...snapshot(second.candidate), resolves: [guard(accepted.id, parent)] }, accepted.id)).rejects.toBeInstanceOf(WireUpdateConflict);
  await stop(); await start();
  expect((await client.submitUpdates(tree, request)).results).toEqual(response.results);
  const resolved = await submit({ ...snapshot(second.candidate), resolves: page.decisions.map(d => guard(accepted.id, d)) }, accepted.id);
  expect(resolved.root).toBe(second.candidate); expect(resolved.conflicted).toBe(false);
  await running.canopy.verifyIntegrity();
});

test("an exact-state guard still rejects snapshot work without creating accepted history", async () => {
  const first = await submit(snapshot(change(root, { "asset.bin": { file: file("first") } })));
  const stale = { ...snapshot(change(root, { "asset.bin": { file: file("second") } })), ifCurrent: base };
  await expect(submit(stale)).rejects.toBeInstanceOf(WireUpdateConflict);
  expect((await client.descriptor(tree)).tree.update).toBe(first.id);
  expect((await client.conflicts(tree, first.id, first.root)).decisions).toEqual([]);
});


test.each([false, true])("divergent snapshot renames remain a coupled choice (nested: %s)", async nested => {
  const page = file("---\nid: pg_moving\n---\nExact bytes\r\n");
  const before = directory({ type: "directory", entries: [{ name: "before.md", file: page }] });
  const left = directory({ type: "directory", entries: [{ name: "left.md", file: page }] });
  const right = directory({ type: "directory", entries: [{ name: "right.md", file: page }] });
  if (nested) root = change(root, { folder: { directory: before } });
  else root = change(root, { "before.md": { file: page } });
  base = (await submit(snapshot(root))).id;
  const a = snapshot(nested ? change(root, { folder: { directory: left } }) : change(root, { "before.md": null, "left.md": { file: page } }));
  const b = snapshot(nested ? change(root, { folder: { directory: right } }) : change(root, { "before.md": null, "right.md": { file: page } }));
  const first = await submit(a), accepted = await submit(b);
  expect(accepted.conflicted).toBe(true); expect(accepted.root).toBe(first.root);
  const decisions = (await client.conflicts(tree, accepted.id, accepted.root)).decisions;
  expect(decisions).toHaveLength(1);
  expect(decisions[0]!.alternatives.map(a => a.value)).toEqual(expect.arrayContaining([
    { directory: nested ? left : a.candidate }, { directory: nested ? right : b.candidate },
  ]));
  const resolved = await submit({ ...snapshot(b.candidate), resolves: [guard(accepted.id, decisions[0]!)] }, accepted.id);
  expect(resolved.conflicted).toBe(false); expect(resolved.root).toBe(b.candidate);
  await running.canopy.verifyIntegrity();
});

test("a snapshot successor of a clean merged prefix preserves peer additions", async () => {
  await submit(snapshot(change(root, { "peer.txt": { file: file("keep") } })));
  const first = snapshot(change(root, { "asset.bin": { file: file("local") } }));
  const second = snapshot(change(first.candidate, { "asset.bin": { file: file("continued") } }));
  const response = await client.submitUpdates(tree, { base, updates: [first, second] });
  const accepted = response.results[1]!.update; await remember(accepted.root);
  expect(at(accepted.root, "peer.txt")?.file).toBe(file("keep"));
  expect(at(accepted.root, "asset.bin")?.file).toBe(file("continued"));
  expect(accepted.conflicted).toBe(false);
  await running.canopy.verifyIntegrity();
});


test("snapshot ambiguity and accepted identity commit atomically", async () => {
  const left = snapshot(change(root, { "asset.bin": { file: file("left") } }));
  const right = snapshot(change(root, { "asset.bin": { file: file("right") } }));
  const prior = await submit(left), db = new Database(`${dir}/canopy.sqlite3`);
  try {
    db.run("CREATE TRIGGER fail_snapshot_conflict AFTER INSERT ON accepted_conflicts BEGIN SELECT RAISE(ABORT, 'injected snapshot conflict failure'); END");
    await expect(submit(right)).rejects.toThrow("injected snapshot conflict failure");
    expect((await client.descriptor(tree)).tree.update).toBe(prior.id);
    db.run("DROP TRIGGER fail_snapshot_conflict");
    expect((await submit(right)).conflicted).toBe(true);
    await running.canopy.verifyIntegrity();
  } finally { db.close(); }
});
