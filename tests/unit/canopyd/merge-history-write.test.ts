import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectStore } from "@overstory/object-store";
import { decodeLogEntry, LOG_ENTRY_FORMAT } from "@overstory/merge-protocol";
import { encodeWireDirectory, hashObject } from "@overstory/protocol";
import { MergeHistory } from "../../../packages/canopyd/src/updates/merge-history.ts";
import type { AcceptedUpdateStore } from "../../../packages/canopyd/src/updates/store.ts";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "merge-history-write-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

test("an entry and the objects it names are published durably together", async () => {
  const objects = new ObjectStore(join(directory, "objects"));
  const history = new MergeHistory({} as AcceptedUpdateStore, objects);
  const leaf = new TextEncoder().encode("leaf");
  const rootBytes = encodeWireDirectory({ type: "directory", entries: [{ name: "a.md", file: hashObject(leaf) }] });
  const named = [{ hash: hashObject(leaf), bytes: leaf }, { hash: hashObject(rootBytes), bytes: rootBytes }];
  const { hash, conflicted } = await history.write({
    format: LOG_ENTRY_FORMAT, tree: "tr_test", previous: null, root: named[1]!.hash, change: "first",
    trace: null, resolves: [], decisions: [],
  }, named);
  expect(conflicted).toBe(false);
  for (const { hash: object, bytes } of named) expect(await objects.read(object)).toEqual(bytes);
  // One publish: three files, their shard directories, the root once, and the
  // root's entry in its parent once for this process.
  const shards = new Set([...named.map((o) => o.hash), hash].map((h) => h.slice(7, 9)));
  expect(objects.writes.fsyncs).toBe(3 + shards.size + 2);
  // The cached entry is the one its stored bytes decode to.
  expect(await history.entry(hash)).toEqual(decodeLogEntry(await objects.read(hash)));
});
