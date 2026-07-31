# CLI
*Part of the [Arbor spec](../spec.md): the intended command surface. Implementation status belongs in [plan.md](../plan.md).*

Every content operand is an Arbor [locator](locators.md). The CLI resolves through arbord and has no private storage API.

## Porcelain

- **`arbor browse <locator>`** — open TreeHopper at a live or historical location.
- **`arbor share <local-path> <canonical-url> <audience>`** — promote a visible subtree in place beneath a writable profile. Audience is required: `--private`, `--public-read`, `--public-write`, or `--with <profile-url>`.
- **`arbor sync <local-path> <canonical-url> [audience]`** — idempotently promote/reconcile a local directory and its canonical boundary.
- **`arbor sync <canonical-url> <local-path>`** — idempotently place and follow a remote tree; a revision suffix produces a pinned read-only placement.
- **`arbor unsync <local-path>`** — remove one placement relationship without deleting files, remote identity, or history.

Canonical URLs may have arbitrary mounted depth:

```sh
arbor share ~/projects/atlas arbor://garden.example/~alice/atlas --private
arbor share ~/editors/handbook arbor://garden.example/~editors/handbook --public-read
arbor sync arbor://garden.example/~editors/handbook ~/work/handbook
```

Promotion never moves an external folder into the profile directory. The canonical child is a virtual mount over the existing OS placement.

## Plumbing

- **`arbor serve [data-directory]`** — run one community authority/live HTTP gateway. A fresh server reserves a first-writer profile; no credential needs to be invented or copied:

  ```sh
  arbor serve ./garden --name "Garden" --community garden --first-writer joe
  # First writer profile: http://127.0.0.1:4318/~joe
  ```

  The first writer opens Arbor locally and claims that complete address through the profile control. `--url` supplies the stable public canonical URL; `--hostname` and `--port` separately control the network listener. Defaults are `./.arbor-community`, `http://127.0.0.1:4318`, and the current OS user as first writer. Existing data restarts without bootstrap arguments. Railway supplies the listener port and `RAILWAY_PUBLIC_DOMAIN` supplies the public URL automatically. Other unattended deployments may use `ARBOR_PUBLIC_ORIGIN`, `ARBOR_HOST_DATA`, community metadata, and `ARBOR_ACCOUNTS_JSON` or an initial `ARBOR_ACCOUNT_TOKEN`; the legacy owner-token name is migration input only.
- **`arbor connect <community-url>`** — activate an already-issued account/device credential. It is recovery/account plumbing rather than onboarding.
- **`arbor status [<locator>]`** — show active community/account, boundary resolution, placement, access, and sync state.
- **`arbor connection set|test|remove <name>`** — administer safe database references while storing DSNs in the operating-system credential store.
- **`arbor run <locator> [--input …]`**, **`arbor bake <locator>`**, and **`arbor deploy <locator> [--watch]`** retain their script/publication meanings.

One host represents one community. Cross-community membership, multiple simultaneously active local identities, boundary aliases/moves, and claim recovery/reset are deferred.
