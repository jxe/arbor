import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeProtocolDirectory, hashObject, type CurrentTree, type TreeSnapshot, type UpdateResponse } from "@ovst/protocol";
import { UpdateCoordinator, type UpdateTransport } from "@ovst/working-tree";
import { ChangeLog, FileControlStore } from "@ovst/working-tree/node";
import { MemoryWorkingTree } from "../support/memory-working-tree.ts";

const TREE = "tr_coordinatorpollaaaaaaaaaaa";

test("a clean tree polls the host only while its watch is not open", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "story-coordinator-poll-"));
  const directory = encodeProtocolDirectory({ type: "directory", entries: [] });
  const initial: TreeSnapshot = { root: hashObject(directory), objects: new Map([[hashObject(directory), directory]]) };
  let descriptors = 0;
  const transport: UpdateTransport = {
    async submitUpdates(): Promise<UpdateResponse> { throw new Error("nothing to submit"); },
    async descriptor(tree: string): Promise<CurrentTree> {
      descriptors += 1;
      return { tree: { id: tree, kind: "ordinary", access: "write", canonical: null, root: initial.root, update: "up_initial", conflicted: false } as never, observedThrough: "up_initial" };
    },
  };
  const working = new MemoryWorkingTree({ base: { root: initial.root, update: "up_initial", cursor: "up_initial" }, snapshot: initial });
  const coordinator = new UpdateCoordinator(TREE, new ChangeLog(TREE, stateRoot), new FileControlStore(stateRoot), transport, working, { pollIntervalMs: 10 });
  try {
    await coordinator.start();
    coordinator.setWatching(true);
    const before = descriptors;
    await Bun.sleep(80);
    expect(descriptors).toBe(before);
    coordinator.setWatching(false);
    await Bun.sleep(80);
    expect(descriptors).toBeGreaterThan(before);
  } finally {
    coordinator.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});
