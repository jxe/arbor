# Deploying a host

Files in this directory:

- `Dockerfile.canopyd` and the root `railway.toml`: the image Railway builds and how it runs it.
- `railway-canopy.ts` (`bun run canopy:railway`) and `canopies/<domain>.env`: managed Railway hosts as reviewable desired state.
- `docker-compose.yml`, `Caddyfile`, `.env.example`: the VPS recipe.
- `hcloud-sync-lab.md` and `hcloud-sync-lab/` (`bun run lab:hcloud`): a disposable multi-machine lab for synchronization, outage, and conflict testing.

The quickest realistic trial is one Railway service with one persistent volume and one public domain. The hosted process is only canopyd, the community host and protocol gateway. Profile claiming and editing happen in Canopy for the web running locally on your own machine.

For multi-machine synchronization, outage, and conflict testing rather than a single-user trial, use the deliberately small [hcloud sync lab](hcloud-sync-lab.md): one disposable community VM, three client VMs, Tailscale, and no infrastructure framework. Its checked-in `bun run lab:hcloud` runner supports preflight, resumable provisioning, evidence collection, and exact-ID teardown.

## Railway

The repository already contains `packages/canopyd/deploy/Dockerfile.canopyd` and `railway.toml`. Railway builds that image, checks `/`, supplies `PORT`, and restarts a failed process. canopyd refuses to initialize on Railway until both a public domain and persistent volume exist, preventing accidental canonical `localhost` URLs or ephemeral canopyd state.

1. Push this Overstory branch to a GitHub repository that Railway can access.
2. In Railway, create a project and add a service from that repository. The first attempted start may fail safely while the required domain and volume are absent.
3. Attach a volume to the service at `/data`. Railway then supplies `RAILWAY_VOLUME_MOUNT_PATH`; canopyd stores its SQLite and immutable objects there.
4. Under **Networking**, either generate a Railway domain or add your own domain. For a custom domain, add both the CNAME and TXT records Railway shows. Railway terminates TLS.
5. Create the founder's profile identity locally with `arbor me create`, then
   run `arbor me` and copy its public Profile TreeID. The start command is
   `bun run canopyd serve`; an unattended host creates its community from
   three service variables on the first start with an empty volume and
   ignores them afterwards:

   ```text
   ARBOR_COMMUNITY_HANDLE=garden
   ARBOR_FIRST_WRITER_HANDLE=joe
   ARBOR_FIRST_WRITER_PROFILE=tr_...
   ```

   The community's display name starts as its handle; its writer can edit the profile later. (On your own machine the same step is `canopyd init garden --founder joe=tr_...`.) With a Railway-provided domain, canopyd derives the canonical URL from `RAILWAY_PUBLIC_DOMAIN`. For a custom domain, add one service variable containing the hostname (without a scheme):

   ```text
   ARBOR_DOMAIN=garden.example.com
   ```

   Do not set an owner token or account JSON for the claim-first trial. If an unusual deployment really needs plain HTTP or a nonstandard public port, pass a complete `--url` in the start command instead of setting `ARBOR_DOMAIN`.
6. Redeploy. Keep the service at one replica: this canopyd uses SQLite and one mounted volume.
7. Verify the deployment:

   ```sh
   curl -fsS https://garden.example.com/.arbor/health
   curl -fsS https://garden.example.com/~joe
   ```

   The first response is `{"status":"ok"}`. The second is the unclaimed profile page and tells you to claim it from Canopy.

Railway volumes persist across deploys and restarts. Restart or redeploy the service after claiming and confirm that the profile URL still resolves. Configure volume backups before using the canopyd for anything non-disposable. Keep this SQLite canopyd at one replica.

Railway references: [Docker/config-as-code](https://docs.railway.com/config-as-code/reference), [public domains and ports](https://docs.railway.com/public-networking), [custom-domain DNS](https://docs.railway.com/networking/domains/working-with-domains), and [persistent volumes](https://docs.railway.com/volumes).

### Managed Railway Canopies

For repeatable deployments, keep each host's non-secret desired state in
`packages/canopyd/deploy/canopies/<domain>.env` and use the repository lifecycle command:

```sh
bun run canopy:railway apply packages/canopyd/deploy/canopies/arb.nxhx.org.env
bun run canopy:railway status packages/canopyd/deploy/canopies/arb.nxhx.org.env
```

`apply` is idempotent. It requires the checked-out revision to be published on
the configured GitHub branch, then creates or reconciles a `canopy-*` Railway
service in the linked project's production environment, configures its Docker
build, start command, and health check, attaches one `/data` volume, sets the
public-domain and bootstrap-handle variables, adds the custom domain, connects
the service to the repository, and prints the CNAME and TXT records that still
need to be installed at the DNS provider. Railway remains the runtime registry;
the checked-in file is the reviewable desired state and contains no credentials.

Destruction is deliberately explicit and exact:

```sh
bun run canopy:railway destroy packages/canopyd/deploy/canopies/arb.nxhx.org.env --yes
```

It deletes only the manifest's `canopy-*` service and its attached volume. DNS
records are external and must be removed separately. Do not put tokens,
passwords, account credentials, or proof secrets in a host deployment file.

## canopyd runtime environment

canopyd reads these variables at start; all are optional.

| Variable | Default | Meaning |
|---|---|---|
| `ARBOR_CANOPY_DATA` | `/data` in the image | Data directory: `canopy.sqlite3` plus `objects/`. |
| `ARBOR_DOMAIN` | from `RAILWAY_PUBLIC_DOMAIN` | Public hostname used to derive the canonical URL; pass `--url` instead for plain HTTP or a nonstandard port. |
| `ARBOR_OBJECT_CACHE_MB` | 256 | In-memory cache of hash-verified immutable objects; the merge worker reads through the same store. |
| `ARBOR_STATE_PROOF_MB` | 64 | Ceiling for one retained-state proof. Live proofs weigh about 36 MB; a lower ceiling silently rejects every proof and re-validates each request. |
| `ARBOR_HISTORY_CACHE_MB` | 256 | History validation cache. A 16 MB cache thrashed and gave no benefit. |
| `ARBOR_CANOPY_NO_WARMUP` | unset | Set to skip the background warm-up of every tree's current semantic state at startup; the first edit after a restart then pays that cost. |
| `ARBOR_MERGE_EXECUTABLE` | the workspace `arbor-merge` | Alternate merge worker implementing `serve`; see [the merge tool](../../../docs/architecture/canopyd/merge-tool.md#running-and-configuring). |

### Health and readiness

`GET /` is the readiness probe; Railway checks it. `GET /.arbor/health` runs a
full historical integrity audit of the database and object store. It is a
maintenance command, not a readiness check: it can exceed a short request
timeout, and polling it has exhausted the memory of a live instance. Call it
deliberately, once, after a deploy or migration.

### Durability

canopyd runs SQLite in WAL mode with `PRAGMA synchronous = NORMAL`. A process
crash loses nothing. An OS crash or power loss can lose the most recent
commits but cannot corrupt the database. Objects are fsynced before the commit
that names them, so a lost commit leaves only unreferenced objects, never a
reference to missing bytes. Back up with an application-consistent copy
(`VACUUM INTO`) plus a tar of `objects/`, as the [migration procedure](../migrations/README.md) does.

Old binaries cannot read retained-state objects written by newer ones. After
a newer canopyd has accepted writes, rolling back needs either a compatible
reader or a coordinated restoration of the backup taken before the upgrade.

## Claim through local Canopy for the web

From this checkout on your own Mac:

```sh
bun install
bun run build:web
bun run arbor -- me create
bun run arbor -- open https://garden.example.com/~joe
```

In Canopy for the web:

1. Select **Claim profile** on the empty reserved profile.
2. Confirm the existing local profile folder, normally `~/.arbor/profile`.
3. Select **Claim profile** in the sheet.

The local profile and its self-certifying Profile TreeID already exist before
the claim. Arbor Sync generates the account-configuration TreeID, DeviceID, and
device credential locally, signs canopyd's challenge with the profile key, and
submits the initial configuration. canopyd verifies the exact reserved profile,
stores only the credential digest, and never receives the profile private key
or returns the raw credential. The resulting `account.yaml`, `trees.yaml`, and
`devices.yaml` checkout is installed beneath
`${ARBOR_DATA_HOME:-~/.arbor}`; implementation state lives beneath its excluded
`.state` mount.

After claiming, create a small folder elsewhere on the Mac and use **Share** to publish it at `/~joe/test` with **Public read**. The UI obtains a fresh client-generated TreeID, source-preservingly adds its declaration and `everyone: read` rule to `trees.yaml`, adds the local path to the current device's `placements`, and initializes the reserved tree. Verify `https://garden.example.com/~joe/test` remotely. The source folder remains at its original OS path.

The reservation names one exact self-certifying Profile TreeID, so an unrelated
client cannot win the account by claiming first. Treat the deployment as
recoverable only to the extent that its profile-key backup, canopyd backup, and
documented restore procedure have actually been tested; end-user dispute and
administrator recovery flows remain future product work.

## Coordinated alpha upgrades

Arbor Sync, canopyd, the TypeScript and Swift clients, the specification, and
the fixtures share one alpha protocol version. Three kinds of change need
different care:

- **Code-only deploys** change neither the schema nor the protocol. Deploy the
  host alone; no writer pause, migration, or client restart is needed.
- **Schema or configuration changes** follow the [migration procedure](../migrations/README.md):
  quiesce writers, back up, rehearse on a copy, migrate once, verify.
- **Protocol changes** that clients send or receive need the coordinated
  cutover below, because an old client cannot talk to a new host and a new
  client cannot talk to an old host.

### Release order

Deploy and verify host acceptance of each new operation and its input forms
before releasing clients that send them. These are separate releases with a
dependency, not simultaneous upgrades. Keep baseline client builds and test
them against newer hosts. A host rollback must keep honoring every semantic
and every accepted state already in use by released clients; disabling new
conflict creation must not discard existing alternatives or their resolution
paths. Never downgrade a host to a binary that can discard accepted
alternatives, and never run an older host over state whose root choices it
cannot represent.

### Coordinated cutover

1. While the old builds still run, stop authoring and settle every app and
   daemon. Verify each tree's accepted update and exact root, and that no
   uncertain pending request, held conflict request, or unattempted suffix
   remains. Matching file roots is not proof that pending work is settled.
   Preserve backups of host and client durable state.
2. If any old request is ambiguous or still held, keep the old builds
   available and complete its recovery or review first. Never manufacture new
   IDs for an old transmitted request, edit stored digests, clear client
   state, or rebase it from the latest files. An uncertain request in the old
   format is settled with the old build; it cannot be translated into a new
   request identity. Postpone the cutover for that work if necessary.
3. Stop old writers and upgrade canopyd, Arbor Sync, and every client
   together. Do not let old clients resume against the new host. Immutable
   objects and accepted history stay intact; old request digests remain
   historical records.
4. Reopen each client and verify descriptor, snapshot, and watch convergence.
   Submit an ordinary edit and verify its retained request has a stable change
   ID. Exercise an exact prepared retry in a disposable test tree. Traffic the
   host does not support must return the explicit unsupported response with no
   accepted-state change.
5. Resume authoring only after every participating client is upgraded. If
   rollback is necessary, stop all writers and restore a mutually compatible
   host and client set together with its verified durable state; never
   downgrade one active participant in isolation.

Before any live cutover, audit every offline, native, and filesystem queue and
adopted prefix, and resolve unknown outcomes with the original request body
and the old build. Neither client rewrites an incompatible pending record: the
daemon rejects it on load, and the native coordinator rejects it before
submission, so the old bytes stay on disk for recovery.

Online checkpoints are not quiet-writer rollback boundaries. A backup taken
while writers were active is recovery evidence, not permission to discard work
accepted or authored after it.

### Verifying a candidate host

For an existing canopyd:

1. Stop every known arborsync writer and record the exact deployed revision,
   current tree identities and refs, ACLs, accepted-update boundaries,
   public-output hashes, SQLite integrity, and immutable-object integrity.
2. Create an application-consistent SQLite backup plus the complete
   immutable-object store. Retain an off-volume copy and prove it starts under
   the old image.
3. Start the exact candidate revision against a separate restored copy.
   Require restart-idempotent schema and configuration migration and exact
   equivalence of identities, refs, history, boundaries, ACLs, public output,
   objects, accounts, and active devices.
4. Rehearse each real local data home from a copy. Require preserved authored
   bytes and placement metadata, private state beneath `.state`, and a valid
   installed account-configuration checkout.
5. Package the way production does: copy the Dockerfile's package payload to
   an isolated directory, install with frozen production-only dependencies
   under Bun 1.3.14, run the merge worker outside the checkout, and push one
   real merge through canopyd's response and closure validation before
   building the Linux image.
6. Only after those rehearsals, deploy the exact tested commit and verify the
   host before reconnecting clients.
7. Claim or pair each real device through Canopy to install its account
   configuration checkout, then rebuild or restart packaged clients.
8. Wait for every placement to become idle with local refs equal to host
   refs, confirm that authored snapshots did not change, and run an isolated
   private synchronization and revocation smoke. Restore the complete backup
   and old image on any equivalence failure.

Never put raw credentials, credential digests, access-link secrets, or user
content in a migration report or shell history.

### Upgrading the Canopy apps

Close both apps before installing. Back up the complete `.arbor` data home
with each SQLite database replaced by a consistent SQLite backup and
integrity-checked; keep the previous Mac bundle beside the new one; keep the
phone's application Library, including its active coordinator; keep per-file
SHA-256 manifests. On the Mac, preserve the existing `/Applications/Canopy.app`
symlink and replace its target with the tested signed bundle; do not launch
the app from the installer. Install the phone last: an old build cannot sync
against a host whose routes changed.

Do not restore an older snapshot-only app over an active source journal; it
cannot publish that journal. Local coordinator schema 3 is source mode; a
coordinator that was never reopened stays at schema 2 and selects source mode
on its next open once its legacy work is settled.

## VPS with Docker Compose

Point an A/AAAA record for your chosen domain at the VPS, install Docker with Compose, and copy or clone this repository there. Then:

```sh
cd deploy
cp .env.example .env
```

Create the founder's identity locally with `arbor me create`, and copy its
Profile TreeID from `arbor me`. Edit `.env` so `ARBOR_DOMAIN` is the real
hostname, `COMMUNITY_HANDLE` and `FIRST_WRITER_HANDLE` have the values you
want, and `FIRST_WRITER_PROFILE` is that exact TreeID. Compose passes all three
bootstrap values to `canopyd serve` as environment variables; they matter only
on the first start with an empty volume. Start the service:

```sh
docker compose up -d --build
docker compose logs -f arbor
```

Caddy obtains and renews TLS certificates and proxies to canopyd. The named `arbor-data` volume survives container replacement, while `restart: unless-stopped` brings both processes back after a crash or VPS reboot. Verify and claim through local Canopy for the web exactly as in the Railway flow.

For upgrades:

```sh
git pull --ff-only
docker compose up -d --build
```

Do not run multiple canopyd replicas against the same canopyd SQLite volume.
