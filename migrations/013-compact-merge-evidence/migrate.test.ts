import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWireDirectory, hashObject, type ObjectHash } from "@arbor/wire";
import { stableJSONString } from "@arbor/core";
import { createCanopySchema, AUTHORITY_SCHEMA } from "../../packages/canopy/src/schema.ts";
import { AcceptedUpdateStore } from "../../packages/canopy/src/updates/store.ts";
import { retentionAudit } from "../../packages/merge/src/retention.ts";
import { loadIntentState, storeIntentState } from "../../packages/merge/src/state-storage.ts";
import { migrateCompactMergeEvidence } from "./run.ts";

const encoder = new TextEncoder();
const objectPath = (root: string, hash: string) => join(root, "objects", hash.slice(7, 9), hash.slice(9));

/** A schema-14 data root with two merge rows over one tree:
 *  - row 1 (legacy): a full-copy state `s1` with a flattened `dependencies`
 *    closure and the evaluator's whole read set as evidence;
 *  - row 2 (compact): an indexed v3 state `s2` whose change envelope names
 *    `s1` as its base state and whose decision cites `s1` as context and as an
 *    alternative, so rewriting `s1` cascades through the envelope into `s2`.
 *  Both rows share their authored state with their result state. */
async function fixture(run: (root: string, ids: Fixture) => Promise<void>) {
  const root = mkdtempSync(`${tmpdir()}/arbor-migration-013-`);
  try {
    mkdirSync(join(root, "objects"), { recursive: true });
    const put = (bytes: Uint8Array) => {
      const hash = hashObject(bytes);
      mkdirSync(join(root, "objects", hash.slice(7, 9)), { recursive: true });
      writeFileSync(objectPath(root, hash), bytes);
      return hash;
    };
    const text = (s: string) => put(encoder.encode(s));
    const json = (value: unknown) => put(encoder.encode(stableJSONString(value)));
    const file1 = text("first\n"), file2 = text("second\n");
    const tree1 = put(encodeWireDirectory({ type: "directory", entries: [{ name: "a.md", file: file1 }] }));
    const tree2 = put(encodeWireDirectory({ type: "directory", entries: [{ name: "a.md", file: file2 }] }));
    const node = (object: string, tree: string) => ({ n: { id: "n", parent: "r", name: "a.md", kind: "file" as const, object, active: true },
      r: { id: "r", parent: null, name: "", kind: "directory" as const, object: tree, active: true } });
    const base = { format: "arbor-merge-intent-state" as const, tree: "tree", nodes: {}, outputs: {}, alternatives: {}, origins: {}, effects: {}, changes: {}, decisions: [] };
    // Legacy full-copy state: written as one JSON object, exactly as the old engine did.
    const s1 = json({ ...base, root: tree1, nodes: node(file1, tree1) });
    const envelope = json({ base: { object: tree1, state: s1 }, incoming: { change: "c2", object: tree2, trace: [] } });
    const s2 = storeIntentState({
      ...base, root: tree2, nodes: node(file2, tree2), changes: { c2: envelope },
      decisions: [{ key: "d", kind: "content", affected: ["n"], selected: 0, dependencies: [], reason: "test", context: s1,
        alternatives: [{ state: s1, object: file1, contributions: [{ change: "c1", operation: null }] },
          { state: s1, object: file2, contributions: [{ change: "c2", operation: null }] }] }],
    }, put, true);
    const load = async (hash: string) => new Uint8Array(readFileSync(objectPath(root, hash)));
    const closure = await retentionAudit(load)([s1, s1]);

    const db = new Database(join(root, "canopy.sqlite3")); createCanopySchema(db);
    db.run("INSERT INTO trees (id, ref, updated_at) VALUES ('tree', ?, 1)", [tree2]);
    const store = new AcceptedUpdateStore(db);
    const first = store.insert({ tree: "tree", root: tree1 as ObjectHash, previousRoot: null, kind: "initial", acceptedAt: 1, subject: "device", requestDigest: tree1 as ObjectHash });
    const second = store.insert({ tree: "tree", root: tree2 as ObjectHash, previousRoot: tree1 as ObjectHash, kind: "accepted", acceptedAt: 2, subject: "device", requestDigest: tree2 as ObjectHash, baseRoot: tree1 as ObjectHash, candidateRoot: tree2 as ObjectHash });
    db.run("UPDATE accepted_updates SET base_root = ?, candidate_root = ?, previous_root = ? WHERE id = ?", [tree1, tree1, tree1, first.id]);
    const evidence = (inputs: string[]) => ({ rule: { id: "tree-default", revision: 1 }, inputs, change: "c", operations: [], validation: "verified", formats: [] });
    const request = { change: "c", candidate: tree2, trace: [], resolves: [] };
    db.run("INSERT INTO accepted_merge_states VALUES (?, ?)", [first.id, JSON.stringify({
      state: s1, authored: s1, decisions: [], dependencies: [...closure], evidence: evidence([tree1, file1, s1, tree1, tree1]), request })]);
    db.run("INSERT INTO accepted_merge_states VALUES (?, ?)", [second.id, JSON.stringify({
      state: s2, authored: s2, decisions: [], retention: { version: 1, roots: [s2] }, evidence: evidence([tree1, tree2, file1, file2, s1]), request })]);
    db.run("UPDATE meta SET value = '14' WHERE key = 'schema_version'"); db.close();
    mkdirSync(join(root, "merge-jobs", "job-stale"), { recursive: true });
    await run(root, { s1, s2, envelope, tree1, tree2, file1, file2, first: first.id, second: second.id, load });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
type Fixture = { s1: string; s2: string; envelope: string; tree1: string; tree2: string; file1: string; file2: string; first: string; second: string; load: (hash: string) => Promise<Uint8Array> };

const records = (root: string) => {
  const db = new Database(join(root, "canopy.sqlite3"));
  const rows = Object.fromEntries((db.query("SELECT accepted_id, record_json FROM accepted_merge_states").all() as Array<{ accepted_id: string; record_json: string }>)
    .map(r => [r.accepted_id, JSON.parse(r.record_json)]));
  const stamp = (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value;
  db.close();
  return { rows, stamp };
};

test("evidence keeps the three roots and the legacy closure becomes two-root retention", () => fixture(async (root, f) => {
  const report = await migrateCompactMergeEvidence(root);
  expect(report.migrated).toBe(true);
  expect(report.rows).toEqual({ total: 2, legacy: 1, compact: 1 });
  expect(report.trees).toEqual([{ id: "tree", root: f.tree2 }]);
  const { rows, stamp } = records(root);
  expect(stamp).toBe("15");
  for (const row of Object.values(rows)) {
    expect(row.dependencies).toBeUndefined();
    expect(row.retention).toEqual({ version: 1, roots: [row.state] });
    expect(row.evidence.rule).toEqual({ id: "tree-default", revision: 1 });
  }
  expect(rows[f.first]!.evidence.inputs).toEqual({ base: f.tree1, current: f.tree1, incoming: f.tree1 });
  expect(rows[f.second]!.evidence.inputs).toEqual({ base: f.tree1, current: f.tree1, incoming: f.tree2 });
}));

test("a full-copy state becomes indexed and every reference to it moves, cascading through the envelope", () => fixture(async (root, f) => {
  const report = await migrateCompactMergeEvidence(root);
  expect(report.states).toEqual({ rewritten: 2, kept: 0 });
  expect(report.changes).toEqual({ rewritten: 1, kept: 0 });
  const { rows } = records(root);
  const n1 = rows[f.first]!.state, n2 = rows[f.second]!.state;
  expect(n1).not.toBe(f.s1); expect(n2).not.toBe(f.s2);
  const root1 = JSON.parse(new TextDecoder().decode(await f.load(n1)));
  expect(root1.format).toBe("arbor-merge-intent-state-v3");
  expect(root1.editable).toBe(false);
  const state1 = await loadIntentState(n1, f.load);
  expect(state1.root).toBe(f.tree1);
  expect(state1.nodes.n!.object).toBe(f.file1);
  const state2 = await loadIntentState(n2, f.load);
  expect(JSON.parse(new TextDecoder().decode(await f.load(n2))).editable).toBe(true);
  expect(state2.decisions[0]!.context).toBe(n1);
  expect(state2.decisions[0]!.alternatives.map(a => a.state)).toEqual([n1, n1]);
  const envelope = state2.changes.c2!;
  expect(envelope).not.toBe(f.envelope);
  expect(JSON.parse(new TextDecoder().decode(await f.load(envelope)))).toEqual({ base: { object: f.tree1, state: n1 }, incoming: { change: "c2", object: f.tree2, trace: [] } });
  // The new roots pass the same audit the daemon runs, and it covers the cascade.
  const closure = await retentionAudit(f.load)([n1, n2], true);
  expect(closure.has(envelope)).toBe(true);
  expect(closure.has(f.file1) && closure.has(f.file2) && closure.has(f.tree1) && closure.has(f.tree2)).toBe(true);
}));

test("superseded objects are deleted after the audit; trees, files and directories stay", () => fixture(async (root, f) => {
  const report = await migrateCompactMergeEvidence(root);
  expect(report.objects.deleted).toBeGreaterThan(0);
  for (const gone of [f.s1, f.s2, f.envelope]) expect(existsSync(objectPath(root, gone))).toBe(false);
  for (const kept of [f.tree1, f.tree2, f.file1, f.file2]) expect(existsSync(objectPath(root, kept))).toBe(true);
  expect(report.audit.after.treeObjects).toBe(4);
  expect(report.jobs).toEqual(["merge-jobs"]);
  expect(existsSync(join(root, "merge-jobs"))).toBe(false);
  expect(report.sqlite.bytesAfter).toBeGreaterThan(0);
}));

test("migration preserves every other authority row and is idempotent", () => fixture(async (root) => {
  const tables = Object.keys(AUTHORITY_SCHEMA).filter(t => t !== "meta" && t !== "accepted_merge_states");
  let db = new Database(join(root, "canopy.sqlite3"));
  const before = tables.map(t => db.query(`SELECT * FROM ${t}`).all()); db.close();
  expect((await migrateCompactMergeEvidence(root)).migrated).toBe(true);
  const again = await migrateCompactMergeEvidence(root);
  expect(again.migrated).toBe(false);
  expect(again.rows.total).toBe(0);
  db = new Database(join(root, "canopy.sqlite3"));
  expect(tables.map(t => db.query(`SELECT * FROM ${t}`).all())).toEqual(before); db.close();
}));

test("a legacy closure that does not match the audit stops the migration before anything changes", () => fixture(async (root, f) => {
  let db = new Database(join(root, "canopy.sqlite3"));
  const record = JSON.parse((db.query("SELECT record_json FROM accepted_merge_states WHERE accepted_id = ?").get(f.first) as { record_json: string }).record_json);
  record.dependencies.push(`sha256:${"f".repeat(64)}`);
  db.run("UPDATE accepted_merge_states SET record_json = ? WHERE accepted_id = ?", [JSON.stringify(record), f.first]); db.close();
  await expect(migrateCompactMergeEvidence(root)).rejects.toThrow("Invalid merge retention closure");
  expect(records(root).stamp).toBe("14");
  expect(existsSync(objectPath(root, f.s1))).toBe(true);
}));

test("an unknown stamp is refused", () => fixture(async (root) => {
  const db = new Database(join(root, "canopy.sqlite3")); db.run("UPDATE meta SET value = '13' WHERE key = 'schema_version'"); db.close();
  await expect(migrateCompactMergeEvidence(root)).rejects.toThrow("Expected schema 14");
}));
