import { expect, test } from "bun:test";
import { decodeWireDirectory, encodeWireDirectory, hashObject, snapshotAccountConfigV2, type ObjectHash } from "@overstory/protocol";
import { checkResourcePolicy } from "./check.ts";

const profile = "tr_aaaaaaaaaaaaaaaaaaaaaaaaaa", tree = "tr_bbbbbbbbbbbbbbbbbbbbbbbbbb", device = "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa";

test("lists only account configurations whose trees.yaml is not resource grammar", async () => {
  const current = snapshotAccountConfigV2({
    account: { canopy: "https://canopy.example", profile },
    resources: { [tree]: { canonical: "https://canopy.example/~joe/notes", access: [{ who: "everyone", allow: ["read"] }] } },
    devices: { [device]: { id: device, label: "Mac", administrator: true } },
  });
  const objects = new Map<ObjectHash, Uint8Array>(current.objects);
  const legacyTrees = new TextEncoder().encode(`${tree}:\n  canonical: https://canopy.example/~joe/notes\n  access:\n    - subject: { kind: everyone }\n      access: read\n`);
  objects.set(hashObject(legacyTrees), legacyTrees);
  const { entries } = decodeWireDirectory(current.objects.get(current.root)!);
  const legacyRoot = encodeWireDirectory({ type: "directory", entries: entries.map(e => e.name === "trees.yaml" ? { name: e.name, file: hashObject(legacyTrees) } : e) });
  objects.set(hashObject(legacyRoot), legacyRoot);
  const report = await checkResourcePolicy(
    [{ id: "tr_current", ref: current.root }, { id: "tr_legacy", ref: hashObject(legacyRoot) }],
    async hash => objects.get(hash)!,
  );
  expect(report.checked).toBe(2);
  expect(report.failing.map(f => f.tree)).toEqual(["tr_legacy"]);
});
