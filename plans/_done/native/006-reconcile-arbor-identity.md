# Plan 006: Reconcile Arbor identity and native planning

> **Executor instructions**: This is a documentation/status milestone. Do not scaffold the app or change a serialized protocol. Follow every step, run the checks, and update this plan's row in `execution.md`. STOP rather than inventing compatibility behavior.
>
> **Drift check**: `git diff --stat dc34126..HEAD -- README.md spec.md spec docs deploy plan packages/arbord/src/server.ts tests`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs/direction
- **Planned at**: Arbor `dc34126`, 2026-08-23
- **Final status**: DONE on 2026-08-23 — current product, specification, deployment, runtime, and planning language now uses Arbor; `docs/client.md` is the informative client-design document.

## Why this matters

The repository still calls the human client TreeHopper and its active native handoffs still prescribe direct iCloud authorship. Signed builds or protocol work created under those names would make a rejected design persistent. This milestone leaves one current product vocabulary and an honest plan index before implementation begins.

## Current state

- `README.md` calls the React browser TreeHopper and describes the native work as future TreeHopper/iCloud integration.
- `spec.md`, `docs/client.md`, deployment docs, server messages, and tests use TreeHopper as a provisional reference-client name.
- `plans/native/README.md` and `execution.md` now record the accepted Arbor synchronization direction; Plans 002–005 remain on disk as superseded evidence.
- Quagmire repository commit `4049fd4` is tagged `0.1.0`; Hunch commit `a1e8379` consumes the remote exact version.

## Scope

**In scope**: current product/spec/reference/deployment wording, current runtime messages and matching tests, plan status/history, doc filenames and links.

**Out of scope**: wire types, authority schema, native project/targets, Hunch or Quagmire source, canonical `arbor:` URLs, `TreeID` values.

## Steps

1. Rename `docs/treehopper.md` to a literal Arbor client-design filename and repair every inbound link. Preserve its informative/non-normative status.
2. Replace current TreeHopper labels with **Arbor**, **Arbor web**, or **native Arbor** according to context. Leave historical plans/record quotations intact.
3. Use **Arbor tree** for an independently versioned `TreeID`; use **sharing** only for audience/access. Do not rename stable serialized fields in this documentation milestone.
4. Update root/reference/native planning status: Quagmire publication is implemented; Plans 002–005 are superseded; Plans 006–019 are active.
5. Update literal runtime error text and assertions that present TreeHopper to users. Do not rename internal package paths unless they are presentation-only.

## Verification

```sh
rg -n 'TreeHopper' README.md spec.md spec docs deploy plan packages/arbord/src/server.ts tests
bun run typecheck
bun test
bun run build
git diff --check
```

Expected: TreeHopper remains only in explicitly marked historical/superseded evidence; all commands exit 0; edited Markdown links resolve.

## Done criteria

- [x] Current public labels consistently say Arbor.
- [x] No persisted app identity has been created.
- [x] Plans 001–005 have accurate final/superseded status.
- [x] Root checks and link checks pass.

## STOP conditions

- A TreeHopper value is serialized or used as stable storage identity rather than presentation.
- Removing a label would change an existing canonical Arbor URL or TreeID.
- Quagmire/Hunch live state contradicts the recorded completion evidence.

## Maintenance note

Historical records are evidence, not cleanup debt. Future renames must distinguish visible product wording from persistence-sensitive bundle, URL, and protocol identities.
