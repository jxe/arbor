import { describe, expect, test } from "bun:test";
import { encodeObjectEnvelopes, encodeWireObject, hashObject, type TreeSnapshot } from "@arbor/wire";
import {
  decodeAdmissionBasis,
  decodeRawSyncState,
  assertUnchangedCanopy,
  replaceWireFile,
  snapshotFromTransition,
  textAtWirePath,
} from "../../tools/recovery/arborsync-recovery.ts";

function file(source: string): [string, Uint8Array] {
  const bytes = encodeWireObject({ type: "file", bytes: new TextEncoder().encode(source) });
  return [hashObject(bytes), bytes];
}

function snapshot(source: string, extra = "one"): TreeSnapshot {
  const [indexHash, indexBytes] = file(source);
  const [extraHash, extraBytes] = file(extra);
  const rootBytes = encodeWireObject({
    type: "directory",
    entries: [
      { name: "_index.md", hash: indexHash },
      { name: "extra.txt", hash: extraHash },
    ],
  });
  const root = hashObject(rootBytes);
  return { root, objects: new Map([[root, rootBytes], [indexHash, indexBytes], [extraHash, extraBytes]]) };
}

describe("ArborSync recovery evidence", () => {
  test("retains legacy editor records instead of passing through the refactored state adapter", () => {
    const basis = snapshot("base");
    const admissionBasis = Buffer.from(JSON.stringify({
      version: 1,
      id: "editor-1",
      ref: { tree: "tr_example", path: "/", stableKey: "id:root" },
      baseUpdate: "10",
      baseRoot: basis.root,
      candidateRoot: basis.root,
      wirePath: "/_index.md",
      contentRevision: "rev-1",
      objects: encodeObjectEnvelopes(basis.objects),
    })).toString("base64url");
    const raw = decodeRawSyncState({
      accepted: { root: basis.root, hashes: [...basis.objects.keys()] },
      acceptedRequestDigests: [`sha256:${"1".repeat(64)}`],
      editorAdmissions: [{
        id: "editor-1",
        ref: { tree: "tr_example", path: "/", stableKey: "id:root" },
        request: { base: "10", candidate: basis.root, ifMatch: "modelHash", objects: [], deltas: [] },
        source: "exact editor source",
        contentRevision: "rev-2",
        admissionBasis,
        requestDigest: `sha256:${"1".repeat(64)}`,
        transmitted: true,
        acknowledged: true,
      }],
    });
    expect(raw.editorAdmissions).toHaveLength(1);
    expect(raw.editorAdmissions[0]!.source).toBe("exact editor source");
    expect(decodeAdmissionBasis(admissionBasis).wirePath).toBe("/_index.md");
  });

  test("reconstructs a sparse pending transition over the accepted object inventory", async () => {
    const basis = snapshot("base");
    const changed = snapshot("pending");
    const changedIndex = [...changed.objects].find(([, bytes]) => {
      const text = new TextDecoder().decode(bytes);
      return text.includes("pending");
    })!;
    const transition = snapshotFromTransition(basis, {
      base: "10",
      candidate: changed.root,
      ifMatch: "modelHash",
      objects: encodeObjectEnvelopes([changedIndex, [changed.root, changed.objects.get(changed.root)!]]),
      deltas: [],
    });
    expect(await textAtWirePath(transition, "/_index.md")).toBe("pending");
    expect(transition.objects.size).toBe(3);
  });

  test("overlays a recorded exact document source without losing disk-only structure", async () => {
    const disk = snapshot("disk", "disk-only");
    const replaced = replaceWireFile(disk, "/_index.md", "recorded");
    expect(await textAtWirePath(replaced, "/_index.md")).toBe("recorded");
    expect(replaced.root).not.toBe(disk.root);
    expect([...replaced.objects.values()].some((bytes) => new TextDecoder().decode(bytes).includes("disk-only"))).toBe(true);
  });

  test("refuses submission after either the Canopy update or root drifts", () => {
    const root = `sha256:${"1".repeat(64)}`;
    expect(() => assertUnchangedCanopy({ update: "10", root }, { update: "10", root })).not.toThrow();
    expect(() => assertUnchangedCanopy({ update: "10", root }, { update: "11", root })).toThrow("Canopy drifted");
    expect(() => assertUnchangedCanopy({ update: "10", root }, { update: "10", root: `sha256:${"2".repeat(64)}` })).toThrow("Canopy drifted");
  });
});
