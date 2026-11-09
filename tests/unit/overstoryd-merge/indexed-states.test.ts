import { expect, test } from "bun:test";
import { decodeLogEntry, encodeLogEntry, LOG_ENTRY_FORMAT, type MergeAnswer } from "@ovst/merge-protocol";
import { decodeProtocolDirectory, encodeProtocolDirectory, entryProvenance, readProvenance, stableJSONString, type ObjectHash, type ProvenanceNode } from "@ovst/protocol";
import { Sidecar } from "../../../packages/overstoryd-merge/src/sidecar.ts";
import { recordedQuestion } from "../../support/replay-check.ts";
import { Fixture } from "./fixture.ts";

/** A sidecar over the fixture's objects. Only a sidecar recording history
 * publishes what it stages, as overstoryd does when it accepts an answer.
 * With `indexes`, it reads entries' indexes as overstoryd keeps them. */
function sidecar(f: Fixture, publish = false, indexes?: Map<string, ProvenanceNode>) {
  return new Sidecar({
    shared: { find: async (hash) => f.objects.get(hash) ?? null, has: async (hash) => f.objects.has(hash) },
    staging: { find: async () => null, stage: async (values) => { if (publish) for (const v of values) f.objects.set(v.hash, v.bytes); } },
    ...(indexes ? { provenance: { index: async (entry: string) => indexes.get(entry) ?? null } } : {}),
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

/** A tree's history recorded as overstoryd records it: each answer becomes the
 * next entry, and its index the one the answer carries. Every tenth update is
 * a concurrent snapshot of the file the update before it changed, so the
 * chain carries open choices whose alternatives name other engine states. */
async function history(f: Fixture, length: number) {
  const s = sidecar(f, true), rules = { id: "tree-default", revision: 1 };
  const indexes = new Map<string, ProvenanceNode>(), entries: string[] = [];
  let head = f.put(encodeLogEntry({ format: LOG_ENTRY_FORMAT, tree: "tr_test", previous: null,
    root: f.tree({ "a.md": "start", "choice.bin": "start\0" }), change: "start", trace: null, resolves: [], decisions: [] }));
  // The chain's first entry is indexed as an import, as overstoryd does.
  indexes.set(head, await entryProvenance(null, decodeLogEntry(f.objects.get(head)!) as never, async (hash: ObjectHash) => f.objects.get(hash)!));
  let previousHead = head;
  for (let index = 0; index < length; index++) {
    const concurrent = index % 10 === 9;
    const base = concurrent ? previousHead : head;
    const files: Record<string, string> = index % 10 === 8 ? { "choice.bin": `left ${index}\0` } : concurrent ? { "choice.bin": `right ${index}\0` }
      : { "a.md": `mine ${index}`, [`f${index}.md`]: "x" };
    const question = { base, head, candidate: { root: withFiles(f, decodeLogEntry(f.objects.get(base)!).root, files),
      change: `change-${index}`, trace: null, resolves: [] }, rules };
    const answer: MergeAnswer = await s.answer(question);
    previousHead = head;
    head = f.put(encodeLogEntry({ format: LOG_ENTRY_FORMAT, tree: "tr_test", previous: head, root: answer.root,
      change: question.candidate.change, trace: null, resolves: [], decisions: answer.decisions,
      asked: { ...(base !== question.head ? { base } : {}), ...(question.candidate.root !== answer.root ? { candidate: question.candidate.root } : {}), rules } }));
    indexes.set(head, await readProvenance(answer.provenance!, async (hash: ObjectHash) => f.objects.get(hash)!));
    entries.push(head);
  }
  return { head, entries, indexes };
}

const same = (answer: MergeAnswer, entry: string, f: Fixture) => {
  const recorded = decodeLogEntry(f.objects.get(entry)!);
  expect({ root: answer.root, decisions: stableJSONString(answer.decisions) })
    .toEqual({ root: recorded.root, decisions: stableJSONString(recorded.decisions) });
};

test("a cold sidecar answers each recorded question as history recorded it, from the indexes answers carried", async () => {
  const f = new Fixture(), { entries, indexes } = await history(f, 40);
  for (const entry of entries) {
    const cold = sidecar(f, false, indexes);
    same(await cold.answer(recordedQuestion(decodeLogEntry(f.objects.get(entry)!))), entry, f);
    expect(cold.indexedCount).toBe(0);
  }
}, 60_000);

test("without overstoryd's indexes a sidecar computes them, as its backfill does", async () => {
  const f = new Fixture(), { entries } = await history(f, 25);
  for (const entry of entries.slice(-4)) {
    const cold = sidecar(f);
    same(await cold.answer(recordedQuestion(decodeLogEntry(f.objects.get(entry)!))), entry, f);
    expect(cold.indexedCount).toBeGreaterThan(0);
  }
}, 60_000);

test("a head whose replay from its basis runs past the budget starts from its index instead", async () => {
  const f = new Fixture(), { entries, indexes } = await history(f, 30);
  const base = entries[2]!, head = entries.at(-1)!;
  const question = { base, head, candidate: { root: withFiles(f, decodeLogEntry(f.objects.get(base)!).root, { "z.md": "late" }),
    change: "late", trace: null, resolves: [] }, rules: { id: "tree-default", revision: 1 } };
  const expected = await sidecar(f, false, indexes).answer(question);
  const budgeted = new Sidecar({
    shared: { find: async (hash) => f.objects.get(hash) ?? null, has: async (hash) => f.objects.has(hash) },
    staging: { find: async () => null, stage: async () => {} },
    provenance: { index: async (entry: string) => indexes.get(entry) ?? null },
  }, undefined, undefined, 0);
  const answer = await budgeted.answer(question);
  expect(answer.root).toBe(expected.root);
  expect(budgeted.replayed).toBeLessThanOrEqual(1);
  expect(budgeted.seededCount).toBe(2);
}, 60_000);
