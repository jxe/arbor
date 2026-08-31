import { describe, expect, test } from "bun:test";
import {
  decodeTransitionPayloadJSON,
  encodeTransitionPayloadJSON,
  encodeWireObject,
  hashObject,
  type AcceptedTransitionPayload,
} from "@arbor/wire";

describe("accepted transition wire encoding", () => {
  test("round-trips canonical object, splice, and copy/insert representations", () => {
    const base = encodeWireObject({ type: "file", bytes: new TextEncoder().encode("base") });
    const result = encodeWireObject({ type: "file", bytes: new TextEncoder().encode("best") });
    const directory = encodeWireObject({ type: "directory", entries: [{ name: "note.md", hash: hashObject(result) }] });
    const payload: AcceptedTransitionPayload = {
      objects: [{ hash: hashObject(directory), bytes: directory }],
      filePatches: [{
        base: hashObject(base),
        result: hashObject(result),
        edits: [{ offset: 1, length: 3, bytes: new TextEncoder().encode("est") }],
      }],
    };
    expect(decodeTransitionPayloadJSON(encodeTransitionPayloadJSON(payload))).toEqual(payload);

    const delta: AcceptedTransitionPayload = {
      objects: [],
      fileDeltas: [{
        base: hashObject(base),
        result: hashObject(result),
        instructions: [{ copy: { offset: 0, length: 1 } }, { insert: new TextEncoder().encode("est") }],
      }],
    };
    expect(decodeTransitionPayloadJSON(encodeTransitionPayloadJSON(delta))).toEqual(delta);
  });

  test("rejects duplicate results and ambiguous delta instructions", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    expect(() => decodeTransitionPayloadJSON({
      objects: [{ hash, bytes: "AA==" }],
      fileDeltas: [{ base: hash, result: hash, instructions: [{ insert: "YQ==" }] }],
    })).toThrow("supplied more than once");
    expect(() => decodeTransitionPayloadJSON({
      objects: [],
      fileDeltas: [{ base: hash, result: `sha256:${"b".repeat(64)}`, instructions: [{ copy: { offset: 0, length: 1 }, insert: "YQ==" }] }],
    })).toThrow("exactly one operation");
  });
});
