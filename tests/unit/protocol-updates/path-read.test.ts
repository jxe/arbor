import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePathReadBundle, decodePathReadPath, encodePathReadBundle, encodePathReadPath, pathReadObjects } from "@ovst/protocol";

// Clients 003: path reads are one walk for every producer and reader; these
// vectors bind it (tree operations §1.2.4), and Swift runs the same file.

type Fixture = {
  root: string;
  objects: { hash: string; base64: string }[];
  valid: { name: string; path: string; objects: string[]; bundleBase64: string }[];
  invalid: { name: string; path: string; bundleBase64: string; error: "off-path" | "missing" | "missing-root" }[];
};

const fixture = JSON.parse(await readFile(join(import.meta.dir, "../../../docs/overstory-spec/conformance/protocol-path-reads.json"), "utf8")) as Fixture;
const objects = new Map(fixture.objects.map(({ hash, base64 }) => [hash, new Uint8Array(Buffer.from(base64, "base64"))]));
const messages = { "off-path": /off the path/, missing: /missing sha256/, "missing-root": /does not hold its root/ };

describe("path read vectors", () => {
  for (const vector of fixture.valid) {
    test(vector.name, async () => {
      const read = await pathReadObjects(fixture.root, vector.path, async (hash) => objects.get(hash) ?? null);
      expect([...read.keys()].sort()).toEqual(vector.objects);
      const bundle = encodePathReadBundle(read);
      expect(Buffer.from(bundle).toString("base64")).toBe(vector.bundleBase64);
      expect([...(await decodePathReadBundle(fixture.root, vector.path, bundle)).keys()].sort()).toEqual(vector.objects);
    });
  }
  for (const vector of fixture.invalid) {
    test(`rejects ${vector.name}`, async () => {
      await expect(decodePathReadBundle(fixture.root, vector.path, new Uint8Array(Buffer.from(vector.bundleBase64, "base64")))).rejects.toThrow(messages[vector.error]);
    });
  }
});

describe("path read URLs", () => {
  test("encode each segment once and decode it once", () => {
    expect(encodePathReadPath("/Trips/Café au lait")).toBe("/Trips/Caf%C3%A9%20au%20lait");
    expect(encodePathReadPath("/")).toBe("");
    expect(decodePathReadPath("/Trips/Caf%C3%A9%20au%20lait")).toBe("/Trips/Café au lait");
    expect(decodePathReadPath("/a%2525b")).toBe("/a%25b");
    expect(() => decodePathReadPath("/a%2Fb")).toThrow();
    expect(() => decodePathReadPath("/a/%2E%2E")).toThrow();
  });
});
