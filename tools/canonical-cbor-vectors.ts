// Regenerates the canonical CBOR conformance vectors from the TypeScript encoder.
// Run from the repository root: bun run tools/canonical-cbor-vectors.ts

import { readFile, writeFile } from "node:fs/promises";
import { canonicalCBORHash, encodeCanonicalCBOR } from "@arbor/core";
import { canonicalUpdateIntent, updateRequestDigest } from "@arbor/wire";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const intentPath = "conformance/wire-update-intent.json";
const intent = JSON.parse(await readFile(intentPath, "utf8"));
const oldDigest: string = intent.identity.digest;
const request = { base: intent.identity.base, candidate: intent.identity.candidate };
const { canonicalJSON: _dropped, ...identity } = intent.identity;
identity.canonicalCBORBase64 = b64(canonicalUpdateIntent(intent.identity.tree, request));
identity.digest = updateRequestDigest(intent.identity.tree, request);
intent.identity = { tree: identity.tree, base: identity.base, candidate: identity.candidate, canonicalCBORBase64: identity.canonicalCBORBase64, digest: identity.digest };
await writeFile(intentPath, JSON.stringify(intent, null, 2) + "\n");
const endpointsPath = "conformance/wire-endpoints.json";
const endpoints = await readFile(endpointsPath, "utf8");
if (!endpoints.includes(oldDigest)) throw new Error("expected old digest in wire-endpoints.json");
await writeFile(endpointsPath, endpoints.replaceAll(oldDigest, identity.digest));

const valid = [
  { name: "null", value: null },
  { name: "booleans", value: [false, true] },
  { name: "empty-containers", value: [[], {}] },
  { name: "integer-widths", value: [0, 23, 24, 255, 256, 65535, 65536, 4294967295, 4294967296, 9007199254740991] },
  { name: "negative-integers", value: [-1, -24, -25, -256, -257, -4294967297] },
  { name: "floats-are-float64", value: [1.5, 0.1, -2.5, 1e21, 1e-7] },
  { name: "text-utf8", value: ["", "a", "é", "日本", "😀"] },
  { name: "map-keys-in-byte-order", value: { b: 1, a: { y: true, x: null }, "é": "last", aa: "after a" } },
  { name: "update-intent-shape", value: { version: "updates-v1", tree: "tr_atlas", base: { root: "sha256:00", update: "1" }, candidate: "sha256:11" } },
].map((entry) => ({ ...entry, canonicalCBORBase64: b64(encodeCanonicalCBOR(entry.value)), hash: canonicalCBORHash(entry.value) }));
const invalid = [
  { name: "unsorted-map-keys", canonicalCBORBase64: b64(Uint8Array.from([0xa2, 0x61, 0x62, 0x01, 0x61, 0x61, 0x02])), reason: "map keys are not in canonical byte order" },
  { name: "duplicate-map-key", canonicalCBORBase64: b64(Uint8Array.from([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02])), reason: "duplicate map key" },
  { name: "non-minimal-length", canonicalCBORBase64: b64(Uint8Array.from([0x18, 0x05])), reason: "integer 5 must use the one-byte head" },
  { name: "trailing-bytes", canonicalCBORBase64: b64(Uint8Array.from([0x01, 0x02])), reason: "one value only" },
  { name: "indefinite-length-array", canonicalCBORBase64: b64(Uint8Array.from([0x9f, 0x01, 0xff])), reason: "indefinite lengths are not canonical" },
  { name: "non-text-map-key", canonicalCBORBase64: b64(Uint8Array.from([0xa1, 0x01, 0x02])), reason: "map keys must be text" },
];
await writeFile("conformance/canonical-cbor-values.json", JSON.stringify({ version: 1, valid, invalid }, null, 2) + "\n");
console.log("intent digest", oldDigest, "->", identity.digest);
