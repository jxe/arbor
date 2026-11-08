# Security 013: fine-grained read rules

**Why:** a model's rows should be hidden from people who may not see them, whatever view
reads them. Today a view on the host reads every row its caller can read in the tree, and a
JSX view's `rows` answer ships those rows to the device, including any the view's own check
leaves out (Joe, 2026-11-08: fine for now). Split from Apps 005 the same day.

**Order:** any time after
[Apps 005](../../status.md#views-on-the-host-and-declared-views--2026-11-08), together with or
after [Schema language 010](../later/schema-language-010-row-ownership.md)'s row ownership.

## Status

- **Effort:** M.
- **Risk:** HIGH: an authority boundary.

## What exists now

- `runView` and `LiveViewBroker` take `readRules` (`packages/apps-runtime/src/views.ts`):
  per model, facts joined into every read and every join of that model. A view that forgets
  them, or a forged `missed` path, can't see past them (`tests/integration/supplies-views.test.ts`).
- The sidecar passes none, and nothing reads them from a tree.

## 1. Read rules in access policy

**Read rules belong to the model, and the host applies them** (Joe, 2026-11-08). Their home
is access policy (spec 05, `access.yaml`), as row-level rules such as
`who: {property: owner}`.
- Parse row-level read rules, and compile them into `ReadRules` once per caller and schema
  version.
- Pass them with every view question, declared views included.

**Verify:** a host view that omits a model's read rule still gets only the rows the rule
allows, through `value`, `tree`, `rows` and a declared view.

## 2. Value predicates

`when: {property: visibility, is: Public}`, so Supplies' public/private check stops being an
app rule its views call and becomes a boundary. Not supported yet (Joe, 2026-11-08).

**Verify:** a `rows` answer for a Supplies page never holds another person's private list.
