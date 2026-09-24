# Overstory plans

Start with [Soon](#soon). Beyond it, choose an outcome below: the order is a menu, not an execution sequence.
For current behavior use [status.md](../status.md); for every retained plan and smaller candidate use the
[detailed catalog](catalog.md). Historical identifiers are recorded inside moved plans; new numbers avoid collisions in their destination directory.

## Soon

Plans chosen for near-term work are in [`soon/`](soon/). Each keeps its owner's identifier
(Native 008 is still Native 008) and its entry in the [catalog](catalog.md), marked **SOON**.

| Plan | What it does |
|---|---|
| Filesystem [005](soon/005-ignore-policy.md) | `.arborignore` and `.gitignore` for placed folders |
| Cleanup [006](soon/006-overstory-identifiers.md) | Rename `Wire*`/`Canopy*` identifiers and UI copy to the Overstory vocabulary |
| Apps [007](soon/007-cddl-collection-schemas.md) | Swift verification and the authorized cutover of the implemented CDDL collection schemas |
| Native [008](soon/008-complete-native-move-copy-undo-capture.md) | Remaining move, copy and compound-undo capture |
| Native [011](soon/011-unify-mac-accounts-and-fold-daemon-clients.md) | Decide who owns a Mac's identity and account credentials (data home or app); the client folds and unused daemon routes are done |
| canopyd [014](soon/014-merge-moved-text.md) | Merge the moved-text forms still held for review (Swift/Python declarations, cross-file structured moves, cross-document references) |
| canopyd [018](soon/018-profile-facts-per-tree.md) | Profile facts stored once per tree (migration 020) |

## Remaining outcomes

| Outcome | What remains | Start here |
|---|---|---|
| Unify Mac account management | Decide who owns a Mac's identity and account credentials (the data home or the app); the client folds and unused daemon routes are done | Native [011](soon/011-unify-mac-accounts-and-fold-daemon-clients.md) |
| Extend Native editing and conflict review | Additional move/copy/undo cases and accepted choices shown in their editor context; the core capture, sync and review paths are already implemented | Native [008](soon/008-complete-native-move-copy-undo-capture.md) and [010](swift/010-inline-choice-context.md); server transfer policy in canopyd [014](soon/014-merge-moved-text.md) |
| Show held folders in the Mac app | List placed folders whose changes the host refused and offer Discard Refused Changes | Native [012](swift/012-show-held-folders.md) |
| Bring back Canopy for the web | One browser bundle served by Arbor Sync (`arbor open`) and by canopyd, running the same working tree and update machine as the Mac app, with the native surfaces ported | Web [025](canopy-web/025-arbor-web.md) and its [surface inventory](canopy-web/surfaces.md) |
| Make Overstory applications executable | CDDL collection schemas (implemented; Swift verification and cutover remain) → headless sidecar with resource policy → durable authoring/compiler → Supplies across local, native and canopyd; hosted agents follow | Apps [007](soon/007-cddl-collection-schemas.md), [005](apps/005-source-resolution-and-sidecar.md), [006](apps/006-durable-authoring.md), [003](apps/003-development-compiler-and-editor-tooling.md), [001](apps/001-supplies-executable-site.md) |
| Make sharing easier | Safe access links and coherent group management; name-based sharing, the directory, and avatar profiles are implemented. Proposed, undecided: per-tree configuration with co-administrators and group-owned trees | Security [004](security/004-access-link-secrets.md), canopyd [005](canopyd/005-tree-configuration-trees.md), [product design](catalog.md#product-completion) |
| Browse document history and authorship | Show accepted document versions, restore an earlier version as a new edit, and explain who contributed current lines | canopyd [007](canopyd/007-document-history-routes-and-restore.md) and [006](canopyd/006-line-provenance.md) |
| Bound storage and improve slow paths | Run the object collector live, bound document-version history, then measure before packing; sparse iOS placement and targeted performance work | canopyd [017](canopyd/017-collect-objects-live.md), [001](canopyd/001-pack-object-storage.md), Native [006](swift/006-sparse-ios-placement.md), [performance candidates](catalog.md#hardening-efficiency-polish-etc) |
| Strengthen safety and delivery | Ignore policy, link healing for folder moves, URL/response/secret boundaries, CI; close compatibility windows only when their explicit conditions hold | [Security](catalog.md#security-boundaries), [CI](catalog.md#testing-and-ci), [ignore policy](soon/005-ignore-policy.md), [folder link healing](filesystem/025-folder-link-healing.md), [cleanups](catalog.md#compatibility-cutoffs) |

## Release and verify what is already built

Source publication is installed, the merge authority is deployed, and substantial Native
move/copy/undo capture plus accepted-choice review are implemented. Their remaining release
and hands-on checks are separate from the extensions above; see [current status](../status.md).

[Release and verification](verification/release-and-soak.md) collects the outstanding installation,
deployment, manual acceptance and soak checks. It separates those checks from new feature work.
[Filesystem 011](filesystem/011-independent-writes-after-rejection.md) owns the implementation
change for independent writes after rejection. Verification checklists do not authorize deployment.

## Parked and conditional work

The [catalog](catalog.md) retains Postgres, external-agent CLI access, representation and locator work,
non-tree disk editing, collection projection and smaller polish candidates. They are available to
select, not an implied commitment to execute them all. Parallel-test isolation
remains deferred.

Account/device recovery is a separate product-design question in the catalog. Editor crash
recovery already has an implementation; neither is what the document-history row means.
Name-based sharing and avatars need product design before an executor plan. Other unresolved
contracts remain in [open questions](open-questions.md).

## Directory map

| Directory | Owns |
|---|---|
| `soon/` | Plans chosen for near-term work, from any owner; each keeps its owner's identifier |
| `swift/` | Placement, offline collections, editor command capture and conflict review |
| `canopy-web/` | The browser client: working-tree rebuild, hosts, and the native surfaces ported |
| `filesystem/` | Rejection scheduling, ignore policy and disk editors |
| `canopyd/` | Merge policy, storage, accepted document history, provenance and hosted-tree configuration |
| `cli/` | Structured access for external agents |
| `apps/` | Executable documents, runtime authority and hosted agents |
| `postgres/` | Providers, projections and representation equivalence |
| `security/` | Input, rendering, authorization and sharing boundaries |
| `testing/` | Implement CI and test isolation |
| `verification/` | Manual acceptance and release/soak checks |
| `cleanups/` | Compatibility cutoffs, locator simplification, and identifier renames |

The [catalog](catalog.md) follows this layout. Completed plans are deleted; git history keeps
them, and each active plan records any identifier it inherited.

## Planning rules

- A plan moves into `soon/` when chosen and keeps its identifier. A new plan's number must not
  collide with a plan of the same owner in `soon/` (canopyd 014 lives there, so the next canopyd
  plan is not 014).
- Keep one owner for each remaining task. Link to it from dependencies instead of copying its checklist.
- Active plans describe remaining work. Delete implemented or superseded executor documents
  after recording their evidence in `status.md`; transfer unfinished gates explicitly.
- **Implemented**, **installed/deployed**, and **manually verified** are separate claims.
- **Needs design**, **deferred**, and **waiting** are not ready-to-execute instructions. Old P1/P2
  labels are workstream assessments, not the current global priority order.
- Check source, tests and `git status` before implementation. Preserve portable contracts and
  historical verification records; do not revive removed architecture from an old checklist.

The former long sections are in the [detailed catalog](catalog.md). Completed implementation and
superseded designs are deleted and remain in git history.
