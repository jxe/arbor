# Links 001: follow a link that names a tree by its ID

**Why and when:** a link written as `overstory://tr_…/path` names a tree without naming a host. Story's editor writes this form for every link to another tree, but can only follow one when the tree is already placed, was visited in the same session, or is a profile in the People list. From outside the app the link is ignored. Joe wants these links honored wherever the device can find the tree, in documents first and then on opens from the OS. The spec says how such a link resolves in one sentence that names a "verified endpoint hint" without defining one, so the plan starts by making the spec say what clients do.

> **Executor instructions**: Do the phases in order and stop after each for Joe's hands-on check; each is useful alone. Each phase lists the spec and doc text that becomes true with it; change that text in the same phase, not earlier or later. The lookup talks to live hosts only when a person activates a link, never in tests against `arb.nxhx.org`.
>
> **Refresh first (2026-10-11)**: the drift check below shows 1,127 changed lines in eight of the nine files since this plan was written: the 2026-10-11 setup and invitation work rewrote `StoryOnboarding.swift` (where the Mac's `onOpenURL` now is) and `StoryRootView.swift`, the `story` commands were regrouped, and `03-locators.md` changed. The sentence in locators §4 that phase 1 replaces is still there. Reread "What happens today" against the source and correct it before phase 1.
>
> **Drift check**: `git diff --stat 7d541bf6..HEAD -- docs/overstory-spec/03-locators.md docs/overstory-spec/02-directory-format.md swift/StoryApp/StoryAppModel.swift swift/StoryApp/StoryVisits.swift swift/StoryApp/StoryOnboarding.swift swift/StoryApp/StoryRootView.swift swift/Packages/StoryKit/Sources/StoryKit/LogicalURL.swift packages/story-sync/src/service.ts packages/cli/src/index.ts`. Stop if `openNestedTree` already asks hosts for a tree by ID.

## Status

- **Effort**: M
- **Risk**: LOW for phases 1 and 2. MEDIUM for phase 3, which gives the iPhone its first handler for opens from the OS.
- **Progress**: TODO
- **Written against**: `7d541bf6`

## What happens today

A click in a document already reaches `StoryWorkspaceState.openNestedTree(_:)` (`swift/StoryApp/StoryAppModel.swift`) with the right tree and path. That function is the whole lookup, and it asks no host.

| The link's tree is | Mac | iPhone |
|---|---|---|
| placed on this device | opens | opens |
| visited earlier in this session | opens | there are no visits on iPhone |
| visited in an earlier launch | fails: `Visits.json` is never searched by tree | n/a |
| a profile in a connected host's People list | opens | opens |
| any other tree on a host where the device has an account | fails with "is not on a connected host", though no host was asked | same |
| named in a URL opened from outside the app | ignored (`StoryIncomingLocator` returns nil for a tree ID) | ignored: there is no `.onOpenURL` |

Three faults sit beside the gap:

- `OverstoryRemoteLocator` (`StoryVisits.swift`), the daemon's `/v1/resolve` (`packages/story-sync/src/service.ts`) and `story open` (`packages/cli/src/index.ts`) read the authority of `overstory://tr_…` as a DNS name and would request `https://tr_…`. The spec says a `tr_` authority is always a TreeID.
- `onOpenURL` on the Mac drops a non-invite URL until onboarding state is ready, which is false at launch, so a link that starts the app is probably lost. This is read from the code and not yet reproduced.
- `openRemoteLocator` loses the path inside the tree when the locator names a placed or writable tree, so a host-form link opens the tree's root, not the page.

## Decisions

1. **The hint is the host form.** A link that must work for a reader who shares no record with its author is written `overstory://host/path` or `https://host/path`. The spec gains no hint syntax. A raw TreeID link carries identity and no location, and resolves only from what the reader's device already knows.
2. **The lookup has one fixed order and stops at the first hit.** A fixed order is not the guessing that locators §4 forbids: the same device with the same records always reaches the same place.
3. **A host is asked for a tree only by ID, only where the reader has an account or is already reading, and only when a person activates the link.** Asking tells that host the reader is interested in that tree. Rendering a document never asks.
4. **An open from the OS asks before it sends a tree ID to any host.** The URL may come from a web page, so the device resolves it from local records silently and shows one confirmation ("Look for this tree on arb.nxhx.org?") before any network lookup. A click inside a document the reader opened needs no confirmation.
5. **A host's answer is checked.** The descriptor it returns must carry the requested TreeID, or the answer is discarded and the lookup moves on.
6. **The editor keeps writing the raw form for links between trees.** It survives the target's canonical name changing, and step 4 of the lookup finds it in the common case, where both trees are on the same host. "Copy link" and share links stay in the host form. Joe may prefer the editor to write the host form when the target has a canonical name; that would be one change in `StoryEditorHost` and is not part of this plan.

## The lookup

One function per client, `locateTree`, replaces the body of `openNestedTree`. It returns where the tree is; a separate step opens it. The steps:

1. **Open now**: the tree is the current one or an open nested tree.
2. **Placed on this device**: the daemon's tree list on the Mac (refreshing it when it has not loaded yet, which `openNestedTree` does not do today); `nativePlacementStore` on iPhone.
3. **Visited**: this session's `navigationLocators`, then the persisted `VisitedTreeStore`, which gains a lookup by tree. A stale visit, whose canonical path no longer resolves, falls through to asking its recorded host by ID.
4. **The host of the document that holds the link.**
5. **Each host where the device has an account**: the home host first, then placement hosts in the order the account lists them.
6. **Not found**: an error that names the hosts that were asked and says the tree was not found there or is not readable with this account. A host answers both cases the same way, so the message cannot say which.

Steps 4 and 5 call `ProtocolClient.descriptor(tree:)`, which is `GET /.overstory/trees/{TreeID}`. A 404 means "not here".

Two rules are enforced by the types, not by convention:

- **Asking a host needs proof of an activation.** `locateTree` takes an `Activation` value. Steps 1 to 3 run without one. Steps 4 and 5 are unreachable unless the caller passes `.documentLink` (made only in the editor's link handler), `.typedLocation` (made only when a person submits Open Location) or `.confirmedOpen` (made only by the confirmation sheet). Code that renders links has no way to construct any of them, so it cannot cause a lookup on a host.
- **A located tree is a value that says how to open it**: `TreeLocation` is `.open`, `.placed(path)`, `.visit(locator)` or `.host(origin, descriptor)`. Opening `.host` uses the descriptor directly, so a tree with no canonical name can be opened. Today `openRemoteLocator` can only open by canonical path; it is split into "resolve a path to a descriptor" and `openRemoteTree(origin:descriptor:path:)`, which also fixes the lost path.

## Phase 1: the spec, and links in documents on the Mac

**Spec and docs, changed in this phase:**

- `docs/overstory-spec/03-locators.md` §4: replace "A raw TreeID locator resolves independently of its current public name, using a verified endpoint hint or already-known server record" with the rule itself:
  - a raw TreeID locator names no host;
  - a client resolves it from records it already holds, in a fixed order: trees it holds, trees it has visited, the host serving the document that contains the link, then hosts where it holds an account;
  - it may ask such a host for the tree by ID, and only when a person activates the link;
  - it accepts an answer only if the descriptor carries that TreeID;
  - it stops at the first host that answers, and this fixed order is what "never guesses among endpoints" requires;
  - a client holding no such record fails, and says which hosts it asked.
- The same section: define the endpoint hint as the host form. An author who wants a link followed by readers with no shared record writes `overstory://host/path` or `https://host/path`; a client that follows one learns the tree's host and records it as a visit, which later resolves the raw form.
- `03-locators.md` §1, beside the two `overstory://` forms: one sentence each on what the form carries (identity without location; location by a replaceable name).
- `02-directory-format.md`, where it says "cross-tree links use canonical or raw TreeID locators": say when each is appropriate, pointing at §4.
- `03-locators.md` §5: state that there is no route from a TreeID to its host, so `GET /.overstory/trees/{TreeID}` is answered only by a host that holds the tree.
- `docs/implementing-editors/design.md`: what following a link to another tree does, including the not-found message.
- No conformance vector changes: the grammar is untouched. Add a short normative example of the order to the spec text.

**Code:**

- `StoryVisits.swift`: `VisitedTreeStore.visit(tree:)`. `OverstoryRemoteLocator.init?` returns nil for a `tr_` authority, so nothing can request `https://tr_…`.
- `StoryAppModel.swift`: `Activation`, `TreeLocation`, `locateTree(_:from:activation:)` with all six steps; `openRemoteTree(origin:descriptor:path:)` split out of `openRemoteLocator`; `openNestedTree` becomes locate-then-open; the containing document's host is passed down from `prepareWorkspace` (today `openNavigationTree` receives only a TreeID).
- The editor's link handler is where `.documentLink` is made.

**Verification:** unit tests for `locateTree` against stub hosts, one per row: each step's hit, a host returning the wrong TreeID (discarded), a stale visit falling through, two hosts both holding the tree (the earlier one wins), and no activation (steps 4 and 5 never run, asserted by counting requests). An app-hosted test that clicking a raw link to a tree with no canonical name opens it at the linked page. `swift/scripts/test-story-app.sh`, `bun run check:links`. By hand, with Joe: a link in Console to a tree that is on `arb.nxhx.org` but not placed.

## Phase 2: opens from the OS on the Mac

**Code:**

- `StoryIncomingLocator` gains `.tree(id:path:stableKey:)` for a `tr_` authority. The test that pins nil for it changes.
- `StoryMacLaunchView.onOpenURL` records a pending open on the workspace instead of dropping it when the app is not ready; the root view consumes it once a window's model exists, and routes it through `navigate(to:)` so it uses `locateTree`. This also fixes the cold-launch drop for host-form URLs.
- A local hit (steps 1 to 3) opens at once. Otherwise the confirmation sheet names the hosts that would be asked; confirming makes `.confirmedOpen`.
- Open Location accepts `overstory://tr_…` and takes the same route with `.typedLocation`; typing a locator and pressing Open is the consent, so it shows no second confirmation.
- Host-form opens keep their path (from the phase 1 split).

**Docs:** `design.md` gains the behavior of opens from outside, including the confirmation. `status.md` records phases 1 and 2.

**Verification:** tests for the pending-open handoff (URL delivered before readiness opens after it), for the confirmation gate (no request before confirming), and for Open Location. By hand: `open 'overstory://tr_…/page'` with the app closed and with it running.

## Phase 3: iPhone

**Code:**

- `.onOpenURL` on the iPhone's launch view, with the same pending-open handoff.
- `locateTree` on iPhone uses step 2 through `nativePlacementStore` and opens `.host` with `place(tree:from:configurationTree:)`. It therefore opens only trees on hosts where the phone has an account.
- A host-form URL opens when the phone has an account at that host; otherwise it says so. An invitation URL is [Sharing 001](../sharing/001-join-on-iphone-first.md)'s: until that plan lands, the handler says that joining needs a Mac for now and offers pairing; after it, the handler hands the URL to the join flow. If Sharing 001 lands first, this phase adds its cases to the handler that plan made.
- Open Location on iPhone accepts a locator, not only a path in the current tree.

**Docs:** `design.md` and `status.md`. State the limit: the iPhone cannot visit a tree anonymously or without an account, because visits and the read-only object store are Mac-only.

**Verification:** simulator tests for the handler and the account limit. By hand on the phone: a host-form link and a raw link from Notes, and an invitation link giving whichever answer Sharing 001's state calls for.

## Phase 4: the command line

- The daemon's `/v1/resolve` and `story open` stop reading a `tr_` authority as a DNS name. `story open overstory://tr_…/path` resolves through trees the daemon holds, then the account hosts, with the command itself as the activation.
- Remove the daemon's non-spec `overstory://tree/<TreeID>/…` form if nothing still writes it; check first.
- `docs/getting-started/cli.md` describes `story open` with a raw locator. Gate: `bun run test:affected`, and `bun run test:protocol` if the `/v1/resolve` response shape changes.

## Not in scope

- A route or syntax that finds a tree's host from its ID alone. Decision 1 rules it out.
- Story for the web, whose link handling returns with Web 025.
- Anonymous or read-only visits on iPhone.
- Changing which form the editor writes for links between trees (decision 6).
- Whether one TreeID held by two hosts can have different roots. If phase 1's tests or hand checks meet it, stop and bring it to Joe; the fixed order hides it otherwise.
