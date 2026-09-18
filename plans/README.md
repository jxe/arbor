# Arbor plans

Choose an outcome below. **Priorities are open**: the order is a menu, not an execution sequence.
For current behavior use [status.md](../status.md); for every retained plan and smaller candidate use the
[detailed catalog](catalog.md). Historical identifiers are recorded inside moved plans; new numbers avoid collisions in their destination directory.

## Remaining outcomes

| Outcome | What remains | Start here |
|---|---|---|
| Extend Native editing and conflict review | Additional move/copy/undo cases, richer review previews and precise inline markers; the core capture, sync and review paths are already implemented | Native [008](native/008-complete-native-move-copy-undo-capture.md) and [010](native/010-client-conflict-review.md); server-policy refinements in Canopy [009](canopy/009-canopy-provenance-merges.md) |
| Bring back Arbor web | Build the independent browser working-tree client, then restore interface parity and editor features | Web [023](web/023-rebuild-the-web-editor-on-the-working-tree.md); [web follow-ons](catalog.md#web-client) |
| Make Arbor applications executable | Resource policy → source resolution/sidecar → durable authoring/compiler → Supplies across local, native and Canopy; hosted agents follow | Apps [004](apps/004-mutation-permissions.md), [005](apps/005-source-resolution-and-sidecar.md), [006](apps/006-durable-authoring.md), [003](apps/003-development-compiler-and-editor-tooling.md), [001](apps/001-supplies-executable-site.md) |
| Make sharing easier | Safe access links; design name-based sharing, avatars and coherent group management | Security [004](security/004-access-link-secrets.md), [product design](catalog.md#product-completion) |
| Browse document history and authorship | Show accepted document versions, restore an earlier version as a new edit, and explain who contributed current lines | Canopy [007](canopy/007-canopy-document-history.md) and [006](canopy/006-line-provenance.md) |
| Bound storage and improve slow paths | Measure retained storage and worker costs before packing; progressive placement and targeted performance work | Canopy [001](canopy/001-pack-object-storage.md), Native [006](native/006-progressive-replica-bootstrap.md), [performance candidates](catalog.md#hardening-efficiency-polish-etc) |
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
| `native/` | Placement, offline collections, editor command capture and conflict review |
| `web/` | Browser working-tree rebuild, editor and interface parity |
| `filesystem/` | Write journals, rejection scheduling, ignore policy and disk editors |
| `canopy/` | Merge policy, storage, accepted document history and provenance |
| `cli/` | Structured access for external agents |
| `apps/` | Executable documents, runtime authority and hosted agents |
| `postgres/` | Providers, projections and representation equivalence |
| `security/` | Input, rendering, authorization and sharing boundaries |
| `testing/` | Implement CI and test isolation |
| `verification/` | Compatibility evidence, manual acceptance and release/soak checks |
| `cleanups/` | Compatibility cutoffs and locator simplification |

The [catalog](catalog.md) follows this layout. Historical records under `_done/` keep their
original taxonomy; each moved active plan records its old identifier.

## Planning rules

- Keep one owner for each remaining task. Link to it from dependencies instead of copying its checklist.
- Active plans describe remaining work. Move implemented or superseded executor documents to
  [_done/](_done/README.md), preserving IDs and evidence; transfer unfinished gates explicitly.
- **Implemented**, **installed/deployed**, and **manually verified** are separate claims.
- **Needs design**, **deferred**, and **waiting** are not ready-to-execute instructions. Old P1/P2
  labels are workstream assessments, not the current global priority order.
- Check source, tests and `git status` before implementation. Preserve portable contracts and
  historical verification records; do not revive removed architecture from an old checklist.

<!-- Preserve inbound links from older documentation while directing readers to the catalog. -->
<a id="source-intent-milestones"></a>
<a id="what-to-do-soon"></a>
<a id="highly-important"></a>
<a id="arbor-sync"></a>
<a id="cleanups"></a>
<a id="product-completion"></a>
<a id="later-portable-deployment"></a>
<a id="hardening-efficiency-polish-etc"></a>
<a id="open-questions-and-completed-work"></a>

The former long sections are in the [detailed catalog](catalog.md). Completed implementation and
superseded designs remain in [history](_done/README.md).
