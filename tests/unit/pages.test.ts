import { describe, expect, test } from "bun:test";
import { canonicalPageFile, decodeProtocolPage, encodeProtocolPage, hashObject, parsePage, samePage, writePageFile } from "@ovst/protocol";
import vectors from "../../docs/overstory-spec/conformance/pages.json";
import { pageFromJSON, pageJSON, type PageJSON } from "../support/page-json.ts";

const encoder = new TextEncoder(), decoder = new TextDecoder();

describe("page vectors", () => {
  for (const item of vectors.reads) test(`read: ${item.name}`, () => {
    const page = parsePage(encoder.encode(item.file));
    if (item.page === null) {
      expect(page).toBeNull();
      return;
    }
    expect(page).not.toBeNull();
    expect(pageJSON(page!)).toEqual(item.page as PageJSON);
    const bytes = encodeProtocolPage(page!);
    expect(Buffer.from(bytes).toString("base64")).toBe(item.object!);
    expect(hashObject(bytes)).toBe(item.hash!);
    expect(samePage(decodeProtocolPage(bytes), page!)).toBe(true);
    const canonical = canonicalPageFile(page!);
    expect(decoder.decode(canonical)).toBe(item.canonical!);
    // The canonical file reads back to the page, and a file that already
    // holds the page is written as it is.
    expect(samePage(parsePage(canonical)!, page!)).toBe(true);
    expect(decoder.decode(writePageFile(page!, encoder.encode(item.file)))).toBe(item.file);
  });
  for (const item of vectors.writes) test(`write: ${item.name}`, () => {
    const page = pageFromJSON(item.page as PageJSON);
    const written = writePageFile(page, item.existing === null ? null : encoder.encode(item.existing));
    expect(decoder.decode(written)).toBe(item.expected);
    expect(samePage(parsePage(written)!, page)).toBe(true);
  });
  for (const item of vectors.invalidObjects) test(`invalid object: ${item.name}`, () => {
    expect(() => decodeProtocolPage(Buffer.from(item.object, "base64"))).toThrow();
  });
});
