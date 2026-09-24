import { describe, expect, test } from "bun:test";
import {
  decodeTransitionPayloadJSON,
  encodeTransitionPayloadJSON,
  encodeProtocolDirectory,
  hashObject,
  type AcceptedTransitionPayload,
} from "@overstory/protocol";

describe("accepted transition wire encoding", () => {
  test("round-trips complete objects and object deltas", () => {
    const base = new TextEncoder().encode("base");
    const result = new TextEncoder().encode("best");
    const directory = encodeProtocolDirectory({ type: "directory", entries: [{ name: "note.md", file: hashObject(result) }] });
    const payload: AcceptedTransitionPayload = {
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

  test("always emits and requires both arrays after the compatibility window", () => {
    const payload = { objects: [], deltas: [] };
    expect(encodeTransitionPayloadJSON(payload)).toEqual(payload);
    expect(() => decodeTransitionPayloadJSON({ objects: [] })).toThrow("deltas must be an array");
  });

  test("rejects duplicate results, ambiguous instructions, and retired representations", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    expect(() => decodeTransitionPayloadJSON({
      objects: [{ hash, bytes: "AA==" }],
      deltas: [{ base: hash, result: hash, instructions: [{ insert: "YQ==" }] }],
    })).toThrow("supplied more than once");
    expect(() => decodeTransitionPayloadJSON({
      objects: [],
      deltas: [{ base: hash, result: `sha256:${"b".repeat(64)}`, instructions: [{ copy: { offset: 0, length: 1 }, insert: "YQ==" }] }],
    })).toThrow("exactly one operation");
  });
});
