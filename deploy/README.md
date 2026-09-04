# Remote trial deployment

The quickest realistic trial is one Railway service with one persistent volume and one public domain. The hosted process is only the community Canopy server and wire gateway. Profile claiming and editing happen in Arbor web running locally on your own machine.

For multi-machine synchronization, outage, and conflict testing rather than a single-user trial, use the deliberately small [hcloud sync lab](hcloud-sync-lab.md): one disposable community VM, three client VMs, Tailscale, and no infrastructure framework. Its checked-in `bun run lab:hcloud` runner supports preflight, resumable provisioning, evidence collection, and exact-ID teardown.

## Railway

The repository already contains `Dockerfile.canopy` and `railway.toml`. Railway builds that image, checks `/`, supplies `PORT`, and restarts a failed process. Arbor refuses to initialize on Railway until both a public domain and persistent volume exist, preventing accidental canonical `localhost` URLs or ephemeral Canopy state.

1. Push this Arbor branch to a GitHub repository that Railway can access.
2. In Railway, create a project and add a service from that repository. The first attempted start may fail safely while the required domain and volume are absent.
3. Attach a volume to the service at `/data`. Railway then supplies `RAILWAY_VOLUME_MOUNT_PATH`; Arbor stores its Canopy SQLite and immutable objects there.
4. Under **Networking**, either generate a Railway domain or add your own domain. For a custom domain, add both the CNAME and TXT records Railway shows. Railway terminates TLS.
5. Create the founder's profile identity locally with `arbor me create`, then
   run `arbor me` and copy its public Profile TreeID. Under **Settings →
   Deploy**, set the start command with that exact identity and your chosen
   community and first-writer handles:

   ```sh
   bun run canopyd -- --community garden --first-writer joe \
     --first-writer-profile tr_...
   ```

   Arbor initially uses `garden` as the community profile's display name; its writer can edit that profile later. With a Railway-provided domain, Arbor derives the canonical URL from `RAILWAY_PUBLIC_DOMAIN`. For a custom domain, add one service variable containing the hostname (without a scheme):

   ```text
   ARBOR_DOMAIN=garden.example.com
   ```

   Do not set an owner token or account JSON for the claim-first trial. If an unusual deployment really needs plain HTTP or a nonstandard public port, pass a complete `--url` in the start command instead of setting `ARBOR_DOMAIN`.
6. Redeploy. Keep the service at one replica: this reference Canopy server uses SQLite and one mounted volume.
7. Verify the deployment:

   ```sh
   curl -fsS https://garden.example.com/.arbor/health
   curl -fsS https://garden.example.com/~joe
   ```

   The first response is `{"status":"ok"}`. The second is the unclaimed profile page and tells you to open Arbor locally.

Railway volumes persist across deploys and restarts. Restart or redeploy the service after claiming and confirm that the profile URL still resolves. Configure volume backups before using the Canopy server for anything non-disposable. Keep this SQLite reference Canopy server at one replica.

Railway references: [Docker/config-as-code](https://docs.railway.com/config-as-code/reference), [public domains and ports](https://docs.railway.com/public-networking), [custom-domain DNS](https://docs.railway.com/networking/domains/working-with-domains), and [persistent volumes](https://docs.railway.com/volumes).

### Managed Railway Canopies

For repeatable deployments, keep each Canopy's non-secret desired state in
`deploy/canopies/<domain>.env` and use the repository lifecycle command:

```sh
bun run canopy:railway apply deploy/canopies/arb.nxhx.org.env
bun run canopy:railway status deploy/canopies/arb.nxhx.org.env
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
bun run canopy:railway destroy deploy/canopies/arb.nxhx.org.env --yes
```

It deletes only the manifest's `canopy-*` service and its attached volume. DNS
records are external and must be removed separately. Do not put tokens,
passwords, account credentials, or proof secrets in a Canopy deployment file.

## Claim through local Arbor web

From this checkout on your own Mac:

```sh
bun install
bun run build:web
bun run arbor -- me create
bun run arbor -- open https://garden.example.com/~joe
```

In Arbor web:

1. Select **Claim profile** on the empty reserved profile.
2. Confirm the existing local profile folder, normally `~/.arbor/profile`.
3. Select **Claim profile** in the sheet.

The local profile and its self-certifying Profile TreeID already exist before
the claim. Arbor Sync generates the account-configuration TreeID, DeviceID, and
device credential locally, signs Canopy's challenge with the profile key, and
submits the initial configuration. Canopy verifies the exact reserved profile,
stores only the credential digest, and never receives the profile private key
or returns the raw credential. The resulting `account.yaml`, `trees.yaml`, and
`devices.yaml` checkout is installed beneath
`${ARBOR_DATA_HOME:-~/.arbor}`; implementation state lives beneath its excluded
`.state` mount.

After claiming, create a small folder elsewhere on the Mac and use **Share** to publish it at `/~joe/test` with **Public read**. The UI obtains a fresh client-generated TreeID, source-preservingly adds its declaration and `everyone: read` rule to `trees.yaml`, adds the local path to the current device's `placements`, and initializes the reserved tree. Verify `https://garden.example.com/~joe/test` remotely. The source folder remains at its original OS path.

The reservation names one exact self-certifying Profile TreeID, so an unrelated
client cannot win the account by claiming first. Treat the deployment as
recoverable only to the extent that its profile-key backup, Canopy backup, and
documented restore procedure have actually been tested; end-user dispute and
administrator recovery flows remain future product work.

## Coordinated alpha upgrades

Arbor Sync, the Canopy server, TypeScript and Swift clients, specifications, and fixtures share one alpha protocol version. Do not deploy a wire-contract or account-configuration change while an old arborsync is still writing, and do not start a new arborsync against an old Canopy server.

For an existing Canopy server:

1. Stop every known arborsync writer and record the exact deployed revision, current tree identities and refs, ACLs, accepted-update boundaries, public-output hashes, SQLite integrity, and immutable-object integrity.
2. Create an application-consistent SQLite backup plus the complete immutable-object store. Retain an off-volume copy and prove it starts under the old image.
3. Start the exact candidate revision against a separate restored copy. Require restart-idempotent schema/configuration migration and exact equivalence of identities, refs, history, boundaries, ACLs, public output, objects, accounts, and active devices.
4. Rehearse each real local data home from a copy. Require preserved authored bytes and placement metadata, private-state relocation beneath `.state`, and a valid installed account-configuration checkout.
5. Only after those rehearsals, deploy the exact tested commit. Verify the Canopy server before reconnecting clients.
6. Claim or pair each real device through Arbor to install its account configuration checkout, then rebuild/restart packaged clients.
7. Wait for every placement to become idle with local refs equal to server refs, confirm that authored snapshots did not change, and run an isolated private synchronization/revocation smoke. Restore the complete backup and old image on any Canopy equivalence failure.

Never put raw credentials, credential digests, access-link secrets, or user content in a migration report or shell history.

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
bootstrap values to `canopyd`. Start the service:

```sh
docker compose up -d --build
docker compose logs -f arbor
```

Caddy obtains and renews TLS certificates and proxies to Arbor. The named `arbor-data` volume survives container replacement, while `restart: unless-stopped` brings both processes back after a crash or VPS reboot. Verify and claim through local Arbor web exactly as in the Railway flow.

For upgrades:

```sh
git pull --ff-only
docker compose up -d --build
```

Do not run multiple Arbor replicas against the same Canopy SQLite volume.
