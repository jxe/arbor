# Ideas and open questions

Candidates without a plan, and unresolved design questions. Nothing here is committed
work. Before promoting a candidate, check current source and tests: an old audit finding
does not prove a current gap. When one becomes real work, write a plan (or add it to
[small work](small-work.md)) and delete it here.

## Product design needed

- **Persistent-host administration.** Permanent domains, graceful restart,
  replacement-host restore and verification, keeping migration scripts procedural.
  Joe, 2026-10-28: running a host may stay hard for now, even once people run their own
  placement hosts.

## Small features

- **`story untrack`.** Ignore rules never untrack an already-published path; today the
  recipe is move out, sync the deletion, move back. One command could publish the deletion
  and leave the bytes. The bytes stay in accepted history, so a leaked secret still needs
  rotating.
- **Ignored paths in the Mac app's publish view.** Mark which paths the ignore rules keep
  out and which ignored paths are still tracked.

## Reliability

- **Explicit web-editor unload drain** (with Web 025). `beforeunload`/`pagehide` has no
  bounded drain or visible pending state.
- **Commit native control text before flush** (reverify). If Quagmire can hold text
  outside `StoryDocumentBinding` at background, navigation or close, commit then flush.
- **Per-key frontmatter conflicts** (reverify). Preserve independent key changes, detect
  same-key conflicts and deletions.
- **Provider-specific materialization controls.** Only when one backing can report a
  reliable snapshot, progress, cancellation and failure boundary.

## Security

- **Validate directory-entry names on every client read path** (reverify). Reject empty,
  dot, parent and separator-bearing names before materialization.
- **Typed authorization errors** (reverify) instead of matching English text.
- **Safe ordinary-file metadata and previews.** Bounded size/type detection and inert
  previews; never parse binary or placeholder bytes as text.
- **Object reachability index.** Replace per-request graph scans only with an index whose
  invalidation cannot widen object access.

## Testing

- **Browser smoke harness** and **accessibility/responsive audits** (with Web 025).
- **overstoryd authorization characterization** (reverify): revoked grants, read-link write
  denial, non-admin access mutation, transitive group removal.
- **Cross-client group workflow coverage**, once the first-party flow is designed.
- **Markdown/BlockNote round-trip fixtures** (reverify) before expanding Web 025 B3.

## Speed

Measure before promoting any of these.

- **Flat-directory acceptance latency** (measured 2026-09-24). 95–130 ms server time with
  1,000 files in one directory; live, no directory exceeds 63 entries. Only if a real tree
  gets that flat.
- **File-provider exact-source cache invalidation**, **static response caching and KaTeX
  code splitting**, **cold/warm workspace benchmarks**, **extension-aware lazy indexing**
  (all reverify).
- **Minimal changed-document reconciliation**, only if large external rewrites make
  whole-document `replaceBlocks` disruptive.
- **Stream the pack experiment harness.** `tests/performance/storage/pack-experiments.ts`
  keeps every object in memory (4 GB RSS on the 2026-10-09 live copy). Only if the store
  grows much further. Also unmeasured on the live host: backup size and time with packs, and
  foreground latency while a pass runs under a burst; measure them with the next backup.

## Cleanup

- **Shared runtime protocol decoding.** When a second trusted boundary besides Story Sync
  needs runtime decoding, colocate pure decoders in `@ovst/protocol`.
- **Provider scalar normalization** and **bounded-placement conformance** belong to the
  Postgres plans and [Apps 010](later/apps-010-native-offline-collection-file-projection.md)
  (formerly Native 003) when they start.

## Open questions

1. **Compiler correctness.** How should handle extraction, validator generation, realm
   separation and access inference be verified as security boundaries?
2. **Cross-server executable data.** How should query discovery, delegated authorization
   and server-to-server routing let a document use remote data without treating network
   reachability as authority? ([Apps 009](later/apps-009-cross-host-delegation.md) is a sketch.)
