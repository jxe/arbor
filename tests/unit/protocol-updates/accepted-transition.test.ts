import { describe, expect, test } from "bun:test";
import {
  decodeTransitionPayloadJSON,
  encodeTransitionPayloadJSON,
  encodeProtocolDirectory,
  hashObject,
  type TransitionPayload,
} from "@ovst/protocol";

describe("accepted transition wire encoding", () => {
  test("round-trips complete objects and object deltas", () => {
    const base = new TextEncoder().encode("base");
    const result = new TextEncoder().encode("best");
    const directory = encodeProtocolDirectory({ type: "directory", entries: [{ name: "note.md", file: hashObject(result), created: 0, modified: 0 }] });
    const payload: TransitionPayload = {
      objects: [{ hash: hashObject(directory), bytes: directory }],
      deltas: [{
        base: hashObject(base),
        result: hashObject(result),
        instructions: [
          { copy: { offset: 0, length: base.length - 3 } },
          { insert: new TextEncoder().encode("est") },
        ],
      }],
    };
    expect(decodeTransitionPayloadJSON(encodeTransitionPayloadJSON(payload))).toEqual(payload);
  });

  test("omits empty arrays and reads an omitted one as empty", () => {
    expect(encodeTransitionPayloadJSON({ objects: [], deltas: [] })).toEqual({});
    expect(decodeTransitionPayloadJSON({})).toEqual({ objects: [], deltas: [] });
    expect(() => decodeTransitionPayloadJSON({ objects: null })).toThrow("objects must be an array");
  });

  test("rejects duplicate results, ambiguous instructions, and retired representations", () => {
    const hash = `sha256:${"a".repeat(64)}`, zero = hashObject(new Uint8Array([0]));
    expect(() => decodeTransitionPayloadJSON({ objects: [{ hash: zero, bytes: "AA==" }] })).toThrow("base64 text");
    expect(() => decodeTransitionPayloadJSON({
      objects: ["AA=="],
      deltas: [{ base: hash, result: zero, instructions: [{ insert: "YQ==" }] }],
    })).toThrow("supplied more than once");
    expect(() => decodeTransitionPayloadJSON({
      objects: [],
      deltas: [{ base: hash, result: `sha256:${"b".repeat(64)}`, instructions: [{ copy: [0, 1], insert: "YQ==" }] }],
    })).toThrow("exactly one operation");
  });
});
