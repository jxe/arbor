# Working in this repository

Everything about how the repository is worked on, for people and agents
alike, is in [DEVELOPMENT.md](DEVELOPMENT.md): setup, what each directory
owns, change discipline, vocabulary, and the verification gates. Read it
first. The points below are the ones that most often go wrong for an agent.

- Read `git status`, the relevant source, and its tests before trusting
  prose or a plan's status label. `status.md` is the status authority;
  `docs/overstory-spec/` is intentionally ahead of the implementation.
- `plans/` contains only remaining work. Delete a completed or superseded
  plan after recording its evidence in `status.md` or `docs/`; do not mark
  it done in place.
- Use `bun run test:affected` as normal change validation (name your paths
  after `--` when the working tree holds unrelated work). Committing does
  not require a fresh test run; reuse checks already run against unchanged
  code. Reserve the full gate in DEVELOPMENT.md for periodic releases,
  live migrations or installs, or Joe's explicit request. Add `bun run
  test:protocol` when an HTTP route or response shape changes.
- Never `swift build` or `swift test` the `CanopyEditor` package standalone
  while its Quagmire dependency is in editable mode; use
  `swift/scripts/test-canopy-editor-local.sh`, which preserves the
  tracked lock. Commits, including those pushed to main, may use Quagmire
  API that is not yet released; local builds take it from the sibling
  checkout. Quagmire is released, and both pins bumped to that exact release,
  as a separate step. A local path never lands in a committed manifest.
- Run git as plain, single commands from your working directory, one per
  shell call: `git status`, then `git add path`, then `git commit -m ...`.
  No `cd dir && git`, `git -C`, `--git-dir`/`--work-tree`, pipes, `$(...)`,
  loops, or `&&`/`;` chains around git; use git's own flags (`-n`,
  `--format`, `--stat`) in place of `| head` or `| grep`. A
  worktree-isolated agent's git commands are refused when they are too
  complex to prove they stay inside the worktree.
- Live data, installed apps, and the public host are never changed without
  Joe's explicit go-ahead. `/.arbor/integrity` is a full audit, not a probe; call it once, never poll it.
