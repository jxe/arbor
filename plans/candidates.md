# Candidates

Work nobody has decided on yet, whether or how: features, fixes and measurements that might
be worth doing. Nothing here is committed. Things only Joe can do are in [Joe's to-do](joe.md); proposed
additions to the spec are [spec extensions](spec-extensions/README.md). Before promoting a
candidate, check current source and tests: an old audit finding does not prove a current gap.
When one is decided, write a plan (or add it to the plan it belongs to) and delete it here.

## Product design needed

- **Persistent-host administration.** Permanent domains, graceful restart,
  replacement-host restore and verification, keeping migration scripts procedural.
  Joe, 2026-10-28: running a host may stay hard for now, even once people run their own
  placement hosts.

## Small features

- **A domain that stops checking** (Names 001, 2026-11-07). When a person's domain stops
  reaching their host, Story falls back to `~alice · host`. Should people whose rules name
  her by the domain be warned?
- **Founding a community off Railway.** Fly and the docker-compose VPS recipe could get the
  same founder-code path as the Railway template (Sharing 004, 2026-11-05). Railway only for
  now.
- **`story untrack`.** Ignore rules never untrack an already-published path; today the
  recipe is move out, sync the deletion, move back. One command could publish the deletion
  and leave the bytes. The bytes stay in accepted history, so a leaked secret still needs
  rotating.
- **Ignored paths in the Mac app's publish view.** Mark which paths the ignore rules keep
  out and which ignored paths are still tracked.

- **Cascading deletes in USL.** Joe, 2026-10-28: add cascade (and maybe set-null) to
  USL at some point. Today only the SQLite layout cascades, for rows owned through a
  model's `ends` (`packages/usl/src/layout.ts`); host row replay checks references and
  refuses a dangling one, so whoever writes the operations spells out the cascade.

- **Full-text search in Beetle** (Joe, 2026-11-11): not a plugin. Support what SQLite FTS5
  and Postgres (`tsvector`, `pg_trgm`) do: perhaps a storage attribute that indexes text
  fields and built-ins to match and rank, run by the host for a `?q=` input and by a
  client over local rows when the query is held in state.

## Reliability

- **Explicit web-editor unload drain** (with Web 025). `beforeunload`/`pagehide` has no
  bounded drain or visible pending state.
- **Commit native control text before flush** (reverify). If Quagmire can hold text
  outside `StoryDocumentBinding` at background, navigation or close, commit then flush.
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

- **The rest of the CLI on the client library** (after `story invite`, 2026-11-07): `story
  agent revoke` edits `devices.yaml` on the host through `@ovst/client` instead of in the
  checkout; `story place` and `story mv <url> <url>` make their `mounts.yaml` edits the same
  way and stop requiring Story Sync when nothing local changes; `story agent create` drops its
  `withStorySync` precondition. What stays with Story Sync: `story status`, `story sync …`,
  `story mv` of a local folder, waiting for a new placement. Correct the comment in
  `packages/protocol/src/config/device-key.ts` and `docs/architecture/story-sync/data-home.md`
  to say which processes read the key. Overlaps Clients 003's account-setup note.

- **Shared runtime protocol decoding.** When a second trusted boundary besides Story Sync
  needs runtime decoding, colocate pure decoders in `@ovst/protocol`.
- **Provider scalar normalization** and **bounded-placement conformance** belong to the
  Postgres plans when they start.
