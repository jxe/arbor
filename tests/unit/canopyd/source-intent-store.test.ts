import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { encodeWireDirectory, hashObject, type SourceOperation } from "@overstory/protocol";
import { AcceptedUpdateStore } from "../../../packages/canopyd/src/updates/store.ts";
import { SourceIntentStore } from "../../../packages/canopyd/src/updates/source-intent-store.ts";
import { executeExactSourceEdits } from "../../../packages/canopyd/src/updates/source-edits.ts";
const NO_ENTRY_CHANGES = { set: [], removed: [] };

// canopyd no longer writes authored_changes; these rows are retained history
// the readers must keep serving until the planned migration folds them away.
let db: Database, dir: string, store: AcceptedUpdateStore;
const bytes = new TextEncoder().encode("abc"), file = hashObject(bytes);
const directory = encodeWireDirectory({ type: "directory", entries: [{ name: "note.md", file }] });
const root = hashObject(directory);
const operations: SourceOperation[] = [{ key: "edit", kind: "editSource", source: { material: { kind: "basis", path: "/note.md", object: file } }, text: "abc" }];
const executed = await executeExactSourceEdits(root, operations, async hash => hash === root ? directory : bytes);
const trace = [{ before: root, after: executed.root, operations }];

function initialize(tree: string) {
  db.run("INSERT INTO trees VALUES (?, ?, 1)", [tree, root]);
  store.insert({ entryChanges: NO_ENTRY_CHANGES, tree, root, previousRoot: null, kind: "initial", acceptedAt: 1 });
}
/** Accept one update of `tree` and seed a retained authored-change row for it. */
function seed(tree: string, change: string, candidateRoot = root, digest = `sha256:${change}`) {
  const accepted = store.commit({
    entryChanges: NO_ENTRY_CHANGES, tree, root, previousRoot: root, expectedUpdate: store.current(tree)!.id,
    kind: "accepted", acceptedAt: 2, subject: "device:one", requestDigest: digest,
    baseRoot: root, candidateRoot, change,
  })!;
  db.run("INSERT INTO authored_changes (accepted_id, trace_json, evidence_json) VALUES (?, ?, ?)",
    [accepted.id, JSON.stringify(trace), JSON.stringify(executed.evidence)]);
  return accepted;
}
beforeEach(() => {
  dir = mkdtempSync(`${tmpdir()}/arbor-intent-`);
  db = new Database(`${dir}/state.sqlite`);
  db.run("PRAGMA foreign_keys = ON");
  db.run("CREATE TABLE trees (id TEXT PRIMARY KEY, ref TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  AcceptedUpdateStore.createSchema(db);
  store = new AcceptedUpdateStore(db);
  initialize("one");
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

test("retained intent reads back by change and by accepted update, and survives later snapshots", () => {
  const accepted = seed("one", "change-one");
  const record = new SourceIntentStore(db).get("one", "change-one")!;
  expect(record).toEqual({ tree: "one", change: "change-one", acceptedUpdate: accepted.id, basisRoot: root, candidateRoot: root, trace, evidence: executed.evidence });
  expect(new SourceIntentStore(db).forAccepted(accepted.id)).toEqual(record);
  store.commit({ entryChanges: NO_ENTRY_CHANGES, tree: "one", root, previousRoot: root, expectedUpdate: accepted.id,
    kind: "accepted", acceptedAt: 3, subject: "device:one", requestDigest: "sha256:snapshot", change: "snapshot" });
  expect(new SourceIntentStore(db).get("one", "change-one")).toEqual(record);
  expect(new SourceIntentStore(db).forAccepted(store.current("one")!.id)).toBeNull();
  expect(() => db.run("DELETE FROM accepted_updates WHERE id = ?", [accepted.id])).toThrow();
});
test("change identity is scoped to its tree", () => {
  seed("one", "change-one");
  initialize("two");
  expect(new SourceIntentStore(db).get("two", "change-one")).toBeNull();
  seed("two", "change-one");
  expect(new SourceIntentStore(db).get("two", "change-one")?.tree).toBe("two");
});
test("retains a candidate graph even when reconciliation projects the basis", () => {
  const candidate = hashObject(new TextEncoder().encode("candidate"));
  seed("one", "other", candidate as typeof root);
  expect(new Set(new SourceIntentStore(db).roots())).toEqual(new Set([root, candidate]));
});
