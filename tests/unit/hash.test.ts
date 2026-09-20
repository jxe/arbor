import { expect, test } from "bun:test";
import { sha256, revisionOf } from "@overstory/protocol";
import { sha256 as portable } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

test("native hashes preserve portable identities for text, binary and typed-array slices", () => {
  const data = Uint8Array.from({ length: 1024 * 1024 + 7 }, (_, i) => i % 251);
  for (const value of ["", "abc", "é😀\r\n", "\ud800", new Uint8Array(), data, data.subarray(3, data.length - 2)]) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const expected = bytesToHex(portable(bytes));
    expect(sha256(value)).toBe(expected);
    expect(revisionOf(value)).toBe(`sha256:${expected}`);
  }
  expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
