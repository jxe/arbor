import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectStore } from "@ovst/object-store";
import { decodeLogEntry, LOG_ENTRY_FORMAT } from "@ovst/merge-protocol";
import { encodeProtocolDirectory, hashObject } from "@ovst/protocol";
import { MergeHistory } from "../../../packages/overstoryd/src/updates/merge-history.ts";
import type { AcceptedUpdateStore } from "../../../packages/overstoryd/src/updates/store.ts";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "merge-history-write-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

test("an entry and the objects it names are published durably together", async () => {
  const objects = new ObjectStore(join(directory, "objects"));
  const history = new MergeHistory({} as AcceptedUpdateStore, objects);
  const leaf = new TextEncoder().encode("leaf");
  const rootBytes = encodeProtocolDirectory({ type: "directory", entries: [{ name: "a.md", file: hashObject(leaf) }] });
  const named = [{ hash: hashObject(leaf), bytes: leaf }, { hash: hashObject(rootBytes), bytes: rootBytes }];
  const { hash, conflicted } = await history.write({
    format: LOG_ENTRY_FORMAT, tree: "tr_test", previous: null, root: named[1]!.hash, change: "first",
    trace: null, resolves: [], decisions: [],
  }, named);
  expect(conflicted).toBe(false);
  for (const { hash: object, bytes } of named) expect(await objects.read(object)).toEqual(bytes);
  // One publish: one journal append of all three, synced once.
  expect(objects.writes).toMatchObject({ written: 3, fsyncs: 1 });
  // The cached entry is the one its stored bytes decode to.
  expect(await history.entry(hash)).toEqual(decodeLogEntry(await objects.read(hash)));
});
