# Hunch rehearsal converter

This disposable operator tool creates a new Arbor tree from a stable snapshot of
a Hunch workspace. It never writes the Hunch source, never overwrites a prior
destination, and keeps personal recipes and run manifests outside the repository
and outside converted trees.

The selected Hunch Home page becomes Arbor's root `_index.md`. Kept Markdown
retains its body and unrelated frontmatter bytes; the generated `clamshell`
stamp is removed and `clamshell-id` becomes `id`. ID-less pages require a stable
reviewed PageID in the private recipe. Files under configured asset roots are
copied byte-for-byte. Trash, `.history`, and `.clamshell.json` remain only in the
Hunch source and its separate backup.

## First rehearsal

Choose private paths outside the repository for the recipe and manifest. The
destination must not exist, and its parent must already exist.

```sh
bun run hunch:rehearsal inventory \
  --source ~/Documents/todos \
  --output /private/operator/path/inventory.json \
  --draft-recipe /private/operator/path/recipe.json
```

Review every page in the draft recipe. Change each `review` action to either
`keep` or `discard` with a reason. For an ID-less page, copy its proposed
six-character `proposedPageID` into `pageID` when keeping it. Also review the
selected Home path and asset roots. The converter refuses unknown, missing,
duplicate, malformed, or still-unreviewed pages.

Run the same dry run twice. The second invocation must match the first plan
exactly and appends a second confirmation to the private manifest.

```sh
bun run hunch:rehearsal dry-run \
  --source ~/Documents/todos \
  --recipe /private/operator/path/recipe.json \
  --destination ~/Documents/arbor-rehearsals/todos-2026-08-25-a \
  --run-id 2026-08-25-a \
  --manifest /private/operator/path/2026-08-25-a.json \
  --known-gap "Provider-backed image rendering is not implemented yet"

bun run hunch:rehearsal dry-run \
  --source ~/Documents/todos \
  --recipe /private/operator/path/recipe.json \
  --destination ~/Documents/arbor-rehearsals/todos-2026-08-25-a \
  --run-id 2026-08-25-a \
  --manifest /private/operator/path/2026-08-25-a.json \
  --known-gap "Provider-backed image rendering is not implemented yet"
```

After reviewing the summary and link warnings, apply and verify:

```sh
bun run hunch:rehearsal apply \
  --source ~/Documents/todos \
  --recipe /private/operator/path/recipe.json \
  --destination ~/Documents/arbor-rehearsals/todos-2026-08-25-a \
  --run-id 2026-08-25-a \
  --manifest /private/operator/path/2026-08-25-a.json

bun run hunch:rehearsal verify \
  --manifest /private/operator/path/2026-08-25-a.json
```

Apply writes into a run-specific sibling staging directory, verifies every
output digest, re-hashes the source, and only then renames the staging directory
to the requested destination. If the source changes or a write fails, the
destination is not created and the visibly named `.incomplete` staging directory
is retained for inspection. Removing an incomplete run remains an explicit
operator decision.

`verify` is an import-baseline check. Once the rehearsal has been edited in
Arbor, it is expected to differ from that initial manifest.
