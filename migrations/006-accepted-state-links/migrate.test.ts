import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanopySchema } from "../../packages/canopy/src/schema.ts";
import { AcceptedUpdateStore } from "../../packages/canopy/src/updates/store.ts";
import { migrateAcceptedStateLinks } from "./run.ts";
import type { ObjectHash } from "@arbor/wire";
const root = (n: string) => `sha256:${n.repeat(64)}` as ObjectHash;
async function fixture(run: (path: string) => void) {
  const dir = await mkdtemp(join(tmpdir(), "arbor-links-migration-"));
  try {
    const path = join(dir, "canopy.sqlite3"), db = new Database(path);
    createCanopySchema(db);
    db.run("INSERT INTO trees (id, ref, updated_at) VALUES ('tree', ?, 1)", [root("a")]);
    const store = new AcceptedUpdateStore(db);
    store.insert({ tree: "tree", root: root("a"), previousRoot: null, kind: "initial", acceptedAt: 1 });
    store.insert({ tree: "tree", root: root("b"), previousRoot: root("a"), kind: "merged", acceptedAt: 2,
      subject: "device", requestDigest: root("c"), merge: { version: "markdown-additive-v1", approximatePlacements: 1 } });
    store.insert({ tree: "tree", root: root("b"), previousRoot: root("b"), kind: "accepted", acceptedAt: 3 });
    db.run("ALTER TABLE accepted_updates DROP COLUMN previous_id");
    db.run("ALTER TABLE accepted_updates DROP COLUMN conflicted");
    db.run("UPDATE meta SET value = '7' WHERE key = 'schema_version'");
    db.close();
    run(path);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
test("offline schema upgrade retains exact history, digests and same-root predecessor identity", async () => fixture(path => {
  let db = new Database(path);
  const before = db.query("SELECT * FROM accepted_updates ORDER BY rowid").all();
  const observations = db.query("SELECT * FROM observations ORDER BY ordinal").all();
  db.close();
  expect(migrateAcceptedStateLinks(path)).toEqual({ migrated: true, accepted: 3 });
  expect(migrateAcceptedStateLinks(path)).toEqual({ migrated: false, accepted: 3 });
  db = new Database(path);
  const after = db.query("SELECT * FROM accepted_updates ORDER BY rowid").all() as Record<string, unknown>[];
  expect<unknown>(after.map(({ previous_id: _p, conflicted: _c, ...old }) => old)).toEqual(before);
  expect(db.query("SELECT * FROM observations ORDER BY ordinal").all()).toEqual(observations);
  const store = new AcceptedUpdateStore(db), states = store.list("tree");
  expect(states[2]!.previous).toEqual({ id: states[1]!.id, root: states[1]!.root });
  expect(store.acceptedRequest("tree", "device", root("c"))!.result.outcome).toBe("accepted");
  // Once migrated, later retention can remove a predecessor without corrupting its successor's link.
  db.run("DELETE FROM observations WHERE update_id = ?", [states[1]!.id]);
  db.run("DELETE FROM accepted_updates WHERE id = ?", [states[1]!.id]);
  expect(store.get(states[2]!.id)!.previous).toEqual(states[2]!.previous);
  db.close();
}));
test("incomplete legacy history aborts before schema or record changes", async () => fixture(path => {
  let db = new Database(path);
  db.run("DELETE FROM observations WHERE update_id = '2'"); db.run("DELETE FROM accepted_updates WHERE id = '2'");
  const before = db.query("SELECT * FROM accepted_updates").all(); db.close();
  expect(() => migrateAcceptedStateLinks(path)).toThrow("Cannot reconstruct predecessor");
  db = new Database(path);
  expect(db.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "7" });
  expect(db.query("SELECT * FROM accepted_updates").all()).toEqual(before);
  db.close();
}));
