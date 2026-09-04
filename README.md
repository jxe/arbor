---
id: jrigzm
---
# Arbor

Arbor turns ordinary folders into a shared, browsable space for people and
agents. Files stay files—readable with `cat`, searchable with `grep`, and
editable by any existing tool—but a folder can gain a stable identity,
history, synchronization, and permissions without moving into a walled
service. Arbor's browser gives the same material a human interface.

The longer-term idea is that documents in this space can also become live
applications: their data, interface, and permitted operations travel together
instead of being split across a website, API, database, and account system.
The reference implementation already provides the local browser/editor, stable
trees, synchronization, community hosting, accounts, and the headless data
runtime. Executable-document presentation, hosted agents, and portable
deployment remain work in progress or specification.

For the longer argument, read [A universal dynamic material](intro.md). For the exact current boundary, see [status.md](status.md).

## Start using Arbor

The current persistent setup is for macOS. From a checkout, install the
dependencies, expose Arbor's commands in your shell, install Arbor Sync as a
user service, create one local profile identity, and open the current folder:

```sh
bun install
bun run build:web
bun link
arbor daemon install
arbor me create
arbor open .
```

`bun link` exposes `arbor`, `arborsync`, and `canopyd` from this checkout.
`arbor daemon install` installs and starts the per-user Arbor Sync launchd
service; if the signed Arbor app already owns that service, the command leaves
its registration in place. Later, `arbor open` attaches to that service and
asks launchd to start it when it is installed but stopped. `arbor me create` is a one-time operation and
refuses to replace an existing identity. Skip it if `arbor me` already reports
one.

`arbor open` accepts a local path, a canonical HTTPS or `arbor://` URL, or no
locator for the current directory. Linux and Windows daemon supervision are
not implemented yet; the [CLI reference](docs/cli.md) documents the isolated
foreground mode available with `ARBOR_DATA_HOME`.

See the [CLI reference](docs/cli.md) for persistent daemon setup, placing synchronized trees, moves, identity backup and restore, and command safety rules.

## Run a Canopy server

A new Canopy community reserves its first account for an existing self-certifying profile. Print the profile TreeID created above:

```sh
arbor me
```

Then start Canopy, replacing `tr_...` with that TreeID:

```sh
canopyd ./garden \
  --community garden \
  --first-writer joe \
  --first-writer-profile tr_...
```

Canopy listens at `http://127.0.0.1:4318` by default and prints the reserved account URL. In another terminal, open and claim it:

```sh
arbor open http://127.0.0.1:4318/~joe
```

Restarting the same command serves the existing data directory without bootstrapping again. For public domains, persistent volumes, backups, restoration, and coordinated upgrades, use the [Canopy deployment guide](deploy/README.md).

## Implementation status

| State | Today |
|---|---|
| **Implemented and tested** | Local filesystem browser/editor, Arbor tree identity and synchronization, Canopy hosting, profile/account claiming, multi-account configuration and pairing, SQLite-backed query execution and transactional mutations |
| **In progress** | Compilation, typechecking, React presentation, activation, and Canopy hosting for the [Supplies example](examples/supplies/README.md) |
| **Specified, not built** | Hosted Arbor agents, portable static/live deployment, and complete Postgres-backed child collections |

[status.md](status.md) is the implementation-status authority. The [specification](spec.md) intentionally describes portable behavior that may not exist in the reference implementation yet.

## Repository guide

- [Introduction](intro.md) — the motivation and proposed end state.
- [Specification](spec.md) — the portable Arbor contracts, in numbered reading order.
- [Documentation map](docs/README.md) — usage, implementation, client-design, and historical documents.
- [Reference implementation](docs/reference-implementation.md) — the Bun, TypeScript, React, and Swift architecture.
- [Client design](docs/client.md) — non-normative Arbor web and native product behavior.
- [Supplies example](examples/supplies/README.md) — the executable-document reference corpus.
- [Development](DEVELOPMENT.md) — repository layout, setup, tests, and local verification.
- [Plans](plans/README.md) — active projects, unresolved questions, maintenance themes, and completed evidence.

This repository does not yet have an open-source license. Licensing is awaiting legal advice.
