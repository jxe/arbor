# Overstory plans

Choose an outcome below. **Priorities are open**: the order is a menu, not an execution sequence.
For current behavior use [status.md](../status.md); for every retained plan and smaller candidate use the
[detailed catalog](catalog.md). Historical identifiers are recorded inside moved plans; new numbers avoid collisions in their destination directory.

## Remaining outcomes

| Outcome | What remains | Start here |
|---|---|---|
| Unify Mac account management | Share account and placement paths with iOS, remove unused daemon routes, and fold the daemon clients into the CLI and Mac app | Native [011](swift/011-unify-mac-accounts-and-fold-daemon-clients.md) |
| Extend Native editing and conflict review | Additional move/copy/undo cases, richer review previews and precise inline markers; the core capture, sync and review paths are already implemented | Native [008](swift/008-complete-native-move-copy-undo-capture.md) and [010](swift/010-client-conflict-review.md); server transfer policy in canopyd [014](canopyd/014-merge-moved-text.md) |
| Show held folders in the Mac app | List placed folders whose changes the host refused and offer Discard Refused Changes | Native [012](swift/012-show-held-folders.md) |
| Bring back Canopy for the web | One browser bundle served by Arbor Sync (`arbor open`) and by canopyd, running the same working tree and update machine as the Mac app, with the native surfaces ported | Web [025](canopy-web/025-arbor-web.md) and its [surface inventory](canopy-web/surfaces.md) |
| Make Overstory applications executable | CDDL collection schemas → headless sidecar with resource policy → durable authoring/compiler → Supplies across local, native and canopyd; hosted agents follow | Apps [007](apps/007-cddl-collection-schemas.md), [004](apps/004-mutation-permissions.md), [005](apps/005-source-resolution-and-sidecar.md), [006](apps/006-durable-authoring.md), [003](apps/003-development-compiler-and-editor-tooling.md), [001](apps/001-supplies-executable-site.md) |
| Make sharing easier | Safe access links and coherent group management; name-based sharing, the directory, and avatar profiles are implemented. Proposed, undecided: per-tree configuration with co-administrators and group-owned trees | Security [004](security/004-access-link-secrets.md), [005](security/005-tree-configuration-trees.md), [product design](catalog.md#product-completion) |
| Browse document history and authorship | Show accepted document versions, restore an earlier version as a new edit, and explain who contributed current lines | canopyd [007](canopyd/007-document-history-routes-and-restore.md) and [006](canopyd/006-line-provenance.md) |
| Make merge rules replaceable | Deployed 2026-09-24: replay on a production copy, then a per-file sidecar cache and 1,000-file latency | canopyd [016](canopyd/016-sidecar-on-objects-and-history.md) |
| Bound storage and improve slow paths | Run the object collector live, bound document-version history, then measure before packing; progressive placement and targeted performance work | canopyd [017](canopyd/017-collect-objects-live.md), [001](canopyd/001-pack-object-storage.md), Native [006](swift/006-progressive-replica-bootstrap.md), [performance candidates](catalog.md#hardening-efficiency-polish-etc) |
| Strengthen safety and delivery | Ignore policy, URL/response/secret boundaries, CI; close compatibility windows only when their explicit conditions hold | [Security](catalog.md#security-boundaries), [CI](catalog.md#testing-and-ci) and [ignore policy](filesystem/005-ignore-policy.md), [cleanups](catalog.md#compatibility-cutoffs) |

## Release and verify what is already built

Source publication is installed, the merge authority is deployed, and substantial Native
move/copy/undo capture plus accepted-choice review are implemented. Their remaining release
and hands-on checks are separate from the extensions above; see [current status](../status.md).

[Release and verification](verification/release-and-soak.md) collects the outstanding installation,
deployment, manual acceptance and soak checks. It separates those checks from new feature work.
[Client compatibility](verification/011-client-compatibility.md) is a separate evidence checklist.
[Filesystem 011](filesystem/011-independent-writes-after-rejection.md) owns the implementation
change for independent writes after rejection. Verification checklists do not authorize deployment.

## Parked and conditional work

The [catalog](catalog.md) retains Postgres, external-agent CLI access, representation and locator work,
non-tree disk editing, collection projection and smaller polish candidates. They are available to
select, not an implied commitment to execute them all. Journal hardening and parallel-test isolation
remain deferred. Fragment storage needs reassessment against the implemented merge authority;
it is not a prerequisite for the existing review UI.

Account/device recovery is a separate product-design question in the catalog. Editor crash
recovery already has an implementation; neither is what the document-history row means.
Name-based sharing and avatars need product design before an executor plan. Other unresolved
contracts remain in [open questions](open-questions.md).

## Directory map

| Directory | Owns |
|---|---|
| `swift/` | Placement, offline collections, editor command capture and conflict review |
| `canopy-web/` | The browser client: working-tree rebuild, hosts, and the native surfaces ported |
| `filesystem/` | Write journals, rejection scheduling, ignore policy and disk editors |
| `canopyd/` | Merge policy, storage, accepted document history and provenance |
| `cli/` | Structured access for external agents |
| `apps/` | Executable documents, runtime authority and hosted agents |
| `postgres/` | Providers, projections and representation equivalence |
| `security/` | Input, rendering, authorization and sharing boundaries |
| `testing/` | Implement CI and test isolation |
| `verification/` | Compatibility evidence, manual acceptance and release/soak checks |
| `cleanups/` | Compatibility cutoffs, locator simplification, and identifier renames |

The [catalog](catalog.md) follows this layout. Completed plans are deleted; git history keeps
them, and each active plan records any identifier it inherited.

## Planning rules

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
