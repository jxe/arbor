# Apps 005: Read rules from access policy, and one plan per view

**Why and when:** Joe wants views and mutations running on hosts, to test the permissions
and lending models against real code. Views, the wire format, code loaded from trees and the
host switch are built ([status](../../status.md#views-on-the-host-and-declared-views--2026-11-08)).
Two things are left before a host serves views over models whose privacy matters.

On 2026-11-06, Joe split the apps work into three plans:
1. This plan.
2. [Apps 010](../later/apps-010-activation-and-lending.md): activation authority and lending.
3. [Apps 011](apps-011-widgets-in-story.md): widgets in Story.

## Status

**PLANNED · M effort · high authority-boundary risk.**

Read [DEVELOPMENT.md](../../DEVELOPMENT.md), `status.md`, current source and tests before
relying on this plan. It authorizes no live-data, installed-app or public-host changes.

## What exists now

- `runView` and `LiveViewBroker` take `readRules` (`packages/apps-runtime/src/views.ts`):
  per model, facts joined into every read and every join of that model, so a view that
  forgets them, or a forged `missed` path, can't see past them.
- The sidecar passes none. Nothing on the host reads a model's read rules yet, so a host
  view reads every row its caller can read in the tree.
- A view's plans are traced per input: two inputs give two plans, each cached.
- `rows` answers are off unless `OVERSTORYD_ROWS_ANSWERS=1`, because without read rules
  they would ship rows a view's own check hides.

## 1. Read rules from access policy

**Read rules belong to the model, and the host applies them** (Joe, 2026-11-08). Their home
is access policy (spec 05, `access.yaml`), next to
[Schema language 010](../later/schema-language-010-row-ownership.md)'s row ownership, as
row-level read rules such as `who: {property: owner}`.
- Parse row-level read rules in access policy, and compile them into `ReadRules` once per
  caller and schema version.
- Pass them with every view question. The sidecar applies them to declared views too.
- Value predicates (`when: {property: visibility, is: Public}`) aren't supported yet
  (Joe, 2026-11-08). Until they are, Supplies' public/private check stays an app rule its
  views call, and `rows` answers stay off.

**Verify:** a host view that omits a model's read rule still gets only the rows the rule
allows, through `value`, `tree` and a declared view.

## 2. One plan per view

Trace with tagged input values, so a plan is cached per view and not per input.

**Verify:** two inputs to `listOwner` reuse one plan and give the same answers as now.

## Completion

Run `bun run typecheck`, `bun run test`, `bun run test:protocol` and
`bun run check:links`. Record evidence in `status.md`, trim steps as they land, and delete
the plan when only Joe's items are left.

Never widen authority to get a fixture passing.
