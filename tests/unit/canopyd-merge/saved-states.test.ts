import { expect, test } from "bun:test";
import { decodeLogEntry, encodeLogEntry, LOG_ENTRY_FORMAT, type MergeAnswer, type MergeQuestion } from "@overstory/merge-protocol";
import { decodeProtocolDirectory, encodeProtocolDirectory } from "@overstory/protocol";
import { Sidecar, type SavedStates } from "../../../packages/canopyd-merge/src/sidecar.ts";
import { Fixture } from "./fixture.ts";

/** Saved states in memory, as `savedStatesIn` keeps them on disk. */
function memorySaves(): SavedStates & { files: Map<string, { tree: string; bytes: Uint8Array; savedAt: number }> } {
  const files = new Map<string, { tree: string; bytes: Uint8Array; savedAt: number }>();
  let clock = 0;
  return {
    files,
    list: async () => [...files].map(([entry, f]) => ({ tree: f.tree, entry, savedAt: f.savedAt })),
    read: async (_tree, entry) => files.get(entry)?.bytes ?? null,
    write: async (tree, entry, bytes) => { files.set(entry, { tree, bytes, savedAt: ++clock }); },
    remove: async (_tree, entry) => { files.delete(entry); },
  };
}

/** A sidecar over the fixture's objects. Only a sidecar recording history
 * publishes what it stages, as canopyd does when it accepts an answer. */
function sidecar(f: Fixture, saved?: SavedStates, publish = false, cacheBytes?: number, replayMillis?: number) {
  return new Sidecar({
    shared: { find: async (hash) => f.objects.get(hash) ?? null, has: async (hash) => f.objects.has(hash) },
    staging: { find: async () => null, stage: async (values) => { if (publish) for (const v of values) f.objects.set(v.hash, v.bytes); } },
    ...(saved ? { saved } : {}),
  }, cacheBytes, undefined, replayMillis);
}

/** `root` with `files` set. */
function withFiles(f: Fixture, root: string, files: Record<string, string>) {
  const directory = decodeProtocolDirectory(f.objects.get(root)!);
  directory.entries = [...directory.entries.filter((e) => !(e.name in files)),
    ...Object.entries(files).map(([name, text]) => ({ name, file: f.put(text) }))]
    .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  return f.put(encodeProtocolDirectory(directory));
}

/** A tree's history recorded as canopyd records it: each answer becomes the
 * next entry. Every tenth update is a concurrent snapshot of the file the
 * update before it changed, so the chain carries open choices whose
 * alternatives name other engine states. */
async function history(f: Fixture, s: Sidecar, length: number, from?: { head: string; question: MergeQuestion }) {
  const rules = { id: "tree-default", revision: 1 };
  let head = from?.head ?? f.put(encodeLogEntry({ format: LOG_ENTRY_FORMAT, tree: "tr_test", previous: null,
    root: f.tree({ "a.md": "start", "choice.bin": "start\0" }), change: "start", trace: null, resolves: [], decisions: [] }));
  let previousHead = head, question = from?.question;
  for (let index = 0; index < length; index++) {
    const concurrent = index % 10 === 9;
    const base = concurrent ? previousHead : head;
    const files: Record<string, string> = index % 10 === 8 ? { "choice.bin": `left ${index}\0` } : concurrent ? { "choice.bin": `right ${index}\0` }
      : { "a.md": `mine ${index}`, [`f${index}.md`]: "x" };
    question = { base, head, candidate: { root: withFiles(f, decodeLogEntry(f.objects.get(base)!).root, files),
      change: `change-${index}`, trace: null, resolves: [] }, rules };
    const answer: MergeAnswer = await s.answer(question);
    previousHead = head;
    head = f.put(encodeLogEntry({ format: LOG_ENTRY_FORMAT, tree: "tr_test", previous: head, root: answer.root,
      change: question.candidate.change, trace: null, resolves: [], decisions: answer.decisions,
      asked: { ...(base !== question.head ? { base } : {}), rules } }));
    await s.save();
  }
  return { head, question: question! };
}

test("a restarted sidecar reads the nearest saved state instead of replaying the chain, with the same answers", async () => {
  const f = new Fixture(), saves = memorySaves();
  const warm = sidecar(f, saves, true);
  const { head } = await history(f, warm, 75);
  expect(saves.files.size).toBe(2);
  const question = { base: head, head, candidate: { root: withFiles(f, decodeLogEntry(f.objects.get(head)!).root, { "a.md": "next" }),
    change: "next", trace: null, resolves: [] }, rules: { id: "tree-default", revision: 1 } };
  const expected = await sidecar(f).answer(question);
  expect(expected.decisions.length).toBeGreaterThan(1);

  const restarted = sidecar(f, saves);
  expect(await restarted.answer(question)).toEqual(expected);
  expect(restarted.restored).toBe(1);
  expect(restarted.replayed).toBeLessThanOrEqual(32);
  const cold = sidecar(f);
  await cold.answer(question);
  expect(cold.replayed).toBe(76);
}, 30_000);

test("an unreadable or mismatched save is discarded and replayed", async () => {
  const f = new Fixture(), saves = memorySaves();
  const { head } = await history(f, sidecar(f, saves, true), 40);
  const question = { base: head, head, candidate: { root: withFiles(f, decodeLogEntry(f.objects.get(head)!).root, { "a.md": "next" }),
    change: "next", trace: null, resolves: [] }, rules: { id: "tree-default", revision: 1 } };
  const expected = await sidecar(f).answer(question);
  const [entry, file] = [...saves.files][0]!;
  const tampered = JSON.parse(new TextDecoder().decode(file.bytes));
  tampered.states[tampered.state].root = f.tree({ "a.md": "forged" });
  saves.files.set(entry, { ...file, bytes: new TextEncoder().encode(JSON.stringify(tampered)) });
  const restarted = sidecar(f, saves);
  expect(await restarted.answer(question)).toEqual(expected);
  expect(restarted.restored).toBe(0);
  expect(restarted.replayed).toBe(41);
  expect(saves.files.has(entry)).toBe(false);
});


test("interrupted replay advances across eviction and process replacement", async () => {
  const f = new Fixture(), saves = memorySaves();
  const { head } = await history(f, sidecar(f, undefined, true), 12);
  const question = { base: head, head, candidate: { root: withFiles(f, decodeLogEntry(f.objects.get(head)!).root, { "a.md": "next" }),
    change: "next", trace: null, resolves: [] }, rules: { id: "tree-default", revision: 1 } };
  const expected = await sidecar(f).answer(question);
  let completed = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    // Zero budget permits exactly one entry per stateOf, then asks for a
    // retry. Recreate the sidecar: only durable replay frontiers survive.
    const restarted = sidecar(f, saves, false, 0, 0);
    try {
      expect(await restarted.answer(question)).toEqual(expected);
      completed = true; break;
    } catch (error) {
      expect(String(error)).toContain("Rebuilding accepted history");
      await restarted.save();
      expect(saves.files.size).toBeGreaterThan(0);
      expect(saves.files.size).toBeLessThanOrEqual(2);
    }
  }
  expect(completed).toBe(true);
});

test("native disk checkpoints and legacy fallback produce the same answers", async () => {
  const { savedStatesIn } = await import("../../../packages/canopyd-merge/src/saved-states.ts");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const path = await mkdtemp(join(tmpdir(), "merge-native-replay-"));
  try {
    const f = new Fixture(), legacy = memorySaves();
    const { head } = await history(f, sidecar(f, legacy, true), 40);
    const disk = savedStatesIn(path);
    for (const [entry, file] of legacy.files) await disk.write(file.tree, entry, file.bytes);
    const question = { base: head, head, candidate: { root: withFiles(f, decodeLogEntry(f.objects.get(head)!).root, { "a.md": "next" }),
      change: "next", trace: null, resolves: [] }, rules: { id: "tree-default", revision: 1 } };
    const expected = await sidecar(f).answer(question);
    expect(await sidecar(f, disk).answer(question)).toEqual(expected);
    // An interrupted cold replay checkpoints directly into the new store.
    const partial = sidecar(f, disk, false, 0, 0);
    await expect(partial.answer(question)).rejects.toThrow("Rebuilding accepted history");
    await partial.save();
    const native = (await disk.list()).find((value) => value.entry !== [...legacy.files.keys()][0])!;
    expect(await disk.readCheckpoint!(native.tree, native.entry)).not.toBeNull();
    expect(await sidecar(f, disk).answer(question)).toEqual(expected);
  } finally { await rm(path, { recursive: true, force: true }); }
});


test("rebuilding an old concurrent basis preserves the already rebuilt head", async () => {
  const f = new Fixture(), saves = memorySaves();
  const { head } = await history(f, sidecar(f, undefined, true), 18);
  let base = head;
  for (let i = 0; i < 8; i++) base = decodeLogEntry(f.objects.get(base)!).previous!;
  const question = { base, head, candidate: { root: withFiles(f, decodeLogEntry(f.objects.get(base)!).root, { "a.md": "concurrent" }),
    change: "concurrent", trace: null, resolves: [] }, rules: { id: "tree-default", revision: 1 } };
  const expected = await sidecar(f).answer(question);
  let completed = false;
  for (let i = 0; i < 80; i++) {
    const restarted = sidecar(f, saves, false, 0, 0);
    try { expect(await restarted.answer(question)).toEqual(expected); completed = true; break; }
    catch (error) {
      expect(String(error)).toContain("Rebuilding accepted history");
      await restarted.save();
      expect(saves.files.size).toBeLessThanOrEqual(3);
    }
  }
  expect(completed).toBe(true);
});


test("a returning device's historical basis survives restart alongside its head", async () => {
  const f = new Fixture(), saves = memorySaves();
  const { head } = await history(f, sidecar(f, undefined, true), 45);
  let base = head;
  for (let i = 0; i < 12; i++) base = decodeLogEntry(f.objects.get(base)!).previous!;
  const question = { base, head, candidate: { root: withFiles(f, decodeLogEntry(f.objects.get(base)!).root, { "a.md": "offline" }),
    change: "offline", trace: null, resolves: [] }, rules: { id: "tree-default", revision: 1 } };
  const cold = sidecar(f, saves);
  const expected = await cold.answer(question);
  await cold.save();
  expect(saves.files.has(base)).toBe(true);
  expect(saves.files.has(head)).toBe(true);
  expect(saves.files.size).toBe(2);
  const restarted = sidecar(f, saves);
  expect(await restarted.answer(question)).toEqual(expected);
  expect(restarted.restored).toBe(2);
  expect(restarted.replayed).toBe(0);
  await restarted.save();
  expect(saves.files.size).toBe(2);
});


test("warm historical bases do not trigger a checkpoint write on every question", async () => {
  const f = new Fixture(), saves = memorySaves();
  const warm = sidecar(f, saves, true);
  const { head } = await history(f, warm, 12);
  const base = decodeLogEntry(f.objects.get(head)!).previous!;
  const question = { base, head, candidate: { root: withFiles(f, decodeLogEntry(f.objects.get(base)!).root, { "a.md": "offline" }),
    change: "offline", trace: null, resolves: [] }, rules: { id: "tree-default", revision: 1 } };
  await warm.answer(question);
  await warm.save();
  expect(saves.files.size).toBe(0);
});
