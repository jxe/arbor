# 022: Tree configurations

Schema 21 → 22, with a wire change: every hosted tree is configured in its
own private tree configuration, and the per-account configuration goes
([canopyd 005](../../../../plans/soon/005-tree-configuration-trees.md); the
contract is [accounts §2–§7](../../../../docs/overstory-spec/04-accounts-and-devices.md#2-tree-configuration-graph)
and [access control §1](../../../../docs/overstory-spec/05-access-control.md#1-subjects-and-rules)).
Old clients cannot talk to the new server: the Mac app, the CLI and the
iPhone app are replaced in the same cutover.

## What changes

For each active ordinary tree, one configuration at the derived TreeID, with
policy `tree-config-v1` and one accepted update:

| Tree | `access.yaml` | `mounts.yaml` |
|---|---|---|
| `/` | `admin` for the root itself (its members administer it), then the `access` rows, less those administration now covers | top-level names other than members' `~handle` |
| an owned tree | `admin` for the owner's profile, then the owner's `trees.yaml` rules for it, less `who: me` rules without `via` and rules naming the owner | its current nested boundaries |

- A person profile, an owned tree like any other, also gets its account's
  `devices.yaml` unchanged and an `apps.yaml`: every `via` rule of the
  account's `trees.yaml` that is not the owner's own grant, under its app,
  with `who: me` for the owner. An owner's rule with `via` and another `who`
  is the tree's own rule and lands in its `access.yaml` with `app`.
- Each device's credential binding moves to the account's new id with the
  same DeviceID and digest, so paired devices keep working once their clients
  store the new configuration TreeID.
- Accounts are rekeyed by profile TreeID (`accounts.id`); each member's
  `/~handle` becomes a member mount; boundaries are recomputed from mounts and
  must equal the old ones.
- Dropped: every account-configuration tree and its history, `trees.account_id`,
  the `access`, `resource_policy` and `tree_reservations` tables. Added:
  `trees.governs`, `tree_policy`, `tree_admins`, `app_policy`, `mounts`.

The run refuses, changing nothing, when: a declared tree still awaits
initialization; an account has no profile or configuration, or a profile has
two accounts; a tree has no owner and is not the root; any rule would be
dropped other than those covered by administration; an account would lend
access it holds only through a group (lending needs a rule naming the lender);
a tree's whole-tree access would change; or the mounts would not reproduce
every boundary exactly. Its report lists every tree, configuration and account,
each tree's whole-tree access before and after (they must be equal), every
lent capability before and after, and the rules administration covers. Code
that ran with its owner's authority now runs only with what `apps.yaml` and
`app` rules lend, so read the `lent` section together.

## Files

- `run.ts <data-root>`: the host migration. Idempotent in the usual way: it
  requires schema 21 and ends with `assertCurrentHostSchema` and
  `assertHostData`.
- `legacy.ts`: the schema-21 account configuration reader and schema, used by
  `run.ts` and the test. It goes with this directory.
- `rekey-data-home.ts`: the Mac half, run after the host is migrated, with
  Arbor Sync stopped. For each account in `${ARBOR_DATA_HOME:-~/.arbor}` it
  downloads the profile configuration the host now serves (with the account's
  own credential), installs it as the checkout at the derived TreeID, saves
  the connection record and credential under the new TreeID, moves
  placements, the current device and per-tree sync metadata, and keeps the old
  checkout under `.state/migration/022/`. It refuses an account whose host
  does not yet serve the new configuration; a rerun is a no-op.
- `migrate.test.ts`: `bun run test:migration packages/canopyd/migrations/022-tree-configurations`.
  It builds a schema-21 host with an owned profile, a shared tree with a
  scoped rule and a `via` grant, a nested boundary, the root's `access` rows
  and two devices; migrates it; checks the report and the configurations;
  serves the result (both devices keep their credentials, the other member
  keeps read, the configuration is administrator-only) and runs the integrity
  audit once; and rekeys a data home against it. Three more tests cover the
  refusals for a changed administrator set, a dropped rule and a lend through
  a group, and one a lend its account is named for.

The Arbor Sync private-state stamp is 6 (was 5), so the first daemon start
after the upgrade discards rebuildable state and re-places every tree from a
snapshot. The iPhone app rekeys its Keychain accounts on launch
(`rekeyStoredAccounts`); its device credential is unchanged.

## Runbook

The [common procedure](../README.md#the-procedure) applies, with these
specifics. Joe confirms each step; nothing touches the live host before
step 6.

1. **Back up** the live data root as one archive, and copy the Mac's
   `~/.arbor` (`cp -a ~/.arbor dot-arbor.before`).
2. **Rehearse** on restored copies:

   ```sh
   bun run test:migration packages/canopyd/migrations/022-tree-configurations
   bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar before
   bun run packages/canopyd/migrations/tools/restore-canopy.ts volume.tar migrated
   bun run packages/canopyd/migrations/022-tree-configurations/run.ts migrated | tee report.json
   bun run packages/canopyd/migrations/tools/compare-canopy-roots.ts before migrated
   ```

   Read `report.json` together: `access` must show no before/after difference
   and `lent` must be what Joe expects code to keep. `compare-canopy-roots`
   reports each removed account-configuration tree and must find every other
   root unchanged. Then serve `migrated` with the new build, call
   `/.arbor/integrity` once, and run `tools/verify.ts` against it.
3. **Rehearse the Mac.** With an isolated copy of `~/.arbor`
   (`ARBOR_DATA_HOME=<copy>`), point it at the served rehearsal copy and run
   `rekey-data-home.ts`; start a foreground daemon on the copy and check every
   placement comes back idle.
4. **Build the clients** from this revision: CLI, Mac app, iPhone app. Run the
   Swift suites first (they have not been compiled in the session that wrote
   them), then a local end-to-end against a local canopyd: claim, pair a
   second device, revoke it, share a tree, approve an app.
5. **Quiesce writers**: `bun run arbor daemon stop`, quit Canopy on the Mac,
   make sure Canopy is not running on the iPhone.
6. **Deploy and migrate in place**, then redeploy so it serves:

   ```sh
   railway ssh -- bun run packages/canopyd/migrations/022-tree-configurations/run.ts /data | tee live-report.json
   ```

   The report must match the rehearsal's.
7. **Rekey the Mac** before anything starts Arbor Sync:

   ```sh
   bun run packages/canopyd/migrations/022-tree-configurations/rekey-data-home.ts | tee rekey-report.json
   ```

   Then install the new Mac app and CLI and `bun run arbor daemon start`.
8. **Verify**: `tools/verify.ts` with `--sync`, the authored-manifest diff,
   and a round-trip edit; then check that `/`, `/~joe` and `/~joe/todos` read
   and write as before from the Mac.
9. **iPhone**: install the new build; it rekeys its account on launch and
   re-places its replicas. Check the same three trees.
10. **Close out**: record the result below and in `status.md`, delete the
    canopyd 005 plan, and delete this directory when the backups age out.

Rollback before step 7 is `restore-canopy` from the archive and a redeploy of
the previous image. After step 7 it also means restoring `~/.arbor` from
`dot-arbor.before` and reinstalling the previous Mac build.

## Rehearsal log

- 2026-09-26: synthetic schema-21 hosts only (`migrate.test.ts`, 5 tests
  passing). No real backup has been rehearsed yet.
