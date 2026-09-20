# Working in this repository

Everything about how the repository is worked on, for people and agents
alike, is in [DEVELOPMENT.md](DEVELOPMENT.md): setup, what each directory
owns, change discipline, vocabulary, and the verification gates. Read it
first. The points below are the ones that most often go wrong for an agent.

- Read `git status`, the relevant source, and its tests before trusting
  prose or a plan's status label. `status.md` is the status authority;
  `spec/` is intentionally ahead of the implementation.
- `plans/` contains only remaining work. Delete a completed or superseded
  plan after recording its evidence in `status.md` or `docs/`; do not mark
  it done in place.
- Documentation-only changes still run `bun run check:links` and
  `git diff --check`; path moves also run every affected build or fixture
  test.
- Never `swift build` or `swift test` the `CanopyEditor` package standalone
  while its Quagmire dependency is in editable mode; use
  `canopy-swift/scripts/test-canopy-editor-local.sh`, which preserves the
  tracked lock. Both Quagmire pins must name the same exact release, and a
  local path never lands in a committed manifest.
- Live data, installed apps, and the public host are never changed without
  Joe's explicit go-ahead. `/.arbor/health` is a full audit, not a probe.
