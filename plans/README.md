# Plans

Feature plans, the things you would notice in Story, are in [`features/`](features) whatever
their timing, which leads each one's entry here and its file. The rest are filed by when Joe
wants them: [`soon/`](soon), [`later/`](later) and [`when-needed/`](when-needed), which holds
plans that wait on a trigger ("when merges bite", "when size hurts") rather than a date. A file
is named by its topic and number, such as `features/agents-001-presence-and-a-first-agent.md`. When a plan's timing
changes, move the file (or, in `features/`, change its timing line) and its paragraph here.

Each plan starts with why and when Joe wants it; the same paragraph is below. Decided small
tasks, hand checks and soaks are [chores](chores.md); undecided work is in
[candidates](candidates.md); proposed additions to the spec are
[spec extensions](spec-extensions/README.md), one file each. Current behavior is in
[status](../status.md). Plans carry no priorities. Delete a plan once done, after recording
its evidence in status.

## Features

What you would notice in Story, as opposed to protocol, host or data plumbing.

**[Agents 001: see who's here, and run a first agent task on the Mac](features/agents-001-presence-and-a-first-agent.md).**
*Soon.* Joe asked on 2026-10-30 for the smoothest way to bring AI into Story: an agent that is a
collaborator, shown through presence the way a person is, run by Claude Code on his own Mac
(no API token). This first plan is presence (formerly Live 001: who is in a tree, on which
page, at which block; light, nothing about cursors sent unless someone shares the page) and a
first cut: task blocks (`> [!agent] …`) added anywhere, Run on the Mac, and the agent as a
presence peer with a status line. It absorbs CLI 004's readiness check and agent skill.

**[Agents 002: talk to the agent, and run tasks from the iPhone](features/agents-002-talk-to-the-agent-and-run-from-anywhere.md).**
*Later.* After Agents 001: the agent asks and Joe answers at its cursor from any device, Run
works from the iPhone while the Mac is awake (through presence messages between one person's
devices), and Codex as a second runner. The conversation vanishes like presence.

**[Agents 003: agent runs in history](features/agents-003-agent-runs-in-history.md).**
*Later,* after overstoryd 007. A run is one history entry labelled with its task, Undo Run is
a history restore, and updates gain an optional attribution so an agent's edits are both
Joe's and the agent's (Joe, 2026-10-30).

**[Live 002: exact carets and selections](features/live-002-exact-carets.md).**
*Later.* After Agents 001: a Quagmire release that reports and draws exact carets and
selections, for people and agents alike. The wire does not change.

**[Editor 003: suggestions, from people and agents](features/editor-003-suggestions.md).**
*Later.* Joe wants two representations that mean different things: inline suggestions in the
page as CriticMarkup, and overlay trees that reference a parent tree like a Git branch. Forks
open.

**[People 001: form groups, share with people, and go to any tree](features/people-001-groups-sharing-and-go-to.md).**
*Soon.* Joe wants People to remember everyone and every tree he has come across, and to make forming
groups to share with easy: see whether a group exists, drag people into it, invite whoever is
missing. Phase 1, the directory tree kept by code, is done (2026-10-25,
[status](../status.md#people-directory-tree-picker-and-usl-summaries--2026-10-25)). Left:
forming groups with 007's editor, a share sheet, and a Go to… field that finds visited trees and
pages by title, with `overstory://tr_…` links found by asking the directory, then the account
hosts (a side slice for any time). Moved to soon on 2026-10-25.

**[Schema language 009: change a collection's schema and keep its rows](features/schema-language-009-schema-changes-keep-the-data.md).**
*Later.* Nothing carries rows across a schema change yet, so a seed bump empties the People
directory. USL meant migrations between relation forms to be small edits to one declaration.
From the ideas' open questions, 2026-10-28.

**[Filesystem 024: open plain folders on the Mac](features/filesystem-024-open-plain-folders-on-the-mac.md).**
*Later.* Opening an ordinary folder in the Mac app, and making it into a tree from there, went away
with the daemon's editor path; after setup a new tree needs `story place`. Joe wants this
before the web editor. Mac only; the browser half is an open question in Web 025.

**[Sharing 001: join on an iPhone first, add a Mac later](features/sharing-001-join-on-iphone-first.md).**
*Later.* An invitation link is usually tapped on a phone, where today it ends at an app that can only
pair with a Mac. Join from the iPhone with the same link, then add a Mac by scanning a code
the Mac shows. After Release 001. It owns what an invitation link does on the iPhone;
People 001 phase 4 owns the iPhone's other link opens.

**[Sharing 002: invite from the command line, through a client library](features/sharing-002-invite-from-the-command-line.md).**
*Later.* Setting up the intro video, Joe could make an invitation only in the Mac app. He wants
`story invite`, built the way the other clients work: the command talks to the host itself
through `@ovst/client`, with Story Sync out of the path. The rest of the CLI's host edits
moving the same way is recorded there as a follow-up.

**[Security 012: get back into an account with the admin's help](features/security-012-get-back-in-with-the-admins-help.md).**
*Later.* A person who has lost every device gets back in through the host's administrator, as the
spec has it; Joe wants that to be as easy as possible for both. The administrator makes a
link from Story, or approves a request the person sends from the new Mac. Before people
depend on Story enough to lose a Mac.

**[overstoryd 007: document history and restore](features/history-007-document-history-routes-and-restore.md).**
*Later.* Seeing and restoring earlier versions of a page; it also decides how long document
versions are kept, which is most of what overstoryd retains.

**[Editor 001: snippets you type or say](features/editor-001-snippets.md).**
*When needed.* Joe asked on 2026-10-24 for TextMate-style snippets in place of template buttons: a page he
edits like any other, such as his standard day outline, that expands where he is when he
picks it from @ or says its name in a pinch recording. Template buttons go away. Forks open:
where a page is marked as a snippet, and exactly what the spoken trigger is. Joe moved it
from soon to when needed on 2026-10-24.

**[Editor 002: dictate several items in one recording](features/editor-002-dictated-lists.md).**
*When needed.* Joe chose spoken breaks on 2026-10-24: "next item", "next item indented" and an outdent
phrase split one pinch recording into several bullets, so a day plan of time rows and tasks
can be dictated in one go. A recording without commands stays one paragraph. Joe moved it
from soon to when needed on 2026-10-24.

## Soon

**[Schema language 007: edit collections in Story, on the Mac and iPhone](soon/schema-language-007-edit-collections-in-story.md).**
Joe wants collections edited natively in Story, the People directory first. The write path is
done and in daily use: Story sends row operations through the host on every device, queued
while offline, and the host derives the result (spec 10 §2.2). Left: the queue's loose ends,
every view intent as row operations, simple edits in the view, then the structured editor
(groups, chips, bullets, drag, inline Markdown). The editing half of the split Joe made on
2026-10-28.

**[Schema language 010: row ownership](soon/schema-language-010-row-ownership.md).**
Rows only their authors edit, as access policy (`who: {property: authors}`, one
`unless`/`when` predicate), with device updates authorized by effect. Formerly 002's
milestone 5; Joe moved it to soon on 2026-10-28.

**[Apps 005: source resolution, execution authority and the sidecar](soon/apps-005-source-resolution-and-sidecar.md).**
Joe wants queries and mutations running on hosts fairly soon, to test the permissions and
lending models against real code. Schema language 005 runs them inside overstoryd as their
caller, from handles registered in code; this plan makes them run as an activated app under
an execution token, from code read out of a tree, and then moves execution into a sidecar.
The sidecar comes first (Joe, 2026-10-28).

**[Performance 004: a provenance index kept at acceptance](soon/performance-004-provenance-index.md).**
Joe chose this on 2026-10-21 instead of Performance 003 (fast catch-up from an older basis,
after the iPhone needed several minutes of history replay on 2026-10-09). Every acceptance
records which change inserted each run of each file's bytes, so the merge engine reads
states instead of replaying history, and line provenance becomes a lookup. It starts with a
spike on the iPhone's catch-up proving the engine can evaluate from the index.

**[Clients 002: more identity-preserving coalescing](soon/merge-002-identity-preserving-coalescing.md).**
Joe wants ordinary editing bursts to publish as a few meaningful authored changes,
with enough identity for overstoryd to merge concurrent work correctly. After the
idle-based publication baseline, extend simplification beyond repeated moves of
one unchanged span. Implement each case in the Swift and TypeScript clients,
using shared examples and the host merge engine to prove the result.

**[Filesystem 026: pages as logical nodes, written to disk by each placement](soon/filesystem-026-pages-as-logical-nodes.md).**
The tree would hold a page's properties and content, and each placement would write its
front matter; formatting stops traveling between devices, which Joe accepted on 2026-10-28,
when he put it in soon.
Front-matter edits become property effects in merge and access.

**[overstoryd 015: explain automatic resolutions and clear reconciled choices](soon/merge-015-resolve-reconciled-choices.md).**
Joe encountered a whole-tree conflict after moving blocks into a new page. Later
accepted edits already produced the intended contents, but the conflict remained
and its cards showed only older alternatives. overstoryd should clear choices it can
prove reconciled, and Story should explain the current result and make explicit
resolution easy. Joe moved it to soon on 2026-10-28.

**[overstoryd 014: the merge handles many cases](soon/merge-014-merge-handles-many-cases.md).**
Prose already merges well; a menu of cases that still go to review. Joe moved it to soon on
2026-10-28.

## Later

**[Schema language 008: port excellences and supplies-remake to Story](later/schema-language-008-port-excellences-and-supplies.md).**
Joe wants the excellences document and supplies-remake to run natively in Story instead of on
Supabase. Split out of Schema language 002 on 2026-10-25; it needs 007's editor and 010's
ownership.

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

**[Performance 007: keep collections in SQLite on the host](later/performance-007-sqlite-collection-storage.md).**
Joe, 2026-10-28: overstoryd should work with a collection's SQLite file instead of keeping
the equivalent table objects, producing canonical objects on demand. The history model
for SQLite collections (less, none, or kept another way) comes first. After Apps 005.

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

**[overstoryd 016: richer choice review](later/merge-016-choice-review-extensions.md).**
Things a real choice review may need: safe binary previews, long sources, visible whitespace,
a freshness policy so unrelated updates don't force a renewed review, explanations of moves
and deletions, combination previews, and bulk and offline resolution. Joe made the ideas item
a plan on 2026-10-28; take each when a real review needs it.

**[Release 003: the iPhone app on the App Store](later/release-003-app-store.md).** After friends
are using the TestFlight build. A sketch of what review requires: account deletion, report
and block, and policy pages. The sample pages are the reviewer's way in.

**[overstoryd 006: line provenance](later/history-006-line-provenance.md).** After
overstoryd 007: who submitted each current line. With Performance 004's index it reads
pieces instead of matching lines.

**Postgres [001](later/postgres-001-child-provider.md), [002](later/postgres-002-observation-and-semantic-sync.md),
[003](later/postgres-003-read-only-sqlite-projection.md), [004](later/postgres-004-bidirectional-projection.md),
[005](later/postgres-005-representation-equivalence.md).** Longer term. For now the point is that
the design shows Postgres backings, SQLite projections and moving a collection between
representations are possible.

## When needed

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
supplies truthful command evidence; [Clients 002](soon/merge-002-identity-preserving-coalescing.md)
can simplify that evidence after it exists, and must not invent missing copy or move identity;
[overstoryd 014](soon/merge-014-merge-handles-many-cases.md) must support an emitted
operation form before a client that emits it is installed; [overstoryd 015](soon/merge-015-resolve-reconciled-choices.md)
gives every automatic outcome its explanation, which 014's "merge with a note" candidates wait
for. The numbers are identifiers, not an execution order. History and provenance support
explanation but do not improve merge decisions; [overstoryd 016](later/merge-016-choice-review-extensions.md)
extends the choice review; Web 025 owns rebuilding the web reviewer;
merge replay cost is Performance 004, including merge and replay cost for large collections
(its step 6). The [testing candidates](candidates.md#testing)
include editor alignment and round-trip characterization.

### History and revisions

[overstoryd 007](features/history-007-document-history-routes-and-restore.md) (history and
restore) comes before [overstoryd 006](later/history-006-line-provenance.md) (line
provenance), which builds on the history API and adds its own metadata and policy. Merge
explanations can link to this history; their provenance proofs and conflict rules stay with
merge work.

### Performance

Latency, transfer size and storage overhead: take a plan when its stated problem occurs, and
measure both the benefit and the cost to correctness, recovery and offline use.
[Performance 004](soon/performance-004-provenance-index.md) and
[Native 006](when-needed/performance-006-sparse-ios-placement.md) are the plans; the shared
merge cache and object packing are live, and packing's leftovers are done. Client
coalescing also reduces wire traffic but stays with merge work. [Performance candidates](candidates.md#speed)
collects measured leads that are not yet plans.
