import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeCBOR, encodeCanonicalCBOR } from "@arbor/core";
import {
  decodeSnapshotBundle,
  encodeSnapshotBundle,
  encodeWireObject,
  hashObject,
  type TreeSnapshot,
} from "@arbor/wire";

function fixture(): TreeSnapshot {
  const file = encodeWireObject({ type: "file", bytes: new TextEncoder().encode("snapshot\n") });
  const fileHash = hashObject(file);
  const root = encodeWireObject({ type: "directory", entries: [{ name: "note.md", hash: fileHash }] });
  const rootHash = hashObject(root);
  return { root: rootHash, objects: new Map([[rootHash, root], [fileHash, file]]) };
}

describe("immutable snapshot bundle", () => {
  test("matches the language-neutral canonical bundle vector", async () => {
    const fixture = JSON.parse(await readFile(join(import.meta.dir, "../../../conformance/wire-snapshot-bundles.json"), "utf8")) as {
      valid: Array<{
        root: string;
        objects: Array<{ hash: string; canonicalCborBase64: string }>;
        canonicalCborBase64: string;
        etag: string;
      }>;
    };
    for (const vector of fixture.valid) {
      const snapshot = {
        root: vector.root,
        objects: new Map(vector.objects.map(({ hash, canonicalCborBase64 }) => [
          hash,
          new Uint8Array(Buffer.from(canonicalCborBase64, "base64")),
        ])),
      };
      const body = encodeSnapshotBundle(snapshot);
      expect(Buffer.from(body).toString("base64")).toBe(vector.canonicalCborBase64);
      expect(hashObject(body)).toBe(vector.etag);
      expect(decodeSnapshotBundle(vector.root, body)).toEqual(snapshot);
    }
  });

  test("encodes only version and hash-ordered object byte strings", () => {
    const snapshot = fixture();
    const body = encodeSnapshotBundle(snapshot);
    const decoded = decodeCBOR(body) as { version: number; objects: Uint8Array[] };
    expect(Object.keys(decoded).sort()).toEqual(["objects", "version"]);
    expect(decoded.version).toBe(1);
    expect(decoded.objects.map(hashObject)).toEqual([...snapshot.objects.keys()].sort());
    expect(decodeSnapshotBundle(snapshot.root, body)).toEqual(snapshot);
  });

  test("rejects a mismatched root, incomplete graph, extras, and unordered objects", () => {
    const snapshot = fixture();
    const objects = [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })).sort((a, b) => a.hash.localeCompare(b.hash));
    const missingRoot = `sha256:${"0".repeat(64)}`;
    expect(() => decodeSnapshotBundle(missingRoot, encodeSnapshotBundle(snapshot))).toThrow("missing reachable object");
    expect(() => decodeSnapshotBundle(snapshot.root, encodeCanonicalCBOR({ version: 1, objects: [objects.find(({ hash }) => hash === snapshot.root)!.bytes] })))
      .toThrow("missing reachable object");
    const extra = encodeWireObject({ type: "file", bytes: new TextEncoder().encode("extra") });
    const withExtra = [...objects, { hash: hashObject(extra), bytes: extra }].sort((a, b) => a.hash.localeCompare(b.hash));
    expect(() => decodeSnapshotBundle(snapshot.root, encodeCanonicalCBOR({ version: 1, objects: withExtra.map(({ bytes }) => bytes) })))
      .toThrow("unreachable objects");
    expect(() => decodeSnapshotBundle(snapshot.root, encodeCanonicalCBOR({ version: 1, objects: objects.toReversed().map(({ bytes }) => bytes) })))
      .toThrow("not ordered by hash");
  });

  test("rejects duplicate, malformed, and noncanonical object bytes", () => {
    const snapshot = fixture();
    const ordered = [...snapshot.objects].map(([hash, bytes]) => ({ hash, bytes })).sort((a, b) => a.hash.localeCompare(b.hash));
    expect(() => decodeSnapshotBundle(snapshot.root, encodeCanonicalCBOR({ version: 1, objects: [ordered[0]!.bytes, ordered[0]!.bytes] })))
      .toThrow("not ordered by hash");
    expect(() => decodeSnapshotBundle(snapshot.root, encodeCanonicalCBOR({ version: 1, objects: [Uint8Array.of(0xff)] })))
      .toThrow();
    const noncanonical = Uint8Array.from([0xa2, 0x64, 0x74, 0x79, 0x70, 0x65, 0x64, 0x66, 0x69, 0x6c, 0x65, 0x65, 0x62, 0x79, 0x74, 0x65, 0x73, 0x58, 0x00]);
    expect(() => decodeSnapshotBundle(hashObject(noncanonical), encodeCanonicalCBOR({ version: 1, objects: [noncanonical] })))
      .toThrow();
  });

  test("rejects a noncanonical outer bundle", () => {
    const snapshot = fixture();
    const canonical = encodeSnapshotBundle(snapshot);
    const versionOffset = canonical.lastIndexOf(0x01);
    expect(versionOffset).toBeGreaterThan(0);
    const noncanonical = Uint8Array.from([
      ...canonical.slice(0, versionOffset),
      0xfb, 0x3f, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ...canonical.slice(versionOffset + 1),
    ]);
    expect(() => decodeSnapshotBundle(snapshot.root, noncanonical)).toThrow("not canonical CBOR");
  });
});
