# canopyd 020: One binary encoding for requests that carry objects

## Status

- **Priority:** P3. The goal is tidiness: one way to carry object bytes, not
  bandwidth.
- **Effort:** M. The spec, vectors, canopyd, both protocol clients, Arbor Sync
  and the Mac app's daemon client.
- **Risk:** LOW for the wire, since JSON stays. MEDIUM for durable client
  state: a persisted update attempt must still replay exactly (step 3).
- **State:** PLANNED 2026-09-27, from the [host–client communication
  review](../../status.md#hostclient-communication-review--2026-09-27). Decided
  with Joe: CBOR joins JSON rather than replacing it, and JSON stays as a
  long-term fallback; watch frames stay JSON over SSE.

## Why

Object bytes travel four ways today:

| Where | Encoding |
|---|---|
| `GET /.arbor/trees/{tree}/snapshots/{root}` | a canonical CBOR bundle |
| `POST …/updates` requests and results, watch transitions, conflict prefixes | JSON with padded base64 objects and delta inserts |
| `PUT /.arbor/accounts` | a third JSON shape, `configuration: { root, objects }` |
| Arbor Sync's `GET /v1/bootstrap` | base64 of a CBOR bundle inside JSON |

After this plan: CBOR wherever objects travel except the watch, one request
shape for anything uploaded, and JSON kept as the readable fallback. Watch
frames stay JSON because SSE is text and most frames are small.

## Decisions

- **Negotiated, never required.** A client sends `Content-Type:
  application/cbor` for a CBOR request and `Accept: application/cbor` for a
  CBOR success response. A host must accept and produce both; a client may use
  either. Without those headers everything is JSON, as today. Error envelopes
  stay JSON on every route (they are shared by every route and small), including
  a 409 conflict's.
- **The same value, not a new schema.** A CBOR body is the canonical CBOR
  (§4.1) of exactly the JSON value, with byte strings where JSON has padded
  base64: object envelope `bytes` and delta `insert`. Keys, nesting, `null`
  and optional-field rules are unchanged. Receivers decode canonical CBOR only.
- **Identities do not move.** Request digests are computed over the intent,
  not the body (spec §2.1), so a request's digest, receipts and exact replay
  are the same in either encoding. A host must treat a JSON and a CBOR
  submission of the same request as the same request.
- **The claim uploads like everything else.** `PUT /.arbor/accounts` carries
  the initial configuration as the configuration tree's activation element, the
  same `CandidateUpdate` (`change`, `candidate`, `trace: null`, `resolves: []`,
  `objects`, `deltas: []`) a `declareTree` request sends, instead of
  `{ root, objects }`. The claim stays one atomic request (spec §1.2 requires
  it); only the shape of its configuration changes, and it can be CBOR too.
- **Bootstrap is local.** `GET /v1/bootstrap` answers CBOR when asked, with
  `spine` as the bundle's bytes rather than base64 text. It keeps answering
  JSON to a caller that does not ask, until the CLI and the Mac app both ask;
  then the JSON form goes, since the daemon and its clients are one install.

## Steps

### 1. Spec and vectors

- `01-tree-operations.md` §4: a new subsection, "Request and response
  encodings", stating the decisions above; §2.1 and §2.4 point to it.
- `04-accounts-and-devices.md` §1.2: the configuration is an activation
  element, with an example.
- A vector file, `protocol-cbor-transport.json`: for the existing request,
  response and claim vectors, the expected canonical CBOR bytes (base64), plus
  rejected cases (non-canonical key order, a base64 string where bytes belong,
  an indefinite length). `canonical-cbor-vectors.ts` generates it from the JSON
  vectors so the two cannot drift.

### 2. TypeScript codecs and canopyd

- `packages/protocol/src/updates/json.ts`: the decoders take a value from
  either encoding. One helper reads a bytes field as a `Uint8Array` or as
  padded base64, so `decodeUpdateRequestJSON` and its siblings serve both
  without a second codec. Encoders take the target encoding. Rename the module
  and functions only if the result reads better (`codec.ts`,
  `decodeUpdateRequest`); keep one name for each thing.
- `ProtocolClient`: `submitUpdates` and `joinAccount` take the encoding,
  defaulting to CBOR once the host accepts it.
- canopyd `host.ts`: `POST …/updates` and `PUT /.arbor/accounts` read the body
  by content type (`arrayBuffer`, and the `body-bytes` counter counts real
  bytes) and answer 2xx by `Accept`. The claim accepts the old `{ root,
  objects }` configuration until every client sends the element (step 5).

### 3. Durable attempts keep their encoding

A persisted attempt replays its exact body, and both clients store it:
TypeScript's `UpdateAttempt.body` (base64 of the JSON text,
`packages/working-tree/src/control.ts`) and Swift's `UpdateAttempt.body` /
`PreparedProtocolUpdate.body`. Add an optional `contentType` beside `body`,
absent meaning JSON, so a record written before this plan replays unchanged
and no control-schema bump or migration is needed. New attempts are prepared
in CBOR and replay in CBOR. The shared runner vectors
(`tests/fixtures/update-runner.json`) gain a case that restarts across an
attempt written as JSON.

### 4. Swift

- `Overstory`: a small Codable encoder and decoder over `CanonicalCBORValue`,
  with `Data` as a byte string, so the existing Codable models (requests,
  results, `ProtocolUpdateResponse`, transitions) serve CBOR without
  hand-written mappings. `ProtocolObjectEnvelope`'s decoder reads bytes from
  either form.
- `ProtocolClient.prepareUpdate`/`submitUpdate` and the claim path in
  `OverstoryClient/Credentials.swift` send CBOR; `PreparedProtocolUpdate`
  carries its content type (step 3).
- The Mac app's `ArborSyncRESTClient.bootstrap` asks for CBOR and decodes the
  spine bytes directly.
- Tests run the vectors from step 1 through both the JSON and CBOR paths.

### 5. Claim shape and bootstrap cutover

- Both clients send the configuration element. After Joe's Mac and iPhone run
  such builds, remove the host's `{ root, objects }` reader and record it as
  done in `status.md` (it is a Cleanup 007-style item: check first that no
  pending claim journal on either device holds the old shape).
- The CLI's `daemon-client.ts` and the Mac app ask `/v1/bootstrap` for CBOR;
  then delete the JSON form and its base64 `spine`.

## Order and deployment

canopyd accepts both encodings (step 2) before any client sends CBOR, so a
deploy goes first and needs Joe's go-ahead; clients follow in their next
install. Nothing here changes the database, so no migration joins
[the next batch](019-migration-batch-024.md).

## Verification

`bun run test:affected` per commit; before merging, the full gate in
[DEVELOPMENT.md](../../DEVELOPMENT.md#verification) including `bun run
test:protocol` (both halves), the Swift package suites and `CanopyAppTests` on
a Mac. Specifically: every step 1 vector through both encodings in both
languages; a TypeScript and a Swift submission of the same request produce
the same digest and receipt whichever encoding carries it; a JSON attempt
persisted before the change replays as JSON after it; canopyd's
update-host tests run once per encoding. After deploy, a round-trip edit from
the Mac and the iPhone. Record the result in `status.md` and delete this plan.
