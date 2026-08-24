# Remote trial deployment

The quickest realistic trial is one Railway service with one persistent volume and one public domain. The hosted process is only the community authority and wire gateway. Profile claiming and editing happen in Arbor web running locally on your own machine.

For multi-machine synchronization, outage, and conflict testing rather than a single-user trial, use the deliberately small [hcloud sync lab](hcloud-sync-lab.md): one disposable community VM, three client VMs, Tailscale, and no infrastructure framework. Its checked-in `bun run lab:hcloud` runner supports preflight, resumable provisioning, evidence collection, and exact-ID teardown.

## Railway

The repository already contains `Dockerfile.host` and `railway.toml`. Railway builds that image, checks `/.arbor/health`, supplies `PORT`, and restarts a failed process. Arbor refuses to initialize on Railway until both a public domain and persistent volume exist, preventing accidental canonical `localhost` URLs or ephemeral authority state.

1. Push this Arbor branch to a GitHub repository that Railway can access.
2. In Railway, create a project and add a service from that repository. The first attempted start may fail safely while the required domain and volume are absent.
3. Attach a volume to the service at `/data`. Railway then supplies `RAILWAY_VOLUME_MOUNT_PATH`; Arbor stores its SQLite authority and immutable objects there.
4. Under **Networking**, either generate a Railway domain or add your own domain. For a custom domain, add both the CNAME and TXT records Railway shows. Railway terminates TLS.
5. Under **Settings → Deploy**, set the start command, choosing your own community and first-writer handles:

   ```sh
   bun run arbor serve --community garden --first-writer joe
   ```

   Arbor initially uses `garden` as the community profile's display name; its writer can edit that profile later. With a Railway-provided domain, Arbor derives the canonical URL from `RAILWAY_PUBLIC_DOMAIN`. For a custom domain, add one service variable containing the hostname (without a scheme):

   ```text
   ARBOR_DOMAIN=garden.example.com
   ```

   Do not set an owner token or account JSON for the claim-first trial. If an unusual deployment really needs plain HTTP or a nonstandard public port, pass a complete `--url` in the start command instead of setting `ARBOR_DOMAIN`.
6. Redeploy. Keep the service at one replica: this reference authority uses SQLite and one mounted volume.
7. Verify the deployment:

   ```sh
   curl -fsS https://garden.example.com/.arbor/health
   curl -fsS https://garden.example.com/~joe
   ```

   The first response is `{"status":"ok"}`. The second is the unclaimed profile page and tells you to open Arbor locally.

Railway volumes persist across deploys and restarts. Restart or redeploy the service after claiming and confirm that the profile URL still resolves. Configure volume backups before using the authority for anything non-disposable.

Railway references: [Docker/config-as-code](https://docs.railway.com/config-as-code/reference), [public domains and ports](https://docs.railway.com/public-networking), [custom-domain DNS](https://docs.railway.com/networking/domains/working-with-domains), and [persistent volumes](https://docs.railway.com/volumes).

## Claim through local Arbor web

From this checkout on your own Mac:

```sh
bun install
bun run build:web
bun run arbor browse https://garden.example.com/~joe
```

In Arbor web:

1. Select **Claim profile** on the empty reserved profile.
2. Choose a visible local folder such as `~/.arbor/profile`.
3. Select **Claim profile** in the sheet.

The local arbord creates or validates a `type: person` profile, submits it to the remote authority, stores the returned device credential in the operating-system credential store, and mounts the profile locally. No claim credential appears in the browser URL, shell history, Arbor content, or server logs.

After claiming, create a small folder elsewhere on the Mac and use **Share** to publish it at `/~joe/test` with **Public read**. Verify `https://garden.example.com/~joe/test` remotely. The source folder should remain at its original OS path and should not appear as a duplicate inside the physical profile folder.

First-claim-wins is deliberately the current v1 policy. Claim the first-writer profile promptly and treat this deployment as disposable until end-user recovery and dispute resolution exist.

### Development credential reset

If a trial device credential is lost, the community operator can rotate that account's token without changing its profile tree or content:

1. Generate a replacement locally and keep the resulting value private:

   ```sh
   printf 'arb_'; openssl rand -hex 32
   ```

2. Temporarily add two Railway service variables: `ARBOR_RESET_ACCOUNT=joe` and `ARBOR_ACCOUNT_TOKEN=<the replacement>`.
3. Deploy the current Arbor version once. The server reports only that the credential was reset; it never prints the token.
4. On the local device, run `arbor connect https://garden.example.com` and paste the replacement when prompted.
5. Remove both temporary Railway variables and redeploy normally.

This is an operator escape hatch for disposable development hosts, not a public recovery or claim-dispute protocol.

## VPS with Docker Compose

Point an A/AAAA record for your chosen domain at the VPS, install Docker with Compose, and copy or clone this repository there. Then:

```sh
cd deploy
cp .env.example .env
```

Edit `.env` so `ARBOR_DOMAIN` is the real hostname and `COMMUNITY_HANDLE` and `FIRST_WRITER_HANDLE` have the values you want. Compose passes the latter two to `arbor serve` as arguments. Start the service:

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

Do not run multiple Arbor replicas against the same SQLite authority volume.
