# Arbord clients
*Part of the [Arbor spec](../spec.md): invariants shared by human and programmatic clients.*

This specification does not prescribe a user interface. Arbor web and native Arbor are reference human clients; a conforming client may use different controls, layout, editor, and platform conventions.

## Persistence authority

A local client treats arbord as the authority for resolution, authored persistence, recovery, and observation. Steady-state placement, access, administrator, canonical-boundary, profile/community, and device-revocation actions are source-preserving guarded edits to the normative account YAML through arbord's ordinary `writeText` mutation; they are not special API mutations. It does not write materialized shared-tree files behind arbord's back and then rely on filesystem observation to reconstruct authored intent. Direct human edits to the account YAML and other files remain supported as external changes.

The client may keep ephemeral presentation state and explicitly documented user preferences. It must not create an independent canonical content, placement, credential, or access database.

## Resolution and provenance

The client accepts the locator forms in [locators.md](locators.md) and retains the resolved `tree`, decoded logical path, optional `PageID`, historical root, endpoint/canonical provenance, and access for as long as an action may refer to the result. It derives writability from effective access and historical state rather than trusting a duplicated resolution flag.

Directory children, search results, backlinks, Trash/recovery rows, visited trees, and mounted boundaries retain explicit tree scope. The client never reconstructs a `NodeRef` from a visible path alone when a resolved reference is available. Historical roots are read-only.

A remote visit does not invent local identity, a placement, or a temporary directory. If the same Arbor tree has a local placement, arbord may resolve the visit to it without changing the tree/path identity.

A browsing client preserves the initiating locator separately from the resolved `NodeRef`. On macOS, an absolute filesystem location remains the tab, history, breadcrumb, Parent, and sidebar address even when arbord resolves it into an enclosing tree and returns a stable `TreeID`/`PageID`; document sessions, mutations, search, and backlinks use that resolved identity. A remote canonical locator likewise remains a read-only navigation address with an explicit tree-root locator. Resolution must not silently replace either address with a tree-relative path. iOS may use only tree-scoped locations because its private replica is deliberately confined to one placement.

Home is derived from the currently resolved node, not from the launch location: it is the enclosing placed-tree root for a local filesystem address, `/` for a tree-scoped address, and the canonical tree root for a remote visit. It is unavailable in ordinary untracked filesystem space. Parent follows the preserved location, so a local client may cross tree boundaries and continue to filesystem `/`; crossing a boundary changes resolved identity and capabilities, not the visible route.

## Source-preserving Markdown

`MarkdownDocument.source` is the authoritative operational Markdown, including frontmatter. Parsed frontmatter and blocks are read conveniences derived by the provider; clients never submit them as authored truth. A structured editor may change only the source constructs represented by an authored edit; unrelated frontmatter order, whitespace, syntax, and unsupported Markdown remain intact or enter a clear raw-source mode.

Arbord returns directory documents already complete under [format.md](format.md#complete-directory-documents). A client edits and submits that source with `baseContentRevision`; it does not construct a second projection. Child-link reorder is a content write. Physical create/move/rename/copy/Trash remains structural, and ordinary link deletion never implies a structural mutation. The confirming node response becomes the next source/revision base because a provider may have appended newly required child links.

An untouched operational document must be returned byte-for-byte. In a block editor, an unchanged document envelope, raw block, or structured block remains exact; an edited or new block may be canonically regenerated in isolation. Reordering an unchanged block at a compatible nesting depth reuses its exact source. Token-level preservation inside an edited block is not required.

A source-preserving editor may represent one admission as ordered, range-guarded UTF-8 replacements against `baseContentRevision`. That is a local exact-source operation: the provider applies it to the complete operational source and confirms the resulting source/revision. It does not make text patches a second synchronization or merge authority. After the local receipt is durable, the provider may map that just-confirmed admission to immutable base/result file-object hashes and immediately freeze an authority attempt using the verified transport extension in [wire.md](wire.md#verified-file-patch-transport-extension). This is eligible only when the patch base is reachable from the retained accepted root and no earlier sync attempt is unresolved. Offline/delayed sync, local pending work, provider-adjusted source, external edits, or unsuitable patches fall back to the ordinary complete changed file object; clients do not retain and compose editor-patch lineages merely to recover the optimization later.

## Mutation retry and resynchronization

For an ambiguous transport failure, a client may retry only the exact serialized request or multipart body with the same mutation ID. It never converts the ambiguity into a new mutation ID. It never automatically retries a declared conflict as new authored intent; it refreshes and asks the caller to merge or replan.

The client begins observing from a read response's `observedThrough` cursor early enough that additional page loads cannot create a gap. When arbord returns `resync-required`, it refetches visible authoritative state and resumes from the returned cursor. Events invalidate state; they do not replace a snapshot without a confirming read.

For authority synchronization, the client durably records the exact accepted base update, candidate root, and immutable objects before `POST .../updates`. It retries only that semantic intent after an ambiguous outcome; the authority derives its identity from canonical JSON, so there is no caller-supplied idempotency key. A native/offline client may request the transport-only complete returned snapshot, avoiding graph-fetch races without changing semantic request identity. An accepted or merged update becomes the new base only after its graph has been rehashed, validated, and applied locally. A conflict has no authority-side record: the response contains the current accepted update, the client's base/candidate identities, structured reasons, and a complete draft snapshot; when requested it also carries the complete current accepted snapshot. The client durably stores that response, permits further local work, and later submits an explicit new candidate against the returned current update.

Initial placement and a watch-invalidated replica with no local changes use the
authority's coherent current-snapshot read. They do not manufacture a
candidate-equals-base update submission merely to pull current state. The
accepted-update ID returned by either a current snapshot or a successful update
is stored as both the accepted base identity and the next watch cursor.

The client verifies that every successful update response repeats its locally
derived semantic request digest. A continuously open watch may receive that
same digest on the accepted ref event only when authenticated as the exact
submitting bearer-credential subject. A match correlates the event with the
durable attempt without reconnecting the stream: after an already-applied
response it is redundant, while after an ambiguous response it prompts an
idempotent replay of the exact request. `Last-Event-ID` remains solely the
durable reconnect/resume cursor.

Unknown error codes and descriptive response fields do not crash the client. Missing required fields and malformed values do not silently become empty or local state.

## Secrets and access

Account/device credentials and access-link secrets are supplied through the appropriate header or secret channel, never embedded in ordinary loopback or canonical request URLs. A raw access-link secret must not enter navigation history, visit records, authored content, logs, diagnostics, receipts, or client caches. UI display of a newly created secret is explicit and one-time where the authority cannot reproduce it.

Configuration uses access rules keyed by semantic subject. Safe authority listings use stable access-entry IDs but hide link digests; a configuration editor reads the user's own `trees.yaml` to transform a link rule. The client distinguishes effective access from explicit rules and represents public access only as the `everyone` rule.

The client displays all active device files and their placements account-wide. It enables edits only for the current device file and, when authorized, `account.yaml` and `trees.yaml`; revoking another device is deletion of its file. Removing a placement never implies deleting its files or remote tree.

## Human-client baseline

A conforming human client makes provenance, read-only/historical state, conflicts, diagnostics, pending durable mutations, and stale/offline content understandable. It provides a way to inspect the exact accepted operational source. Exact controls, wording, panes, sheets, gestures, editor libraries, and responsive layout are outside the specification.
