# Smaller project 002: One grammar for locator identity surfaces

## Status

- **Priority:** P2
- **Effort:** M
- **State:** PLANNED — grammar decisions first, then TypeScript and Swift parsers, vectors,
  renderers, and spec text in one change.
- **Depends on:** the `arbor://<TreeID>` authority and `;arbor-rev=` segment parameter
  (landed 2026-09-02); [Cleanup 001](../cleanups/001-pageid-stable-key-cutoff.md)
  for the legacy `#<PageID>` input bridge.

## Target result

A stable key appears in exactly one encoding per surface, every surface is listed in one
table in [locators](../../spec/04-locators.md), and everything attached to a path segment
uses the single `;arbor-<name>=<value>` parameter mechanism. A reader of the spec can answer
"where can a key show up, and how is it spelled there" from that table alone.

## What exists today

The same canonical key JSON (`[["id","x7f3q2"]]`) has five surfaces:

| Surface | Spelling | Owner |
|---|---|---|
| `NodeRef.stableKey` | canonical key JSON text | model and Wire §6 |
| Final path segment | `;arbor-key=<base64url of the JSON>` | locators |
| Markdown relative link | `#arbor-key=<base64url>` fragment alias, translated by Arbor renderers | directory format, locators |
| Row child segment | the raw single string key when it is a valid path component, otherwise `~row-<base64url>` | child backings |
| Legacy input | bare `#<PageID>` and `#row=<key>` fragments, accepted but never emitted | locators, remove-later 001 |

`;arbor-key=` and `;arbor-rev=` already share one parameter grammar, so the segment side is
done. The remaining spread is between the JSON text, the base64url token, the fragment alias,
and the `~row-` segment rule.

## Decisions to make before implementation

1. **Does the Markdown `#arbor-key=` alias survive?** It exists so a non-Arbor Markdown
   reader follows the plain relative path. Arbor renderers already rewrite it to the segment
   form before emitting HTML, so the alias is authoring convenience only. Options: keep it as
   the one authored spelling (and say so), or retire it and let authored Markdown carry
   `;arbor-key=` directly, accepting that non-Arbor readers see the parameter in the path.
   The second option removes a translation step from every renderer and the "no key plus
   fragment in one relative link" limitation (03 §Stable keys, 02 §Complete documents).
2. **Should the row child segment always be the base64url key?** Today a single string key
   that is a valid path component is used raw and anything else becomes `~row-<b64>`. That
   rule needs a reversibility proof: a raw key equal to a literal `~row-…` string is already
   excluded, but a raw key that collides with an expanded Markdown record's filename in a
   mixed collection is not addressed. Either prove the rule or make the segment uniform.
   Smaller project 001 owns the related expanded-file path question; decide the two together.
3. **When does `#<PageID>` / `#row=` input acceptance end?** Cleanup 001 gates the PageID
   bridge on an owner-index uniqueness proof. Once it closes, `legacyStableKeyCandidate`
   leaves `ResolvedLocatorState` in both parsers and the `url-resolution.json` cases that
   carry it are rewritten.

## Work once decided

- Parsers: `packages/core/src/logical-url.ts` and
  `native/Packages/ArborClient/Sources/ArborClient/LogicalURL.swift` change together;
  `conformance/url-resolution.json` is the shared contract and gains a case per surface.
- Renderers: the Markdown alias translation in `arbor/react`'s `Markdown`, the HTTP
  projection redirect rule (locators §6), and link healing in arborsync all read the table.
- Row segments: `rowPathSegment` in `packages/stores` and its Swift replica counterpart.
- Spec: the table replaces the prose in 03 §Stable keys and the alias paragraphs in 02;
  06 §Row identity references the table instead of restating the `~row-` rule.

## Do not

- Introduce a second key encoding or a second parameter syntax.
- Change `NodeRef.stableKey` or the canonical key JSON definition.
- Reintroduce a PageID or row-only locator variant.
