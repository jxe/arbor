# Remote trial deployment

The quickest realistic trial is one Railway service with one persistent volume and one public domain. The hosted process is only the community authority and wire gateway. Profile claiming and editing happen in TreeHopper running locally on your own machine.

## Railway

The repository already contains `Dockerfile.host` and `railway.toml`. Railway builds that image, checks `/.arbor/health`, supplies `PORT`, and restarts a failed process. Arbor refuses to initialize on Railway until both a public domain and persistent volume exist, preventing accidental canonical `localhost` URLs or ephemeral authority state.

1. Push this Arbor branch to a GitHub repository that Railway can access.
2. In Railway, create a project and add a service from that repository. The first attempted start may fail safely while the required domain and volume are absent.
3. Attach a volume to the service at `/data`. Railway then supplies `RAILWAY_VOLUME_MOUNT_PATH`; Arbor stores its SQLite authority and immutable objects there.
4. Under **Networking**, either generate a Railway domain or add your own domain. For a custom domain, add both the CNAME and TXT records Railway shows. Railway terminates TLS.
5. Add these service variables:

   ```text
   ARBOR_COMMUNITY_HANDLE=garden
   ARBOR_COMMUNITY_NAME=Garden
   ARBOR_FIRST_WRITER_HANDLE=joe
   ```

   With a Railway-provided domain, Arbor derives the canonical URL from `RAILWAY_PUBLIC_DOMAIN`. For a custom domain, also set the stable canonical address explicitly:

   ```text
   ARBOR_PUBLIC_ORIGIN=https://garden.example.com
   ```

   Do not set an owner token or account JSON for the claim-first trial.
6. Redeploy. Keep the service at one replica: this reference authority uses SQLite and one mounted volume.
7. Verify the deployment:

   ```sh
   curl -fsS https://garden.example.com/.arbor/health
   curl -fsS https://garden.example.com/~joe
   ```

   The first response is `{"status":"ok"}`. The second is the unclaimed profile page and tells you to open Arbor locally.

Railway volumes persist across deploys and restarts. Restart or redeploy the service after claiming and confirm that the profile URL still resolves. Configure volume backups before using the authority for anything non-disposable.

Railway references: [Docker/config-as-code](https://docs.railway.com/config-as-code/reference), [public domains and ports](https://docs.railway.com/public-networking), [custom-domain DNS](https://docs.railway.com/networking/domains/working-with-domains), and [persistent volumes](https://docs.railway.com/volumes).

## Claim through local TreeHopper

From this checkout on your own Mac:

```sh
bun install
bun run build:web
bun link
arbor browse ~/Arbor
```

In TreeHopper:

1. Open the persistent profile control in the top-right corner.
2. Paste the complete reserved profile URL, for example `https://garden.example.com/~joe`.
3. Choose a visible local folder such as `/Users/joe/Arbor/joe`.
4. Select **Claim profile**.

The local arbord creates or validates a `type: person` profile, submits it to the remote authority, stores the returned device credential in the operating-system credential store, and mounts the profile locally. No claim credential appears in the browser URL, shell history, Arbor content, or server logs.

After claiming, create a small folder elsewhere on the Mac and use **Share** to publish it at `/~joe/test` with **Public read**. Verify `https://garden.example.com/~joe/test` remotely. The source folder should remain at its original OS path and should not appear as a duplicate inside the physical profile folder.

First-claim-wins is deliberately the current v1 policy. Claim the first-writer profile promptly and treat this deployment as disposable until claim recovery and administrative reset exist.

## VPS with Docker Compose

Point an A/AAAA record for your chosen domain at the VPS, install Docker with Compose, and copy or clone this repository there. Then:

```sh
cd deploy
cp .env.example .env
```

Edit `.env` so `ARBOR_DOMAIN` and `ARBOR_PUBLIC_ORIGIN` use the real domain and the community/first-writer values are correct. Start the service:

```sh
docker compose up -d --build
docker compose logs -f arbor
```

Caddy obtains and renews TLS certificates and proxies to Arbor. The named `arbor-data` volume survives container replacement, while `restart: unless-stopped` brings both processes back after a crash or VPS reboot. Verify and claim through local TreeHopper exactly as in the Railway flow.

For upgrades:

```sh
git pull --ff-only
docker compose up -d --build
```

Do not run multiple Arbor replicas against the same SQLite authority volume.
