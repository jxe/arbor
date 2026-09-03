# Plan 016: Bridge Quagmire to Arbor documents

> **Executor instructions**: Build a thin private host adapter over ArborKit sessions and exact Quagmire `0.1.0`. Do not modify/tag Quagmire, create a second canonical document model, or port voice/product chrome.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- native/Packages/ArborKit native/Packages/ArborReplica native/Packages/ArborQuagmire native/project.yml spec/02-directory-format.md docs/client.md packages/editor tests /Users/joe/src/quagmire`

## Status

- **Priority**: P1
- **Effort**: XL
- **Risk**: HIGH
- **Depends on**: Plans 012 and 014
- **Category**: editor integration
- **Planned at**: Arbor `dc34126`, Quagmire `4049fd4`, 2026-08-23
- **Reconciled at**: Arbor `01776d6`, Quagmire `4049fd4`, 2026-08-24
- **Completed**: 2026-08-24

## Reconciled protocol decision

- ArborQuagmire uses range-guarded local source replacements so untouched Markdown remains exact. Its durable admission result is still a complete authoritative source and revision.
- At this plan's completion, the bridge did not emit wire `filePatches`. Plan 021 subsequently carried its guarded admissions through both providers as one-shot sync provenance; it remains a lockstep first-alpha transport, not a negotiated mixed-version capability.

## Why this matters

Arbor supplies exact Markdown, content guards, and accepted roots; Quagmire supplies stable editable block identity and native interaction. A host-owned codec/source ledger joins them without contaminating either public model or losing unsupported/untouched source.

## Current state

- Quagmire `0.1.0` is storage/serialization/navigation neutral and requires synchronous `persistCommit` plus async `flush`.
- Stable BlockID lifecycle, H1–H6, raw fallback, system replacement, and neutral documentLink are public and fixture-tested.
- Arbor content writes accept complete exact source plus `baseContentRevision`; providers parse and confirm authoritative source.

## Component contract

Create `ArborQuagmire`, depending on Quagmire and ArborKit only:

- Markdown-to-Quagmire codec with host-supplied stable BlockIDs;
- private BlockID-keyed ledger containing original semantic block, structural context, and opaque source record;
- exact unchanged envelope/raw/compatible block reuse; isolated canonical serialization for edited/new/depth-changed blocks;
- synchronous serialize/admit before `persistCommit` returns; `flush` awaits all admitted generations;
- rebase only from accepted authoritative source; clean system replacement creates no authored undo; conflicts retain prior base and local candidate.

Quagmire never sees Arbor types, source ranges/handles, Markdown syntax, root/sync data, or persisted reference metadata.

## References/actions

- Inline mention inserts an ordinary scoped link; line-leading mention inserts documentLink.
- Resolve with tree scope and PageID; stale readable paths heal only through explicit source edit.
- Create/append/move/copy/inline operations persist destination before source removal.
- Link deletion never implies Trash; inline-then-Trash flushes parent first.
- Revalidate authority/materialization after every await and stop visibly before the first unsafe mutation.

## Scope

**In scope**: ArborQuagmire package/tests, focused ArborKit session additions, editor surface using fake/offline replica providers.

**Out of scope**: Quagmire/Hunch changes, voice/polish, full app chrome, macOS arbord provider, network merge changes.

## Steps

1. Lock fixtures for every Quagmire block/mark, H1–H6, frontmatter trivia, CRLF, raw Markdown, links, footnotes/LaTeX/HTML, split/merge/reorder/indent, and provider completion.
2. Implement codec/ledger and exact assembly rules. No-op must be byte-identical; editing one structured block normalizes only it.
3. Implement synchronous generation admission, accepted rebase, conflict/retry, clean external replacement, duplicate-tab sharing, flush, and terminal drain.
4. Implement scoped mention/reference resolution and the complete crash-safe documentLink action matrix.
5. Mount the editor on Markdown-capable fake/replica surfaces; disable editor commands elsewhere.
6. Rerun unchanged Quagmire and Hunch remote-package gates.

## Verification

```sh
swift test --package-path native/Packages/ArborQuagmire
swift test --package-path native/Packages/ArborKit
swift test --package-path native/Packages/ArborReplica
/Users/joe/src/quagmire/scripts/verify.sh
git -C /Users/joe/src/hunch diff --check
git diff --check
```

Expected: exact-source fixtures pass; immediate commit/flush cannot report false quiescence; destination failures leave source exact; Quagmire tag/source remain unchanged.

Completed evidence: `ArborQuagmire` passed eight tests covering byte-exact no-op source with frontmatter/CRLF/raw constructs, all supported block kinds and H1-H6, semantic bold/italic/code/strike/link preservation after edits, one narrow guarded UTF-8 admission, sequential synchronous generations plus flush, shared PageID bindings across duplicate tabs, scoped references and destination failure safety, and clean accepted replacement with stable BlockIDs plus a remapped exact-source ledger. The app mounts exact Quagmire `0.1.0` for writable Markdown-capable sessions. Quagmire's unchanged verification script passed its package tests and macOS/iOS builds; Hunch and Quagmire remained unmodified.

## Done criteria

- [x] Untouched operational Markdown is byte-identical and edited blocks retain represented semantics.
- [x] Every synchronous Quagmire commit is admitted to one ordered provider write chain before flush can finish.
- [x] Accepted replacement preserves matching BlockIDs without creating authored undo or losing source-ledger fidelity.
- [x] Duplicate tabs share the PageID-keyed binding while cross-document failures leave the source exact.
- [x] Quagmire remains exact remote `0.1.0` with no Arbor or source-provenance API added to it.

## STOP conditions

- Required editor behavior is absent from exact Quagmire 0.1.0.
- Stable identity remints during an in-place operation.
- Integration requires public source-provenance or Arbor APIs in Quagmire.
- A failed cross-document action can lose the only copy.

## Maintenance note

ArborQuagmire is private glue, not a portable Markdown standard. Parser-specific ledger representation may change while its fidelity tests remain fixed.
