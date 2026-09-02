import { describe, expect, test } from "bun:test";
import { applyObjectDelta, encodeWireObject, hashObject, objectDelta, type ObjectDelta } from "@arbor/wire";

function pseudoRandom(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

function roundTrip(base: Uint8Array, target: Uint8Array): ObjectDelta {
  const delta: ObjectDelta = { base: hashObject(base), result: hashObject(target), instructions: objectDelta(base, target) };
  expect(applyObjectDelta(base, delta)).toEqual(target);
  return delta;
}

function insertedBytes(delta: ObjectDelta): number {
  return delta.instructions.reduce((total, instruction) => total + ("insert" in instruction ? instruction.insert.byteLength : 0), 0);
}

describe("object delta derivation", () => {
  test("copies unchanged payload around an edit at the end of a file whose length header changed", () => {
    const payload = pseudoRandom(200_000, 7);
    const base = encodeWireObject({ type: "file", bytes: payload });
    const edited = new Uint8Array(payload.byteLength + 4);
    edited.set(payload, 0);
    edited.set(new TextEncoder().encode("tail"), payload.byteLength);
    const target = encodeWireObject({ type: "file", bytes: edited });
    expect(base.byteLength - payload.byteLength).toBe(target.byteLength - edited.byteLength);

    const delta = roundTrip(base, target);
    expect(insertedBytes(delta)).toBeLessThan(64);
    expect(delta.instructions.length).toBeLessThan(6);
  });

  test("expresses a moved block as copies rather than retransmitted bytes", () => {
    const first = pseudoRandom(5_000, 11);
    const second = pseudoRandom(5_000, 13);
    const base = new Uint8Array([...first, ...second]);
    const target = new Uint8Array([...second, ...first]);

    const delta = roundTrip(base, target);
    expect(insertedBytes(delta)).toBeLessThan(64);
  });

  test("inserts everything when the base shares nothing", () => {
    const base = new Uint8Array(40).fill(1);
    const target = new Uint8Array(40).fill(2);
    const delta = roundTrip(base, target);
    expect(delta.instructions).toEqual([{ insert: target }]);
  });

  test("keeps a middle replacement between a common prefix and suffix", () => {
    const base = new TextEncoder().encode("# Note\n\nCommon text\n\nshared tail\n");
    const target = new TextEncoder().encode("# Note\n\nFrom A text\n\nshared tail\n");
    const delta = roundTrip(base, target);
    expect(delta.instructions).toEqual([
      { copy: { offset: 0, length: 8 } },
      { insert: new TextEncoder().encode("From A") },
      { copy: { offset: 14, length: base.byteLength - 14 } },
    ]);
  });

  test("handles a directory that gained one entry among many", () => {
    const file = hashObject(encodeWireObject({ type: "file", bytes: new Uint8Array([1]) }));
    const names = Array.from({ length: 400 }, (_, index) => `page-${String(index).padStart(4, "0")}.md`);
    const base = encodeWireObject({ type: "directory", entries: names.map((name) => ({ name, hash: file })) });
    const target = encodeWireObject({
      type: "directory",
      entries: [...names, "page-0200a.md"].sort().map((name) => ({ name, hash: file })),
    });
    const delta = roundTrip(base, target);
    expect(insertedBytes(delta)).toBeLessThan(160);
  });
});
