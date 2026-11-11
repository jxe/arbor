import { describe, expect, test } from "bun:test";
import { decodeDirectoryValue, decodeProtocolDirectory, encodeCanonicalCBOR, hashObject, type ProtocolDirectoryEntry } from "@ovst/protocol";

/** decodeProtocolDirectory reads common directories in one pass; it must
 * accept exactly what the general decoder accepts, with the same result. */

const hash = (seed: string) => hashObject(new TextEncoder().encode(seed));
const bytesOf = (entries: unknown[], extra: Record<string, unknown> = {}) => encodeCanonicalCBOR({ type: "directory", entries, ...extra });

function agree(bytes: Uint8Array): "accepted" | "refused" {
  let general: unknown, generalError: unknown, fast: unknown, fastError: unknown;
  try { general = decodeDirectoryValue(bytes); } catch (error) { generalError = error; }
  try { fast = decodeProtocolDirectory(bytes); } catch (error) { fastError = error; }
  if (generalError) {
    expect(fastError).toBeDefined();
    expect((fastError as Error).message).toBe((generalError as Error).message);
    return "refused";
  }
  expect(fastError).toBeUndefined();
  expect(fast).toEqual(general);
  return "accepted";
}

const sample: ProtocolDirectoryEntry[] = [
  { name: "a.md", page: hash("a"), created: 0, modified: 0 },
  { name: "b", directory: hash("b") },
  { name: "c.txt", file: hash("c"), created: 0, modified: 0 },
  { name: "nested", tree: "tr_example" },
  { name: "é.md", file: hash("e"), created: 0, modified: 0 },
  { name: "日本", directory: hash("j") },
];

describe("directory scan", () => {
  test("accepts canonical directories of every entry kind", () => {
    expect(agree(bytesOf([]))).toBe("accepted");
    expect(agree(bytesOf(sample))).toBe("accepted");
    const many = Array.from({ length: 300 }, (_, i) => ({ name: `page-${String(i).padStart(4, "0")}.md`, file: hash(String(i)), created: 0, modified: 0 }));
    expect(agree(bytesOf(many))).toBe("accepted");
    expect(decodeProtocolDirectory(bytesOf(sample)).entries).toEqual(sample);
  });

  test("refuses what the general decoder refuses", () => {
    const refusals: unknown[][] = [
      [{ name: "b", file: hash("b"), created: 0, modified: 0 }, { name: "a", file: hash("a"), created: 0, modified: 0 }],
      [{ name: "a", file: hash("a"), created: 0, modified: 0 }, { name: "a", file: hash("b"), created: 0, modified: 0 }],
      [{ name: "", file: hash("a"), created: 0, modified: 0 }],
      [{ name: ".", file: hash("a"), created: 0, modified: 0 }],
      [{ name: "..", directory: hash("a") }],
      [{ name: "a/b", file: hash("a"), created: 0, modified: 0 }],
      [{ name: "a\\b", file: hash("a"), created: 0, modified: 0 }],
      [{ name: "a\0", file: hash("a"), created: 0, modified: 0 }],
      [{ name: "é", file: hash("a"), created: 0, modified: 0 }],
      [{ name: "a", file: "sha256:ABC", created: 0, modified: 0 }],
      [{ name: "a", file: hash("a").toUpperCase(), created: 0, modified: 0 }],
      [{ name: "a", tree: "" }],
      [{ name: "a", file: hash("a"), page: hash("b"), created: 0, modified: 0 }],
      [{ name: "a" }],
      [{ name: "a", other: hash("a") }],
    ];
    for (const entries of refusals) expect(agree(bytesOf(entries))).toBe("refused");
    expect(agree(encodeCanonicalCBOR({ type: "directory" }))).toBe("refused");
    expect(agree(encodeCanonicalCBOR({ type: "folder", entries: [] }))).toBe("refused");
    expect(agree(new Uint8Array([...bytesOf(sample), 0]))).toBe("refused");
  });

  test("agrees on every single-byte change and truncation of a valid directory", () => {
    const valid = bytesOf(sample);
    let accepted = 0;
    for (let index = 0; index < valid.length; index++) {
      expect(agree(valid.subarray(0, index))).toBe("refused");
      for (const value of [0x00, 0x17, 0x18, 0x2e, 0x2f, 0x61, 0x66, 0x67, 0x78, 0x80, 0xa1, 0xa2, 0xa3, 0xc3, 0xff, valid[index]! ^ 1, valid[index]! + 1]) {
        const changed = valid.slice();
        changed[index] = value & 0xff;
        if (agree(changed) === "accepted") accepted++;
      }
    }
    expect(accepted).toBeGreaterThan(0);
  });

  test("non-minimal lengths are refused", () => {
    const valid = [...bytesOf([{ name: "zz", file: hash("a"), created: 0, modified: 0 }])];
    const name = [0x64, 0x6e, 0x61, 0x6d, 0x65, 0x62, 0x7a, 0x7a]; // "name", then "zz"
    const at = valid.findIndex((_, index) => name.every((byte, offset) => valid[index + offset] === byte));
    expect(at).toBeGreaterThan(0);
    const patched = [...valid.slice(0, at + 5), 0x78, 0x02, ...valid.slice(at + 6)];
    expect(agree(new Uint8Array(patched))).toBe("refused");
  });
});
