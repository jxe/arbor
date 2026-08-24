import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AcceptedUpdateStore } from "@arbor/authority";
import type { ObjectHash } from "@arbor/wire";

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
    db.run("CREATE TABLE update_replays (legacy INTEGER)");
    AcceptedUpdateStore.ensureSchema(db);
    store = new AcceptedUpdateStore(db);
    db.run("INSERT INTO trees (id, ref, updated_at) VALUES ('tr_test', ?, 1)", [A]);
    store.insert("up_initial", {
      tree: "tr_test",
      root: A,
      previousRoot: null,
      kind: "initial",
      acceptedAt: 1,
    });
  });

  afterEach(() => db.close());

  test("commits the ref, reflog, accepted row, and digest as one result", () => {
    const accepted = store.commit("up_next", {
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
    });
    expect(accepted?.id).toBe("up_next");
    expect((db.query("SELECT ref FROM trees WHERE id = 'tr_test'").get() as { ref: string }).ref).toBe(B);
    expect(db.query("SELECT * FROM reflog").all()).toHaveLength(1);
    expect(store.list("tr_test")).toHaveLength(2);
    expect(store.acceptedRequest("tr_test", "device:one", "sha256:request")).toEqual({
      status: 201,
      result: { outcome: "accepted", update: accepted! },
    });
  });

  test("a failed compare-and-swap changes no authority state", () => {
    const accepted = store.commit("up_stale", {
      tree: "tr_test",
      root: C,
      previousRoot: B,
      expectedRoot: B,
      kind: "accepted",
      acceptedAt: 2,
      requestDigest: "sha256:stale",
    });
    expect(accepted).toBeNull();
    expect(store.list("tr_test").map((update) => update.id)).toEqual(["up_initial"]);
    expect(db.query("SELECT * FROM reflog").all()).toHaveLength(0);
    expect((db.query("SELECT ref FROM trees WHERE id = 'tr_test'").get() as { ref: string }).ref).toBe(A);
  });

  test("the one-way schema upgrade removes the obsolete replay table", () => {
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'update_replays'").get()).toBeNull();
  });
});
