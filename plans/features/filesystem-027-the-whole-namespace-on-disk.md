# Filesystem 027: The whole namespace on disk

**Timing:** Not soon (Joe, 2026-11-05: "in features and not to do anytime soon").

**Why and when:** Joe asked whether Overstory should do more to live up to the promise of a global namespace, the way AFS, sshfs and IPFS do. The first half was making any readable tree reachable without an account: visitor sessions and read-only placements (accounts §5.6, `story place --read-only`, built 2026-11-05). This plan is the other half, the AFS feeling: every tree you can read is a path on your disk, without placing it first. `~/Overstory/garden.example/~alice/notes/drift.md` opens in any editor, and an agent can `cat` and `grep` across trees it has never seen, with files fetched only when opened. Not soon: it is a large native piece (a File Provider extension), and placed folders already cover the trees Joe works in every day.

> **Executor instructions**: Start by re-reading accounts §5.6 and the read-only placement code (`packages/client/src/placements.ts`, `packages/story-sync/src/state/trees.ts`), which this builds on. Spike the File Provider extension on its own before touching Story Sync. Nothing here changes the protocol; if it seems to, stop and ask Joe.

## Status

- **Effort**: XL
- **Risk**: MEDIUM. File Provider extensions are hard to debug and their behavior shifts between macOS releases. Nothing here writes to a host that a placement does not already write.
- **Depends on**: visitor sessions and read-only placements (done 2026-11-05). Benefits from [Native 006](../when-needed/performance-006-sparse-ios-placement.md) (sparse placement), which wants the same "fetch only what's opened" machinery.
- **Category**: product completion

## What exists

- A **placement** puts one tree in one folder, wholly materialized, and keeps it in sync. `placements.yaml` lists them; a TreeID appears at most once (deferred 11 in the spec README: several placements of one tree).
- A **read-only placement** (`access: read`) follows a tree at any host: with an account there, as a visitor, or as anyone.
- **Canonical URLs** already form a tree of names: `https://host/~alice/notes/…`, with nested trees found by longest boundary (locators §5). Story Sync's object cache and the hosts' object routes already serve single objects by hash.

## The design

### What you see

One folder per host you've visited, under one root:

```text
~/Overstory/
  garden.example/
    ~joe/            → your trees there, as their canonical paths
    ~alice/notes/    → readable to you, so listed
  railton.example/
    ~railton/essays/
  .trees/
    tr_7k3m…/        → any tree by TreeID, at the host that serves it
```

- A host's folder appears when you first open a path under it (type it in Finder's Go to Folder, follow a link, or `ls` it). Listing a host's folder shows what that host's `GET /.overstory/trees` lists to you.
- Below a tree's root, directories and files are the tree's own entries. Files are placeholders until opened, then hydrated from objects by hash. Story Sync evicts hydrated files under disk pressure.
- Trees you have placed also appear here. The placed folder and this view are two views of one tree held by one Story Sync, so they never disagree. This is the case deferred 11 names, so the spec's README entry needs an answer first: the namespace view never publishes on its own, only through the placement.

### Writing

- In a tree you can only read, files are read-only.
- In a tree you can write that you have **placed**, an edit here is an edit to the placement.
- In a tree you can write that you have **not** placed: open question below.

### How

- **macOS:** a File Provider extension (`NSFileProviderReplicatedExtension`) in Story.app, talking to Story Sync over its loopback API. Not FUSE: macFUSE needs a kernel extension, and File Provider is what iCloud Drive and Dropbox use, with Finder badges and on-demand download for free.
- **Story Sync:** new loopback routes to list a canonical path, read a file by its entry, and watch a tree for changes to push to the extension. It reads through the same connections as read-only placements (account, visitor, or anyone), and keeps a lightweight watch on every tree the extension has open.
- **Linux and cloud agents:** `story ls` / `story cat` over the same routes first. FUSE only if agents need real paths there.
- **iPhone:** the same extension shows the namespace in the Files app, which is the natural home for Native 006's sparse placement.

## Steps

1. **Spike.** A File Provider extension that shows one public tree, read only, hydrating files on open. Measure first-open latency against a Railway host.
2. **Story Sync routes** for listing a canonical path, reading an entry, and change notifications, with tests against two local hosts (one where the profile is a visitor).
3. **The namespace root**: hosts appear on first open, `.trees/` by TreeID, and placed trees shown as the same tree.
4. **Eviction and offline**: what stays hydrated, what Finder shows when a host is unreachable.
5. **iPhone Files app**, then Native 006 on top of it.
6. **Close out**: a hand check with Joe (open a stranger's public tree in TextEdit; `grep -r` across two hosts in Terminal; edit a placed tree through the namespace view), status, and delete this plan.

## Open questions

- **Writing to an unplaced tree you can write.** Either refuse (place it first) or give the namespace view its own change log per tree. Refusing is simpler and probably right.
- **Which hosts to list.** Only hosts you've opened, or also every host your People directory knows?
- **Names that are not hosts.** With person-owned domains ([Names 001](../soon/names-001-your-own-domain-names-your-profile.md)), `~/Overstory/alice.com/` could show Alice's trees wherever she hosts them.
- **Search.** Spotlight indexing of hydrated files only, or Story Sync's own search behind the extension?
