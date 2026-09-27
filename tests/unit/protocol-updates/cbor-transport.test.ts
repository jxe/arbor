import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  decodeCandidateUpdateJSON, decodeUpdateRequestJSON, decodeUpdateResponseJSON, decodeWireBody, encodeCandidateUpdateJSON,
  encodeUpdateRequestJSON, encodeUpdateResponseJSON, encodeWireBody, updateRequestDigests,
} from "@overstory/protocol";

/** `protocol-cbor-transport.json`: every request, response and claim vector through both encodings (tree operations §4.4). */
interface Case { name: string; json: any; canonicalCBORBase64: string }
const vectors = JSON.parse(await readFile(new URL("../../../docs/overstory-spec/conformance/protocol-cbor-transport.json", import.meta.url), "utf8")) as {
  requests: Array<Case & { tree: string; requestDigests: string[] }>;
  responses: Case[];
  claims: Case[];
  rejected: Array<{ name: string; kind: "request" | "response" | "claim"; canonicalCBORBase64: string }>;
};
const bytes = (value: string) => new Uint8Array(Buffer.from(value, "base64"));

for (const c of vectors.requests) test(`request vector in both encodings: ${c.name}`, () => {
  const fromJSON = decodeUpdateRequestJSON(decodeWireBody(encodeWireBody(c.json, "json"), "json"));
  const fromCBOR = decodeUpdateRequestJSON(decodeWireBody(bytes(c.canonicalCBORBase64), "cbor"), "cbor");
  expect(fromCBOR).toEqual(fromJSON);
  expect(encodeWireBody(encodeUpdateRequestJSON(fromJSON, "cbor"), "cbor")).toEqual(bytes(c.canonicalCBORBase64));
  expect<unknown>(encodeUpdateRequestJSON(fromCBOR)).toEqual(c.json);
  // Identity is the intent, not the body: both encodings name the same digests.
  expect(updateRequestDigests(c.tree, fromCBOR)).toEqual(c.requestDigests);
  expect(updateRequestDigests(c.tree, fromJSON)).toEqual(c.requestDigests);
});

for (const c of vectors.responses) test(`response vector in both encodings: ${c.name}`, () => {
  const fromJSON = decodeUpdateResponseJSON(c.json);
  const fromCBOR = decodeUpdateResponseJSON(decodeWireBody(bytes(c.canonicalCBORBase64), "cbor"), "cbor");
  expect(fromCBOR).toEqual(fromJSON);
  expect(encodeWireBody(encodeUpdateResponseJSON(fromJSON, "cbor"), "cbor")).toEqual(bytes(c.canonicalCBORBase64));
  expect<unknown>(encodeUpdateResponseJSON(fromCBOR)).toEqual(c.json);
});

for (const c of vectors.claims) test(`claim vector in both encodings: ${c.name}`, () => {
  const value = decodeWireBody(bytes(c.canonicalCBORBase64), "cbor") as Record<string, unknown>;
  const fromJSON = decodeCandidateUpdateJSON(c.json.configuration, true);
  const fromCBOR = decodeCandidateUpdateJSON(value.configuration, true, "cbor");
  expect(fromCBOR).toEqual(fromJSON);
  expect(fromCBOR.trace).toBeNull();
  const { configuration: _json, ...rest } = c.json;
  const { configuration: _cbor, ...restCBOR } = value;
  expect({ ...restCBOR }).toEqual(rest);
  expect(encodeWireBody({ ...rest, configuration: encodeCandidateUpdateJSON(fromJSON, "cbor") }, "cbor")).toEqual(bytes(c.canonicalCBORBase64));
});

for (const c of vectors.rejected) test(`rejected CBOR body: ${c.name}`, () => {
  expect(() => {
    const value = decodeWireBody(bytes(c.canonicalCBORBase64), "cbor");
    if (c.kind === "request") decodeUpdateRequestJSON(value, "cbor");
    else if (c.kind === "response") decodeUpdateResponseJSON(value, "cbor");
    else decodeCandidateUpdateJSON((value as { configuration?: unknown }).configuration, true, "cbor");
  }).toThrow();
});

test("JSON refuses a byte string where padded base64 belongs", () => {
  const request = vectors.requests[0]!;
  const cborValue = decodeWireBody(bytes(request.canonicalCBORBase64), "cbor");
  expect(() => decodeUpdateRequestJSON(cborValue, "json")).toThrow("base64");
});
