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
function sidecar(f: Fixture, saved?: SavedStates, publish = false) {
  return new Sidecar({
    shared: { find: async (hash) => f.objects.get(hash) ?? null, has: async (hash) => f.objects.has(hash) },
    staging: { find: async () => null, stage: async (values) => { if (publish) for (const v of values) f.objects.set(v.hash, v.bytes); } },
    ...(saved ? { saved } : {}),
  });
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
});

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
