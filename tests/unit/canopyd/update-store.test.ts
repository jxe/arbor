import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AcceptedUpdateStore } from "@overstory/canopyd";
import { encodeWireDirectory, type ObjectHash } from "@overstory/protocol";
import { ensureCanopyReadIndexes } from "../../../packages/canopyd/src/schema.ts";
import { ObservationLog } from "../../../packages/canopyd/src/updates/observations.ts";

const A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as ObjectHash;
const B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as ObjectHash;
const C = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as ObjectHash;

describe("accepted-update transaction store", () => {
  let db: Database;
  let store: AcceptedUpdateStore;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    db.run("CREATE TABLE trees (id TEXT PRIMARY KEY, ref TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    db.run("CREATE TABLE reflog (tree_id TEXT NOT NULL, ref TEXT NOT NULL, previous_ref TEXT, changed_at INTEGER NOT NULL)");
    AcceptedUpdateStore.createSchema(db);
    store = new AcceptedUpdateStore(db);
    db.run("INSERT INTO trees (id, ref, updated_at) VALUES ('tr_test', ?, 1)", [A]);
    store.insert({
      tree: "tr_test",
      root: A,
      previousRoot: null,
      kind: "initial",
      acceptedAt: 1,
    });
  });

  afterEach(() => db.close());

  test("observation replay pages by ordinal and catches appends after the starting position", () => {
    const log = new ObservationLog(db);
    const anchor = log.latestCursor("tr_test")!;
    const start = log.position("tr_test", anchor);
    for (let i=0;i<150;i++) store.insert({tree:"tr_test",root:A,previousRoot:A,kind:"accepted",acceptedAt:i+2,transition:{objects:[],deltas:[]}});
    const seen: string[] = [];
    let ordinal = start.through;
    for (;;) {
      const page = log.page("tr_test",ordinal);
      expect(page.length).toBeLessThanOrEqual(64);
      if (!page.length) break;
      seen.push(...page.map(row=>row.updateID!)); ordinal=page.at(-1)!.ordinal;
    }
    expect(seen).toHaveLength(150);
    expect(new Set(seen).size).toBe(150);
    expect(log.position("other-tree",anchor).retained).toBe(false);
    expect(log.position("tr_test",null).through).toBe(ordinal);
    const appended=store.insert({tree:"tr_test",root:A,previousRoot:A,kind:"accepted",acceptedAt:999});
    expect(log.page("tr_test",ordinal).map(row=>row.updateID)).toEqual([appended.id]);
  });

  test("descriptor and observation lookups use their scoped indexes", () => {
    ensureCanopyReadIndexes(db);
    ensureCanopyReadIndexes(db); // Existing stores gain indexes idempotently.
    const plans = [
      ["SELECT id, root FROM accepted_updates WHERE tree_id = ? ORDER BY rowid DESC LIMIT 1", "tr_test", "accepted_updates_tree"],
      ["SELECT cursor FROM observations WHERE update_id = ? ORDER BY ordinal DESC LIMIT 1", store.current("tr_test")!.id, "observations_update"],
    ];
    for (const [query, value, index] of plans) {
      const detail = (db.query("EXPLAIN QUERY PLAN " + query).all(value!) as {detail: string}[]).map(row => row.detail).join("\n");
      expect(detail).toContain(index!);
      expect(detail).not.toContain("SCAN");
      expect(detail).not.toContain("TEMP B-TREE");
    }
  });

  test("commits the ref, reflog, accepted row, and digest as one result", () => {
    const bytes = encodeWireDirectory({ type: "directory", entries: [] });
    const accepted = store.commit({
      tree: "tr_test",
      root: B,
      previousRoot: A,
      expectedUpdate: store.current("tr_test")!.id,
      expectedRoot: A,
      kind: "accepted",
      acceptedAt: 2,
      subject: "device:one",
      baseRoot: A,
      candidateRoot: B,
      remoteRoot: A,
      requestDigest: "sha256:request",
      transition: { objects: [{ hash: B, bytes }], deltas: [] },
    });
    expect(accepted?.id).toBe(String(Number(store.list("tr_test")[0]!.id) + 1));
    expect((db.query("SELECT ref FROM trees WHERE id = 'tr_test'").get() as { ref: string }).ref).toBe(B);
    expect(db.query("SELECT * FROM reflog").all()).toHaveLength(1);
    expect(store.list("tr_test")).toHaveLength(2);
    expect(store.list("tr_test").map((update) => Number(update.id))).toEqual(store.list("tr_test").map((update) => Number(update.id)).sort((a, b) => a - b));
    expect(store.transition(accepted!.id)).toEqual({ objects: [{ hash: B, bytes }], deltas: [] });
    expect(store.acceptedRequest("tr_test", "device:one", "sha256:request")).toEqual({
      status: 201,
      result: { outcome: "accepted", update: accepted!, requestDigest: "sha256:request" },
    });
  });

  test("a failed compare-and-swap changes no authority state", () => {
    const accepted = store.commit({
      tree: "tr_test",
      root: C,
      previousRoot: B,
      expectedUpdate: store.current("tr_test")!.id,
      expectedRoot: B,
      kind: "accepted",
      acceptedAt: 2,
      requestDigest: "sha256:stale",
    });
    expect(accepted).toBeNull();
    expect(store.list("tr_test")).toHaveLength(1);
    expect(db.query("SELECT * FROM reflog").all()).toHaveLength(0);
    expect((db.query("SELECT ref FROM trees WHERE id = 'tr_test'").get() as { ref: string }).ref).toBe(A);
  });

  test("accepted identity guards commits even when projection bytes are unchanged", () => {
    const initial = store.current("tr_test")!;
    const input = { tree: "tr_test", root: A, previousRoot: A, expectedRoot: A, expectedUpdate: initial.id, kind: "accepted" as const, acceptedAt: 2 };
    const metadata = store.commit(input)!;
    expect(metadata.root).toBe(initial.root);
    expect(metadata.id).not.toBe(initial.id);
    expect(store.commit({ ...input, root: B, acceptedAt: 3 })).toBeNull();
    expect(store.current("tr_test")!.id).toBe(metadata.id);
    expect(store.list("tr_test")).toHaveLength(2);
  });

  test("persists unresolved metadata and predecessor links independently of projection and observation", () => {
    const initial = store.current("tr_test")!;
    const metadata = store.commit({ tree: "tr_test", root: A, previousRoot: A,
      expectedRoot: A, expectedUpdate: initial.id, kind: "accepted", acceptedAt: 2, conflicted: true })!;
    const next = store.commit({ tree: "tr_test", root: B, previousRoot: A,
      expectedRoot: A, expectedUpdate: metadata.id, kind: "merged", acceptedAt: 3,
      merge: { version: "markdown-additive-v1", approximatePlacements: 1 } })!;
    expect(next.conflicted).toBe(true);
    expect(next.previous).toEqual({ id: metadata.id, root: A });
    expect(Object.hasOwn(next, "merge")).toBe(false);
    expect(Object.hasOwn(next, "kind")).toBe(false);
    expect(new AcceptedUpdateStore(db).get(next.id)).toEqual(next);
    db.run("UPDATE observations SET cursor = 'independent-observation' WHERE update_id = ?", [next.id]);
    expect(new ObservationLog(db).forUpdate(next.id)!.cursor).toBe("independent-observation");
    expect(store.get(next.id)!.id).toBe(next.id);
  });

  test("ignores legacy status rows while accepting their cursors as replay anchors", () => {
    const observations = new ObservationLog(db);
    const initial = store.current("tr_test")!;
    db.run(`INSERT INTO observations
      (cursor, tree_id, kind, update_id, change_json, created_at)
      VALUES ('legacy-status', 'tr_test', 'tree.status', NULL, '{}', 2)`);

    expect(observations.latestCursor("tr_test")).toBe(initial.id);
    expect(observations.after("tr_test", initial.id).records).toEqual([]);
    expect(observations.after("tr_test", "legacy-status").retained).toBe(true);

    const accepted = store.commit({
      tree: "tr_test",
      root: B,
      previousRoot: A,
      expectedUpdate: store.current("tr_test")!.id,
      expectedRoot: A,
      kind: "accepted",
      acceptedAt: 3,
    })!;
    expect(observations.latestCursor("tr_test")).toBe(accepted.id);
    expect(observations.after("tr_test", "legacy-status").records.map((record) => record.updateID)).toEqual([accepted.id]);
  });
  test("ancestry uses accepted identities and refuses gaps or a traversal beyond its bound", () => {
    const initial = store.current("tr_test")!;
    const first = store.insert({ tree: "tr_test", root: A, previousRoot: A, kind: "accepted", acceptedAt: 2 });
    const second = store.insert({ tree: "tr_test", root: A, previousRoot: A, kind: "accepted", acceptedAt: 3 });
    expect(store.ancestry(initial.id, second.id)).toEqual([first, second]);
    expect(store.ancestry(initial.id, second.id, 1)).toBeNull();
    expect(store.ancestry(second.id, second.id)).toEqual([]);
    db.run("DELETE FROM observations WHERE update_id = ?", [first.id]);
    db.run("DELETE FROM accepted_updates WHERE id = ?", [first.id]);
    expect(store.ancestry(initial.id, second.id)).toBeNull();
  });

});
