# @overstory/protocol

The Overstory protocol in code. Everything an independent implementation
would have to reproduce lives here, and nothing else in the workspace is a
dependency of it. The Swift twin is `swift/Packages/Overstory`.

- `model/`: identifiers and `TreeID`, the node model and node keys, logical
  paths and URLs, canonical CBOR and hashing, resource policy, protocol errors,
  SSE parsing, UTF-8 helpers, and the atomic file-write helper shared by the
  configuration writers and `fs`.
- `objects.ts`, `snapshots.ts`: immutable objects, directory graphs, and
  snapshot bundles.
- `updates/`: the update request and accepted-state contracts, strict JSON and
  base64 transport encoding, the canonical semantic intent and its digest,
  object deltas, and applying accepted transitions.
- `transport.ts`: the HTTP and SSE client (`WireClient`) a host speaks to.
- `documents/`: the Markdown and directory-document format (spec 02): parsing,
  child links, document icons, display titles, and document merge.
- `config/`: `account.yaml`, `trees.yaml`, `devices.yaml`, and resource
  configuration (spec 04 and 05), tree placements, the host account stores,
  and the private data-home root.

Subpath exports exist for `hash`, `logical-path`, `logical-url`, `node-key`,
`node-model`, `path`, `sse`, `utf8`, `file-ops`, and `account-config-v2`.
Only the plural v2 account configuration is supported.

This package must not depend on the host, SQLite, server history, access
internals, or the merge engine.
