import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalUpdateIntent,
  decodeFilePatches,
  decodeObjectEnvelopes,
  decodeUpdateRequestJSON,
  updateRequestDigest,
  type ObjectHash,
} from "@arbor/wire";

interface IntentFixtures {
  version: number;
  identity: {
    tree: string;
    base: { root: ObjectHash; update: string };
    candidate: ObjectHash;
    canonicalJSON: string;
    digest: string;
  };
  replayCases: Array<{
    name: string;
    sameIntent: boolean;
    expected: { sameBody?: boolean; differentDigest?: boolean; additionalAcceptedUpdates?: number };
  }>;
}

const fixtures = JSON.parse(await readFile(
  join(import.meta.dir, "../../../conformance/wire-update-intent.json"),
  "utf8",
)) as IntentFixtures;
const patchFixtures = JSON.parse(await readFile(
  join(import.meta.dir, "../../../conformance/wire-file-patches.json"),
  "utf8",
)) as {
  valid: { base: ObjectHash; result: ObjectHash; edits: Array<{ offset: number; length: number; bytes: string }> };
  invalid: Array<{ name: string; patches: unknown[] }>;
};

describe("updates-v1 JSON identity", () => {
  test("matches the language-neutral canonical JSON and digest vector", () => {
    const identity = fixtures.identity;
    expect(canonicalUpdateIntent(identity.tree, identity)).toBe(identity.canonicalJSON);
    expect(updateRequestDigest(identity.tree, identity)).toBe(identity.digest);
  });

  test("depends on every semantic field but not object-envelope ordering", () => {
    const identity = fixtures.identity;
    const changed = [
      ["other-tree", identity.base, identity.candidate],
      [identity.tree, { ...identity.base, update: "up_other" }, identity.candidate],
      [identity.tree, { ...identity.base, root: `${identity.base.root.slice(0, -1)}0` as ObjectHash }, identity.candidate],
      [identity.tree, identity.base, `${identity.candidate.slice(0, -1)}0` as ObjectHash],
    ] as const;
    for (const [tree, base, candidate] of changed) {
      expect(updateRequestDigest(tree, { base, candidate })).not.toBe(identity.digest);
    }
    expect(fixtures.replayCases).toEqual(expect.arrayContaining([
      expect.objectContaining({ sameIntent: true, expected: expect.objectContaining({ additionalAcceptedUpdates: 0 }) }),
      expect.objectContaining({ sameIntent: false, expected: expect.objectContaining({ differentDigest: true }) }),
    ]));
  });

  test("accepts exact duplicate envelopes and rejects ambiguous transport", () => {
    const hash = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as ObjectHash;
    expect(decodeObjectEnvelopes([
      { hash, bytes: "YQ==" },
      { hash, bytes: "YQ==" },
    ])).toHaveLength(1);
    expect(() => decodeObjectEnvelopes([
      { hash, bytes: "YQ==" },
      { hash, bytes: "Yg==" },
    ])).toThrow("different bytes");
    expect(() => decodeObjectEnvelopes([{ hash, bytes: "YQ" }])).toThrow("padded base64");
    expect(() => decodeUpdateRequestJSON({
      base: fixtures.identity.base,
      candidate: fixtures.identity.candidate,
      objects: [],
      returnSnapshot: "yes",
    })).toThrow('returnSnapshot must be true or "if-result-differs"');
    expect(decodeUpdateRequestJSON({
      base: fixtures.identity.base,
      candidate: fixtures.identity.candidate,
      objects: [],
      returnSnapshot: "if-result-differs",
    }).returnSnapshot).toBe("if-result-differs");
  });

  test("validates canonical file-patch envelopes before server use", () => {
    const { base, result } = patchFixtures.valid;
    const decoded = decodeFilePatches([patchFixtures.valid]);
    expect(decoded).toEqual([{
      base,
      result,
      edits: [
        { offset: 1, length: 2, bytes: new Uint8Array([120]) },
        { offset: 4, length: 0, bytes: new Uint8Array([121]) },
      ],
    }]);
    for (const fixture of patchFixtures.invalid) {
      expect(() => decodeFilePatches(fixture.patches), fixture.name).toThrow();
    }
    expect(() => decodeUpdateRequestJSON({
      base: fixtures.identity.base,
      candidate: fixtures.identity.candidate,
      objects: [{ hash: result, bytes: "eA==" }],
      filePatches: [{ base, result, edits: [{ offset: 0, length: 0, bytes: "eA==" }] }],
    })).toThrow("also supplied as a complete object");
  });
});
