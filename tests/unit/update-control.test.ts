import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { decodeUpdateRequestJSON, encodeBase64 } from "@overstory/protocol";
import { attemptEncoding, attemptRequest, decodeControl, encodeAttempt, UpdateStateError } from "../../packages/working-tree/src/control.ts";

const transport = JSON.parse(await readFile(new URL("../../docs/overstory-spec/conformance/protocol-authored-transport.json", import.meta.url), "utf8"));
const requestJSON = transport.cases[0].value;
const base = { root: `sha256:${"0".repeat(64)}`, update: requestJSON.base };

test("a new attempt is prepared in CBOR and replays the same request and digests", () => {
  const attempt = encodeAttempt(transport.tree, base, requestJSON);
  expect(attempt.contentType).toBe("application/cbor");
  expect(attemptEncoding(attempt)).toBe("cbor");
  expect(attemptRequest(attempt)).toEqual(decodeUpdateRequestJSON(requestJSON));
  expect(attempt.requestDigests).toEqual(encodeAttempt(transport.tree, base, requestJSON, "json").requestDigests);
});

test("an attempt persisted as JSON before CBOR decodes and replays as JSON", () => {
  // The record exactly as a client wrote it before bodies could be CBOR: no content type.
  const earlier = encodeAttempt(transport.tree, base, requestJSON, "json");
  expect("contentType" in earlier).toBe(false);
  const body = encodeBase64(new TextEncoder().encode(JSON.stringify(requestJSON)));
  expect(earlier.body).toBe(body);
  const control = decodeControl(JSON.parse(JSON.stringify({ schema: 4, attempt: earlier, attemptTip: "change-1", settled: [] })));
  expect(control.attempt!.contentType).toBeUndefined();
  expect(attemptEncoding(control.attempt!)).toBe("json");
  expect(attemptRequest(control.attempt!)).toEqual(decodeUpdateRequestJSON(requestJSON));
});

test("an attempt in an unknown encoding is refused, not rewritten", () => {
  const attempt = { ...encodeAttempt(transport.tree, base, requestJSON), contentType: "application/xml" };
  expect(() => decodeControl({ schema: 4, attempt, attemptTip: "change-1", settled: [] })).toThrow(UpdateStateError);
});
