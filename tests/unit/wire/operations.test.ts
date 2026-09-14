import { describe, expect, test } from "bun:test";
import fixtures from "../../../conformance/wire-operations.json";
import { canonicalUpdateIntent, decodeCandidateUpdateJSON, decodeUpdateRequestJSON, encodeCandidateUpdateJSON, updateRequestDigest } from "@arbor/wire";

describe("semantic operation conformance", () => {
  for (const fixture of fixtures.valid) test(fixture.name, () => {
    const update = decodeCandidateUpdateJSON(fixture.candidate);
    expect(encodeCandidateUpdateJSON(update) as unknown).toEqual(fixture.candidate);
    const intent = { ...update, base: fixtures.base };
    expect(updateRequestDigest(fixtures.tree, intent)).toBe(fixture.digest);
    expect(Buffer.from(canonicalUpdateIntent(fixtures.tree, intent)).toString("base64")).toBe(fixture.canonicalCBORBase64);
  });
  for (const fixture of fixtures.invalid) test(`reject ${fixture.name}`, () => {
    expect(() => decodeCandidateUpdateJSON(fixture.candidate)).toThrow();
  });
  test("reject duplicate changes and bind change and operation contents into identity", () => {
    const update = decodeCandidateUpdateJSON(fixtures.valid[1]!.candidate);
    expect(() => decodeUpdateRequestJSON({ base: fixtures.base, updates: [fixtures.valid[1]!.candidate, fixtures.valid[1]!.candidate] })).toThrow("Duplicate change");
    const intent = { ...update, base: fixtures.base };
    expect(updateRequestDigest(fixtures.tree, { ...intent, change: "another-change" })).not.toBe(fixtures.valid[1]!.digest);
    expect(updateRequestDigest(fixtures.tree, { ...intent, operations: null })).not.toBe(fixtures.valid[1]!.digest);
    const mutated = structuredClone(intent);
    (mutated.operations![0] as { text: string }).text = "different";
    expect(updateRequestDigest(fixtures.tree, mutated)).not.toBe(fixtures.valid[1]!.digest);
  });
});
