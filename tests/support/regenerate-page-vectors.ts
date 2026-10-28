// Recomputes the expected results in
// docs/overstory-spec/conformance/pages.json from its inputs, with the
// TypeScript reference (`@ovst/protocol` pages.ts). Review the diff: the
// Swift port (`ProtocolPage` in Overstory) is held to the same file.
//
//   bun tests/support/regenerate-page-vectors.ts

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CBORTag, canonicalPageFile, encodeCanonicalCBOR, encodeProtocolPage, hashObject, parsePage, writePageFile } from "@ovst/protocol";
import { pageJSON, pageFromJSON } from "./page-json.ts";

const path = join(import.meta.dir, "../../docs/overstory-spec/conformance/pages.json");
const file = JSON.parse(readFileSync(path, "utf8"));
const encoder = new TextEncoder(), decoder = new TextDecoder();

for (const item of file.reads) {
  const page = parsePage(encoder.encode(item.file));
  delete item.page; delete item.object; delete item.hash; delete item.canonical;
  if (!page) { item.page = null; continue; }
  const bytes = encodeProtocolPage(page);
  item.page = pageJSON(page);
  item.object = Buffer.from(bytes).toString("base64");
  item.hash = hashObject(bytes);
  item.canonical = decoder.decode(canonicalPageFile(page));
}
for (const item of file.writes) {
  item.expected = decoder.decode(writePageFile(pageFromJSON(item.page), item.existing === null ? null : encoder.encode(item.existing)));
}
// Objects a decoder must reject, each a canonical CBOR map unless noted.
const body = new TextEncoder().encode("Body\n");
const invalid: Array<[string, Uint8Array]> = [
  ["id among the properties", encodeCanonicalCBOR({ type: "page", properties: [["id", "x"]], body })],
  ["duplicate property", encodeCanonicalCBOR({ type: "page", properties: [["a", 1], ["a", 2]], body })],
  ["empty id", encodeCanonicalCBOR({ type: "page", id: "", properties: [], body })],
  ["missing body", encodeCanonicalCBOR({ type: "page", properties: [] })],
  ["unknown member", encodeCanonicalCBOR({ type: "page", properties: [], body, extra: 1 })],
  ["wrong type", encodeCanonicalCBOR({ type: "file", properties: [], body })],
  ["body is not UTF-8", encodeCanonicalCBOR({ type: "page", properties: [], body: Uint8Array.of(0xff) })],
  ["tag 1 is not a page timestamp", encodeCanonicalCBOR({ type: "page", properties: [["t", new CBORTag(1, 0)]], body })],
  ["date that is not a day", encodeCanonicalCBOR({ type: "page", properties: [["d", new CBORTag(1004, "2026-02-30")]], body })],
  ["date-time with an offset", encodeCanonicalCBOR({ type: "page", properties: [["d", new CBORTag(0, "2026-10-28T09:38:25+02:00")]], body })],
  ["date-time with a trailing zero", encodeCanonicalCBOR({ type: "page", properties: [["d", new CBORTag(0, "2026-10-28T09:38:25.10Z")]], body })],
];
// 2.0 encoded as a float rather than the integer 2 is not canonical.
{
  const bytes = encodeCanonicalCBOR({ type: "page", properties: [["n", 1.5]], body });
  const at = bytes.indexOf(0xfb);
  bytes.set([0x40, 0x00, 0, 0, 0, 0, 0, 0], at + 1);
  invalid.push(["integral float", bytes]);
}
file.invalidObjects = invalid.map(([name, bytes]) => ({ name, object: Buffer.from(bytes).toString("base64") }));
writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
