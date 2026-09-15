import { expect, test } from "bun:test";
import { encodeWireDirectory, hashObject, type AcceptedUpdate, type ObjectHash, type SourceOperation } from "@arbor/wire";
import { executeExactSourceEdits } from "../../../packages/canopy/src/updates/source-edits.ts";
import { reconcileSourceEdits, type SourceHistoryEntry } from "../../../packages/canopy/src/updates/source-reconciliation.ts";
import type { SourceIntent } from "../../../packages/canopy/src/updates/source-intent-store.ts";

function fixture(text = "α😀omega\r\n", extension = "md") {
  const bytes = new TextEncoder().encode(text), file = hashObject(bytes);
  const directory = encodeWireDirectory({ type: "directory", entries: [{ name: `a.${extension}`, file }, { name: `b.${extension}`, file }] });
  const root = hashObject(directory), objects = new Map([[root, directory], [file, bytes]]);
  const basis = { id: "basis", root };
  const initial: AcceptedUpdate = { ...basis, tree: "tree", previous: null, conflicted: false, acceptedAt: 1, subject: "author" };
  const load = async (hash: ObjectHash) => { const bytes = objects.get(hash); if (!bytes) throw new Error("Missing object"); return bytes; };
  async function change(change: string, range: [number, number], text: string, path = `/a.${extension}`) {
    const operations: SourceOperation[] = [{ key: "edit", kind: "editSource", source: { material: { kind: "basis", path, object: file }, range }, text }];
    const result = await executeExactSourceEdits(root, operations, load);
    for (const entry of result.generated) objects.set(...entry);
    return { intent: { change, operations, evidence: result.evidence } satisfies SourceIntent, candidate: result.root };
  }
  async function accept(authored: Awaited<ReturnType<typeof change>>, history: SourceHistoryEntry[]) {
    const current = history.at(-1)?.update ?? initial;
    const result = await reconcileSourceEdits(basis, authored.candidate, authored.intent, current, history, load);
    if (result.outcome !== "merged") throw new Error(`Expected merge, got ${result.outcome}`);
    for (const entry of result.generated) objects.set(...entry);
    const update = { ...initial, id: `accepted-${history.length}`, root: result.root, previous: { id: current.id, root: current.root } };
    history.push({ update, intent: { ...authored.intent, tree: "tree", acceptedUpdate: update.id, basisRoot: root, candidateRoot: authored.candidate }, summary: result.merge! });
    return result;
  }
  return { root, basis, initial, load, change, accept };
}

test("three disjoint UTF-8 edits commute in every arrival order and retain all contributions", async () => {
  for (const order of [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]]) {
    const f = fixture();
    const changes = await Promise.all([f.change("alpha", [0,2], "A"), f.change("emoji", [2,6], "🙂"), f.change("word", [6,11], "z")]);
    const history: SourceHistoryEntry[] = [];
    for (const index of order) await f.accept(changes[index]!, history);
    const combined = await f.change("expected", [0,11], "A🙂z");
    expect(history.at(-1)!.update.root).toBe(combined.candidate);
    expect(history.at(-1)!.summary).toMatchObject({ version: "exact-source-disjoint-v1", basis: f.basis,
      contributions: order.map(index => ({ change: changes[index]!.intent.change, operation: "edit" })) });
  }
});
test("equal file hashes at different paths remain distinct material", async () => {
  const f = fixture("same"), history: SourceHistoryEntry[] = [];
  await f.accept(await f.change("a", [0,4], "A"), history);
  await f.accept(await f.change("b", [0,4], "B", "/b.md"), history);
  expect(history).toHaveLength(2);
});
test("equal-byte replacement remains a contribution and blocks overlapping peers", async () => {
  const f = fixture("abc"), history: SourceHistoryEntry[] = [];
  await f.accept(await f.change("same", [0,1], "a"), history);
  const conflict = await f.change("overlap", [0,1], "A");
  expect((await reconcileSourceEdits(f.basis, conflict.candidate, conflict.intent, history[0]!.update, history, f.load)).outcome).toBe("rejected");
  await f.accept(await f.change("independent", [2,3], "C"), history);
  expect(history.at(-1)!.summary).toMatchObject({ contributions: [{ change: "same", operation: "edit" }, { change: "independent", operation: "edit" }] });
});
test("same-anchor insertions stay ambiguous even if their bytes match", async () => {
  const f = fixture("abc"), history: SourceHistoryEntry[] = [];
  await f.accept(await f.change("first", [1,1], "x"), history);
  const second = await f.change("second", [1,1], "x");
  expect((await reconcileSourceEdits(f.basis, second.candidate, second.intent, history[0]!.update, history, f.load)).outcome).toBe("rejected");
});
test("missing history, snapshot barriers and different equal-root basis identities cannot be guessed", async () => {
  const f = fixture("abc"), history: SourceHistoryEntry[] = [];
  await f.accept(await f.change("first", [0,1], "a"), history);
  const second = await f.change("second", [2,3], "C"), current = history[0]!.update;
  for (const broken of [null, [], [{ ...history[0]!, intent: null }], [{ ...history[0]!, summary: { ...history[0]!.summary!, basis: { ...f.basis, id: "another" } } }]] as Array<SourceHistoryEntry[] | null>) {
    expect((await reconcileSourceEdits(f.basis, second.candidate, second.intent, current, broken, f.load)).outcome).toBe("rejected");
  }
});
test("the initial exact-acceptance records remain usable without inferring a merged basis", async () => {
  const f = fixture("abc"), history: SourceHistoryEntry[] = [];
  await f.accept(await f.change("first", [0,1], "A"), history);
  history[0]!.summary = null;
  await f.accept(await f.change("second", [2,3], "C"), history);
  expect(history.at(-1)!.update.root).toBe((await f.change("expected", [0,3], "AbC")).candidate);
});

test("concurrency declines structured formats, Markdown structures, and newly introduced markup", async () => {
  for (const [text, extension, replacement] of [
    ['{"a":1,"b":2}', "json", "{"], ["a: 1\nb: 2", "yaml", "a"],
    ["let x = 1;", "ts", "l"], ["---\nid: x\n---\nabc", "md", "-"],
    ["```js\nabc\n```", "md", "`"], ["abc", "md", "#"],
  ]) {
    const f = fixture(text!, extension!), history: SourceHistoryEntry[] = [];
    await f.accept(await f.change("first", [0,1], replacement!), history);
    const second = await f.change("second", [2,3], "Z");
    expect((await reconcileSourceEdits(f.basis, second.candidate, second.intent, history[0]!.update, history, f.load)).outcome).toBe("rejected");
  }
});
