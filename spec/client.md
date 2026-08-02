# Arbord clients
*Part of the [Arbor spec](../spec.md): invariants shared by human and programmatic clients.*

This specification does not prescribe a user interface. TreeHopper is one reference human client; a conforming client may use different controls, layout, editor, and platform conventions.

## Persistence authority

A local client treats arbord as the authority for resolution, authored persistence, placement changes, access changes, recovery, and observation. It does not write materialized shared-tree files behind arbord's back and then rely on filesystem observation to reconstruct authored intent. Direct external edits remain supported as external changes, not as a substitute for mutation receipts.

The client may keep ephemeral presentation state and explicitly documented user preferences. It must not create an independent canonical content, placement, credential, or access database.

## Resolution and provenance

The client accepts the locator forms in [locators.md](locators.md) and retains the resolved `tree`, decoded logical path, optional `PageID`, historical root, endpoint/canonical provenance, access, and writable state for as long as an action may refer to the result.

Directory children, search results, backlinks, Trash/recovery rows, visited trees, and mounted boundaries retain explicit tree scope. The client never reconstructs a `NodeRef` from a visible path alone when a resolved reference is available. Historical roots are read-only.

A remote visit does not invent local identity, a placement, or a temporary directory. If the same shared tree has a local placement, arbord may resolve the visit to it without changing the tree/path identity.

## Source-preserving Markdown and projection

Authored Markdown remains canonical. An untouched document must be returned byte-for-byte. A structured editor may change only the source constructs represented by an authored edit; unrelated frontmatter order, whitespace, syntax, and unsupported Markdown remain intact or enter a clear raw-source mode.

A client constructs complete directory documents from the stored/implicit body plus the full child listing. Synthetic managed rows carry explicit provenance and never persist. Before mutation, the client separates body/property edits from structural row operations and maps synthetic anchors to real child references rather than sending session block IDs.

## Mutation retry and resynchronization

For an ambiguous transport failure, a client may retry only the exact serialized request or multipart body with the same mutation ID. It never converts the ambiguity into a new mutation ID. It never automatically retries a declared conflict as new authored intent; it refreshes and asks the caller to merge or replan.

The client begins observing from a read response's `observedThrough` cursor early enough that additional page loads cannot create a gap. When arbord returns `resync-required`, it refetches visible authoritative state and resumes from the returned cursor. Events invalidate state; they do not replace a snapshot without a confirming read.

Unknown error codes and descriptive response fields do not crash the client. Missing required fields and malformed values do not silently become empty or local state.

## Secrets and access

Account/device credentials and access-link secrets are supplied through the appropriate header or secret channel, never embedded in ordinary loopback or canonical request URLs. A raw access-link secret must not enter navigation history, visit records, authored content, logs, diagnostics, receipts, or client caches. UI display of a newly created secret is explicit and one-time where the authority cannot reproduce it.

Revocation uses the stable access-entry ID where available. A client distinguishes effective access, public access, and explicit access entries rather than inferring authority from profile names or visible labels.

## Human-client baseline

A conforming human client makes provenance, read-only/historical state, conflicts, diagnostics, pending durable mutations, and stale/offline content understandable. It provides a way to inspect authored source and does not present synthetic projection bytes as source. Exact controls, wording, panes, sheets, gestures, editor libraries, and responsive layout are outside the specification.
