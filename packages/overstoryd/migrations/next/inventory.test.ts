import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveHost } from "@ovst/overstoryd";
import { deviceClient, testAccount } from "../../../../tests/helpers/devices.ts";
import { encodeCanonicalCBOR } from "@ovst/protocol/cbor";
import { inventory, legacyEntries } from "./inventory.ts";

let sandbox: string, dataRoot: string;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "story-inventory-"));
  dataRoot = join(sandbox, "host");
  const host = await serveHost({
    dataRoot, accounts: [testAccount("owner", "inventory-owner", { communityWriter: true })],
    publicOrigin: "http://127.0.0.1:0", hostname: "127.0.0.1", port: 0,
  });
  await (await deviceClient(host.url, "inventory-owner")).account();
  host.server.stop(true);
  await host.overstoryd[Symbol.asyncDispose]();
});

afterAll(async () => { await rm(sandbox, { recursive: true, force: true }); });

test("the inventory reads every tree's head and lists short ids without writing", async () => {
  const report = await inventory(dataRoot);
  expect(report.trees.length).toBeGreaterThan(0);
  for (const tree of report.trees) {
    expect(tree.missingObjects).toBe(0);
    expect(tree.directories).toBeGreaterThan(0);
  }
  expect(report.shortTrees.map((tree) => tree.id)).toEqual(report.trees.filter((tree) => tree.short).map((tree) => tree.id));
});

test("directories from before entry times are read as they stand", () => {
  const file = `sha256:${"1".repeat(64)}`;
  const legacy = encodeCanonicalCBOR({ type: "directory", entries: [{ name: "a.md", file }, { name: "b", page: file }] });
  expect(legacyEntries(legacy)).toEqual([{ name: "a.md", file }, { name: "b", page: file }]);
  expect(() => legacyEntries(encodeCanonicalCBOR({ type: "file" }))).toThrow();
});
