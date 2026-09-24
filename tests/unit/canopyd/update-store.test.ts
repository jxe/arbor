import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AcceptedUpdateStore } from "@overstory/canopyd";
import type { ObjectHash } from "@overstory/protocol";
import { ObservationLog } from "../../../packages/canopyd/src/updates/observations.ts";
const NO_ENTRY_CHANGES = { set: [], removed: [] };

const A = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as ObjectHash;
const B = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as ObjectHash;
const C = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as ObjectHash;
/** A stand-in log entry: these tests exercise rows, never the entry object. */
function entry(conflicted = false) {
  return { hash: C, conflicted };
}

describe("accepted-update transaction store", () => {
  let db: Database;
  let store: AcceptedUpdateStore;

  beforeEach(() => {
    db = new Database(":memory:");
    db.run("PRAGMA foreign_keys = ON");
    db.run("CREATE TABLE trees (id TEXT PRIMARY KEY, ref TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    AcceptedUpdateStore.createSchema(db);
    store = new AcceptedUpdateStore(db);
    db.run("INSERT INTO trees (id, ref, updated_at) VALUES ('tr_test', ?, 1)", [A]);
    store.insert({entryChanges:NO_ENTRY_CHANGES, entry: entry(),
      tree: "tr_test",
      root: A,
      previousRoot: null,
      acceptedAt: 1,
    });
  });

  afterEach(() => db.close());

  test("observation replay pages by ordinal and catches appends after the starting position", () => {
    const log = new ObservationLog(db);
    const anchor = log.latestCursor("tr_test")!;
    const start = log.position("tr_test", anchor);
    for (let i=0;i<150;i++) store.insert({entryChanges:NO_ENTRY_CHANGES, entry: entry(),tree:"tr_test",root:A,previousRoot:A,acceptedAt:i+2});
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
    const appended=store.insert({entryChanges:NO_ENTRY_CHANGES, entry: entry(),tree:"tr_test",root:A,previousRoot:A,acceptedAt:999});
    expect(log.page("tr_test",ordinal).map(row=>row.updateID)).toEqual([appended.id]);
  });

  test("descriptor and observation lookups use their scoped indexes", () => {
    const plans: Array<[string, unknown[], string]> = [
      ["SELECT ordinal, root FROM accepted_updates WHERE tree_id = ? ORDER BY ordinal DESC LIMIT 1", ["tr_test"], "accepted_updates_tree"],
      ["SELECT ordinal, tree_id FROM accepted_updates WHERE tree_id = ? AND ordinal > ? ORDER BY ordinal LIMIT 64", ["tr_test", 0], "accepted_updates_tree"],
      ["SELECT u.root, p.root FROM accepted_updates u LEFT JOIN accepted_updates p ON p.ordinal = u.previous_ordinal WHERE u.ordinal = ?", [Number(store.current("tr_test")!.id)], "INTEGER PRIMARY KEY"],
      ["SELECT 1 FROM accepted_updates WHERE tree_id = ? AND root = ? LIMIT 1", ["tr_test", A], "accepted_updates_root"],
    ];
    for (const [query, values, index] of plans) {
      const detail = (db.query("EXPLAIN QUERY PLAN " + query).all(...(values as string[])) as {detail: string}[]).map(row => row.detail).join("\n");
      expect(detail).toContain(index!);
      expect(detail).not.toContain("SCAN");
      expect(detail).not.toContain("TEMP B-TREE");
    }
  });

  test("commits the ref, accepted row, and digest as one result", () => {
    const accepted = store.commit({entryChanges:NO_ENTRY_CHANGES, entry: entry(),
      tree: "tr_test",
      root: B,
      previousRoot: A,
      expectedUpdate: store.current("tr_test")!.id,
      acceptedAt: 2,
      subject: "device:one",
      requestDigest: "sha256:request",
    });
    expect(accepted?.id).toBe(String(Number(store.list("tr_test")[0]!.id) + 1));
    expect((db.query("SELECT ref FROM trees WHERE id = 'tr_test'").get() as { ref: string }).ref).toBe(B);
    expect(store.list("tr_test")).toHaveLength(2);
    expect(store.list("tr_test").map((update) => Number(update.id))).toEqual(store.list("tr_test").map((update) => Number(update.id)).sort((a, b) => a - b));
    expect(store.acceptedRequest("tr_test", "device:one", "sha256:request")).toEqual({
      status: 201,
      result: { outcome: "accepted", update: accepted!, requestDigest: "sha256:request" },
    });
  });

  test("a failed compare-and-swap changes no authority state", () => {
    const accepted = store.commit({entryChanges:NO_ENTRY_CHANGES, entry: entry(),
      tree: "tr_test",
      root: C,
      previousRoot: B,
      expectedUpdate: store.current("tr_test")!.id,
      acceptedAt: 2,
      requestDigest: "sha256:stale",
    });
    expect(accepted).toBeNull();
    expect(store.list("tr_test")).toHaveLength(1);
    expect((db.query("SELECT ref FROM trees WHERE id = 'tr_test'").get() as { ref: string }).ref).toBe(A);
  });

  test("accepted identity guards commits even when projection bytes are unchanged", () => {
    const initial = store.current("tr_test")!;
    const input = { entryChanges: NO_ENTRY_CHANGES, entry: entry(), tree: "tr_test", root: A, previousRoot: A, expectedUpdate: initial.id, acceptedAt: 2 };
    const metadata = store.commit(input)!;
    expect(metadata.root).toBe(initial.root);
    expect(metadata.id).not.toBe(initial.id);
    expect(store.commit({ ...input, root: B, acceptedAt: 3 })).toBeNull();
    expect(store.current("tr_test")!.id).toBe(metadata.id);
    expect(store.list("tr_test")).toHaveLength(2);
  });

  test("persists unresolved metadata and predecessor links independently of projection", () => {
    const initial = store.current("tr_test")!;
    const metadata = store.commit({entryChanges:NO_ENTRY_CHANGES, entry: entry(true), tree: "tr_test", root: A, previousRoot: A,
      expectedUpdate: initial.id, acceptedAt: 2 })!;
    const next = store.commit({entryChanges:NO_ENTRY_CHANGES, entry: entry(true), tree: "tr_test", root: B, previousRoot: A,
      expectedUpdate: metadata.id, acceptedAt: 3 })!;
    expect(next.conflicted).toBe(true);
    expect(next.previous).toEqual({ id: metadata.id, root: A });
    expect(Object.hasOwn(next, "merge")).toBe(false);
    expect(Object.hasOwn(next, "kind")).toBe(false);
    expect(new AcceptedUpdateStore(db).get(next.id)).toEqual(next);
    // The id is the row's ordinal, spelled canonically; the cursor is the same text.
    expect(new ObservationLog(db).forUpdate(next.id)!.cursor).toBe(next.id);
    for (const spelling of [`0${next.id}`, `${next.id}.0`, "au_legacy"]) expect(store.get(spelling)).toBeNull();
  });

  test("cursors are never reused and anything but a retained ordinal of the tree is not retained", () => {
    const observations = new ObservationLog(db);
    const initial = store.current("tr_test")!;
    const pruned = store.insert({entryChanges:NO_ENTRY_CHANGES, entry: entry(), tree: "tr_test", root: A, previousRoot: A, acceptedAt: 2 });
    db.run("DELETE FROM accepted_updates WHERE ordinal = ?", [pruned.id]);
    const next = store.insert({entryChanges:NO_ENTRY_CHANGES, entry: entry(), tree: "tr_test", root: A, previousRoot: A, acceptedAt: 3 });
    expect(Number(next.id)).toBe(Number(pruned.id) + 1);
    expect(observations.latestCursor("tr_test")).toBe(next.id);
    for (const cursor of [pruned.id, "legacy-status", "0", "01", "-1", `${initial.id}.0`])
      expect(observations.position("tr_test", cursor).retained).toBe(false);
    expect(observations.position("tr_test", initial.id)).toEqual({ retained: true, through: Number(initial.id) });
    expect(observations.page("tr_test", Number(initial.id)).map((record) => record.updateID)).toEqual([next.id]);
  });
  test("conflicted follows each row's own log entry", () => {
    const initial = store.current("tr_test")!;
    const open = store.commit({ entryChanges: NO_ENTRY_CHANGES, entry: entry(true), tree: "tr_test", root: B, previousRoot: A,
      expectedUpdate: initial.id, acceptedAt: 2 })!;
    const closed = store.commit({ entryChanges: NO_ENTRY_CHANGES, entry: entry(), tree: "tr_test", root: C, previousRoot: B,
      expectedUpdate: open.id, acceptedAt: 3 })!;
    expect([open.conflicted, closed.conflicted]).toEqual([true, false]);
    expect(store.entryOf(open.id)).toBe(C);
    expect(() => store.insert({ entryChanges: NO_ENTRY_CHANGES, tree: "tr_test", root: C, previousRoot: C, acceptedAt: 4 } as never)).toThrow();
  });

});
