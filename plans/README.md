# Plans

Plans are filed by when Joe wants them: [`soon/`](soon), [`later/`](later) and
[`when-needed/`](when-needed), which holds plans that wait on a trigger ("when merges bite",
"when size hurts") rather than a date. Within a folder a file is named by its topic and number,
such as `soon/links-001-tree-id-links.md`. Move a file when its timing changes, and move its
paragraph here with it.

Each plan starts with why and when Joe wants it; the same paragraph is below. Small tasks
and install, deploy and soak checks are in [small work](small-work.md); unplanned candidates
and open design questions are in [ideas](ideas.md). Current behavior is in
[status](../status.md). Plans carry no priorities. Delete a plan once done, after recording
its evidence in status.

## Soon

**[Schema language 005: collections that sync](soon/schema-language/005-collections-that-sync.md)**,
building [003: model, storage and presentation layers](soon/schema-language/003-layers-and-sigils.md)
and [004: logical collections](soon/schema-language/004-logical-collections.md) (proposed), with the
[group overview](soon/schema-language/README.md). Joe split it out of Schema language 002 on
2026-10-22 to do first, because People 001 needs it: the layered USL, collections whose rows are
the tree's content while each placement chooses files or SQLite, row operations with field-level
merge, and SQLite that syncs through Story Sync. Row operations, field merge and SQLite sync are
built on branch `claude/project-thread-6kt6l8` in a pre-004 form; 004's forks are open.

**[Live 001: see who else is here](soon/live-001-presence.md).**
Joe asked on 2026-10-13 for presence in Overstory and Story: who is looking at a tree, which
page each person is on, and where their cursor is when two people share a page. It must be
light: nothing about cursors is sent unless someone else is on the same page. Joe wants it soon (2026-10-20).
It starts with the spec, because presence is the first live data a host relays that is not
part of a tree.

**[overstoryd 015: explain automatic resolutions and clear reconciled choices](soon/merge-015-resolve-reconciled-choices.md).**
Joe encountered a whole-tree conflict after moving blocks into a new page. Later
accepted edits already produced the intended contents, but the conflict remained
and its cards showed only older alternatives. overstoryd should clear choices it can
prove reconciled, and Story should explain the current result and make explicit
resolution easy. It starts with the portable explanation every automatic outcome
needs (merge notes, rule revisions), which overstoryd 014's menu reuses.

**[Links 001: follow a link that names a tree by its ID](soon/links-001-tree-id-links.md).**
Story writes `overstory://tr_…` links between trees but can follow one only when the tree
is already placed or was just visited, and ignores them when the OS opens one. Joe wants
them honored wherever the device can find the tree. The plan starts by making the spec
say how such a link resolves, with the host form as the hint.

### Cleanups

What a finished project left behind: old readers to delete, notes to write. Each is small and
named `cleanup-` and the plan it came from. Smaller leftovers still are in
[small work](small-work.md).

**[Rename 002: remove the old-spelling read aliases](soon/cleanup-rename-002-remove-old-spelling-aliases.md).**
The 2026-10-10 rename left readers accepting six old spellings, among them `arbor://` and the
`;arbor-*` locator parameters, because authored content and shared links still carry
them. Joe wants that tolerance to be temporary: once the rename has been live a few weeks.

**[Performance 002: retire the earlier merge-cache formats](soon/cleanup-performance-002-retire-old-merge-cache-formats.md).**
The shared cache is live and the iPhone's stuck request went through it. Look at the
host's cache directory once, then delete the two older readers.

**[overstoryd 001: pack storage follow-ups](soon/cleanup-overstoryd-001-pack-storage-follow-ups.md).**
Packing is live since 2026-10-09. Architecture notes, a periodic check of pack files and
packed bytes in the reports remain; take them when the store is next worked on.

## Later

**[Filesystem 024: open plain folders on the Mac](later/filesystem-024-open-plain-folders-on-the-mac.md).**
Opening an ordinary folder in the Mac app, and making it into a tree from there, went away
with the daemon's editor path; after setup a new tree needs `story place`. Joe wants this
before the web editor. Mac only; the browser half is an open question in Web 025.

**[People 001: a directory you own, and Go to…](later/people-001-directory-and-go-to.md).**
Joe wants People to remember everyone and every tree he has come across, and to make forming
groups to share with easy: see whether a group exists, drag people into it, invite whoever is
missing. A Go to… field finds visited trees and pages by title. The directory is a private
tree of collections with a grouped arrangement, so it waits for Schema language 005's
collections that sync.

**[Schema language 002: database views in Story](later/schema-language-002-cranberries-in-story.md).**
Joe wants excellences and supplies-remake to run natively in Story: collections presented as
views and edited in a native structured editor, embedded in pages, with row ownership as access
policy, and ports of both sites. The data underneath moved to Schema language 005 on 2026-10-22,
so this comes after it, at a different time.

**[Apps 005: source resolution and the execution sidecar](later/apps-005-source-resolution-and-sidecar.md).**
Joe wants queries and mutations running on hosts fairly soon, to test the permissions and
lending models against real code. This is the first step: a headless sidecar that runs them
under overstoryd's authorization.

**[Apps 006: durable query and mutation authoring](later/apps-006-durable-authoring.md).**
Part of the same push, after Apps 005: the authoring API that declares author and user
authority together is what exercises the permissions and lending models.

**[Apps 008: app approvals and lending on placement hosts](later/apps-008-app-approvals-on-placement-hosts.md).**
Part of the lending test: an app approved at a profile's home host should work on its
placement hosts too. After Apps 005.

**[Apps 003: compile and typecheck executable documents](later/apps-003-development-compiler-and-editor-tooling.md).**
Later, for testing Overstory as a web framework: one compiler and typechecker for
executable documents everywhere, which the Supplies site needs. After the queries and
mutations work.

**[Apps 001: the Supplies executable site](later/apps-001-supplies-executable-site.md).**
Later, the web-framework test itself: the Supplies site running locally and on overstoryd,
then deployed to a third-party host such as Vercel. After Apps 003, 005 and 006.

**[Apps 002: hosted agents](later/apps-002-overstoryd-hosted-agents.md).** After the Supplies site:
authored agents hosted beside an app, calling its own query and mutation handles. No timing
yet.

**[Apps 009: code on one host using access held on another](later/apps-009-cross-host-delegation.md).**
After Apps 008, once apps span hosts. A design sketch; no timing yet.

**[Apps 010: collection rows in native offline replicas](later/apps-010-native-offline-collection-file-projection.md).**
When browsing collection rows offline on native becomes a real need.

**[Web 025: Story for the web](later/story-web-025-story-web.md)**, with its
[surface inventory](later/story-web-surfaces.md). For sharing with others: people without the Mac
or iPhone app need a way to read and edit a tree. After the Native 022 soak closeout.

**[Security 004: access links without leaking secrets](later/security-004-access-link-secrets.md).**
When Joe shares by link, alongside Web 025: an access link must not leak its secret into
URLs, history or logs. Nothing is in production yet, so until then the spec carries the
requirement.

**[Performance 004: a provenance index kept at acceptance](later/performance-004-provenance-index.md).**
Joe chose this on 2026-10-21 instead of Performance 003 (fast catch-up from an older basis,
after the iPhone needed several minutes of history replay on 2026-10-09). Every acceptance
records which change inserted each run of each file's bytes, so the merge engine reads
states instead of replaying history, and line provenance becomes a lookup. It starts with a
spike on the iPhone's catch-up proving the engine can evaluate from the index.

**[Clients 002: more identity-preserving coalescing](later/merge-002-identity-preserving-coalescing.md).**
Joe wants ordinary editing bursts to publish as a few meaningful authored changes,
with enough identity for overstoryd to merge concurrent work correctly. After the
idle-based publication baseline, extend simplification beyond repeated moves of
one unchanged span. Implement each case in the Swift and TypeScript clients,
using shared examples and the host merge engine to prove the result.

**[Sharing 001: join on an iPhone first, add a Mac later](later/sharing-001-join-on-iphone-first.md).**
An invitation link is usually tapped on a phone, where today it ends at an app that can only
pair with a Mac. Join from the iPhone with the same link, then add a Mac by scanning a code
the Mac shows. After Release 001. It owns what an invitation link does on the iPhone;
Links 001 owns the iPhone's other link opens.

**[Sharing 002: invite from the command line, through a client library](later/sharing-002-invite-from-the-command-line.md).**
Setting up the intro video, Joe could make an invitation only in the Mac app. He wants
`story invite`, built the way the other clients work: the command talks to the host itself
through `@ovst/client`, with Story Sync out of the path. The rest of the CLI's host edits
moving the same way is recorded there as a follow-up.

**[Security 012: get back into an account with the admin's help](later/security-012-get-back-in-with-the-admins-help.md).**
A person who has lost every device gets back in through the host's administrator, as the
spec has it; Joe wants that to be as easy as possible for both. The administrator makes a
link from Story, or approves a request the person sends from the new Mac. Before people
depend on Story enough to lose a Mac.

**[Release 003: the iPhone app on the App Store](later/release-003-app-store.md).** After friends
are using the TestFlight build. A sketch of what review requires: account deletion, report
and block, and policy pages. The sample pages are the reviewer's way in.

**[overstoryd 007: document history and restore](later/history-007-document-history-routes-and-restore.md).**
Seeing and restoring earlier versions of a page; it also decides how long document
versions are kept, which is most of what overstoryd retains.

**[overstoryd 006: line provenance](later/history-006-line-provenance.md).** After
overstoryd 007: who submitted each current line. With Performance 004's index it reads
pieces instead of matching lines.

**Postgres [001](later/postgres-001-child-provider.md), [002](later/postgres-002-observation-and-semantic-sync.md),
[003](later/postgres-003-read-only-sqlite-projection.md), [004](later/postgres-004-bidirectional-projection.md),
[005](later/postgres-005-representation-equivalence.md).** Longer term. For now the point is that
the design shows Postgres backings, SQLite projections and moving a collection between
representations are possible.

## When needed

**[overstoryd 014: the merge handles many cases](when-needed/merge-014-merge-handles-many-cases.md).**
Prose already merges well. Take an item from its menu when a real edit reaches review that
should have merged.

**[Native 008: copies with changes and compound undo](when-needed/merge-008-copies-with-changes-and-compound-undo.md).**
When merges bite: a real concurrent edit reviews or loses a copy, paste or undo that should
have merged. Needs a new Quagmire release.

**[Native 006: sparse iOS placement](when-needed/performance-006-sparse-ios-placement.md).** When size hurts:
a tree too big to place on the iPhone in one download.

**[Security 010: signed profile statements](when-needed/security-010-signed-profile-statements.md).**
When a host Joe does not control is involved, or a home host must be left behind.

## Groups

Some plans cover different stages of the same work. They stay separate files because their
proofs and release boundaries differ, and they share examples rather than duplicate tasks.

### Merge improvements

Editor intent, client publication, host merging and conflict review. [Native 008](when-needed/merge-008-copies-with-changes-and-compound-undo.md)
supplies truthful command evidence; [Clients 002](later/merge-002-identity-preserving-coalescing.md)
can simplify that evidence after it exists, and must not invent missing copy or move identity;
[overstoryd 014](when-needed/merge-014-merge-handles-many-cases.md) must support an emitted
operation form before a client that emits it is installed; [overstoryd 015](soon/merge-015-resolve-reconciled-choices.md)
gives every automatic outcome its explanation, which 014's "merge with a note" candidates wait
for. The numbers are identifiers, not an execution order. History and provenance support
explanation but do not improve merge decisions; [server refinements](small-work.md#server-refinements)
tracks hand checks of merge rules already deployed; Web 025 owns rebuilding the web reviewer;
merge replay cost is Performance 004, including merge and replay cost for large collections
(its step 6). The [testing candidates](ideas.md#testing) in ideas
include editor alignment and round-trip characterization.

### History and revisions

[overstoryd 007](later/history-007-document-history-routes-and-restore.md) (history and
restore) comes before [overstoryd 006](later/history-006-line-provenance.md) (line
provenance), which builds on the history API and adds its own metadata and policy. Merge
explanations can link to this history; their provenance proofs and conflict rules stay with
merge work.

### Performance

Latency, transfer size and storage overhead: take a plan when its stated problem occurs, and
measure both the benefit and the cost to correctness, recovery and offline use.
[Performance 004](later/performance-004-provenance-index.md) and
[Native 006](when-needed/performance-006-sparse-ios-placement.md) are the plans; the shared
merge cache and object packing are live, with their leftovers in the cleanups above. Client
coalescing also reduces wire traffic but stays with merge work. [Performance ideas](ideas.md#speed)
collects measured leads that are not yet plans.
