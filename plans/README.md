# Overstory plans

Start with [Soon](#soon). Beyond it, choose an outcome below: the order is a menu, not an execution sequence.
For current behavior use [status.md](../status.md); for every retained plan and smaller candidate use the
[detailed catalog](catalog.md). Historical identifiers are recorded inside moved plans; new numbers avoid collisions in their destination directory.

## Soon

Plans chosen for near-term work are in [`soon/`](soon/). Each keeps its owner's identifier
(canopyd 005 is still canopyd 005) and its entry in the [catalog](catalog.md), marked **SOON**.

| Plan | What it does |
|---|---|
| canopyd [005](soon/005-tree-configuration-trees.md) | Per-tree configuration, co-administration, profile configuration in place of the account configuration, and lending |

## Remaining outcomes

| Outcome | What remains | Start here |
|---|---|---|
| Extend Native editing | Copies with changes, paste and inline provenance, and compound undo; capture, block moves, Move to Document, sync and accepted-choice review are implemented | Native [008](swift/008-copies-with-changes-and-compound-undo.md); server transfer policy in canopyd [014](canopyd/014-merge-handles-many-cases.md) |
| Make the merge handle many more cases | Lose nothing, keep the syntax, approach the meaning; merge or merge with a note far more often than asking for review: anchors that agree in both orders, cross-document links, new keys and arrays in JSON/YAML, code moves and imports, and formats such as BibTeX and notebooks | canopyd [014](canopyd/014-merge-handles-many-cases.md) |
| Show declined folders in the Mac app | List placed folders with declined paths and offer restore and resend | Native [012](swift/012-show-declined-folders.md) |
| Bring back Canopy for the web | One browser bundle served by Arbor Sync (`arbor open`) and by canopyd, running the same working tree and update machine as the Mac app, with the native surfaces ported | Web [025](canopy-web/025-arbor-web.md) and its [surface inventory](canopy-web/surfaces.md) |
| Make Overstory applications executable | Headless sidecar with resource policy → durable authoring/compiler → Supplies across local, native and canopyd; hosted agents follow. Declarative collection schemas are implemented; their Swift edits await the [Mac gates](release-and-soak.md#collection-schema-mac-gates) | Apps [005](apps/005-source-resolution-and-sidecar.md), [006](apps/006-durable-authoring.md), [003](apps/003-development-compiler-and-editor-tooling.md), [001](apps/001-supplies-executable-site.md) |
| Make sharing easier | Safe access links and coherent group management; name-based sharing, the directory, and avatar profiles are implemented. Adopted: per-tree configuration with co-administrators and group-owned trees; proposed: trees on several hosts, device keys, portable profiles | Security [004](security/004-access-link-secrets.md), canopyd [005](soon/005-tree-configuration-trees.md), Security [006](security/006-home-host-vouching.md), [007](security/007-device-keys.md), [008](security/008-portable-profiles.md), [product design](catalog.md#product-completion) |
| Browse document history and authorship | Show accepted document versions, restore an earlier version as a new edit, and explain who contributed current lines | canopyd [007](canopyd/007-document-history-routes-and-restore.md) and [006](canopyd/006-line-provenance.md) |
| Bound storage and improve slow paths | Run the object collector live, bound document-version history, then measure before packing; sparse iOS placement and targeted performance work | canopyd [017](canopyd/017-collect-objects-live.md), [001](canopyd/001-pack-object-storage.md), Native [006](swift/006-sparse-ios-placement.md), [performance candidates](catalog.md#hardening-efficiency-polish-etc) |
| Strengthen safety and delivery | URL/response/secret boundaries; close compatibility windows only when their explicit conditions hold | [Security](catalog.md#security-boundaries), [compatibility cutoffs](catalog.md#compatibility-cutoffs) |

## Release and verify what is already built

Source publication is installed, the merge authority is deployed, and substantial Native
move/copy/undo capture plus accepted-choice review are implemented. Their remaining release
and hands-on checks are separate from the extensions above; see [current status](../status.md).

[Release and verification](release-and-soak.md) collects the outstanding installation,
deployment, manual acceptance and soak checks. It separates those checks from new feature work.
Verification checklists do not authorize deployment.

## Parked and conditional work

The [catalog](catalog.md) retains Postgres, external-agent CLI access, representation work,
non-tree disk editing, collection projection and smaller polish candidates. They are available to
select, not an implied commitment to execute them all.

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
| `filesystem/` | Disk editors |
| `canopyd/` | Merge policy, storage, accepted document history, provenance and hosted-tree configuration |
| `cli/` | Structured access for external agents |
| `apps/` | Executable documents, runtime authority and hosted agents |
| `postgres/` | Providers, projections and representation equivalence |
| `security/` | Input, rendering, authorization and sharing boundaries |

The [catalog](catalog.md) follows this layout. Completed plans are deleted; git history keeps
them, and each active plan records any identifier it inherited.

## Planning rules

- A plan moves into `soon/` when chosen and keeps its identifier. A new plan's number must not
  collide with a plan of the same owner in `soon/` (Filesystem 005 lives there, so the next
  Filesystem plan is not 005).
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
