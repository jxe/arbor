# Agents 003: agent runs in history

**Timing:** Later, after [overstoryd 007](history-007-document-history-routes-and-restore.md)
(document history and restore) and [Agents 001](agents-001-presence-and-a-first-agent.md).
Its last phase also waits on [overstoryd 006](../later/history-006-line-provenance.md) (line
provenance).

**Why and when:** Joe, 2026-10-30 (thread "Bring AI into Story smoothly"): a run should be in
history; undoing a run is part of history support; a finished task vanishes from the page but
is kept in history; and an agent's edits are marked as both Joe's and the agent's. None of
this can be built before history exists, so it is its own plan.

> **Executor instructions**: Refresh this plan against overstoryd 007 and Agents 001 as built
> before starting; both will have moved. Do the phases in order and stop after each for Joe's
> hands-on check. Phase 1 changes the update format, so it runs `bun run test:protocol` and
> the Swift `Overstory` tests. Pushing `main` deploys overstoryd. Never test against
> `arb.nxhx.org`.

## Status

- **Effort:** M.
- **Risk:** MEDIUM: phase 1 adds a field to accepted updates, which every client and the host
  must carry and never treat as authority.
- **Progress:** TODO, waiting on overstoryd 007.

## What happens after Agents 001 and overstoryd 007

- A run publishes its edits through Story Sync from Joe's Mac, as ordinary updates from that
  device. Nothing in an update says it came from an agent, or from which run; updates carry no
  message at all.
- Undo Run restores files from an APFS snapshot the runner keeps for a day.
- The task block is removed from the page when the run finishes; nothing records the run.
- History (from 007) lists a page's accepted versions and can restore one as a new change.

## Decisions

From Joe, 2026-10-30:

1. **A run is an entry in history.** History shows it as one entry, labelled with the task
   text ("Agent: merge the duplicates and sort by aisle"), even when it touched several pages
   or published several updates.
2. **Undo Run is a history restore.** It restores each page the run changed to its version
   before the run, as new changes, and the APFS snapshot goes away.
3. **History is the task archive.** The run's entry shows the task it came from, which is the
   block it removed.
4. **An agent's edits are both Joe's and the agent's.** The update is still Joe's (his
   account, his device), and also names the agent and the run. Line provenance shows both,
   such as "Joe · Claude".

## Phase 1: updates can say an agent made them

- `01-tree-operations.md`: an update gains an optional `attribution`:

  ```ts
  type UpdateAttribution = {
    agent: string;        // "Claude", "Codex"
    run: string;          // opaque, the same for every update of one run
    task: string;         // the task text, ≤ 280 characters
  };
  ```

  It is descriptive only: it never grants or limits anything, and access and authorship stay
  the account's and device's. The host stores it with the accepted update and returns it in
  history.
- Story Sync's loopback API gains a way for the runner to say "updates from this placed tree
  belong to run R until I say otherwise", and Story Sync puts the attribution on what it
  publishes from that tree meanwhile. (Edits Joe makes in the same folder by other means
  during a run would be attributed too; the Story editor publishes on its own credential, so
  its edits are not.)
- Models, vectors, and tests that an update with and without `attribution` round-trips, and
  that a forged one changes nothing about access.

## Phase 2: runs in History, and Undo Run

- History groups a run's updates into one entry with the agent mark and the task text, and
  lists the pages it changed. Opening it shows each page's change, including the removed task
  block.
- **Undo Run** (from the run's entry, and from the bubble's result line right after the run)
  restores each changed page to its version before the run, through 007's restore, as new
  changes. A page changed by someone else since is listed and left alone, as Agents 001's
  snapshot undo did.
- The runner stops taking APFS snapshots.

**Verification:** a run touching two pages appears once in each page's history and once as a
run; Undo Run restores both; with one page edited by hand after the run, that page is left
alone and named.

## Phase 3: both names in line provenance

After overstoryd 006: a line last changed by an attributed update shows the person and the
agent ("Joe · Claude"), and filtering provenance by agent works.

## Close out

Record the attribution field and what History shows in `status.md`, and delete this plan.
