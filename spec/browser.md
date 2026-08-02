# The browser
*Part of the [Arbor spec](../spec.md): durable requirements for Arbor's human surface.*

TreeHopper is a view and editing surface over arbord, never an independent storage authority. Web and native versions share the same mounted namespace, locators, access, mutations, receipts, and event stream.

## 1. Browsing and editing

TreeHopper browses ordinary local files, placed shared trees, transient remote visits, historical revisions, and safe `system:` records. A remote HTTP or Arbor locator opens in the same browser location model; an unresolved person-profile reservation renders as an empty, claimable profile rather than a connection form. Opening a location does not invent identity. Source-preserving Markdown, projected directories, collections, and ordinary files follow [format.md](format.md); synthetic projection rows and virtual mounts never persist as fabricated Markdown or duplicate filesystem content.

A canonical boundary shows its canonical path, `TreeID`, placement, effective/public access, revision, and sync/conflict state. Resolution uses the longest accessible boundary. An unavailable or private nested tree is not exposed through its parent.

## 2. Profile control

One persistent profile icon owns account and public-identity tasks:

- open and edit the complete public person profile tree;
- list writable person and group namespaces;
- create a public group profile tree;
- disconnect or switch the active local account.

One local Arbor data home has one active personal identity. New-member onboarding begins by browsing the complete reserved profile URL. The empty profile view owns the Claim action; its sheet asks only for a visible local profile folder, creates that folder if absent, and accepts `~` as the local home directory. Activating an already-issued device credential remains CLI recovery plumbing rather than browser onboarding UI. Raw credentials go directly to the operating-system credential store and never appear in content or durable diagnostics.

Person and group profiles are whole trees at `/~<handle>`, not single pages. The profile icon distinguishes public profile editing from sharing an arbitrary subtree.

An unresolved same-community person locator in the community document is a claimable reservation. TreeHopper derives the community and handle from the browsed HTTP or `arbor://` location, creates or validates `type: person` profile content in the selected folder, and submits atomically. The first success continues as the new profile account; later attempts show `already-claimed`.

## 3. Share

Eligible subtrees always show **Share**, but the action is disabled until the current account is connected and has an initialized profile. The terms “Give this subtree a URL,” “Canonical tree,” and embedded server credentials are not separate surfaces.

The Share sheet:

- requires an explicit audience, including an explicit Private choice;
- previews the canonical child path beneath a writable person/group profile;
- promotes an already canonical subtree at the same path;
- mounts an arbitrary external folder as a virtual child without moving, copying, or representing it as synthetic Markdown;
- reopens for an existing boundary to show HTTP/Arbor addresses, raw TreeID fallback, sync state, access, and revocation.

Access is whole-tree and supports:

- `everyone` with `none`, `read`, or `write`;
- a person profile with `read` or `write`;
- a group profile with `read` or `write`;
- a secret-bearing read/write link whose authority record stores only a digest.

Public write requires an explicit warning. Person/group access uses stable profile `TreeID`s, never mutable display names. Group membership is authored in the group profile; membership alone does not grant write to that group tree.

Sharing a nested subtree promotes it in place to a longer canonical boundary. Parent access never leaks into the child and child access never reveals its parent. Writes that would replace a reserved mount return a structured conflict.

## 4. Home, visits, and agents

Home reads `system:trees` and shows local placements plus account-visible remote trees and writable profile/group namespaces. A remote tree can be placed locally. Historical visits remain read-only pins.

An agent page remains ordinary tree content: its prompt/configuration are editable Markdown, its tools are locators, and its transcript/effects use the same namespace and permission model.
