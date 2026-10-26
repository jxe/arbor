# Plans

Plans are filed by when Joe wants them: [`soon/`](soon), [`later/`](later) and
[`when-needed/`](when-needed), which holds plans that wait on a trigger ("when merges bite",
"when size hurts") rather than a date. Within a folder a file is named by its topic and number,
such as `soon/live-001-presence.md`. Move a file when its timing changes, and move its
paragraph here with it.

Each plan starts with why and when Joe wants it; the same paragraph is below. Small tasks
and install, deploy and soak checks are in [small work](small-work.md); unplanned candidates
and open design questions are in [ideas](ideas.md). Current behavior is in
[status](../status.md). Plans carry no priorities. Delete a plan once done, after recording
its evidence in status.

## Soon

**[Schema language 007: edit collection rows in Story, on the Mac and iPhone](soon/schema-language-007-edit-rows-in-story.md).**
Joe, 2026-10-24: the next step after Schema language 006, which shows collections read-only in
Story on the Mac ([status](../status.md#collections-in-story-on-the-mac--2026-10-25)). Part 1 is the
backend: Story reads collections on the iPhone and writes row operations from code, through
the host on every device, queued while offline (Schema language 002's milestone 3a). The host
derives the result (spec 10 §2.2, Joe 2026-10-25), so no client encodes a collection's tables. Part 1
is done, the iPhone check included; the People directory writes all its rows through it
(2026-10-25). Part 2 is simple edits in the view on the games sandbox: a bullet's value, a
row's name, chips, delete and add.

**[Schema language 002: the collection editor, ownership and pages that show collections](soon/schema-language-002-collection-editor.md).**
Joe wants collections edited natively in Story: a structured editor (groups, chips, bullets,
drag, inline Markdown), row ownership as access policy, and pages that show a collection kept
elsewhere. Its first customer is the People directory. Moved to soon on 2026-10-25, without the
site ports, which are Schema language 008 in later.

**[People 001: form groups, share with people, and go to any tree](soon/people-001-groups-sharing-and-go-to.md).**
Joe wants People to remember everyone and every tree he has come across, and to make forming
groups to share with easy: see whether a group exists, drag people into it, invite whoever is
missing. Phase 1, the directory tree kept by code, is done (2026-10-25,
[status](../status.md#people-directory-tree-picker-and-usl-summaries--2026-10-25)). Left:
forming groups with 002's editor, a share sheet, and a Go to… field that finds visited trees and
pages by title, with `overstory://tr_…` links found by asking the directory, then the account
hosts (a side slice for any time). Moved to soon on 2026-10-25.

**[Live 001: see who else is here](soon/live-001-presence.md).**
Joe asked on 2026-10-13 for presence in Overstory and Story: who is looking at a tree, which
page each person is on, and where their cursor is when two people share a page. It must be
light: nothing about cursors is sent unless someone else is on the same page. Joe wants it soon (2026-10-20).
It starts with the spec, because presence is the first live data a host relays that is not
part of a tree.

### Cleanups

What a finished project left behind: old readers to delete, notes to write. Each is small and
named `cleanup-` and the plan it came from. Smaller leftovers still are in
[small work](small-work.md).

**[Schema language 005: publish USL 0.3.0 and move the sites](soon/cleanup-schema-language-005-publish-usl-and-move-the-sites.md).**
Collections that sync landed on 2026-10-24 ([status](../status.md#collections-that-sync--2026-10-24)).
`@ovst/usl` 0.3.0 is unpublished, and cranberries, excellences and supplies-remake still use the
0.2.0 syntax. Joe deferred both that day; take it when a site is next worked on.

**[Schema language 005: gaps left in collections that sync](soon/cleanup-schema-language-005-collection-gaps.md).**
Mixed row and text frames are refused, host materializations are never evicted, a mutation's
guard is the whole tree, and a receipt lost in a crash refuses the retry. None blocks People 001.

## Later

**[Filesystem 024: open plain folders on the Mac](later/filesystem-024-open-plain-folders-on-the-mac.md).**
Opening an ordinary folder in the Mac app, and making it into a tree from there, went away
with the daemon's editor path; after setup a new tree needs `story place`. Joe wants this
before the web editor. Mac only; the browser half is an open question in Web 025.

**[Schema language 008: port excellences and supplies-remake to Story](later/schema-language-008-port-excellences-and-supplies.md).**
Joe wants the excellences document and supplies-remake to run natively in Story instead of on
Supabase. Split out of Schema language 002 on 2026-10-25; it needs 002's editor and ownership.

**[Apps 005: source resolution, execution authority and the sidecar](later/apps-005-source-resolution-and-sidecar.md).**
Joe wants queries and mutations running on hosts fairly soon, to test the permissions and
lending models against real code. Schema language 005 runs them inside overstoryd as their
caller, from handles registered in code; this plan makes them run as an activated app under
an execution token, from code read out of a tree, and then moves execution into a sidecar.
One fork for Joe: whether the sidecar comes first or waits.

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
People 001 phase 4 owns the iPhone's other link opens.

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

**[overstoryd 015: explain automatic resolutions and clear reconciled choices](when-needed/merge-015-resolve-reconciled-choices.md).**
Joe encountered a whole-tree conflict after moving blocks into a new page. Later
accepted edits already produced the intended contents, but the conflict remained
and its cards showed only older alternatives. overstoryd should clear choices it can
prove reconciled, and Story should explain the current result and make explicit
resolution easy. Joe moved it to when-needed on 2026-10-25: take it when a stale whole-tree conflict
like that one shows up again.

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

**[Editor 001: snippets you type or say](when-needed/editor-001-snippets.md).**
Joe asked on 2026-10-24 for TextMate-style snippets in place of template buttons: a page he
edits like any other, such as his standard day outline, that expands where he is when he
picks it from @ or says its name in a pinch recording. Template buttons go away. Forks open:
where a page is marked as a snippet, and exactly what the spoken trigger is. Joe moved it
here from soon on 2026-10-24.

**[Editor 002: dictate several items in one recording](when-needed/editor-002-dictated-lists.md).**
Joe chose spoken breaks on 2026-10-24: "next item", "next item indented" and an outdent
phrase split one pinch recording into several bullets, so a day plan of time rows and tasks
can be dictated in one go. A recording without commands stays one paragraph. Joe moved it
here from soon on 2026-10-24.

## Groups

Some plans cover different stages of the same work. They stay separate files because their
proofs and release boundaries differ, and they share examples rather than duplicate tasks.

### Merge improvements

Editor intent, client publication, host merging and conflict review. [Native 008](when-needed/merge-008-copies-with-changes-and-compound-undo.md)
supplies truthful command evidence; [Clients 002](later/merge-002-identity-preserving-coalescing.md)
can simplify that evidence after it exists, and must not invent missing copy or move identity;
[overstoryd 014](when-needed/merge-014-merge-handles-many-cases.md) must support an emitted
operation form before a client that emits it is installed; [overstoryd 015](when-needed/merge-015-resolve-reconciled-choices.md)
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
merge cache and object packing are live, with packing's leftovers in the cleanups above. Client
coalescing also reduces wire traffic but stays with merge work. [Performance ideas](ideas.md#speed)
collects measured leads that are not yet plans.
