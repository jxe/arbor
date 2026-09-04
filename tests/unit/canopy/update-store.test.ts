import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AcceptedUpdateStore } from "@arbor/canopy";
import { encodeWireObject, type ObjectHash } from "@arbor/wire";
import { ObservationLog } from "../../../packages/canopy/src/updates/observations.ts";

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

  test("commits the ref, reflog, accepted row, and digest as one result", () => {
    const bytes = encodeWireObject({ type: "directory", entries: [] });
    const accepted = store.commit({
      tree: "tr_test",
      root: B,
      previousRoot: A,
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
      result: { outcome: "accepted", update: accepted!, requestDigest: "sha256:request", observedThrough: accepted!.id },
    });
  });

  test("a failed compare-and-swap changes no authority state", () => {
    const accepted = store.commit({
      tree: "tr_test",
      root: C,
      previousRoot: B,
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
      expectedRoot: A,
      kind: "accepted",
      acceptedAt: 3,
    })!;
    expect(observations.latestCursor("tr_test")).toBe(accepted.id);
    expect(observations.after("tr_test", "legacy-status").records.map((record) => record.updateID)).toEqual([accepted.id]);
  });
});
