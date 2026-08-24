# Arbord clients
*Part of the [Arbor spec](../spec.md): invariants shared by human and programmatic clients.*

This specification does not prescribe a user interface. Arbor web and native Arbor are reference human clients; a conforming client may use different controls, layout, editor, and platform conventions.

## Persistence authority

A local client treats arbord as the authority for resolution, authored persistence, placement changes, access changes, recovery, and observation. It does not write materialized shared-tree files behind arbord's back and then rely on filesystem observation to reconstruct authored intent. Direct external edits remain supported as external changes, not as a substitute for mutation receipts.

The client may keep ephemeral presentation state and explicitly documented user preferences. It must not create an independent canonical content, placement, credential, or access database.

## Resolution and provenance

The client accepts the locator forms in [locators.md](locators.md) and retains the resolved `tree`, decoded logical path, optional `PageID`, historical root, endpoint/canonical provenance, access, and writable state for as long as an action may refer to the result.

Directory children, search results, backlinks, Trash/recovery rows, visited trees, and mounted boundaries retain explicit tree scope. The client never reconstructs a `NodeRef` from a visible path alone when a resolved reference is available. Historical roots are read-only.

A remote visit does not invent local identity, a placement, or a temporary directory. If the same Arbor tree has a local placement, arbord may resolve the visit to it without changing the tree/path identity.

## Source-preserving Markdown

`MarkdownDocument.source` is the authoritative operational Markdown, including frontmatter. Parsed frontmatter and blocks are read conveniences derived by the provider; clients never submit them as authored truth. A structured editor may change only the source constructs represented by an authored edit; unrelated frontmatter order, whitespace, syntax, and unsupported Markdown remain intact or enter a clear raw-source mode.

Arbord returns directory documents already complete under [format.md](format.md#complete-directory-documents). A client edits and submits that source with `baseContentRevision`; it does not construct a second projection. Child-link reorder is a content write. Physical create/move/rename/copy/Trash remains structural, and ordinary link deletion never implies a structural mutation. The confirming node response becomes the next source/revision base because a provider may have appended newly required child links.

An untouched operational document must be returned byte-for-byte. In a block editor, an unchanged document envelope, raw block, or structured block remains exact; an edited or new block may be canonically regenerated in isolation. Reordering an unchanged block at a compatible nesting depth reuses its exact source. Token-level preservation inside an edited block is not required.

## Mutation retry and resynchronization

For an ambiguous transport failure, a client may retry only the exact serialized request or multipart body with the same mutation ID. It never converts the ambiguity into a new mutation ID. It never automatically retries a declared conflict as new authored intent; it refreshes and asks the caller to merge or replan.

The client begins observing from a read response's `observedThrough` cursor early enough that additional page loads cannot create a gap. When arbord returns `resync-required`, it refetches visible authoritative state and resumes from the returned cursor. Events invalidate state; they do not replace a snapshot without a confirming read.

For authority synchronization, the client durably records the exact accepted base update, candidate root, immutable objects, and idempotency key before `POST .../updates`. It retries only that exact semantic intent after an ambiguous outcome. An accepted or merged update becomes the new base only after its graph has been rehashed, validated, and applied locally. A conflict has no authority-side record: the response contains the current accepted update, the client's base/candidate identities, structured reasons, and a complete draft snapshot. The client durably stores that response, permits further local work, and later submits an explicit new candidate with a new key against the returned current update.

Unknown error codes and descriptive response fields do not crash the client. Missing required fields and malformed values do not silently become empty or local state.

## Secrets and access

Account/device credentials and access-link secrets are supplied through the appropriate header or secret channel, never embedded in ordinary loopback or canonical request URLs. A raw access-link secret must not enter navigation history, visit records, authored content, logs, diagnostics, receipts, or client caches. UI display of a newly created secret is explicit and one-time where the authority cannot reproduce it.

Revocation uses the stable access-entry ID where available. A client distinguishes effective access, public access, and explicit access entries rather than inferring authority from profile names or visible labels.

## Human-client baseline

A conforming human client makes provenance, read-only/historical state, conflicts, diagnostics, pending durable mutations, and stale/offline content understandable. It provides a way to inspect the exact accepted operational source. Exact controls, wording, panes, sheets, gestures, editor libraries, and responsive layout are outside the specification.
