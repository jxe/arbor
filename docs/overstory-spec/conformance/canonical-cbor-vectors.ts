// Regenerates the canonical CBOR conformance vectors from the TypeScript encoder.
// Run from the repository root: bun run docs/overstory-spec/conformance/canonical-cbor-vectors.ts

import { readFile, writeFile } from "node:fs/promises";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { accountChallengeBytes, personProfileTreeID, treeConfigurationID, type AccountChallenge } from "@overstory/protocol";
import { canonicalCBORHash, encodeCanonicalCBOR, canonicalUpdateIntent, encodeProtocolDirectory, hashObject, updateRequestDigest, updateRequestDigests } from "@overstory/protocol";
import { activationElement, decodeUpdateRequestJSON, decodeUpdateResponseJSON, encodeCandidateUpdateJSON, encodeUpdateRequestJSON, encodeUpdateResponseJSON, initialPersonConfig, snapshotTreeConfig } from "@overstory/protocol";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const emptyDirectory = encodeProtocolDirectory({ type: "directory", entries: [] });
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
  // `GET /v1/bootstrap` answers canonical CBOR with the spine as bytes; the JSON file is its readable spelling.
  await writeFile(path.replace(/\.json$/, ".cbor"), encodeCanonicalCBOR({ ...value, spine: new Uint8Array(Buffer.from(value.spine, "base64")) }));
}

// Object models are the symbolic source of truth; payloads are raw for files.
const objectPath = "docs/overstory-spec/conformance/protocol-objects.json";
const objectVectors = JSON.parse(await readFile(objectPath, "utf8"));
for (const vector of objectVectors.objects) {
  const bytes = vector.model.type === "file" ? Buffer.from(vector.model.bytesBase64, "base64") : encodeProtocolDirectory(vector.model);
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
  ...([
    ["collection-file-schema-ts", 1, "schema.ts"],
    ["collection-file-unknown-version", 2, "schema.cddl"],
  ] as const).map(([name, version, schemaSource]) => ({
    name,
    entries: [{ name: "_store.json", file: invalidHash }, { name: schemaSource, file: invalidHash }].sort((a, b) => a.name < b.name ? -1 : 1),
    childrenSource: { version, type: "collection-file", format: "json", source: "_store.json", schemaSource, schemaFingerprint: invalidHash, childSetHash: invalidHash },
  })),
].map(({ name, entries, childrenSource }: { name: string; entries: unknown[]; childrenSource?: unknown }) => ({
  name,
  canonicalCborBase64: b64(encodeCanonicalCBOR({ type: "directory", entries, ...(childrenSource ? { childrenSource } : {}) })),
}));
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

// Account challenges (accounts §1.2): the profile key signs the canonical
// CBOR of the complete challenge. Placement accounts have no challenge
// (accounts §1.3), so none names a home host.
{
  const path = "docs/overstory-spec/conformance/protocol-account-challenges.json";
  const fixture = JSON.parse(await readFile(path, "utf8"));
  const exact = fixture.cases.find((c: any) => c.name === "exact-account");
  fixture.cases = fixture.cases.filter((c: any) => c.name !== "placement");
  // A real profile key: the zero-key profile above has no private key.
  const seed = Buffer.alloc(32, 7);
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const publicKey = Buffer.from(createPublicKey(privateKey).export({ format: "der", type: "spki" })).subarray(12);
  const profileTree = personProfileTreeID(publicKey);
  const home = { ...exact.response, profileTree, configurationTree: treeConfigurationID(profileTree) };
  const signed = (name: string, challenge: AccountChallenge) => {
    const bytes = accountChallengeBytes(challenge);
    return { name, challenge, canonicalCBORHex: Buffer.from(bytes).toString("hex"), signature: sign(null, bytes, privateKey).toString("base64url") };
  };
  fixture.signing = {
    description: "The profile key signs the canonical CBOR of the complete challenge (accounts §1.2). Generated by canonical-cbor-vectors.ts.",
    seedHex: seed.toString("hex"),
    publicKey: publicKey.toString("base64url"),
    challenges: [signed("home", home)],
  };
  await writeFile(path, JSON.stringify(fixture, null, 2) + "\n");
}

// Request and response bodies in both encodings (tree operations §4.4): each
// JSON vector's CBOR form comes from the one codec, so the two cannot drift.
{
  const conformance = "docs/overstory-spec/conformance";
  const read = async (name: string) => JSON.parse(await readFile(`${conformance}/${name}`, "utf8"));
  const same = (left: unknown, right: unknown, what: string) => {
    if (!Bun.deepEquals(left, right, true)) throw new Error(`${what} does not round-trip through the JSON codec`);
  };
  const authored = await read("protocol-authored-transport.json");
  const accepted = await read("protocol-accepted-transport.json");
  const challenges = await read("protocol-account-challenges.json");
  const requests = [
    ...authored.cases.filter((c: any) => c.valid).map((c: any) => ({ name: c.name, source: `protocol-authored-transport.json#${c.name}`, tree: authored.tree, value: c.value })),
    ...endpoints.cases.filter((c: any) => c.request.body?.updates).map((c: any) => ({
      name: c.name, source: `protocol-endpoints.json#${c.name}`,
      tree: decodeURIComponent(c.request.path.match(/^\/\.arbor\/trees\/([^/]+)\/updates$/)[1]), value: c.request.body,
    })),
  ].map(({ name, source, tree, value }) => {
    const request = decodeUpdateRequestJSON(value);
    same(encodeUpdateRequestJSON(request), value, source);
    return { name, source, tree, requestDigests: updateRequestDigests(tree, request), json: value, canonicalCBORBase64: b64(encodeCanonicalCBOR(encodeUpdateRequestJSON(request, "cbor"))) };
  });
  const responses = [
    ...accepted.cases.filter((c: any) => c.kind === "response" && c.valid).map((c: any) => ({ name: c.name, source: `protocol-accepted-transport.json#${c.name}`, value: c.value })),
    ...endpoints.cases.filter((c: any) => c.request.body?.updates).map((c: any) => ({ name: c.name, source: `protocol-endpoints.json#${c.name}`, value: c.response.body })),
  ].map(({ name, source, value }) => {
    const response = decodeUpdateResponseJSON(value);
    same(encodeUpdateResponseJSON(response), value, source);
    return { name, source, json: value, canonicalCBORBase64: b64(encodeCanonicalCBOR(encodeUpdateResponseJSON(response, "cbor"))) };
  });
  // A claim carries its configuration as the configuration tree's activation
  // element (accounts §1.2). The proof fields are placeholders: this vector
  // fixes the transport, not a verifiable claim.
  const challenge = challenges.cases.find((c: any) => c.name === "exact-account").response;
  const device = { id: "dv_aaaaaaaaaaaaaaaaaaaaaaaaaa", label: "Alice's Mac", key: "ed25519:iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w" };
  const configuration = activationElement(snapshotTreeConfig(initialPersonConfig(challenge.profileTree, device)), device.id);
  const claim = (encoding: "json" | "cbor") => ({
    account: challenge.account, profileTree: challenge.profileTree, configurationTree: challenge.configurationTree, challenge,
    publicKey: "A".repeat(43), signature: "A".repeat(86), device, configuration: encodeCandidateUpdateJSON(configuration, encoding),
  });
  const claims = [{ name: "claim with a key device", json: claim("json"), canonicalCBORBase64: b64(encodeCanonicalCBOR(claim("cbor"))) }];
  // Rejected bodies: each is well-formed CBOR that a receiver must refuse.
  const first = requests[0]!, firstCBOR = Buffer.from(first.canonicalCBORBase64, "base64");
  const firstValue = encodeUpdateRequestJSON(decodeUpdateRequestJSON(first.json), "cbor");
  const entry = (key: string, value: unknown) => [...encodeCanonicalCBOR(key), ...encodeCanonicalCBOR(value)];
  const rejected = [
    { name: "map keys out of canonical order", kind: "request", reason: "keys must be ordered by their encoded bytes",
      canonicalCBORBase64: b64(Uint8Array.from([0xa2, ...entry("updates", firstValue.updates), ...entry("base", firstValue.base)])) },
    { name: "base64 text where bytes belong", kind: "request", reason: "object bytes are a byte string in CBOR",
      canonicalCBORBase64: b64(encodeCanonicalCBOR(first.json)) },
    { name: "indefinite-length map", kind: "request", reason: "indefinite lengths are not canonical",
      canonicalCBORBase64: b64(Uint8Array.from([0xbf, ...firstCBOR.subarray(1), 0xff])) },
    { name: "delta insert as base64 text", kind: "request", reason: "a delta insert is a byte string in CBOR",
      canonicalCBORBase64: b64(encodeCanonicalCBOR({ ...firstValue, updates: [{ ...firstValue.updates[0]!, deltas: [{ base: first.json.updates[0].objects[0].hash, result: `sha256:${"b".repeat(64)}`, instructions: [{ insert: "QQ==" }] }] }] })) },
    { name: "response reconciliation bytes as base64 text", kind: "response", reason: "object bytes are a byte string in CBOR",
      canonicalCBORBase64: b64(encodeCanonicalCBOR(responses[0]!.json)) },
    { name: "claim configuration as the retired snapshot shape", kind: "claim", reason: "the configuration is an activation element",
      canonicalCBORBase64: b64(encodeCanonicalCBOR({ ...claim("cbor"), configuration: { root: configuration.candidate, objects: configuration.objects } })) },
  ];
  await writeFile(`${conformance}/protocol-cbor-transport.json`, JSON.stringify({
    version: 1,
    description: "Request and response bodies in both encodings (tree operations §4.4, accounts §1.2). Each case's `json` is the JSON body; `canonicalCBORBase64` is the canonical CBOR of the same value, with byte strings where JSON has padded base64 (object `bytes`, delta `insert`). Decoding either must give the same model, and a request's digests are the same in both. `rejected` bodies are CBOR a receiver must refuse. Generated by canonical-cbor-vectors.ts from the JSON vectors named in `source`.",
    requests, responses, claims, rejected,
  }, null, 2) + "\n");
}

// Reference kinds control sparse graph validation, including directory-shaped files.
const graphPayload = new TextEncoder().encode("raw payload\n");
const graphLeaf = { hash: hashObject(graphPayload), bytes: graphPayload };
const graphDirectory = { hash: hashObject(emptyDirectory), bytes: emptyDirectory };
function graph(name: string, mode: string, entries: any[], members: typeof graphLeaf[], valid: boolean) {
  const bytes = encodeProtocolDirectory({ type: "directory", entries });
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
