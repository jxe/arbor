# Apps 010: Activation and lending

**Why and when:** after [Apps 005](../../status.md#views-on-the-host-and-declared-views--2026-11-08). Joe wants to test the permissions and lending models against real code. Joe split this out of Apps 005 on 2026-11-06. Once Apps 005 runs views and mutations from trees as their caller, this plan makes them run as an app, under the authority an activation grants.

## Status

**PLANNED · M–L effort · high authority-boundary risk.** It needs Apps 005 steps 3–4, which
load code from trees and turn it on in the host. Widgets from other people
([Apps 011](../soon/apps-011-widgets-in-story.md)) wait on this plan. Joe's own
widgets don't.

## 1. What code gets without asking (decided)

Joe decided on 2026-11-11 that code with no lender gets only `everyone` access and the tree's
own `app` rules. Anything more of the caller's needs the caller's `who: me` entry in
`apps.yaml`, which is what a placement host already gives
([access control §1.1](../../docs/overstory-spec/3.2-access-control.md#11-execution-authority)).
An app reads and writes its own personal models
([Apps 011](../soon/apps-011-widgets-in-story.md)) in the reader's tree without asking.

Still to do in code: `executionAllows` in `packages/overstoryd/src/access.ts` stops treating
the caller's own access as a grant with no lender. Until this lands, Joe's own widgets run as
their reader, as Apps 011 says.

## 2. Activation and execution tokens

- An **activation** is private host configuration (in the tree configuration graph,
  spec 04 §2). It extends Apps 005's activation (tree, path, export, pinned version) with the
  activation's lenders, providers and resource limits.
  - Unactivated handles are refused.
  - Sharing a module's source never enables execution.
- **Each question runs under its own host-issued execution token**
  ([execution tokens](../../docs/architecture/overstoryd/execution-sidecar.md#execution-tokens)).
  - The token carries the actual caller, the source tree and path, the pinned code version,
    the lent grants with their lenders, and the activation.
  - The issuer chooses lenders in a fixed order: the caller's own access first, then by
    lender TreeID.
  - There is no public mint endpoint.
  - This replaces the caller's own authority in `HostCollections`.
- **The token checks the reads and the update, not the route.** A view's reads (its
  narrowing) and a mutation's submitted update are checked against the token, not the
  route's caller check.
- **History says which code made a change.** A mutation's update is authored by the app,
  with the caller recorded.

## 3. Revocation

Revoking the activation, a lender's grant or the caller's access:
- Ends open view streams.
- Refuses queued results and receipts.
- Fails closed if the invalidation channel is lost.

A revoked caller can't use an old receipt to read a result.

## 4. Consent in Story

The first time Story runs an app's view or mutation that needs more than §1 gives:
- It asks, using the declared scope of the app's addressable views and mutations.
- The answer is written to the reader's `apps.yaml` as `who: me`.
- Later versions that stay inside the approved scope don't ask again. A wider scope asks
  for the difference.

Story shows what was approved and lets the reader revoke it.

**Verify:** extend `tests/integration/host-collections.test.ts` with real execution tokens
and the real materializations, not mocked grants:
- An anonymous reader through an `app` rule.
- Caller-only reads.
- A lent write.
- A mutation by a caller who can read but not write, allowed only through a lender.
- Revocation while a stream is open and while results are queued.
- A forged or stale token.

Consent and revocation in Story get a hand check on the Mac. Add it to
[Joe's to-do](../joe.md) when the step lands.

## Before a real app is enabled

Run a soak on an isolated copy of the live host, covering Story consent and revocation, and
configuration conflict resolution, including queued configuration writes. Take a fresh
backup of the live host first. When the steps above land, the soak and the go-ahead go to
[Joe's to-do](../joe.md).

## Completion

Run `bun run typecheck`, `bun run test`, `bun run test:protocol` and
`bun run check:links`. Record evidence in `status.md`, trim steps as they land, and delete
the plan when only Joe's items are left.

Not here:
- Approvals on placement hosts
  ([Apps 008](../later/apps-008-app-approvals-on-placement-hosts.md)).
- Cross-host delegation ([Apps 009](../later/apps-009-cross-host-delegation.md)).
- Durable workflows and author authority in authoring
  ([Apps 006](../later/apps-006-durable-authoring.md)).

Never widen authority to get a fixture passing.

## Text moved from the spec (2026-11-11)

Joe moved these undecided designs out of [apps](../../docs/overstory-spec/4.1-apps.md) on 2026-11-11, since they aren't built. They come back into the spec when this plan decides them. Old section numbers are from that chapter before the move.

### From §7 Compilation and hosting


Compilation begins from the addressed view's module and follows its explicit import graph. It produces a reviewed app manifest containing:

- source tree `TreeID`, logical module path, and code-version identity;
- public component and asset bundles;
- server-only query and mutation handles with Standard Schema input contracts
  and author/user authority requirements with human-readable consent descriptions;
- resolved read/write capabilities and backing-coupled features;
- required tree roots, node/edge schemas, store identities, and schema fingerprints;
- static query results when explicitly baked; and
- live-host requirements.

A module's path is ordinary Overstory identity, not an application ID. Moving a module changes its view's address just as moving any other file changes its URL. Imported named handles are identified by tree, module path, and export name; code hashes identify their versions.

An Overstory host explicitly enables app hosting for a tree and grants its tree execution principal the reviewed capabilities required by its compiled modules. Merely adding `.ts` or `.tsx` source does not publish it, execute it, or grant it access. The host may compile eagerly or on demand, but a request uses one coherent version of the addressed view and all of its handles. An incompatible compilation fails without replacing the last usable version.

Framework filenames do not create mutation endpoints, action routes, loaders, or private-data boundaries. Generated transport endpoints are host protocol details and are never authored or navigable nodes.

### From §11 Portability and limits

Static baking may replace explicitly static reads with compiled results. A view depending on user identity, live data, mutations, or hosted-only capabilities remains an executable-host requirement and cannot silently become static.
