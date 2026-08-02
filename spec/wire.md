# Wire and community authority
*Part of the [Arbor spec](../spec.md): canonical boundaries, identity, access, synchronization, and live HTTP projection.*

## 1. Mounted canonical namespace

One host represents one community:

```text
/                       community profile tree
/~joe/                  Joe's complete person profile
/~editors/              Editors' complete group profile
/~editors/handbook/     content or an independent shared subtree
```

The community root is a public-read `type: group` tree. Handles are unique, contain no `~`, and identify public-read person/group profile trees at `/~<handle>`. Profiles may contain arbitrary files and directories.

Canonical boundaries are independent of local placements:

```ts
interface CanonicalBoundary {
  path: string;
  tree: TreeID;
  parentTree: TreeID | null;
  kind: "community-profile" | "person-profile" | "group-profile" | "shared-subtree";
}
```

`/.well-known/arbor/*` chooses the longest accessible boundary and walks the remaining path within that tree. A longer boundary is valid only when its parent graph contains a nested-tree entry at that exact path. An unrelated alias cannot shadow content.

The raw `arbor://tree/<TreeID>` form remains the identity fallback and does not by itself reveal an authority.

The host's public HTTP projection parses the same Arbor Markdown block model as TreeHopper and renders a no-JavaScript, non-editable document surface with matching content width, typography, block spacing, lists, child rows, code, images, toggles, footnotes, and safe raw-Markdown fallbacks. A directory's `_index.md` is its authored body; unmentioned accessible children are projected below it and `_index.md` is never a child row. Inaccessible nested boundaries are omitted. Extensionless URLs are canonical for Markdown pages. An HTTP request whose `Accept` header includes `text/markdown` receives the untouched stored Markdown instead of HTML. Untrusted authored HTML and unsafe URL schemes are escaped rather than executed.

## 2. Promotion and placement

Sharing an ordinary visible directory promotes it in place:

1. validate the requested canonical child path beneath a writable person/group profile;
2. snapshot and validate the existing directory;
3. create the child `TreeID`;
4. replace or reserve the exact parent entry with a nested-tree boundary;
5. apply the complete explicit initial public/person/group access rule set in the same authority transaction;
6. record the existing local OS placement.

The canonical URL and bytes remain stable while longest-prefix resolution changes the enclosing `TreeID`. `PageID`s in stored Markdown remain unchanged.

An arbitrary external folder may be mounted as a virtual child beneath a writable profile. Its OS path remains unchanged. Arbor does not move it, duplicate it in the profile folder, or fabricate Markdown to represent the mount. TreeHopper and REST children/snapshot resolution expose the mounted child. Parent mutations that would replace a reserved mount fail with `reserved-boundary`.

Boundary moves, aliases, and cross-parent remounts are deferred.

## 3. Accounts, profiles, membership, and claims

The profile tree's `TreeID` is the stable person/group identity. `_index.md` is ordinary authored content:

```yaml
type: person
```

or:

```yaml
type: group
members:
  - arbor://garden.example/~alice
  - arbor://garden.example/~bob
```

Community membership is the `members` list in the community root. An unresolved same-community person locator reserves its handle. A claim supplies a valid visible profile snapshot. The authority atomically:

- verifies the reservation is still unresolved;
- creates a public-read person profile tree;
- mounts it at `/~<handle>`;
- creates one account and device credential;
- returns the credential once.

The first successful submission wins. Concurrent/later submissions return `already-claimed`. There are no invitation secrets, approval queues, invitation records, dispute workflows, or administrative resets in v1.

Removing an unresolved locator releases the handle. Removing a claimed locator disables that account's future authenticated operations but does not delete its profile or descendant trees. User interfaces require confirmation for this removal.

Group profiles list existing same-community person locators. Writers of the group tree administer its content and namespace. Membership alone never grants write to the group. Direct members are used when another tree grants that group read or write. Nested groups and cross-community membership are deferred.

The authority bootstraps the community root with one unresolved first-writer locator. The first successful browser claim creates that account/profile and grants it write to the community root. One host supports multiple accounts and identifies their writable namespaces by authenticated profile `TreeID`, never a process-wide owner token.

## 4. Access

Access is whole-tree. Entries have subjects:

- `everyone`;
- a person/group profile `TreeID`;
- a secret-link digest.

Levels are `none`, `read`, and `write`. “Private” means no `everyone` entry; public read/write are product labels for `everyone: read|write`. Each nested boundary is evaluated independently.

A create request carries at most one `everyone` rule plus zero or more distinct same-community person/group profile rules. The host resolves profile locators to profile `TreeID`s before the authority transaction. Tree creation, the administering profile's implicit write entry, and every requested initial entry either commit together or do not exist. Secret-link entries are created only after the tree exists because their raw secrets remain client-side and must never enter durable mutation records.

Profile access resolves locators to stable profile `TreeID`s. Group-derived access reads the current verified authored membership. Display names never become authority.

Link secrets are generated client-side. Only `sha256:<digest>` is stored. The browser keeps the secret in a URL fragment and converts it to an authorization header; raw secrets do not enter normal request URLs, content, authority storage, journals, receipts, events, diagnostics, errors, or logs. Removing the digest entry revokes the link.

Public write is explicit and subject to rate/storage limits. Revocation prevents future remote reads/writes; already materialized local files remain visible but stale/read-only.

## 5. Objects, refs, and synchronization

Each `TreeID` has one mutable current root and an append-only ref history. The graph below a root consists of deterministic immutable CBOR objects:

- file object: raw bytes;
- directory object: sorted name to object-hash or nested-`TreeID` entries.

```text
GET  /.arbor/trees/{TreeID}/ref
POST /.arbor/trees/{TreeID}/push
GET  /.arbor/trees/{TreeID}/watch
GET  /.arbor/objects/{hash}
```

Push is compare-and-swap. Authorities verify object hashes, complete reachability, names, quotas, profile schemas, permissions, and preservation of registered child boundaries before advancing a tip. A stale expected ref returns `ref-conflict`; replacing a child boundary returns `reserved-boundary`.

Arbord pushes authored changes immediately and polls/watches for remote tips. If only one side advanced it fast-forwards; if both differ from the common ref it preserves local content and surfaces a conflict. Access does not alter the `TreeID` or URL.

## 6. Community/account endpoints

The reference host exposes:

```text
GET  /.arbor/account
GET  /.arbor/trees
POST /.arbor/trees
POST /.arbor/claims/{handle}
GET  /.arbor/trees/{TreeID}/access
POST /.arbor/trees/{TreeID}/access
GET  /.well-known/arbor/*
```

Account/device credentials authenticate one account. `/.arbor/account` returns safe account identity plus writable profile/group descriptors, never the credential. Claim is the only anonymous tree-creation route and is constrained by an authored reservation.

## 7. HTTP projection and data

The canonical HTTP URL projects the current accessible tip. Markdown and ordinary files map directly. Directory listings retain mounted paths and enforce child access. Private content returns no bytes without account/profile/link authority.

Static baking and custom deployed applications remain separate publication profiles. SQLite is captured through checkpoint/backup as a whole-database CAS unit. Postgres remains externally authoritative; Arbor syncs only safe connection references while each device supplies its credential.
