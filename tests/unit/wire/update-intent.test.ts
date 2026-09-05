import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalUpdateIntent,
  decodeObjectDeltas,
  decodeObjectEnvelopes,
  decodeUpdateRequestJSON,
  updateRequestDigest,
  updateRequestDigests,
  type ObjectHash,
} from "@arbor/wire";

interface IntentFixtures {
  version: number;
  identity: {
    tree: string;
    base: string;
    candidate: ObjectHash;
    ifMatch: "bytesHash" | "modelHash";
    onConflict?: "reject" | "merge";
    canonicalCBORBase64: string;
    digest: string;
  };
  laterElement: {
    tree: string;
    base: { requestDigest: ObjectHash; candidate: ObjectHash };
    candidate: ObjectHash;
    ifMatch: "modelHash";
    onConflict: "merge";
    canonicalCBORBase64: string;
    digest: ObjectHash;
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
const deltaFixtures = JSON.parse(await readFile(
  join(import.meta.dir, "../../../conformance/wire-object-deltas.json"),
  "utf8",
)) as {
  valid: { base: ObjectHash; result: ObjectHash; instructions: unknown[] };
  invalid: Array<{ name: string; deltas: unknown[] }>;
};

describe("updates-v1 JSON identity", () => {
  test("matches the language-neutral canonical CBOR and digest vector", () => {
    const identity = fixtures.identity;
    expect(Buffer.from(canonicalUpdateIntent(identity.tree, identity)).toString("base64")).toBe(identity.canonicalCBORBase64);
    expect(updateRequestDigest(identity.tree, identity)).toBe(identity.digest);
  });

  test("depends on every semantic field but not object-envelope ordering", () => {
    const identity = fixtures.identity;
    const changed = [
      ["other-tree", identity.base, identity.candidate, identity.ifMatch, identity.onConflict],
      [identity.tree, `${identity.base}0`, identity.candidate, identity.ifMatch, identity.onConflict],
      [identity.tree, null, identity.candidate, identity.ifMatch, identity.onConflict],
      [identity.tree, identity.base, `${identity.candidate.slice(0, -1)}0` as ObjectHash, identity.ifMatch, identity.onConflict],
      [identity.tree, identity.base, identity.candidate, "bytesHash", undefined],
      [identity.tree, identity.base, identity.candidate, identity.ifMatch, "reject"],
    ] as const;
    for (const [tree, base, candidate, ifMatch, onConflict] of changed) {
      expect(updateRequestDigest(tree, { base, candidate, ifMatch, onConflict })).not.toBe(identity.digest);
    }
    // onConflict is digested at its effective value, so an omitted merge equals an explicit one.
    expect(updateRequestDigest(identity.tree, { base: identity.base, candidate: identity.candidate, ifMatch: identity.ifMatch }))
      .toBe(identity.digest);
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
      base: { root: fixtures.identity.candidate, update: fixtures.identity.base },
      updates: [{ candidate: fixtures.identity.candidate, ifMatch: "modelHash", objects: [], deltas: [] }],
    })).toThrow("base update id or null");
    const activation = decodeUpdateRequestJSON({ base: null, updates: [{ candidate: fixtures.identity.candidate,
      ifMatch: "bytesHash", objects: [], deltas: [] }] });
    expect(activation.base).toBeNull();
    expect(activation.updates[0]!.deltas).toEqual([]);
    expect(() => decodeUpdateRequestJSON({
      base: null,
      updates: [{
        candidate: fixtures.identity.candidate,
        ifMatch: "bytesHash",
        objects: [],
        deltas: [{ base: fixtures.identity.candidate, result: `${fixtures.identity.candidate.slice(0, -1)}0`, instructions: [{ insert: "eA==" }] }],
      }],
    })).toThrow("no base to apply deltas");
  });

  test("validates canonical object-delta envelopes before server use", () => {
    const { base, result } = deltaFixtures.valid;
    const decoded = decodeObjectDeltas([deltaFixtures.valid]);
    expect(decoded).toEqual([{
      base,
      result,
      instructions: [
        { copy: { offset: 0, length: 1 } },
        { insert: new Uint8Array([120]) },
      ],
    }]);
    for (const fixture of deltaFixtures.invalid) {
      expect(() => decodeObjectDeltas(fixture.deltas), fixture.name).toThrow();
    }
    expect(() => decodeUpdateRequestJSON({
      base: fixtures.identity.base,
      updates: [{
        candidate: fixtures.identity.candidate,
        ifMatch: "modelHash",
        objects: [{ hash: result, bytes: "eA==" }],
        deltas: [{ base, result, instructions: [{ insert: "eA==" }] }],
      }],
    })).toThrow("also supplied as a complete object");
  });

  test("chains later identities through the exact append-only prefix", () => {
    const first = {
      candidate: fixtures.identity.candidate,
      ifMatch: fixtures.identity.ifMatch,
      onConflict: fixtures.identity.onConflict,
      objects: [],
      deltas: [],
    };
    const second = {
      candidate: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as ObjectHash,
      ifMatch: "modelHash" as const,
      objects: [],
      deltas: [],
    };
    const digests = updateRequestDigests(fixtures.identity.tree, { base: fixtures.identity.base, updates: [first, second] });
    expect(digests[0]).toBe(fixtures.identity.digest);
    expect(digests[1]).toBe(updateRequestDigest(fixtures.identity.tree, {
      base: { requestDigest: digests[0]!, candidate: first.candidate },
      candidate: second.candidate,
      ifMatch: second.ifMatch,
    }));
    expect(digests[1]).toBe(fixtures.laterElement.digest);
    expect(Buffer.from(canonicalUpdateIntent(fixtures.laterElement.tree, fixtures.laterElement)).toString("base64"))
      .toBe(fixtures.laterElement.canonicalCBORBase64);
    expect(updateRequestDigests(fixtures.identity.tree, { base: fixtures.identity.base, updates: [first] })).toEqual(digests.slice(0, 1));
  });
});
