# Overstory conformance vectors

These language-neutral vectors accompany the portable [Overstory specification](../../../README.md). Independent implementations use them to verify exact authored-format, locator, synchronized-configuration, wire-object, request-identity, HTTP-value, and observation behavior.

The vectors are normative only where their owning specification defines an exact representation or result. Reference daemon responses, client presentation values, and replaceable host algorithms live under [`tests/fixtures`](../../../tests/fixtures) instead.

`url-resolution.json` and `node-targets.json` are the shared TypeScript/Swift
locator contract, resolved against a source directory
([locators §2.1](../03-locators.md#21-links-written-in-markdown)). A bare
fragment is only ever a content fragment. The Markdown link surface has five
more files, each run by both implementations:

- `stable-key-tokens.json`: key tokens that must round-trip, and tokens that must be rejected.
- `markdown-source-directories.json`: the directory a body's links resolve from, and the file a link names for it.
- `markdown-links.json`: what a writer emits for a target.
- `markdown-link-healing.json`: byte-preserving rewrites after a move, a body-form change, or a stale path.
- `markdown-link-destinations.json`: which hrefs a Markdown source contains.

`node-model.json` freezes the provider-neutral model-sampling values (refs,
identity rules, snapshots, child pages, collection-file descriptors) that the
`@overstory/protocol` node-model decoders and the native model types share. Positive
and negative cases are decoded independently by TypeScript and Swift. Unknown
fields are forward-compatible, but legacy identity/location fields and
incomplete known capabilities are explicitly invalid and cannot grant
behavior. The daemon no longer serves these values over REST (its node routes
were deleted in Native 022 Phase 7); the vectors bind the in-process model
that editors and working trees still build.

`canonical-cbor-values.json` freezes Overstory's canonical CBOR subset: every
valid case pairs a JSON value with its exact encoding and `sha256:` hash, and
every invalid case is a byte sequence a decoder must reject. Every structured hashed
identity (directory object hashes, `updates-v1` and `mutate-v1` digests, query output
hashes, collection-file child-set hashes, and schema fingerprints) uses this encoding; file object hashes use raw bytes;
`protocol-update-intent.json` records the currently implemented update digest derived from it.

`collection-schemas.json` binds the collection schema profile of
[child backings §2.4](../06-child-backings.md#24-collection-schema-profile):
accepted schemas with their columns, key, child name and fingerprint; rejected
schemas with the first diagnostic's code and location; value and CSV-cell
diagnostics as JSON Pointers, including accepted undeclared row members and
CSV columns; exact CSV encodings; malformed-UTF-8 sources; and
generated sources and values at each limit. Generated parts repeat a template,
replacing `{i}` and `{i+1}`; a `{"$repeat": v, "count": n}` value is an
array of n copies. `node-model.json` and `protocol-objects.json` carry
version-1 descriptors naming `schema.cddl` and invalid version and schema-file
pairings.

`client-state-machines.json` freezes the transition scenarios of the one
client synchronization machine, `working-tree-updates` (`UpdateMachine` in
`CanopyWorkingTree`, `reduceUpdate` in `@overstory/working-tree`): a working tree
publishes the local changes in its change log, whether an editor or a folder
appended them. Changes, roots, updates, cursors, and digests are tokens. The
fixture pins the reducers only; the runners' shared vectors are an
implementation fixture, `tests/fixtures/update-runner.json`. The daemon's
folder synchronization still runs its own loop. There
is no editor-side machine: editors append local changes to the change log
([editor sources](../../implementing-editors/editor-source.md)).

`protocol-update-intent.json` also carries `envelopeIndependence`: several
packings of object envelopes across the same plural request produce
identical element digests, which is what lets an adopter re-pack a persisted
request's objects and still prove the same identity.

Overstory object vectors use `bytesBase64` for exact stored bytes: raw payloads for
files and canonical CBOR for directories. Entry target keys (`file`, `directory`,
`tree`) determine interpretation; payload bytes never determine file kind.
Regenerate the vectors with `bun docs/overstory-spec/conformance/canonical-cbor-vectors.ts`.

`protocol-authored-updates.json` binds the consolidated target request grammar and exact
CBOR/digests in TypeScript and Swift. `protocol-accepted-state.json` binds target accepted
states, simplified receipts and material-reference inspection.
`protocol-authored-transport.json` combines authored intent with complete objects and
sparse deltas, testing exact bytes, validation and transport-independent identity.
The two authored-request vector sets bind active request codecs; accepted-state
read vectors remain ahead of active HTTP adoption. `repeatDecisions` in read fixtures duplicates
the sole decision with IDs `decision_0`, `decision_1`, etc.; it tests absence of a
fixed count cap without duplicating fixture text. The previous deployed-format
`protocol-update-intent.json` and `protocol-operations.json` remain compatibility evidence.

`accepted-ambiguity.json` records planned semantic scenarios, not executable claims
that a host supports those effects. `protocol-operations.json` and
`protocol-update-intent.json` are likewise grammar and digest vectors: they do
not assert that their effects execute today. [status.md](../../../status.md) is the
authority for the implemented subset; the request grammar itself is in
[tree operations §2.1](../01-tree-operations.md#21-the-update-request).

- `cross-document-copy.json` supplies the same exact UTF-8 source span, destination
  and foreign-document capture to Swift and TypeScript admission tests. Both must
  bind the declared path and captured bytes to the authored graph before emitting
  `copySource`; ordinary text equality is not provenance.
- `source-moves.json` gives the exact meaning of a generation's moves beside its
  edits, all in basis coordinates: each case's result, or whether it is refused
  as invalid or as an order basis coordinates do not decide. The Swift and
  TypeScript executors, both change logs (moves publish as `moveSource` before the
  frame's edits) and canopyd's fast path (`arrangeSources`) run it.
- `page-conversion-undo.json` checks paired Swift/TypeScript page-creation
  receipts, historical removal and redo target identities through queue restart.

- `resource-policy.json`: shared valid/invalid `who` / `app` / `allow` / `within` grammar, `admin` and `apps.yaml` rules, consumed by `@overstory/protocol` and Swift `Overstory`.
- `tree-configuration.json`: derived configuration TreeIDs, the graph by tree kind, validation, invariants and merge, consumed by `@overstory/protocol` (derivation also by Swift `Overstory`).
- `device-keys.json`: device `key` encodings and their DER public keys, and the device-session and profile-reset challenges ([accounts §5](../04-accounts-and-devices.md#5-device-pairing)) with their exact canonical CBOR and signatures. Ed25519 signatures are deterministic and must match; the P-256 signature is one valid signature, to verify rather than reproduce. Consumed by `@overstory/protocol`, canopyd and Swift `Overstory`.

## Index

| Vector | Binds |
|---|---|
| `accepted-ambiguity.json` | Planned semantic conflict scenarios (not executable claims) |
| `canonical-cbor-values.json` | The canonical CBOR subset and its hashes |
| `client-state-machines.json` | Document admission and working-tree update machines |
| `collection-schemas.json` | The declarative collection schema profile: syntax, metadata, values, CSV cells, limits |
| `cross-document-copy.json` | Cross-document copy capture in both admission queues |
| `device-keys.json` | Device key encodings, session and reset challenges, and their signatures |
| `directory-documents.json` | Directory document projection (spec 02) |
| `entry-actions.json` | Entry move, copy, remove, and restore semantics |
| `errors.json` | Protocol error shapes and codes |
| `node-model.json` | Provider-neutral node model decoding |
| `node-targets.json` | Node target resolution |
| `observation-events.sse`, `observation-events-invalid.json` | Watch stream framing, valid and invalid |
| `page-conversion-undo.json` | Page-creation receipts and undo targets through restart |
| `resource-policy.json` | `who` / `app` / `allow` / `within` rule grammar |
| `source-admission-queue.json` | Admission queue records and trace compaction (`traces`) |
| `source-copy.json`, `source-preservation.json` | Source transfer and exact-byte preservation |
| `source-moves.json` | Moves beside edits in basis coordinates, their refusals, and their frames |
| `tree-configuration.json` | Tree configuration derivation, graph, validation, invariants and merge |
| `url-resolution.json` | Locator resolution (spec 03) |
| `protocol-accepted-state.json`, `protocol-accepted-transport.json` | Accepted states, receipts, inspection, and catch-up transport |
| `protocol-authored-updates.json`, `protocol-authored-transport.json` | The authored request grammar, digests, and transport encodings |
| `protocol-endpoints.json` | Route shapes |
| `protocol-graphs.json`, `protocol-objects.json`, `protocol-object-deltas.json`, `protocol-snapshot-bundles.json`, `protocol-values.json` | Objects, directory graphs, deltas, snapshot bundles, and canonical values |
| `protocol-operations.json`, `protocol-update-intent.json` | Source operations and the update digest |

`protocol-account-challenges.json` covers community-address, exact-account, and invitation-code challenge requests. All return the same complete account-bound challenge; TypeScript and Swift clients consume these cases.
