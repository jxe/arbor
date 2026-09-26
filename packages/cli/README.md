# @overstory/cli

The `arbor` command: daemon supervision (`daemon.ts`), profile identity,
placing and moving trees, status, and short-lived cloud sessions
(`cloud.ts`). It is a client of the daemon through `daemon-client.ts` (its
own `ArborSyncRESTClient`, not a shared package) and
edits the profile configuration checkout on disk (other trees' configurations
through the host). Every command is documented
in [the CLI reference](../../docs/getting-started/cli.md).
