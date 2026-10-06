# Plans

Each plan starts with why and when Joe wants it; the same paragraph is below. Small tasks
and install, deploy and soak checks are in [small work](small-work.md); unplanned candidates
and open design questions are in [ideas](ideas.md). Current behavior is in
[status](../status.md). Plans carry no priorities. Delete a plan once done, after recording
its evidence in status.

Related plans are grouped in [merge improvements](merge/README.md),
[history and revisions](history/README.md), and [performance](performance/README.md).

## Soon

**[Rename 001: Arbor and Canopy names become Overstory, ost and Hunch](rename/001-overstory-names.md).**
The commands, daemons, dot directories, env vars, routes and the app still say Arbor
or Canopy. Joe settled the new names on 2026-10-06 and wants them applied in one
cutover: `overstoryd`, `ostd`, `ost`, `.ost`, `.ostignore`, `overstory://`, and Hunch.app.

**[canopyd 015: resolve choices that later work has reconciled](merge/015-resolve-reconciled-choices.md).**
Joe encountered a whole-tree conflict after moving blocks into a new page. Later
accepted edits already produced the intended contents, but the conflict remained
and its cards showed only older alternatives. Address this after the page-transfer
fixes: canopyd should clear choices it can prove reconciled, and Canopy should
explain the current result and make explicit resolution easy.

**[Filesystem 024: disk editors for non-tree folders](filesystem/024-disk-editors-for-non-tree-folders.md).**
Opening an ordinary folder in the Mac app, and making it into a tree from there, went away
with the daemon's editor path; today a new tree needs `arbor place`. Joe wants this first,
before the web editor. The web half follows Web 025.

**[Apps 005: source resolution and the execution sidecar](apps/005-source-resolution-and-sidecar.md).**
Joe wants queries and mutations running on hosts fairly soon, to test the permissions and
lending models against real code. This is the first step: a headless sidecar that runs them
under canopyd's authorization.

**[Apps 006: durable query and mutation authoring](apps/006-durable-authoring.md).**
Part of the same push, after Apps 005: the authoring API that declares author and user
authority together is what exercises the permissions and lending models.

**[Apps 008: app approvals and lending on placement hosts](apps/008-app-approvals-on-placement-hosts.md).**
Part of the lending test: an app approved at a profile's home host should work on its
placement hosts too. After Apps 005.

## Later

**[Clients 002: more identity-preserving coalescing](merge/002-identity-preserving-coalescing.md).**
Joe wants ordinary editing bursts to publish as a few meaningful authored changes,
with enough identity for canopyd to merge concurrent work correctly. After the
idle-based publication baseline, extend simplification beyond repeated moves of
one unchanged span. Implement each case in the Swift and TypeScript clients,
using shared examples and the host merge engine to prove the result.

**[Apps 003: compile and typecheck executable documents](apps/003-development-compiler-and-editor-tooling.md).**
Later, for testing Overstory as a web framework: one compiler and typechecker for
executable documents everywhere, which the Supplies site needs. After the queries and
mutations work.

**[Apps 001: the Supplies executable site](apps/001-supplies-executable-site.md).**
Later, the web-framework test itself: the Supplies site running locally and on canopyd,
then deployed to a third-party host such as Vercel. After Apps 003, 005 and 006.

**[Web 025: Canopy for the web](canopy-web/025-arbor-web.md)**, with its
[surface inventory](canopy-web/surfaces.md). For sharing with others: people without the Mac
or iPhone app need a way to read and edit a tree. After Filesystem 024 and the Native 022
soak closeout.

**[Security 004: access links without leaking secrets](security/004-access-link-secrets.md).**
When Joe shares by link, alongside Web 025: an access link must not leak its secret into
URLs, history or logs. Nothing is in production yet, so until then the spec carries the
requirement.

**[Apps 002: hosted agents](apps/002-canopy-hosted-agents.md).** After the Supplies site:
authored agents hosted beside an app, calling its own query and mutation handles. No timing
yet.

**[Apps 009: code on one host using access held on another](apps/009-cross-host-delegation.md).**
After Apps 008, once apps span hosts. A design sketch; no timing yet.

## Parked

**[canopyd 014: the merge handles many cases](merge/014-merge-handles-many-cases.md).**
Prose already merges well. Take an item from its menu when a real edit reaches review that
should have merged.

**[Native 008: copies with changes and compound undo](merge/008-copies-with-changes-and-compound-undo.md).**
When merges bite: a real concurrent edit reviews or loses a copy, paste or undo that should
have merged. Needs Quagmire 0.9.0.

**[canopyd 007: document history and restore](history/007-document-history-routes-and-restore.md).**
Parked. Seeing and restoring earlier versions of a page; it also decides how long document
versions are kept, which is most of what canopyd retains.

**[canopyd 006: line provenance](history/006-line-provenance.md).** Parked, and after
canopyd 007: who submitted each current line.

**[canopyd 001: pack object storage](performance/001-pack-object-storage.md).** When size hurts:
the live volume or backups grow until loose objects cost startup, audit or backup time.
Space is not pressing.

**[Native 006: sparse iOS placement](performance/006-sparse-ios-placement.md).** When size hurts:
a tree too big to place on the iPhone in one download.

**[Apps 010: collection rows in native offline replicas](apps/010-native-offline-collection-file-projection.md).**
When browsing collection rows offline on native becomes a real need.

**[Security 002: decode URL paths once](security/002-path-decoding.md)** and
**[Security 003: harden canopyd responses](security/003-canopy-host-responses.md).**
Nothing is in production, so these leaks are tolerable for now; what matters is that the
spec states the requirement. Do them before a host serves people other than Joe.

**[Security 010: signed profile statements](security/010-signed-profile-statements.md).**
When a host Joe does not control is involved, or a home host must be left behind.

**Postgres [001](postgres/001-child-provider.md), [002](postgres/002-observation-and-semantic-sync.md),
[003](postgres/003-read-only-sqlite-projection.md), [004](postgres/004-bidirectional-projection.md),
[005](postgres/005-representation-equivalence.md).** Longer term. For now the point is that
the design shows Postgres backings, SQLite projections and moving a collection between
representations are possible.
