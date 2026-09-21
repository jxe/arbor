// Regenerates the canonical CBOR conformance vectors from the TypeScript encoder.
// Run from the repository root: bun run docs/overstory-spec/conformance/canonical-cbor-vectors.ts

import { readFile, writeFile } from "node:fs/promises";
import { canonicalCBORHash, encodeCanonicalCBOR, canonicalUpdateIntent, encodeWireDirectory, hashObject, updateRequestDigest, updateRequestDigests } from "@overstory/protocol";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const emptyDirectory = encodeWireDirectory({ type: "directory", entries: [] });
// Historical protocol-update-intent.json and protocol-operations.json retain the previous
// encoding's exact bytes and digests. Do not rehash them through the active codec.
for (const path of ["docs/overstory-spec/conformance/protocol-authored-updates.json", "docs/overstory-spec/conformance/protocol-authored-transport.json"]) {
  const fixture = JSON.parse(await readFile(path, "utf8"));
  for (const c of fixture.cases) {
    if (!c.valid) continue;
    let base = c.value.base;
    c.identities = c.value.updates.map((u: any) => {
      const intent = {...u,base};
      const bytes = canonicalUpdateIntent(fixture.tree,intent);
      const digest = updateRequestDigest(fixture.tree,intent);
      base = {requestDigest:digest,candidate:u.candidate};
      return {digest,canonicalCBORBase64:b64(bytes)};
    });
  }
  await writeFile(path,JSON.stringify(fixture,null,2)+"\n");
}
const endpointsPath = "docs/overstory-spec/conformance/protocol-endpoints.json";
const endpoints = JSON.parse(await readFile(endpointsPath,"utf8"));
for (const c of endpoints.cases) {
  if (!c.request.body?.updates) continue;
  const previous = c.request.derivedRequestDigest;
  const tree = decodeURIComponent(c.request.path.match(/^\/\.arbor\/trees\/([^/]+)\/updates$/)[1]);
  const digest = updateRequestDigests(tree,c.request.body)[0];
  if (previous) {
    const text = JSON.stringify(c).replaceAll(previous,digest);
    Object.assign(c,JSON.parse(text));
  }
}
await writeFile(endpointsPath,JSON.stringify(endpoints,null,2)+"\n");

// Bootstrap pending requests preserve semantic identity after object rehashing.
for (const path of ["tests/fixtures/arborsync/bootstrap.json", "tests/fixtures/arborsync/bootstrap-pending.json"]) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (value.pending) value.pending.requestDigests = updateRequestDigests(value.tree.id, value.pending);
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

// Object models are the symbolic source of truth; payloads are raw for files.
const objectPath = "docs/overstory-spec/conformance/protocol-objects.json";
const objectVectors = JSON.parse(await readFile(objectPath, "utf8"));
for (const vector of objectVectors.objects) {
  const bytes = vector.model.type === "file" ? Buffer.from(vector.model.bytesBase64, "base64") : encodeWireDirectory(vector.model);
  delete vector.canonicalCborBase64;
  vector.bytesBase64 = b64(bytes);
  vector.hash = hashObject(bytes);
}
const invalidHash = "sha256:" + "0".repeat(64);
objectVectors.invalid = [
  { name: "unsorted-directory", entries: [{ name: "z", file: invalidHash }, { name: "a", file: invalidHash }] },
  { name: "duplicate-name", entries: [{ name: "a", file: invalidHash }, { name: "a", file: invalidHash }] },
  { name: "dual-target", entries: [{ name: "a", file: invalidHash, tree: "tr_child" }] },
  { name: "entry-with-hash-key", entries: [{ name: "a", hash: invalidHash }] },
  { name: "file-and-directory", entries: [{ name: "a", file: invalidHash, directory: invalidHash }] },
].map(({ name, entries }) => ({ name, canonicalCborBase64: b64(encodeCanonicalCBOR({ type: "directory", entries })) }));
objectVectors.invalid.push({ name: "noncanonical-cbor", canonicalCborBase64: b64(Buffer.concat([Buffer.from([0xa2]), encodeCanonicalCBOR("entries"), encodeCanonicalCBOR([]), encodeCanonicalCBOR("type"), encodeCanonicalCBOR("directory")])) });
await writeFile(objectPath, JSON.stringify(objectVectors, null, 2) + "\n");

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
await writeFile("docs/overstory-spec/conformance/canonical-cbor-values.json", JSON.stringify({ version: 1, valid, invalid }, null, 2) + "\n");
console.log("Regenerated Wire vectors");

// Reference kinds control sparse graph validation, including directory-shaped files.
const graphPayload = new TextEncoder().encode("raw payload\n");
const graphLeaf = { hash: hashObject(graphPayload), bytes: graphPayload };
const graphDirectory = { hash: hashObject(emptyDirectory), bytes: emptyDirectory };
function graph(name: string, mode: string, entries: any[], members: typeof graphLeaf[], valid: boolean) {
  const bytes = encodeWireDirectory({ type: "directory", entries });
  return { name, mode, valid, root: hashObject(bytes), objects: [ { hash: hashObject(bytes), bytesBase64: b64(bytes) }, ...members.map(member => ({ hash: member.hash, bytesBase64: b64(member.bytes) })) ] };
}
const graphVectors = [
  graph("raw-file", "complete", [{ name: "file", file: graphLeaf.hash }], [graphLeaf], true),
  graph("directory-shaped-file", "complete", [{ name: "file", file: graphDirectory.hash }], [graphDirectory], true),
  graph("omitted-file", "sparse-files", [{ name: "file", file: graphLeaf.hash }], [], true),
  graph("missing-file", "complete", [{ name: "file", file: graphLeaf.hash }], [], false),
  graph("missing-directory", "sparse-files", [{ name: "dir", directory: graphDirectory.hash }], [], false),
  graph("kind-conflict", "complete", [{ name: "dir", directory: graphDirectory.hash }, { name: "file", file: graphDirectory.hash }], [graphDirectory], false),
  graph("unreachable", "complete", [], [graphLeaf], false),
];
await writeFile("docs/overstory-spec/conformance/protocol-graphs.json", JSON.stringify({ version: 1, cases: graphVectors }, null, 2) + "\n");
