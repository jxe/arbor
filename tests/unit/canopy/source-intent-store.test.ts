import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { encodeWireDirectory, hashObject, type SourceOperation } from "@arbor/wire";
import { AcceptedUpdateStore } from "../../../packages/canopy/src/updates/store.ts";
import { SourceIntentStore } from "../../../packages/canopy/src/updates/source-intent-store.ts";
import { executeExactSourceEdits } from "../../../packages/canopy/src/updates/source-edits.ts";

let db: Database, dir: string, store: AcceptedUpdateStore;
const bytes = new TextEncoder().encode("abc"), file = hashObject(bytes);
const directory = encodeWireDirectory({ type: "directory", entries: [{ name: "note.md", file }] });
const root = hashObject(directory);
const operations: SourceOperation[] = [{ key: "edit", kind: "editSource", source: { material: { kind: "basis", path: "/note.md", object: file } }, text: "abc" }];
const executed = await executeExactSourceEdits(root, operations, async hash => hash === root ? directory : bytes);
const sourceIntent = { change: "change-one", trace: [{ before: root, after: executed.root, operations }], evidence: executed.evidence };
function initialize(tree: string) {
  db.run("INSERT INTO trees VALUES (?, ?, 1)", [tree, root]);
  store.insert({ tree, root, previousRoot: null, kind: "initial", acceptedAt: 1 });
}
function input(tree = "one", digest = "sha256:request") {
  return { tree, root, previousRoot: root, expectedRoot: root, expectedUpdate: store.current(tree)!.id,
    kind: "accepted" as const, acceptedAt: 2, subject: "device:one", requestDigest: digest,
    baseRoot: root, candidateRoot: root, sourceIntent };
}
function state() {
  return ["trees", "reflog", "accepted_updates", "observations", "authored_changes"].map(table => db.query(`SELECT * FROM ${table}`).all());
}
beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/arbor-intent-`);
  db = new Database(`${dir}/state.sqlite`);
  db.run("PRAGMA foreign_keys = ON");
  db.run("CREATE TABLE trees (id TEXT PRIMARY KEY, ref TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  db.run("CREATE TABLE reflog (tree_id TEXT NOT NULL, ref TEXT NOT NULL, previous_ref TEXT, changed_at INTEGER NOT NULL)");
  AcceptedUpdateStore.createSchema(db);
  store = new AcceptedUpdateStore(db);
  initialize("one");
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

test("equal-byte intent survives reopening, receipts replay, snapshots leave it intact", () => {
  const prior = store.current("one")!;
  const accepted = store.commit(input())!;
  expect(accepted.id).not.toBe(prior.id);
  expect(accepted.root).toBe(prior.root);
  const record = new SourceIntentStore(db).get("one", sourceIntent.change)!;
  expect(record.evidence).toEqual(executed.evidence);
  db.close(); db = new Database(`${dir}/state.sqlite`); db.run("PRAGMA foreign_keys = ON"); store = new AcceptedUpdateStore(db);
  expect(new SourceIntentStore(db).get("one", sourceIntent.change)).toEqual(record);
  const before = state();
  expect(store.acceptedRequest("one", "device:one", "sha256:request")?.result.update).toEqual(accepted);
  expect(state()).toEqual(before);
  store.commit({ ...input("one", "sha256:snapshot"), sourceIntent: undefined });
  expect(new SourceIntentStore(db).get("one", sourceIntent.change)).toEqual(record);
  expect(() => db.run("DELETE FROM accepted_updates WHERE id = ?", [accepted.id])).toThrow();
  expect(new SourceIntentStore(db).roots()).toEqual([root]);
});
test("change identity is immutable within its tree and independent across trees", () => {
  store.commit(input());
  const before = state();
  expect(() => store.commit({ ...input("one", "sha256:other"), subject: "device:other" })).toThrow();
  expect(state()).toEqual(before);
  initialize("two"); store.commit(input("two"));
  expect(new SourceIntentStore(db).get("two", sourceIntent.change)?.tree).toBe("two");
});
test("failure after provenance insertion rolls back all authority state", () => {
  db.run("CREATE TRIGGER fail_intent AFTER INSERT ON authored_changes BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  const before = state();
  expect(() => store.commit(input())).toThrow("injected failure");
  expect(state()).toEqual(before);
});
test("invalid evidence and missing receipt cannot leave partial state", () => {
  const before = state();
  expect(() => store.commit({ ...input(), sourceIntent: { ...sourceIntent, evidence: [] } })).toThrow("Source evidence");
  expect(() => store.commit({ ...input(), requestDigest: undefined })).toThrow("does not match");
  expect(state()).toEqual(before);
});
test("retains a candidate graph even when reconciliation projects the basis", async () => {
  const edits: SourceOperation[] = [{ ...operations[0]!, text: "different" } as SourceOperation];
  const result = await executeExactSourceEdits(root, edits, async hash => hash === root ? directory : bytes);
  store.commit({ ...input(), candidateRoot: result.root, sourceIntent: { change: "other", trace: [{ before: root, after: result.root, operations: edits }], evidence: result.evidence } });
  expect(new Set(new SourceIntentStore(db).roots())).toEqual(new Set([root, result.root]));
  const record = new SourceIntentStore(db).get("one", "other")!;
  expect(() => new SourceIntentStore(db).insert(record)).toThrow("transaction");
});
