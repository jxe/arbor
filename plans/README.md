# Plans

The folder a plan is in is its timing, and nothing else records it (Joe, 2026-11-07):
[`soon/`](soon) is what Joe wants next, features included; [`features/`](features) holds the
other plans for things you would notice in Story; [`later/`](later) and
[`when-needed/`](when-needed) hold the rest, the latter for plans that wait on a trigger ("when
merges bite", "when size hurts") rather than a date. Plans and their paragraphs here don't say
soon or later; they may say what they come after. A file
is named by its topic and number, such as `soon/release-003-app-store.md`. When a plan's timing
changes, move the file and its paragraph here.

Each plan starts with why Joe wants it and what it comes after; the same paragraph is below. Things only
Joe can do (hand checks on his devices, releases and publishing, go-aheads for live data,
soaks) are in [Joe's to-do](joe.md); undecided work is in
[candidates](candidates.md); proposed additions to the spec are
[spec extensions](spec-extensions/README.md), one file each. Current behavior is in
[status](../status.md). Plans carry no priorities.

## When work is done

A plan holds only work that is left, so it shrinks as it is built (Joe, 2026-11-06):

- **Remove finished steps** in the same commit that finishes them, or as soon as a session
  notices. Record what was built in [status](../status.md) (what, where, how it was checked),
  then delete the step, along with any background, decisions or "as built" notes that only
  served it. Don't strike steps through or mark them done in place.
- **Retitle the plan to what is left.** Rename the file (keep its topic and number), its
  heading, and its paragraph here, so the title names the remaining work, not the original
  goal.
- **Move Joe's items to [Joe's to-do](joe.md):** hand checks, tries on his Mac or iPhone,
  releases, publishing, and go-aheads for live data. A plan doesn't keep them, even as
  "left for Joe".
- **Delete the plan** once nothing else is left: after its evidence is in status and its
  Joe items are in the to-do file. Remove its paragraph here and fix links to it.
- **Small decided tasks** a session can do without Joe go in the plan they came from, or are
  done on the spot. There is no separate list for them.

## Features

What you would notice in Story, as opposed to protocol, host or data plumbing.

**[Schema language 007: edit rows in Story's collection view, and the structured editor](features/schema-language-007-editing-in-the-collection-view.md).**
Joe wants collections edited natively in Story, the People directory first. The write path is
done and in daily use: Story sends row operations through the host on every device, queued
while offline, and the host derives the result (spec 10 §2.2). Left: the queue's loose ends,
every view intent as row operations, simple edits in the view, then the structured editor
(groups, chips, bullets, drag, inline Markdown). The editing half of the split Joe made on
2026-10-28.

**[Agents 004: talk to the agent while it works](features/agents-004-talk-to-the-agent.md).**
After Agents 002's presence messages. The agent asks and Joe answers at its cursor from any
device, and the conversation vanishes like presence; the agent can also show work in progress,
and a task can carry blocks under it. Split from Agents 002 by Joe, 2026-11-07.

**[Agents 005: webhook runners, starting with a claude.ai scheduled task](features/agents-005-webhook-runners.md).**
After Agents 002. Run with the Mac asleep: Story POSTs the run request to a URL, such as a
claude.ai scheduled task's API trigger (still a beta), GitHub Actions or your own server.

**[Agents 006: Codex as a runner](features/agents-006-codex.md).**
After Agents 002. The same runner with `codex exec`; Codex's hooks are weaker, so Story Sync
falls back to the files it sees change.

**[Live 002: exact carets and selections](features/live-002-exact-carets.md).**
After Agents 001: a Quagmire release that reports and draws exact carets and
selections, for people and agents alike. The wire does not change.

**[Editor 003: suggestions, from people and agents](features/editor-003-suggestions.md).**
Joe wants two representations that mean different things: inline suggestions in the
page as CriticMarkup, and overlay trees that reference a parent tree like a Git branch. Forks
open.

**[People 001: form groups, share with people, and go to any tree](features/people-001-groups-sharing-and-go-to.md).**
Joe wants People to remember everyone and every tree he has come across, and to make forming
groups to share with easy: see whether a group exists, drag people into it, invite whoever is
missing. Phase 1, the directory tree kept by code, is done (2026-10-25,
[status](../status.md#people-directory-tree-picker-and-usl-summaries--2026-10-25)). Left:
forming groups with 007's editor, a person picker, and a Go to… field that finds visited trees and
pages by title, with `overstory://tr_…` links found by asking the directory, then the account
hosts (a side slice for any time). Its share sheet phase was dropped on 2026-11-01 for Sharing 003.

**[Schema language 009: change a collection's schema and keep its rows](features/schema-language-009-schema-changes-keep-the-data.md).**
Nothing carries rows across a schema change yet, so a seed bump empties the People
directory. USL meant migrations between relation forms to be small edits to one declaration.
From the ideas' open questions, 2026-10-28.

**[Filesystem 024: open plain folders on the Mac](features/filesystem-024-open-plain-folders-on-the-mac.md).**
Opening an ordinary folder in the Mac app, and making it into a tree from there, went away
with the daemon's editor path; after setup a new tree needs `story place`. Joe wants this
before the web editor. Mac only; the browser half is an open question in Web 025.

**[Sharing 001: join on an iPhone first, add a Mac later](features/sharing-001-join-on-iphone-first.md).**
An invitation link is usually tapped on a phone, where today it ends at an app that can only
pair with a Mac. Join from the iPhone with the same link, then add a Mac by scanning a code
the Mac shows. After Release 001. It owns what an invitation link does on the iPhone;
People 001 phase 4 owns the iPhone's other link opens.

**[Sharing 003: New Tree… on the iPhone](features/sharing-003-new-tree-on-the-iphone.md).**
Moving a page to another tree from the share sheet is built on the Mac and the iPhone
([status](../status.md#move-a-page-to-another-tree--2026-11-01)); the iPhone's tree menu still
lacks New Tree…, which needs an administrator device. Three open questions for Joe: one-off
shares, where the MAI tree lives, and Undo for a move.

**[Filesystem 027: the whole namespace on disk](features/filesystem-027-the-whole-namespace-on-disk.md).**
The AFS half of the global namespace: every tree you can read is a path under
`~/Overstory/<host>/…`, fetched when opened, through a File Provider extension on the Mac (and
the Files app on the iPhone). Builds on visitor sessions and read-only placements (2026-11-05).

**[Security 013: fine-grained read rules](features/security-013-row-read-rules.md).**
A model's read rules in access policy (`who: {property: owner}`, later value predicates),
applied by the host to every view, so a view or a `rows` answer never sees a row its reader
may not. Until then, views see whatever their caller can read in the tree (Joe, 2026-11-08).

**[Security 012: get back into an account with the admin's help](features/security-012-get-back-in-with-the-admins-help.md).**
A person who has lost every device gets back in through the host's administrator, as the
spec has it; Joe wants that to be as easy as possible for both. The administrator makes a
link from Story, or approves a request the person sends from the new Mac. Before people
depend on Story enough to lose a Mac.

**[Editor 001: snippets you type or say](features/editor-001-snippets.md).**
Joe asked on 2026-10-24 for TextMate-style snippets in place of template buttons: a page he
edits like any other, such as his standard day outline, that expands where he is when he
picks it from @ or says its name in a pinch recording. Template buttons go away. Forks open:
where a page is marked as a snippet, and exactly what the spoken trigger is.

**[Editor 002: dictate several items in one recording](features/editor-002-dictated-lists.md).**
Joe chose spoken breaks on 2026-10-24: "next item", "next item indented" and an outdent
phrase split one pinch recording into several bullets, so a day plan of time rows and tasks
can be dictated in one go. A recording without commands stays one paragraph.

## Soon

**[Protocol 001: retire the old routes the spec review replaced](soon/protocol-001-spec-review-route-changes.md).**
Joe's spec review changes routes and shapes on both ends. Left: the moves still marked "Not
yet", which ship with the Protocol 003 flag day, host and clients together, deleting every
old form.

**[Protocol 003: times in directory entries, one date encoding, history dropped](soon/protocol-003-times-in-directory-entries.md).** Entries carry `created`/`modified` stamped from the update's `at`; row dates tagged like page dates; a flag-day migration drops history (Joe, 2026-11-11).

**[Filesystem 026: page provenance, and dropping Markdown file entries](soon/filesystem-026-page-provenance-and-cleanup.md).**
Pages are logical nodes, written to disk by each placement: built, released in 0.1.6 and
converted on Joe's todos tree ([status](../status.md#pages-as-logical-nodes-built--2026-10-28)).
Left: provenance for page bodies, the front-matter merge cases it closes, and removing the
`.md` file-entry path once every tree is converted.

**[Apps 012: Story asks for declared views like any view](soon/apps-012-one-kind-of-view.md).**
overstoryd serves a schema's `~views` entries as declared views through the same route as
authored ones. Left: Story Sync answers them locally on a placed tree, and Story draws both
kinds the same way.

**[Release 003: the iPhone app on the App Store](soon/release-003-app-store.md).** So Story can be found without a TestFlight invitation. A sketch of what review requires: account deletion, report
and block, and policy pages. The sample pages are the reviewer's way in.

**[Apps 015: Beetle views and mutations](soon/apps-015-the-view-language.md).** Joe, 2026-11-11:
views and mutations are written in Beetle (`.beetle` files), and TypeScript
support for both goes. Parser and checker (built), evaluators on the host and in Story, Supplies
ported, the TypeScript path removed.

**[Apps 011: widgets in Story](soon/apps-011-widgets-in-story.md).**
After Apps 015. Small apps embedded in pages by a link to a `.view` file, drawn natively in
SwiftUI (no web view, no React), with state owned by the app, the page or the reader.
Absorbs Apps 001 and 003; an HTML renderer comes later.

## Later

**[Schema language 010: row ownership](later/schema-language-010-row-ownership.md).**
Rows only their authors edit, as access policy (`who: {property: authors}`, one
`unless`/`when` predicate), with device updates authorized by effect. Formerly 002's
milestone 5.

**[Apps 014: USL plugins](later/apps-014-usl-plugins.md).** A sketch: real code extends
the data (value types, two-way relations, derived fields and models, live sources) instead
of UVL. After Apps 015.

**[Apps 010: activation and lending](later/apps-010-activation-and-lending.md).**
After Apps 005: code runs as an activated app under an execution token with lenders, not as
its caller; revocation; first-run consent in Story writes `apps.yaml`. Decide first what code
gets without asking.

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

**[Performance 007: keep collections in SQLite on the host](later/performance-007-sqlite-collection-storage.md).**
Joe, 2026-10-28: overstoryd should work with a collection's SQLite file instead of keeping
the equivalent table objects, producing canonical objects on demand. The history model
for SQLite collections (less, none, or kept another way) comes first. After Apps 005.

**[Apps 002: hosted agents](later/apps-002-overstoryd-hosted-agents.md).** After Apps 011:
authored agents hosted beside an app, calling its own query and mutation handles. No timing
yet.

**[Apps 009: code on one host using access held on another](later/apps-009-cross-host-delegation.md).**
After Apps 008, once apps span hosts. A design sketch; no timing yet.

**[Web 025: Story for the web](later/story-web-025-story-web.md)**, with its
[surface inventory](later/story-web-surfaces.md). For sharing with others: people without the Mac
or iPhone app need a way to read and edit a tree.

**[Security 004: access links without leaking secrets](later/security-004-access-link-secrets.md).**
When Joe shares by link, alongside Web 025: an access link must not leak its secret into
URLs, history or logs. Nothing is in production yet, so until then the spec carries the
requirement.

**[overstoryd 016: richer choice review](later/merge-016-choice-review-extensions.md).**
Things a real choice review may need: safe binary previews, long sources, visible whitespace,
a freshness policy so unrelated updates don't force a renewed review, explanations of moves
and deletions, combination previews, and bulk and offline resolution. Joe made the ideas item
a plan on 2026-10-28; take each when a real review needs it.

**[overstoryd 007: page history](later/history-007-page-history.md).**
`story changes <page> --day yesterday` lists what was added to and deleted from a page; then
History with Restore, agent runs in History with Undo Run, and blame naming who submitted each
line and the agent ("Joe · Claude"). All of it reads Performance 004's provenance index rather
than stored versions. Merged from overstoryd 006 and 007 on 2026-11-07.

**[Postgres 001: collections backed by Postgres, and SQLite projections of them](later/postgres-001-postgres-backed-collections.md).**
Longer term. For now the point is that the design shows Postgres backings, SQLite projections
and moving a collection between representations are possible. Five plans until 2026-11-01,
when Joe had them rewritten as one against logical collections.

## When needed

**[Clients 002: coalesce moves with edits, selections, copies and undo](when-needed/merge-002-coalesce-moves-with-edits-copies-and-undo.md).**
When edit bursts are still large: real journals or network logs show requests well over a few
KB from moves with edits, selections, copies or undo. Typing bursts and runs of moves already
compose (2026-11-07); left are those cases, each in the Swift and TypeScript clients with shared
examples and host merge evidence.

**[Native 008: copies with changes and compound undo](when-needed/merge-008-copies-with-changes-and-compound-undo.md).**
When merges bite: a real concurrent edit reviews or loses a copy, paste or undo that should
have merged. Needs a new Quagmire release.

**[Native 006: sparse iOS placement](when-needed/performance-006-sparse-ios-placement.md).** When size hurts:
a tree too big to place on the iPhone in one download.

**[Security 010: signed profile statements](when-needed/security-010-signed-profile-statements.md).**
When a host Joe does not control is involved, or a home host must be left behind.

**[overstoryd 015: explain automatic resolutions and clear reconciled choices](when-needed/merge-015-resolve-reconciled-choices.md).**
When a conflict that later work already reconciled shows up again. Joe encountered a whole-tree conflict after moving blocks into a new page. Later
accepted edits already produced the intended contents, but the conflict remained
and its cards showed only older alternatives. overstoryd should clear choices it can
prove reconciled, and Story should explain the current result and make explicit
resolution easy.

**[overstoryd 017: more formats as elements, choices named by block, and the cases still open](when-needed/merge-017-more-formats-and-open-cases.md).**
When a real edit in one of these formats, or one of the open cases, goes to review. After the 2026-10-31 todos conflicts, Joe asked for one merge model instead of a growing list
of allowances. Markdown merges as blocks and JSON, YAML, TOML and CSV as elements since
2026-11-01 ([status](../status.md#merge-as-blocks-and-elements--2026-11-01)). Left: JSONL,
XML/HTML/CSS and code as elements, choices named by the blocks they cover, then the menu of
cases that still go to review, which was overstoryd 014 until Joe folded it in on 2026-11-01.

**[Performance 008: merge cost by edit, not by size](when-needed/performance-008-merge-cost-by-edit.md).**
When merges of large collections get slow. What Performance 004 (merges start from a provenance index; closed 2026-11-02) left: a
canonical contribution order inside choices, and collection merges and replay that decode
only the chunks an edit touches instead of whole tables.

## Groups

Some plans cover different stages of the same work. They stay separate files because their
proofs and release boundaries differ, and they share examples rather than duplicate tasks.

### Merge improvements

Editor intent, client publication, host merging and conflict review. [Native 008](when-needed/merge-008-copies-with-changes-and-compound-undo.md)
supplies truthful command evidence; [Clients 002](when-needed/merge-002-coalesce-moves-with-edits-copies-and-undo.md)
can simplify that evidence after it exists, and must not invent missing copy or move identity;
[overstoryd 017](when-needed/merge-017-more-formats-and-open-cases.md) must support an emitted
operation form before a client that emits it is installed; [overstoryd 015](when-needed/merge-015-resolve-reconciled-choices.md)
clears choices later work has reconciled; [Editor 003 part 3](features/editor-003-suggestions.md#part-3-merge-notes)
gives every automatic outcome its explanation (merge notes), which 015's authority resolutions
and 017's "merge with a note" cases wait for. The numbers are identifiers, not an execution order. History and provenance support
explanation but do not improve merge decisions; [overstoryd 016](later/merge-016-choice-review-extensions.md)
extends the choice review; Web 025 owns rebuilding the web reviewer;
merge replay cost is Performance 004, including merge and replay cost for large collections
(its step 6). The [testing candidates](candidates.md#testing)
include editor alignment and round-trip characterization.

### History and revisions

[overstoryd 007](later/history-007-page-history.md) holds page changes, History and restore,
agent runs, and line provenance, all read from the provenance index. Merge explanations can
link to this history; their provenance proofs and conflict rules stay with merge work.

### Performance

Latency, transfer size and storage overhead: take a plan when its stated problem occurs, and
measure both the benefit and the cost to correctness, recovery and offline use.
[Performance 008](when-needed/performance-008-merge-cost-by-edit.md) and
[Native 006](when-needed/performance-006-sparse-ios-placement.md) are the plans; the
provenance index ([Performance 004](https://github.com/jxe/arbor/blob/4844b1c/plans/soon/performance-004-provenance-index.md), closed), the object journal and
object packing are live. Client
coalescing also reduces wire traffic but stays with merge work. [Performance candidates](candidates.md#speed)
collects measured leads that are not yet plans.
