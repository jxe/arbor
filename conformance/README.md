# Arbor conformance vectors

These language-neutral vectors accompany the portable [Arbor specification](../spec.md). Independent implementations use them to verify exact authored-format, locator, synchronized-configuration, wire-object, request-identity, HTTP-value, and observation behavior.

The vectors are normative only where their owning specification defines an exact representation or result. Reference daemon responses, client presentation values, and replaceable Canopy algorithms live under [`tests/fixtures`](../tests/fixtures) instead.

`url-resolution.json` is the shared TypeScript/Swift locator contract. Its
`legacyStableKeyCandidate` field records input-only migration evidence; it does
not turn an ordinary content fragment into identity. A resolver may use that
candidate only after the old PageID owner index proves one accessible owner.

`node-model.json` freezes the provider-neutral model-sampling values (refs,
identity rules, snapshots, child pages, collection-file descriptors) that the
`@arbor/core` node-model decoders and the native model types share. Positive
and negative cases are decoded independently by TypeScript and Swift. Unknown
fields are forward-compatible, but legacy identity/location fields and
incomplete known capabilities are explicitly invalid and cannot grant
behavior. The daemon no longer serves these values over REST (its node routes
were deleted in Native 022 Phase 7); the vectors bind the in-process model
that editors and working trees still build.

`canonical-cbor-values.json` freezes Arbor's canonical CBOR subset: every
valid case pairs a JSON value with its exact encoding and `sha256:` hash, and
every invalid case is a byte sequence a decoder must reject. Every hashed
identity (object hashes, `updates-v1` and `mutate-v1` digests, query output
hashes, collection-file child-set hashes, and schema fingerprints) uses this encoding;
`wire-update-intent.json` shows the update digest derived from it.

`client-state-machines.json` freezes the transition scenarios of the two
client state machines: `document-admission` for an editor against its
working tree's document session (`DocumentAdmissionMachine` in `ArborKit`,
`reduceAdmission` in `@arbor/core`; one transport, a rejected admission runs
the host's local merge helper), and `working-tree-updates` for the update
machine a working tree runs against Wire (`UpdateMachine` in
`ArborWorkingTree`, `reduceUpdate` in `@arbor/canopy-client`; every working
tree is a source, there is no filesystem role). Roots, updates, cursors, and
digests are tokens. The `working-tree-updates` scenarios include adoption: a request whose
leading elements were adopted from another working tree resubmits them
exactly after a restart, and a watch event carrying an adopted element's
digest is evidence for the whole request.

`wire-update-intent.json` also carries `envelopeIndependence`: several
packings of object envelopes across the same plural request produce
identical element digests, which is what lets an adopter re-pack a persisted
request's objects and still prove the same identity.
