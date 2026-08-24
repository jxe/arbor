import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalUpdateIntent,
  decodeObjectEnvelopes,
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
  join(import.meta.dir, "../../../spec/fixtures/wire-update-intent.json"),
  "utf8",
)) as IntentFixtures;

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
  });
});
