# Plans

Each plan starts with why and when Joe wants it; the same paragraph is below. Small tasks
and install, deploy and soak checks are in [small work](small-work.md); unplanned candidates
and open design questions are in [ideas](ideas.md). Current behavior is in
[status](../status.md). Plans carry no priorities. Delete a plan once done, after recording
its evidence in status.

Related plans are grouped in [merge improvements](merge/README.md),
[history and revisions](history/README.md), and [performance](performance/README.md).

## Soon

**[Security 011: Story Sync answers only its own user](security/011-story-sync-local-callers.md).**
Trying the Mac download from a second account on his Mac, Joe found the app about to attach
to his own account's sync helper: it listens on a fixed loopback port and does not ask who is
calling. Before the download goes beyond a few friends who each have their own Mac.

**[Release 001: publish the first Mac and iPhone builds](release/001-publish-the-first-release.md).**
So friends can install Story from a link on nxhx.org and from TestFlight. The Mac DMG is
notarized and the iPhone build is in beta review; publishing, a clean-machine walkthrough
and one delivered update remain, mostly Joe's. It absorbed Release 002.

**[overstoryd 015: explain automatic resolutions and clear reconciled choices](merge/015-resolve-reconciled-choices.md).**
Joe encountered a whole-tree conflict after moving blocks into a new page. Later
accepted edits already produced the intended contents, but the conflict remained
and its cards showed only older alternatives. overstoryd should clear choices it can
prove reconciled, and Story should explain the current result and make explicit
resolution easy. It starts with the portable explanation every automatic outcome
needs (merge notes, rule revisions), which overstoryd 014's menu reuses.

**[Links 001: follow a link that names a tree by its ID](links/001-tree-id-links.md).**
Story writes `overstory://tr_…` links between trees but can follow one only when the tree
is already placed or was just visited, and ignores them when the OS opens one. Joe wants
them honored wherever the device can find the tree. The plan starts by making the spec
say how such a link resolves, with the host form as the hint.

**[Filesystem 024: open plain folders on the Mac](filesystem/024-open-plain-folders-on-the-mac.md).**
Opening an ordinary folder in the Mac app, and making it into a tree from there, went away
with the daemon's editor path; after setup a new tree needs `story place`. Joe wants this
before the web editor. Mac only; the browser half is an open question in Web 025.

**[Apps 005: source resolution and the execution sidecar](apps/005-source-resolution-and-sidecar.md).**
Joe wants queries and mutations running on hosts fairly soon, to test the permissions and
lending models against real code. This is the first step: a headless sidecar that runs them
under overstoryd's authorization.

**[Apps 006: durable query and mutation authoring](apps/006-durable-authoring.md).**
Part of the same push, after Apps 005: the authoring API that declares author and user
authority together is what exercises the permissions and lending models.

**[Apps 008: app approvals and lending on placement hosts](apps/008-app-approvals-on-placement-hosts.md).**
Part of the lending test: an app approved at a profile's home host should work on its
placement hosts too. After Apps 005.

## Later

**[Performance 003: fast catch-up from an older authored basis](performance/003-fast-historical-catch-up.md).**
Joe requested this on 2026-10-09 after the iPhone caught up but needed several minutes
of server history reconstruction. Retain useful historical checkpoints within a byte
budget, reduce replay work as history grows, and measure end-to-end catch-up after
restart and with an empty cache. Preserve exact authored and conflict semantics.

**[Clients 002: more identity-preserving coalescing](merge/002-identity-preserving-coalescing.md).**
Joe wants ordinary editing bursts to publish as a few meaningful authored changes,
with enough identity for overstoryd to merge concurrent work correctly. After the
idle-based publication baseline, extend simplification beyond repeated moves of
one unchanged span. Implement each case in the Swift and TypeScript clients,
using shared examples and the host merge engine to prove the result.

**[Apps 003: compile and typecheck executable documents](apps/003-development-compiler-and-editor-tooling.md).**
Later, for testing Overstory as a web framework: one compiler and typechecker for
executable documents everywhere, which the Supplies site needs. After the queries and
mutations work.

**[Apps 001: the Supplies executable site](apps/001-supplies-executable-site.md).**
Later, the web-framework test itself: the Supplies site running locally and on overstoryd,
then deployed to a third-party host such as Vercel. After Apps 003, 005 and 006.

**[Web 025: Story for the web](story-web/025-story-web.md)**, with its
[surface inventory](story-web/surfaces.md). For sharing with others: people without the Mac
or iPhone app need a way to read and edit a tree. After the Native 022 soak closeout.

**[Security 004: access links without leaking secrets](security/004-access-link-secrets.md).**
When Joe shares by link, alongside Web 025: an access link must not leak its secret into
URLs, history or logs. Nothing is in production yet, so until then the spec carries the
requirement.

**[Release 004: an intro video for invited friends](release/004-intro-video.md).**
Joe wants a short video to send with an invitation: getting set up, the iPhone gestures, and
agents. He records and narrates; the plan holds the shot list, the demo setup and how the
cut is assembled. After Release 001.

**[Sharing 001: join on an iPhone first, add a Mac later](sharing/001-join-on-iphone-first.md).**
An invitation link is usually tapped on a phone, where today it ends at an app that can only
pair with a Mac. Join from the iPhone with the same link, then add a Mac by scanning a code
the Mac shows. After Release 001. It owns what an invitation link does on the iPhone;
Links 001 owns the iPhone's other link opens.

**[Security 012: get back into an account with the admin's help](security/012-get-back-in-with-the-admins-help.md).**
A person who has lost every device gets back in through the host's administrator, as the
spec has it; Joe wants that to be as easy as possible for both. The administrator makes a
link from Story, or approves a request the person sends from the new Mac. Before people
depend on Story enough to lose a Mac.

**[Release 003: the iPhone app on the App Store](release/003-app-store.md).** After friends
are using the TestFlight build. A sketch of what review requires: account deletion, report
and block, and policy pages. The sample pages are the reviewer's way in.

**[Apps 002: hosted agents](apps/002-overstoryd-hosted-agents.md).** After the Supplies site:
authored agents hosted beside an app, calling its own query and mutation handles. No timing
yet.

**[Apps 009: code on one host using access held on another](apps/009-cross-host-delegation.md).**
After Apps 008, once apps span hosts. A design sketch; no timing yet.

## Cleanups

What a finished project left behind: old readers to delete, notes to write. Each is small
and lives in `cleanups/`, named by the plan it came from. Smaller leftovers still are in
[small work](small-work.md).

**[Rename 002: remove the old-spelling read aliases](cleanups/rename-002-remove-old-spelling-aliases.md).**
The 2026-10-10 rename left readers accepting six old spellings, among them `arbor://` and the
`;arbor-*` locator parameters, because authored content and shared links still carry
them. Joe wants that tolerance to be temporary: once the rename has been live a few weeks.

**[Performance 002: retire the earlier merge-cache formats](cleanups/performance-002-retire-old-merge-cache-formats.md).**
The shared cache is live and the iPhone's stuck request went through it. Look at the
host's cache directory once, then delete the two older readers.

**[overstoryd 001: pack storage follow-ups](cleanups/overstoryd-001-pack-storage-follow-ups.md).**
Packing is live since 2026-10-09. Architecture notes, a periodic check of pack files and
packed bytes in the reports remain; take them when the store is next worked on.

## Parked

**[overstoryd 014: the merge handles many cases](merge/014-merge-handles-many-cases.md).**
Prose already merges well. Take an item from its menu when a real edit reaches review that
should have merged.

**[Native 008: copies with changes and compound undo](merge/008-copies-with-changes-and-compound-undo.md).**
When merges bite: a real concurrent edit reviews or loses a copy, paste or undo that should
have merged. Needs a new Quagmire release.

**[overstoryd 007: document history and restore](history/007-document-history-routes-and-restore.md).**
Parked. Seeing and restoring earlier versions of a page; it also decides how long document
versions are kept, which is most of what overstoryd retains.

**[overstoryd 006: line provenance](history/006-line-provenance.md).** Parked, and after
overstoryd 007: who submitted each current line.

**[Native 006: sparse iOS placement](performance/006-sparse-ios-placement.md).** When size hurts:
a tree too big to place on the iPhone in one download.

**[Apps 010: collection rows in native offline replicas](apps/010-native-offline-collection-file-projection.md).**
When browsing collection rows offline on native becomes a real need.

**[Security 010: signed profile statements](security/010-signed-profile-statements.md).**
When a host Joe does not control is involved, or a home host must be left behind.

**Postgres [001](postgres/001-child-provider.md), [002](postgres/002-observation-and-semantic-sync.md),
[003](postgres/003-read-only-sqlite-projection.md), [004](postgres/004-bidirectional-projection.md),
[005](postgres/005-representation-equivalence.md).** Longer term. For now the point is that
the design shows Postgres backings, SQLite projections and moving a collection between
representations are possible.
