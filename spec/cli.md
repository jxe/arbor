# CLI
*Part of the [Arbor spec](../spec.md): the intended command surface. Implementation status belongs in [plan.md](../plan.md).*

Every content operand is an Arbor [locator](locators.md). The CLI resolves through arbord and has no private storage API.

## Porcelain

- **`arbor browse <locator>`** — open TreeHopper at a local, remote, live, or historical location. A reserved person-profile URL renders as an empty profile whose Claim action asks only for its local folder. If the resolved tree already has a local placement, Arbor opens that writable placement instead of its public web view.
- **`arbor sync [audience-options] <local-path> <canonical-url>`** — idempotently promote/reconcile a local directory and its canonical boundary. A new boundary without audience options is private and produces a warning; an existing boundary without them retains its ACL unchanged.
- **`arbor sync <canonical-url> <local-path>`** — idempotently place and follow a remote tree; a revision suffix produces a pinned read-only placement.
- **`arbor unsync <local-path>`** — remove the placement at that local path without deleting files, remote identity, or history.
- **`arbor unsync <local-path> <canonical-url>`** (in either order) — remove only that exact local/canonical placement pair. A mismatched pair is rejected without changing either side.

`--access` accepts one or more complete `<subject>=<level>` entries. Entries may be comma-separated inside one argument or supplied through repeated flags; both forms are equivalent, whitespace is trimmed, and the last occurrence of a subject wins. `public` names everyone; `~<handle>` names a person or group profile in the destination community. Levels are `read`, `write`, and `none`, where `none` removes that subject's entry. `--clear-access` removes every explicit entry before applying following access arguments. Options are written before the locators, and an assignment containing `~` is quoted as a whole so the shell cannot expand it. For a new boundary, Arbor compiles the resulting entries into one complete initial ACL and applies it atomically with promotion; it does not create the tree with only the first entry and patch the rest afterward.

```sh
arbor sync ~/projects/atlas arbor://garden.example/~alice/atlas
arbor sync --access public=read ~/groups/editors arbor://garden.example/~editors
arbor sync --access public=read ~/editors/handbook arbor://garden.example/~editors/handbook
arbor sync --access '~editors=write' ~/projects/atlas arbor://garden.example/~alice/atlas
arbor sync --access public=none ~/projects/atlas arbor://garden.example/~alice/atlas
arbor sync --clear-access --access 'public=read,~editors=write' ~/projects/atlas arbor://garden.example/~alice/atlas
arbor sync arbor://garden.example/~editors/handbook ~/work/handbook
arbor unsync arbor://garden.example/~editors/handbook ~/work/handbook
```

The first command warns that it created a private boundary. The second creates the Editors group profile when that folder's `_index.md` declares `type: group`; the next publishes its handbook for reading, followed by granting the Editors profile write access, removing public access alone, and replacing the entire explicit audience. Setting an existing `write` entry to `read` downgrades it. Promotion never moves an external folder into the profile directory. The canonical child is a virtual mount over the existing OS placement. Access-link creation and revocation remain in TreeHopper because the raw secret must be generated, displayed, and kept out of shell history. The former `-r`, `-rw`, `--remove`, and `--private` options remain accepted as compatibility aliases but are not the authored command surface.

## Plumbing

- **`arbor serve [data-directory]`** — run one community authority/live HTTP gateway. A fresh server reserves a first-writer profile; no credential needs to be invented or copied:

  ```sh
  arbor serve ./garden --community garden --first-writer joe
  # First writer profile: http://127.0.0.1:4318/~joe
  ```

  The first writer opens Arbor locally and claims that complete address through the profile control. `--community` and `--first-writer` are required when a fresh server starts unattended; its initial community display name is the handle and may be edited later. `--url` supplies an explicit stable public origin for unusual HTTP or nonstandard-port deployments; standard HTTPS hosting may set `ARBOR_DOMAIN`. `--hostname` and `--port` separately control the network listener. Interactive defaults are `./.arbor-community`, `http://127.0.0.1:4318`, and the current OS user as first writer. Existing data restarts without bootstrap arguments. Railway supplies the listener port and `RAILWAY_PUBLIC_DOMAIN` supplies a generated public URL automatically. `ARBOR_HOST_DATA` selects host storage. `ARBOR_ACCOUNTS_JSON` or an initial `ARBOR_ACCOUNT_TOKEN` remain migration inputs; the legacy owner-token name is migration input only.
- **`arbor connect <community-url>`** — activate an already-issued account/device credential. It is recovery/account plumbing rather than onboarding.
- **`arbor status [<locator>]`** — show active community/account, boundary resolution, placement, access, and sync state.
- **`arbor connection set|test|remove <name>`** — administer safe database references while storing DSNs in the operating-system credential store.
- **`arbor run <locator> [--input …]`**, **`arbor bake <locator>`**, and **`arbor deploy <locator> [--watch]`** retain their script/publication meanings.

One host represents one community. Cross-community membership, multiple simultaneously active local identities, boundary aliases/moves, and end-user claim recovery/dispute resolution are deferred.

An operator-controlled development escape hatch can rotate a known account credential without changing its profile tree: set `ARBOR_RESET_ACCOUNT=<handle>` and a replacement `ARBOR_ACCOUNT_TOKEN` on the host for one restart, then remove the reset variable. The replacement must be `arb_` followed by 64 lowercase hexadecimal characters. Arbor never prints it. This is deployment recovery plumbing, not end-user claim recovery or dispute resolution.
