# Arbor conformance vectors

These language-neutral vectors accompany the portable [Arbor specification](../spec.md). Independent implementations use them to verify exact authored-format, locator, synchronized-configuration, wire-object, request-identity, HTTP-value, and observation behavior.

The vectors are normative only where their owning specification defines an exact representation or result. Reference daemon responses, client presentation values, and replaceable Canopy algorithms live under [`tests/fixtures`](../tests/fixtures) instead.

`url-resolution.json` is the shared TypeScript/Swift locator contract. Its
`legacyStableKeyCandidate` field records input-only migration evidence; it does
not turn an ordinary content fragment into identity. A resolver may use that
candidate only after the old PageID owner index proves one accessible owner.
