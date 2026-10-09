# Ideas and open questions

Candidates without a plan, and unresolved design questions. Nothing here is committed
work. Before promoting a candidate, check current source and tests: an old audit finding
does not prove a current gap. When one becomes real work, write a plan (or add it to
[small work](small-work.md)) and delete it here.

## Product design needed

- **Claimed-member removal, restoration and access-history recovery.** Confirmation,
  revocation, historical visibility and restoration without a parallel group database.
- **Claim disputes and recovery without the operator.** Operator recovery exists
  (`canopyd recover`); recovery by the profile key or DNS across hosts keeps the same
  Profile TreeID with auditable proof of control ([Security 010](security/010-signed-profile-statements.md)).
- **Persistent-host administration.** Permanent domains, graceful restart,
  replacement-host restore and verification, keeping migration scripts procedural.
- **Choice review extensions**, when a real review needs one: safe binary previews,
  richer directory browsing, long-source comparison beyond 4,000 lines, visible
  whitespace and line-ending differences, a freshness policy so unrelated accepted updates
  need not force renewed review, explanations of verified moves and deletions, rule-provided combination previews, bulk and
  offline resolution.

## Reliability

- **Explicit web-editor unload drain** (with Web 025). `beforeunload`/`pagehide` has no
  bounded drain or visible pending state.
- **Commit native control text before flush** (reverify). If Quagmire can hold text
  outside `CanopyDocumentBinding` at background, navigation or close, commit then flush.
- **Per-key frontmatter conflicts** (reverify). Preserve independent key changes, detect
  same-key conflicts and deletions.
- **Provider-specific materialization controls.** Only when one backing can report a
  reliable snapshot, progress, cancellation and failure boundary.

## Security

- **Validate directory-entry names on every client read path** (reverify). Reject empty,
  dot, parent and separator-bearing names before materialization.
- **Typed authorization errors** (reverify) instead of matching English text; coordinate
  with [Security 003](security/003-canopy-host-responses.md).
- **Upgrade the `yaml` dependency** (reverify) past the nested-collection stack-overflow fix.
- **Safe ordinary-file metadata and previews.** Bounded size/type detection and inert
  previews; never parse binary or placeholder bytes as text.
- **Object reachability index.** Replace per-request graph scans only with an index whose
  invalidation cannot widen object access.

## Testing

- **Browser smoke harness** and **accessibility/responsive audits** (with Web 025).
- **canopyd authorization characterization** (reverify): revoked grants, read-link write
  denial, non-admin access mutation, transitive group removal.
- **Cross-client group workflow coverage**, once the first-party flow is designed.
- **`mergeBlocks` characterization** and **Markdown/BlockNote round-trip fixtures**
  (reverify) before changing alignment or expanding Web 025 B3.

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

## Cleanup

- **Shared runtime protocol decoding.** When a second trusted boundary besides Arbor Sync
  needs runtime decoding, colocate pure decoders in `@overstory/protocol`.
- **Provider scalar normalization** and **bounded-placement conformance** belong to the
  Postgres plans and Native 003 when they start.

## Open questions

1. **Shared-tree recovery and endpoint movement.** How can a stable TreeID refresh endpoint
   hints durably and verifiably without a central registry?
2. **Identity and recovery UX.** How should device replacement, profile recovery and
   disputes prove control without turning Arbor Sync into a multi-user account service?
3. **Merge semantics.** What logical conflict semantics should structured collections and
   whole-database SQLite revisions use beyond text's three-way merge?
4. **Determinism.** How should query and agent-tool runtimes isolate clock, randomness, I/O
   and runtime upgrades from results claimed to be deterministic?
5. **Compiler correctness.** How should handle extraction, validator generation, realm
   separation and access inference be verified as security boundaries?
6. **Schema evolution.** How do mounted consumers keep working on older shapes while a tree
   or external database changes schema?
7. **Consent precision.** How should interfaces explain prefix declarations broader than
   what a particular run reads or writes?
8. **Cross-server executable data.** How should query discovery, delegated authorization
   and server-to-server routing let a document use remote data without treating network
   reachability as authority? ([Apps 009](apps/009-cross-host-delegation.md) is a sketch.)
