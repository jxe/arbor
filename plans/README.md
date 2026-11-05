# Plans

Feature plans, the things you would notice in Story, are in [`features/`](features) whatever
their timing, which leads each one's entry here and its file. The rest are filed by when Joe
wants them: [`soon/`](soon), [`later/`](later) and [`when-needed/`](when-needed), which holds
plans that wait on a trigger ("when merges bite", "when size hurts") rather than a date. A file
is named by its topic and number, such as `features/agents-002-talk-to-the-agent-and-run-from-anywhere.md`. When a plan's timing
changes, move the file (or, in `features/`, change its timing line) and its paragraph here.

Each plan starts with why and when Joe wants it; the same paragraph is below. Decided small
tasks, hand checks and soaks are [chores](chores.md); undecided work is in
[candidates](candidates.md); proposed additions to the spec are
[spec extensions](spec-extensions/README.md), one file each. Current behavior is in
[status](../status.md). Plans carry no priorities. Delete a plan once done, after recording
its evidence in status.

## Features

What you would notice in Story, as opposed to protocol, host or data plumbing.

**[Agents 002: talk to the agent, and run tasks from the iPhone](features/agents-002-talk-to-the-agent-and-run-from-anywhere.md).**
*Later.* After Agents 001: the agent asks and Joe answers at its cursor from any device, Run
works from the iPhone while the Mac is awake (through presence messages between one person's
devices), and Codex as a second runner. The conversation vanishes like presence.

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
forming groups with 007's editor, a person picker, and a Go to… field that finds visited trees and
pages by title, with `overstory://tr_…` links found by asking the directory, then the account
hosts (a side slice for any time). Moved to soon on 2026-10-25. Its share sheet phase was dropped on 2026-11-01 for Sharing 003.

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

**[Sharing 003: move a page to another tree from the share sheet](features/sharing-003-move-pages-between-trees.md).**
*Now.* Built on the Mac and the iPhone (on main since 2026-11-01). Left: New Tree… on the
iPhone, and Joe's hand check. Joe wants a public tree and to move pages into it from todos while keeping them linked
there (2026-11-01). The share sheet names the page's tree and who has access to that tree;
picking another tree previews its access and moves the page, leaving a link where it was.

**[Sharing 004: start your own community from a Railway template](features/sharing-004-start-your-own-community.md).**
*Built, then set aside.* Founding by code, the host image, the template's definition and Story's
wording are on main (2026-11-05). Left: Joe publishes the image and the template, a rehearsal
from a fresh Railway account, and what Story says to a host too old for it. A newcomer can ask a friend for an invitation or run their own host. Joe (2026-11-04)
wants the Railway template first, so nobody makes an identity and then gives up at Railway: the
host is founded by a generated code, logs a founder link, and Story's invitation flow claims it
and makes the claimer the community's administrator.

**[Filesystem 027: the whole namespace on disk](features/filesystem-027-the-whole-namespace-on-disk.md).**
*Not soon.* The AFS half of the global namespace: every tree you can read is a path under
`~/Overstory/<host>/…`, fetched when opened, through a File Provider extension on the Mac (and
the Files app on the iPhone). Builds on visitor sessions and read-only placements (2026-11-05).
Joe filed it on 2026-11-05 "in features and not to do anytime soon".

**[Security 012: get back into an account with the admin's help](features/security-012-get-back-in-with-the-admins-help.md).**
*Later.* A person who has lost every device gets back in through the host's administrator, as the
spec has it; Joe wants that to be as easy as possible for both. The administrator makes a
link from Story, or approves a request the person sends from the new Mac. Before people
depend on Story enough to lose a Mac.

**[overstoryd 007: document history and restore](features/history-007-document-history-routes-and-restore.md).**
*Later.* Seeing and restoring earlier versions of a page; it also decides how long document
versions are kept, which is most of what overstoryd retains. Since 2026-11-01 it also holds
agent runs in History (formerly Agents 003): updates carry an optional attribution naming the
agent and run, a run is one History entry, and Undo Run is a restore.

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

**[Performance 008: merge cost by edit, not by size](soon/performance-008-merge-cost-by-edit.md).**
What Performance 004 (merges start from a provenance index; closed 2026-11-02) left: a
canonical contribution order inside choices, and collection merges and replay that decode
only the chunks an edit touches instead of whole tables.

**[Clients 002: more identity-preserving coalescing](soon/merge-002-identity-preserving-coalescing.md).**
Joe wants ordinary editing bursts to publish as a few meaningful authored changes,
with enough identity for overstoryd to merge concurrent work correctly. After the
idle-based publication baseline, extend simplification beyond repeated moves of
one unchanged span. Implement each case in the Swift and TypeScript clients,
using shared examples and the host merge engine to prove the result.

**[Filesystem 026: pages as logical nodes, written to disk by each placement](soon/filesystem-026-pages-as-logical-nodes.md).**
The tree holds a page's properties and content, and each placement writes its front matter;
formatting stops traveling between devices, which Joe accepted on 2026-10-28. Steps 1 to 5
are on main ([status](../status.md#pages-as-logical-nodes-built--2026-10-28)) and the host
converted Joe's todos tree on 2026-11-01, and it has shipped in Story 0.1.6 and 0.1.7. Left: the
hand check, converting the other trees, and step 6's cleanup.

**[overstoryd 015: explain automatic resolutions and clear reconciled choices](soon/merge-015-resolve-reconciled-choices.md).**
Joe encountered a whole-tree conflict after moving blocks into a new page. Later
accepted edits already produced the intended contents, but the conflict remained
and its cards showed only older alternatives. overstoryd should clear choices it can
prove reconciled, and Story should explain the current result and make explicit
resolution easy. Joe moved it to soon on 2026-10-28.

**[overstoryd 017: merge as blocks and elements, and the cases still open](soon/merge-017-blocks-and-elements.md).**
After the 2026-10-31 todos conflicts, Joe asked for one merge model instead of a growing list
of allowances. Markdown merges as blocks and JSON, YAML, TOML and CSV as elements since
2026-11-01 ([status](../status.md#merge-as-blocks-and-elements--2026-11-01)). Left: JSONL,
XML/HTML/CSS and code as elements, choices named by the blocks they cover, then the menu of
cases that still go to review, which was overstoryd 014 until Joe folded it in on 2026-11-01.

**[Names 001: your own domain names your profile](soon/names-001-your-own-domain-names-your-profile.md).**
Joe, 2026-11-05: a person points a domain they own at their profile, as Bluesky handles do (a
DNS TXT record or a `.well-known` file, checked against the profile's own front matter), so
`alice.com` names her wherever she is hosted and rules written with it survive a move.
Steps 1-4 (spec, resolver, overstoryd, `story me domain`) on main 2026-11-05
([status](../status.md#domain-locators-your-own-domain-names-your-profile--2026-11-05)); left:
showing and accepting domains in Story, and a hand check on one of Joe's domains.

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
overstoryd 007: who submitted each current line, and the agent when an update names one
("Joe · Claude"). With Performance 004's index it reads pieces instead of matching lines.

**[Postgres 001: collections backed by Postgres, and SQLite projections of them](later/postgres-001-postgres-backed-collections.md).**
Longer term. For now the point is that the design shows Postgres backings, SQLite projections
and moving a collection between representations are possible. Five plans until 2026-11-01,
when Joe had them rewritten as one against logical collections.

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
[overstoryd 017](soon/merge-017-blocks-and-elements.md) must support an emitted
operation form before a client that emits it is installed; [overstoryd 015](soon/merge-015-resolve-reconciled-choices.md)
clears choices later work has reconciled; [Editor 003 part 3](features/editor-003-suggestions.md#part-3-merge-notes)
gives every automatic outcome its explanation (merge notes), which 015's authority resolutions
and 017's "merge with a note" cases wait for. The numbers are identifiers, not an execution order. History and provenance support
explanation but do not improve merge decisions; [overstoryd 016](later/merge-016-choice-review-extensions.md)
extends the choice review; Web 025 owns rebuilding the web reviewer;
merge replay cost is Performance 004, including merge and replay cost for large collections
(its step 6). The [testing candidates](candidates.md#testing)
include editor alignment and round-trip characterization.

### History and revisions

[overstoryd 007](features/history-007-document-history-routes-and-restore.md) (history and
restore) comes before [overstoryd 006](later/history-006-line-provenance.md) (line
provenance), which builds on the history API and adds its own metadata and policy. 007 adds
the agent attribution on updates; 006 adds who submitted each update and shows both. Merge
explanations can link to this history; their provenance proofs and conflict rules stay with
merge work.

### Performance

Latency, transfer size and storage overhead: take a plan when its stated problem occurs, and
measure both the benefit and the cost to correctness, recovery and offline use.
[Performance 008](soon/performance-008-merge-cost-by-edit.md) and
[Native 006](when-needed/performance-006-sparse-ios-placement.md) are the plans; the
provenance index ([Performance 004](https://github.com/jxe/arbor/blob/4844b1c/plans/soon/performance-004-provenance-index.md), closed), the object journal and
object packing are live. Client
coalescing also reduces wire traffic but stays with merge work. [Performance candidates](candidates.md#speed)
collects measured leads that are not yet plans.
