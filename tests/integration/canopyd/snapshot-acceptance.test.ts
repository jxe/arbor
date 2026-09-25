import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { ProjectionProviderHost } from "@overstory/arborsync/state";
import { serveHost } from "@overstory/canopyd";
import { acceptedEntries } from "../../support/log-entries.ts";
import { expectReplayableHistory } from "../../support/replay-check.ts";
import { ProtocolClient, ProtocolUpdateConflict, decodeProtocolDirectory, encodeProtocolDirectory, hashObject,
  type CandidateUpdate, type Hash, type ProtocolDirectory, type ProtocolDirectoryEntry } from "@overstory/protocol";
import { collectionChildSetHash } from "@overstory/collection-schema";

let dir: string, running: Awaited<ReturnType<typeof serveHost>>, client: ProtocolClient;
let tree: string, base: string, root: string, objects: Map<string, Uint8Array>;
const token = "snapshot-owner";
async function start() {
  running = await serveHost({ dataRoot: dir, accounts: [{ handle: "owner", token, communityWriter: true }],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0 });
  client = new ProtocolClient(running.url, token);
}
async function stop() { running.server.stop(true); await running.canopy[Symbol.asyncDispose](); }
function file(text: string) { const bytes = new TextEncoder().encode(text), hash = hashObject(bytes); objects.set(hash, bytes); return hash; }
function directory(value: ProtocolDirectory) {
  value.entries.sort((a,b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  const bytes = encodeProtocolDirectory(value), hash = hashObject(bytes); objects.set(hash, bytes); return hash;
}
function change(basis: string, entries: Record<string, Omit<ProtocolDirectoryEntry, "name"> | null>): string {
  const value = decodeProtocolDirectory(objects.get(basis)!);
  for (const [name, entry] of Object.entries(entries)) {
    value.entries = value.entries.filter(e => e.name !== name);
    if (entry) value.entries.push({ name, ...entry } as ProtocolDirectoryEntry);
  }
  return directory(value);
}
function snapshot(candidate: string): CandidateUpdate {
  return { change: crypto.randomUUID(), candidate, trace: null, resolves: [], deltas: [],
    objects: [...objects].map(([hash, bytes]) => ({ hash, bytes })) };
}
async function submit(update: CandidateUpdate, basis = base) {
  return (await client.submitUpdates(tree, { base: basis, updates: [update] })).results[0]!.update;
}
async function remember(acceptedRoot: string) {
  for (const [hash, bytes] of (await client.snapshot(tree, acceptedRoot)).objects) objects.set(hash, bytes);
}
function at(acceptedRoot: string, name: string) { return decodeProtocolDirectory(objects.get(acceptedRoot)!).entries.find(e => e.name === name); }
function guard(state: string, decision: Awaited<ReturnType<ProtocolClient["conflicts"]>>["decisions"][number]) {
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
afterEach(async () => {
  try { await expectReplayableHistory(dir, tree); }
  finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});

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
  // The suffix continues the prefix's hidden alternative: one choice, same identity.
  const prefix = (await client.conflicts(tree, response.results[0]!.update.id, response.results[0]!.update.root)).decisions;
  expect(decisions[0]!.id).toBe(prefix[0]!.id);
  expect(decisions[0]!.alternatives.map(a => a.value)).not.toContainEqual({ file: file("local") });
  await stop(); await start();
  expect(await client.submitUpdates(tree, request)).toEqual(response);
  await running.canopy.verifyIntegrity();
});

async function collection(basis: string, name: string) {
  const local = await mkdtemp(`${tmpdir()}/arbor-snapshot-collection-`), stores = new ProjectionProviderHost();
  try {
    const source = `overstory-schema-version = 1\noverstory-primary-key = ["id"]\nrow = { id: tstr, ${name}: tstr }\n`;
    await writeFile(`${local}/schema.cddl`, source); await writeFile(`${local}/_store.json`, "[]");
    const value = decodeProtocolDirectory(objects.get(basis)!);
    value.entries = value.entries.filter(e => e.name === "_index.md");
    value.entries.push({ name: "_store.json", file: file("[]") }, { name: "schema.cddl", file: file(source) });
    value.childrenSource = { version: 1, type: "collection-file", source: "_store.json", schemaSource: "schema.cddl",
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
  expect(hidden.id).not.toBe(decision.selected);
  // Hidden alternative material is accepted-state material: it reads through the ordinary object route.
  expect(hashObject(await client.object(tree, right.candidate))).toBe(right.candidate);
  const unrelated = hashObject(new TextEncoder().encode(`never accepted ${crypto.randomUUID()}`));
  const unreachable = await fetch(`${running.url}/.arbor/trees/${tree}/objects/${unrelated}`, { headers: { authorization: `Bearer ${token}` } });
  expect(unreachable.status).toBe(404);
  const body = new TextDecoder().decode(objects.get(at(accepted.root, "_index.md")!.file!)) + "Continued\n";
  const continued = await submit(snapshot(change(accepted.root, { "_index.md": { file: file(body) } })), accepted.id);
  expect(continued.conflicted).toBe(true); await remember(continued.root);
  expect(at(continued.root, "_index.md")?.file).toBe(file(body));
  await expect(submit({ ...snapshot(right.candidate), resolves: [guard(accepted.id, decision)] }, continued.id)).rejects.toBeInstanceOf(ProtocolUpdateConflict);
  const latest = (await client.conflicts(tree, continued.id, continued.root)).decisions[0]!;
  const resolved = await submit({ ...snapshot(right.candidate), resolves: [guard(continued.id, latest)] }, continued.id);
  expect(resolved.root).toBe(right.candidate); expect(resolved.conflicted).toBe(false);
  await stop(); await start(); await running.canopy.verifyIntegrity();
});


test("a batch that changes root metadata beside an open file choice continues that choice across restart", async () => {
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
  // Root metadata does not touch the file choice's material, so no root choice
  // encloses it; the displayed file's edit continues the selected alternative.
  expect(accepted.root).toBe(second.candidate); expect(accepted.conflicted).toBe(true);
  const before = (await client.conflicts(tree, childState.id, childState.root)).decisions[0]!;
  const page = await client.conflicts(tree, accepted.id, accepted.root);
  expect(page.decisions).toHaveLength(1);
  const child = page.decisions[0]!;
  expect(child.kind).toBe("entry"); expect(child.id).toBe(before.id);
  expect(child.alternatives.find(a => a.id === child.selected)!.value).toEqual({ file: file(bodyFor("Hidden")) });
  expect(child.alternatives.map(a => a.value)).toContainEqual(before.alternatives.find(a => a.id !== before.selected)!.value);
  await stop(); await start();
  expect((await client.submitUpdates(tree, request)).results).toEqual(response.results);
  const resolved = await submit({ ...snapshot(second.candidate), resolves: page.decisions.map(d => guard(accepted.id, d)) }, accepted.id);
  expect(resolved.root).toBe(second.candidate); expect(resolved.conflicted).toBe(false);
  await running.canopy.verifyIntegrity();
});

test("an exact-state guard still rejects snapshot work without creating accepted history", async () => {
  const first = await submit(snapshot(change(root, { "asset.bin": { file: file("first") } })));
  const stale = { ...snapshot(change(root, { "asset.bin": { file: file("second") } })), ifCurrent: base };
  await expect(submit(stale)).rejects.toBeInstanceOf(ProtocolUpdateConflict);
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

// A folder the tree merge cannot reconcile is one choice about that folder,
// as it was before every snapshot recorded a merge state.
function folderOf(entries: Record<string, string | ProtocolDirectoryEntry>) {
  return directory({ type: "directory", entries: Object.entries(entries).map(([name, value]) =>
    typeof value === "string" ? { name, file: file(value) } : { ...value, name }) });
}
const movingPage = "---\nid: pg_moving\n---\nExact bytes\r\n";
async function folderConflict(extra: { left?: Record<string, Omit<ProtocolDirectoryEntry, "name"> | null>; right?: Record<string, Omit<ProtocolDirectoryEntry, "name"> | null> } = {}) {
  const inner = (name: string) => folderOf({ [name]: movingPage });
  const outer = (name: string, x: string) => folderOf({ inner: { name: "inner", directory: inner(name) }, "x.txt": x });
  root = change(root, { outer: { directory: outer("before.md", "x") } });
  base = (await submit(snapshot(root))).id;
  const a = snapshot(change(root, { outer: { directory: outer("left.md", "x") }, ...extra.left }));
  const b = snapshot(change(root, { outer: { directory: outer("right.md", "x2") }, "b-only.txt": { file: file("b") }, ...extra.right }));
  const first = await submit(a), accepted = await submit(b);
  await remember(accepted.root);
  return { a, b, first, accepted, inner, outer };
}

test.each(["current", "incoming"])("a nested folder conflict is one choice about that folder; the rest merges (resolve: %s)", async side => {
  const { a, b, accepted, inner, outer } = await folderConflict();
  expect(accepted.conflicted).toBe(true);
  const page = await client.conflicts(tree, accepted.id, accepted.root);
  expect(page.decisions).toHaveLength(1);
  const decision = page.decisions[0]!;
  const parent = { material: { kind: "basis" as const, path: "/", object: accepted.root }, within: ["outer"] };
  expect(decision).toMatchObject({ kind: "entry", affected: [parent], dependencies: [], actions: ["resolveConflict"] });
  expect(decision.alternatives.map((alternative) => [alternative.value, alternative.placement, alternative.contributions])).toEqual([
    [{ directory: inner("left.md") }, { parent, name: "inner" }, [{ change: a.change, operation: null }]],
    [{ directory: inner("right.md") }, { parent, name: "inner" }, [{ change: b.change, operation: null }]],
  ]);
  expect(decision.selected).toBe(decision.alternatives[0]!.id);
  // Everything outside the folder merged: the incoming sibling edit and addition show.
  const shown = decodeProtocolDirectory(objects.get(at(accepted.root, "outer")!.directory!)!);
  expect(shown.entries.map((e) => [e.name, e.file ?? e.directory])).toEqual([["inner", inner("left.md")], ["x.txt", file("x2")]]);
  expect(at(accepted.root, "b-only.txt")?.file).toBe(file("b"));
  const chosen = side === "current" ? accepted.root
    : change(accepted.root, { outer: { directory: outer("right.md", "x2") } });
  const resolved = await submit({ ...snapshot(chosen), resolves: [guard(accepted.id, decision)] }, accepted.id);
  expect(resolved.conflicted).toBe(false); expect(resolved.root).toBe(chosen);
  expect((await client.conflicts(tree, resolved.id, resolved.root)).decisions).toEqual([]);
  await running.canopy.verifyIntegrity();
});

test("a file conflict and a folder conflict in one snapshot are separate choices", async () => {
  const { accepted, inner } = await folderConflict({ left: { "asset.bin": { file: file("left\0") } }, right: { "asset.bin": { file: file("right\0") } } });
  const decisions = (await client.conflicts(tree, accepted.id, accepted.root)).decisions;
  const scopes = decisions.map((d) => [d.kind, d.alternatives[0]!.placement?.parent.within ?? [], d.alternatives[0]!.placement?.name, d.alternatives.map((a) => a.value)]);
  expect(scopes).toEqual(expect.arrayContaining([
    ["entry", [], "asset.bin", [{ file: file("left\0") }, { file: file("right\0") }]],
    ["entry", ["outer"], "inner", [{ directory: inner("left.md") }, { directory: inner("right.md") }]],
  ]));
  expect(decisions).toHaveLength(2);
  // Resolving one leaves the other open.
  const folder = decisions.find((d) => d.alternatives[0]!.placement?.name === "inner")!;
  const resolved = await submit({ ...snapshot(accepted.root), resolves: [guard(accepted.id, folder)] }, accepted.id);
  expect(resolved.conflicted).toBe(true);
  const left = (await client.conflicts(tree, resolved.id, resolved.root)).decisions;
  expect(left.map((d) => d.alternatives[0]!.placement?.name)).toEqual(["asset.bin"]);
  await running.canopy.verifyIntegrity();
});

test("a file conflict inside a conflicting folder is part of the folder's choice", async () => {
  const { accepted } = await folderConflict({
    left: { outer: { directory: folderOf({ inner: { name: "inner", directory: folderOf({ "left.md": movingPage, "data.bin": "L\0" }) }, "x.txt": "x" }) } },
    right: { outer: { directory: folderOf({ inner: { name: "inner", directory: folderOf({ "right.md": movingPage, "data.bin": "R\0" }) }, "x.txt": "x2" }) } },
  });
  const decisions = (await client.conflicts(tree, accepted.id, accepted.root)).decisions;
  expect(decisions).toHaveLength(1);
  expect(decisions[0]!.alternatives.map((a) => a.placement?.name)).toEqual(["inner", "inner"]);
  await running.canopy.verifyIntegrity();
});

test("an edit inside a conflicting folder continues its displayed version", async () => {
  const { accepted, inner } = await folderConflict();
  const decision = (await client.conflicts(tree, accepted.id, accepted.root)).decisions[0]!;
  const edited = folderOf({ "left.md": movingPage, "added.md": "Added\n" });
  const outerNow = decodeProtocolDirectory(objects.get(at(accepted.root, "outer")!.directory!)!);
  const outer = directory({ ...outerNow, entries: outerNow.entries.map((e) => e.name === "inner" ? { name: "inner", directory: edited } : e) });
  const next = await submit(snapshot(change(accepted.root, { outer: { directory: outer } })), accepted.id);
  expect(next.conflicted).toBe(true);
  expect(next.root).toBe(change(accepted.root, { outer: { directory: outer } }));
  const continued = (await client.conflicts(tree, next.id, next.root)).decisions;
  expect(continued).toHaveLength(1);
  expect(continued[0]!.id).toBe(decision.id);
  expect(continued[0]!.alternatives.map((a) => a.value)).toEqual([{ directory: edited }, { directory: inner("right.md") }]);
  await running.canopy.verifyIntegrity();
});

test("a folder choice depends on the open choices inside its folder", async () => {
  const inner = (entries: Record<string, string>) => ({ folder: { directory: folderOf(entries) } });
  root = change(root, inner({ "before.md": movingPage, "data.bin": "base\0" }));
  base = (await submit(snapshot(root))).id;
  await submit(snapshot(change(root, inner({ "before.md": movingPage, "data.bin": "one\0" }))));
  const fileChoice = await submit(snapshot(change(root, inner({ "before.md": movingPage, "data.bin": "two\0" }))));
  const [file] = (await client.conflicts(tree, fileChoice.id, fileChoice.root)).decisions;
  expect(file!.alternatives[0]!.placement?.name).toBe("data.bin");
  await remember(fileChoice.root);
  const shownFolder = at(fileChoice.root, "folder")!.directory!;
  const renamed = (name: string) => change(fileChoice.root, { folder: { directory: directory({
    ...decodeProtocolDirectory(objects.get(shownFolder)!),
    entries: decodeProtocolDirectory(objects.get(shownFolder)!).entries.map((e) => e.name === "before.md" ? { ...e, name } : e) }) } });
  await submit(snapshot(renamed("left.md")), fileChoice.id);
  const accepted = await submit(snapshot(renamed("right.md")), fileChoice.id);
  const decisions = (await client.conflicts(tree, accepted.id, accepted.root)).decisions;
  const folder = decisions.find((d) => d.alternatives[0]!.placement?.name === "folder")!;
  const inside = decisions.find((d) => d.alternatives[0]!.placement?.name === "data.bin")!;
  expect(decisions).toHaveLength(2);
  expect(folder.dependencies).toEqual([inside.id]);
  // Replacing the folder must also resolve the choice inside it.
  await expect(submit({ ...snapshot(renamed("right.md")), resolves: [guard(accepted.id, folder)] }, accepted.id)).rejects.toBeInstanceOf(ProtocolUpdateConflict);
  const resolved = await submit({ ...snapshot(renamed("right.md")), resolves: [guard(accepted.id, folder), guard(accepted.id, inside)] }, accepted.id);
  expect(resolved.conflicted).toBe(false); expect(resolved.root).toBe(renamed("right.md"));
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
    db.run("CREATE TRIGGER fail_snapshot_conflict AFTER INSERT ON accepted_updates BEGIN SELECT RAISE(ABORT, 'injected snapshot conflict failure'); END");
    await expect(submit(right)).rejects.toThrow("injected snapshot conflict failure");
    expect((await client.descriptor(tree)).tree.update).toBe(prior.id);
    db.run("DROP TRIGGER fail_snapshot_conflict");
    expect((await submit(right)).conflicted).toBe(true);
    await running.canopy.verifyIntegrity();
  } finally { db.close(); }
});

test("every acceptance records a log entry after its predecessor's, and only profile trees have profile facts, for their heads", async () => {
  const left = snapshot(change(root, { "asset.bin": { file: file("left") } }));
  const right = snapshot(change(root, { "asset.bin": { file: file("right") } }));
  await submit(left); const accepted = await submit(right);
  const refused = { ...snapshot(change(root, { "asset.bin": { file: file("refused") } })), ifCurrent: base };
  await expect(submit(refused)).rejects.toBeInstanceOf(ProtocolUpdateConflict);
  const db = new Database(`${dir}/canopy.sqlite3`, { readonly: true });
  try {
    // Bootstrap trees, their boundary attachments and every snapshot.
    const entries = acceptedEntries(dir);
    const byID = new Map(entries.map((e) => [e.id, e]));
    for (const row of db.query("SELECT ordinal, previous_ordinal FROM accepted_updates").all() as Array<{ ordinal: number; previous_ordinal: number | null }>)
      expect(byID.get(String(row.ordinal))!.entry.previous).toBe(row.previous_ordinal === null ? null : byID.get(String(row.previous_ordinal))!.hash);
    expect(byID.get(accepted.id)!.entry.decisions).toHaveLength(1);
    expect(db.query("SELECT key FROM meta WHERE key LIKE 'profile:%'").all()).toEqual([]);
    const profiles = db.query("SELECT tree_id, index_hash, facts FROM profile_facts").all() as Array<{ tree_id: string; index_hash: string; facts: string }>;
    // The community and the owner's profile; the configuration tree has none.
    expect(profiles).toHaveLength(2);
    expect(profiles.map(p => JSON.parse(p.facts).type).sort()).toEqual(["group", "person"]);
    const community = profiles.find(p => p.tree_id === tree)!;
    expect(community.index_hash).toBe(at(accepted.root, "_index.md")!.file!);
  } finally { db.close(); }
});

test("health checks only the database while integrity audits history in one shared run", async () => {
  const health = await fetch(`${running.url}/.arbor/health`);
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: "ok" });
  const first = running.canopy.verifyIntegrity();
  expect(running.canopy.verifyIntegrity()).toBe(first);
  await first;
  const integrity = await fetch(`${running.url}/.arbor/integrity`);
  expect(integrity.status).toBe(200);
  expect(await integrity.json()).toEqual({ status: "ok" });
});

test("the host validates declarative collections itself and preserves undeclared row members", async () => {
  const schema = 'overstory-schema-version = 1\noverstory-primary-key = ["id"]\nrow = { id: tstr, count: uint }\n';
  const people = (rows: Array<Record<string, unknown>>, declared = rows) => directory({
    type: "directory",
    entries: [{ name: "_store.json", file: file(`${JSON.stringify(rows)}\n`) }, { name: "schema.cddl", file: file(schema) }],
    childrenSource: {
      version: 1, type: "collection-file", format: "json", source: "_store.json", schemaSource: "schema.cddl",
      schemaFingerprint: hashObject(new TextEncoder().encode(schema)) as Hash,
      childSetHash: collectionChildSetHash(declared.map((row) => ({ key: `[["id",${JSON.stringify(row.id)}]]`, name: String(row.id), properties: row }))),
    },
  });
  // Invalid rows and a client-asserted hash that the host recomputes differently are both rejected.
  await expect(submit(snapshot(change(root, { people: { directory: people([{ id: "a", count: -1 }]) } })))).rejects.toThrow();
  await expect(submit(snapshot(change(root, { people: { directory: people([{ id: "a", count: 1 }], [{ id: "a", count: 2 }]) } })))).rejects.toThrow();

  // An undeclared member is accepted, but a declared member keeps its type.
  await expect(submit(snapshot(change(root, { people: { directory: people([{ id: "a", count: "1", note: "x" }]) } })))).rejects.toThrow();

  const accepted = await submit(snapshot(change(root, { people: { directory: people([{ id: "a", count: 1, note: { kept: [true] } }]) } })));
  expect(accepted.root).not.toBe(root);
  const readPage = async () => {
    const page = await fetch(`${running.url}/people`, { headers: { authorization: `Bearer ${token}`, accept: "text/html" } });
    expect(page.status).toBe(200);
    return page.text();
  };
  const before = await readPage();
  expect(before).toContain("people/a");
  expect(before).not.toContain("schema.cddl");
  // A restarted host reads the same rows from the exact stored bytes, with no apps process.
  await stop(); await start();
  expect(await readPage()).toBe(before);
  const stored = decodeProtocolDirectory(await client.object(tree, decodeProtocolDirectory(await client.object(tree, accepted.root)).entries.find(e => e.name === "people")!.directory!));
  const store = stored.entries.find(e => e.name === "_store.json")!.file!;
  expect(new TextDecoder().decode(await client.object(tree, store))).toBe('[{"id":"a","count":1,"note":{"kept":[true]}}]\n');
});
