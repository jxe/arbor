# Reliability 001: Fix the escaped-backslash bug in the link-healing regex

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update this plan's entry in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 4247481..HEAD -- packages/arborsync/src/workspace.ts`
> The working tree was already dirty when this plan was written; also run
> `git status --short packages/arborsync/src/workspace.ts`. If the excerpt under
> "Current state" does not match the live code, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `4247481`, 2026-07-31

## Why this matters

When a page moves, arborsync rewrites links that point at it so they keep
resolving — this is what makes durable page IDs worth having. The regex that
finds those links contains `[^)\\s]+` inside a **regex literal**. In a regex
literal, `\\` is an escaped backslash, so the character class excludes `)`,
`\`, and the literal letter `s` — it does not exclude whitespace, which is what
the author meant.

Page IDs are six characters drawn from `abcdefghijklmnopqrstuvwxyz0123456789`,
so roughly one in six contains an `s`. Links to those pages are silently
skipped by link healing: they rot into stale relative paths while links to
`s`-free IDs heal correctly. The failure is data-dependent and looks random,
which makes it expensive to diagnose from a bug report. This is a one-character
fix plus a test that would have caught it.

## Current state

File involved:

- `packages/arborsync/src/workspace.ts` — the arborsync workspace session;
  `scheduleLinkHealing` rewrites links after a move.

`packages/arborsync/src/workspace.ts:1218-1226`:

```ts
  private scheduleLinkHealing(treePath: string, revision: string, document: NonNullable<TreeNode["document"]>): void {
    if (this.healingTimers.has(treePath)) return;
    const healBlock = (block: ArborBlock): ArborBlock => {
      if (block.type === "rawMarkdown") return block;
      let changed = false;
      const content = (block.content ?? "").replace(/\]\(([^)#]+)#([^)\\s]+)\)/g, (match, oldPath: string, encodedID: string) => {
        let id: string;
        try { id = decodeURIComponent(encodedID); } catch { return match; }
        const owner = this.idOwners.get(id);
        if (!owner) return match;
        let desired = posix.relative(posix.dirname(treePath), owner);
```

The intended class is `[^)\s]+` — "one or more characters that are neither a
closing paren nor whitespace".

For contrast, two other sites in the repo use `\\s` **correctly**, because they
build a regex from a string where the extra backslash is required:

- `packages/canopy/src/canopy.ts:908`
- `packages/stores/src/server-config.ts:73`

Do not change those. Only the regex *literal* in `workspace.ts` is wrong.

Page IDs are minted at `packages/editor/src/markdown.ts:444-452` from the
alphabet `abcdefghijklmnopqrstuvwxyz0123456789`, six characters long — which is
why `s`-containing IDs are common.

Repo conventions:

- Tests live in `tests/unit/*.test.ts` and `tests/integration/*.test.ts`, using
  `bun:test`. Link healing is workspace behavior, so an integration test is the
  right layer; use `tests/integration/workspace.test.ts` as the structural
  exemplar.
- Note `tests/integration/workspace.test.ts` mutates `process.env.ARBOR_DATA_HOME`
  at module scope. Do not copy that pattern into a new file; if you add to the
  existing file, leave its setup alone.

## Commands you will need

| Purpose      | Command                                          | Expected on success             |
|--------------|--------------------------------------------------|---------------------------------|
| Typecheck    | `bun run typecheck`                              | exit 0, no output               |
| Tests        | `bun test`                                       | all pass (155 before this plan) |
| Integration  | `bun test tests/integration/workspace.test.ts`   | all pass                        |

## Scope

**In scope**:

- `packages/arborsync/src/workspace.ts` (the single regex literal)
- `tests/integration/workspace.test.ts` (add a test)

**Out of scope** (do NOT touch):

- `packages/canopy/src/canopy.ts:908` and
  `packages/stores/src/server-config.ts:73` — their `\\s` is correct because
  they pass a string to `new RegExp(...)`.
- The rest of `scheduleLinkHealing`'s logic — the relative-path computation,
  the debounce timer, and the revision-guarded write are all working as
  intended. This plan changes exactly one character class.
- `packages/editor/src/markdown.ts` — the page-ID alphabet stays as it is.

## Git workflow

- Branch: `correctness-and-reliability/001-link-healing`
- Commit message style from `git log`: short imperative sentence, no prefix.
  Example: `Match whitespace, not the letter s, when healing links`.
- Do NOT push or open a PR.

## Steps

### Step 1: Confirm the defect before changing it

Run this to see the current behavior — it demonstrates that an `s`-bearing ID
is not matched:

```bash
bun -e 'const bad = /\]\(([^)#]+)#([^)\\s]+)\)/g; const good = /\]\(([^)#]+)#([^)\s]+)\)/g; const text = "[a](old/path#as3k9z) and [b](old/path#a13k9z)"; console.log("bad:", text.match(bad)); console.log("good:", text.match(good));'
```

Expected: the `bad` regex matches only the second link (the one with no `s` in
its ID); the `good` regex matches both.

If both regexes produce identical output, the defect is not what this plan
describes — STOP and report.

### Step 2: Fix the character class

In `packages/arborsync/src/workspace.ts:1221`, change `[^)\\s]+` to `[^)\s]+`.
Change nothing else on that line.

**Verify**: `grep -n 'replace(/\\]\\(' packages/arborsync/src/workspace.ts` shows
the line now containing `[^)\s]+` and not `[^)\\s]+`.

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Add a regression test with an `s`-bearing page ID

Add a test to `tests/integration/workspace.test.ts` that:

1. Creates a workspace fixture with two pages, where the target page's
   frontmatter `id` deliberately contains the letter `s` (e.g. `as3k9z` — six
   characters from the lowercase-alphanumeric alphabet).
2. Authors a link in the source page pointing at the target by path and ID, in
   the form the healer matches: `[label](relative/path#as3k9z)`.
3. Moves the target page to a different directory through the workspace's
   normal mutation API (find the existing move-test in that file with
   `grep -n "move" tests/integration/workspace.test.ts` and follow its shape).
4. Waits for healing to complete. Link healing is debounced via
   `this.healingTimers` — do **not** use a fixed `setTimeout`; use a bounded
   poll loop that re-reads the source page until the link updates or an
   attempt budget is exhausted. `tests/integration/cli-sync.test.ts:128` shows
   the poll-loop pattern used in this repo; copy that shape.
5. Asserts the link in the source page now points at the target's new path.

Add a second case in the same test (or a sibling test) with an `s`-free ID
(e.g. `a13k9z`) so the test documents that both heal — that is what makes it a
regression test for *this* bug rather than a generic healing test.

**Verify**: `bun test tests/integration/workspace.test.ts` → all pass,
including the new case.

**Verify**: temporarily revert step 2's change and re-run the test; the
`s`-bearing case must FAIL. Restore the fix afterward. (This proves the test
actually covers the bug. If it passes with the bug restored, the test is not
exercising the healer — STOP and report.)

### Step 4: Full gate

**Verify**: `bun run typecheck` → exit 0.

**Verify**: `bun test` → all pass.

## Test plan

- One integration test in `tests/integration/workspace.test.ts` covering:
  healing a link whose target page ID contains `s` (the regression), and
  healing one whose ID does not (the case that already worked).
- Structural pattern: the existing move tests in the same file; poll-loop
  pattern from `tests/integration/cli-sync.test.ts:128`.
- The step 3 revert-and-fail check is part of the test plan, not optional.

## Done criteria

ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun test` exits 0
- [ ] `grep -c '\[^)\\\\s\]' packages/arborsync/src/workspace.ts` returns 0
- [ ] The new test fails when the fix is reverted (verified in step 3)
- [ ] `git status --short` shows no modified files outside the In-scope list
- [ ] `plans/README.md` entry for Reliability 001 updated

## STOP conditions

Stop and report back if:

- The step 1 check shows both regexes behaving identically.
- `scheduleLinkHealing` is no longer present at
  `packages/arborsync/src/workspace.ts:1218` or its body differs materially from
  the excerpt above.
- The new test passes even with the bug restored (step 3's final check).
- Healing turns out to require a running arborsync server that the integration
  test harness cannot start — in that case report what you found rather than
  building new test infrastructure.

## Maintenance notes

- Any future regex *literal* in this codebase that needs a whitespace class
  should use `\s`, not `\\s`. The two `\\s` sites in
  `packages/canopy/src/canopy.ts` and `packages/stores/src/server-config.ts`
  are correct only because they go through `new RegExp(string)`.
- A reviewer should confirm the diff is exactly one character plus tests.
- Deliberately deferred: link healing currently only rewrites links in blocks
  whose type is not `rawMarkdown`. Whether raw Markdown blocks should also heal
  is a product question, not a bug, and is out of scope here.
