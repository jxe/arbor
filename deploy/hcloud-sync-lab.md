# hcloud sync lab

This plan exercises Arbor synchronization on real, disposable Linux machines without building a general deployment platform. The first lab has exactly four Hetzner Cloud VMs:

```text
arbor-community    canonical authority and wire gateway
arbor-alice        client A
arbor-bob          client B
arbor-carol        client C
```

The machines use their ordinary root disks and communicate through Tailscale. There is no Terraform/OpenTofu, Kubernetes, load balancer, Hetzner private network, attached volume, DNS setup, or TLS proxy in the baseline lab. `hcloud` creates, starts, stops, and deletes the VMs; ordinary Linux commands inject network faults.

The lab is disposable. Use a separate Hetzner project, a dedicated Tailscale machine group if desired, a generated Arbor account credential, and content that can be deleted.

## What this lab must establish

The lab should answer four questions with recorded evidence:

1. **Liveness:** when one client changes a tree and the network is healthy, do the other clients eventually receive the exact bytes?
2. **Safety:** during outages and divergence, does Arbor avoid silently overwriting any client's authored content?
3. **Convergence:** after connectivity returns and conflicts are explicitly resolved, do all non-pinned placements reach the same tree ref and bytes?
4. **Identity:** does one `TreeID` remain the same when materialized at different paths and, later, on different filesystems?

The lab tests `updates-v1`, not the removed whole-tree CAS protocol. Independent Markdown additions must be merged by the authority and accepted as one new update. Unsafe binary, frontmatter, path-kind, and nested-boundary overlap must return one complete draft to the submitting client without creating accepted history, candidate-object, or conflict resources. The client must retain that response and its local files across restart until an explicit new update resolves it. Accepted history is inspected only as private host state; the lab also proves that history and non-current objects are absent from the wire API.

## Keep the infrastructure simple

Start with root disks only:

| Machine | Arbor content path | Purpose |
|---|---|---|
| `arbor-community` | `/var/lib/arbor-community` | Authority SQLite database and immutable objects |
| `arbor-alice` | `/home/arbor/lab` | Ordinary home-directory placement |
| `arbor-bob` | `/srv/arbor/lab` | Same trees at a different absolute path |
| `arbor-carol` | `/mnt/arbor/lab` | Same trees under a mount-shaped path |

These paths are enough to prove reader-local placement. They do not by themselves test different Linux devices or filesystem implementations. Add the loop-mounted filesystem variant near the end only after the baseline sync, outage, and conflict runs are understood.

Do not add a Hetzner Volume merely to preserve this disposable lab. Add one later only for the separate replacement-host durability test where the community VM must be destroyed and recreated without losing authority state.

## One-time setup

Install the official Hetzner CLI on the Mac and create a context for a dedicated Hetzner project:

```sh
brew install hcloud
hcloud context create arbor-lab
hcloud location list
```

The context command prompts for the project API token. Do not put that token in this repository or in a shell script. Hetzner's current CLI setup guide is [here](https://github.com/hetznercloud/cli/blob/main/docs/tutorials/setup-hcloud-cli.md).

Register an existing SSH public key with the project if it is not already present. Confirm the exact flag names with `hcloud ssh-key create --help`; `hcloud` was not installed on the development Mac when this plan was written, so the live CLI help is authoritative.

## Recommended rerunnable workflow

The repository includes a resumable runner for the ordinary four-VM workflow. It uses the direct `hcloud` CLI described below; it does not introduce an infrastructure framework. The default names and paths match this document.

```sh
bun run lab:hcloud preflight
bun run lab:hcloud run
```

`run` creates the four machines, installs the pinned Bun version from `.bun-version`, deploys the exact committed Git revision, initiates Tailscale login, and prints each node's approval URL (with an SSH command as a fallback). Approve those nodes interactively, then continue without recreating anything:

```sh
bun run lab:hcloud resume
bun run lab:hcloud smoke
bun run lab:hcloud test
```

`smoke` creates one private tree on Alice, places it on Bob and Carol, and requires identical SHA-256 manifests plus a healthy authority. `test` includes that smoke gate and then runs the mandatory accepted-update suite: serial A/B/C propagation, three-client offline Markdown additions, canonical semantic-request replay, a durable binary conflict with no private accepted-history entry, arbord restart, explicit client resolution, `/push` and public-history absence, current-object-only authorization, and device pairing/revocation. It fails on byte-manifest disagreement or missing authored markers, not merely on a status label.

The full `test` command is a pre-production gate. Run it from the exact committed candidate revision and collect its evidence before requesting approval to update Railway. Do not deploy the Railway authority first and use this lab as an after-check.

Local resume data lives in the ignored `.arbor-lab/<run-id>.json`. It contains exact server IDs, IP addresses, configuration, revision, and completed phases, but no Hetzner, Tailscale, or Arbor credentials. The disposable Arbor account token is generated and retained only in the authority's root-readable environment file; clients receive it over SSH on standard input while being configured.

Useful lifecycle commands are:

```sh
bun run lab:hcloud status
bun run lab:hcloud collect
bun run lab:hcloud down
```

`down` makes a best-effort evidence collection first, requests Tailscale logout, verifies every recorded server's name and run labels, and deletes only the four recorded Hetzner server IDs. If a run must be selected explicitly, add `--run-id <id>`. The underlying manual commands remain documented below as the recovery and inspection path.

## Create the four VMs

Use four small x86 Ubuntu machines in one location. `CX23`, `ubuntu-24.04`, and `nbg1` are reasonable starting values, but verify availability with `hcloud server-type list`, `hcloud image list`, and `hcloud location list` before creation.

```sh
for arbor_lab_node in community alice bob carol; do
  hcloud server create \
    --name "arbor-${arbor_lab_node}" \
    --type cx23 \
    --image ubuntu-24.04 \
    --location nbg1 \
    --ssh-key arbor-lab \
    --label purpose=arbor-sync-lab
done

hcloud server list --selector purpose=arbor-sync-lab
```

The four names are the complete deletion scope. Never use a broad account-wide delete command to tear down the lab.

On each VM:

1. Create an unprivileged `arbor` OS user for the Arbor processes and content.
2. Install Tailscale and authenticate it interactively. Avoid putting a reusable Tailscale auth key in cloud-init or this repository.
3. Give the node its matching hostname (`arbor-community`, `arbor-alice`, and so on).
4. Verify `tailscale ping arbor-community` from every client.
5. Install Git, Bun at the version pinned in `.bun-version`, and the small fault-injection tools `iptables` and `iproute2`.
6. Clone or copy the same Arbor revision to `/opt/arbor`, run `bun install --frozen-lockfile`, and record `git rev-parse HEAD`.

Keep public key-only SSH available as a recovery path during network experiments. Restrict Arbor's ports to `tailscale0`; the community gateway must not be reachable over the public interface. Once Tailscale works, a minimal UFW policy is sufficient:

```sh
sudo ufw default deny incoming
sudo ufw allow OpenSSH
sudo ufw allow in on tailscale0
sudo ufw enable
```

This intentionally leaves public SSH available while the lab is active. Tightening SSH to a known source IP is optional and should not complicate the first run.

## Run the community and clients

Use one generated, disposable initial device credential on all three clients for the synchronization matrix. The automated acceptance suite separately creates a short-lived paired device, proves it can read the test tree, revokes it, and proves the same credential is then denied. The runner keeps credentials in the authority's root-readable environment or in process memory and does not print them.

Run the community as one systemd service with the equivalent of:

```sh
cd /opt/arbor
bun run arbor serve /var/lib/arbor-community \
  --community sync-lab \
  --url http://arbor-community:4318 \
  --hostname 0.0.0.0 \
  --port 4318
```

The service's root-only environment file supplies `ARBOR_ACCOUNT_HANDLE=owner` and `ARBOR_ACCOUNT_TOKEN`. Tailscale MagicDNS makes `http://arbor-community:4318` stable within the lab. This is intentionally private HTTP inside the encrypted tailnet; public HTTPS projection is a separate deployment test.

On each client:

1. Create its content path from the table above.
2. Run `bun run arbor connect http://arbor-community:4318` and paste the same disposable credential.
3. Install `libsecret-1-0`, `gnome-keyring`, and `dbus-x11`, unlock a disposable login keyring inside a D-Bus session, and run one persistent headless arbord process using `bun run arbor browse <content-path> --no-open` under systemd. The checked-in runner configures this Secret Service environment for `Bun.secrets` automatically.

Stop the client service before adding a new placement with `arbor sync`, then start it again. This avoids two arbord processes mutating the same private state while the scenario is being prepared.

## Test discipline

Use a fresh Arbor tree for every scenario, named with a monotonic scenario ID such as `s01-a-to-all` or `s12-edit-delete`. A conflicted tree is evidence: do not overwrite or reuse it merely to continue the run. Start the next scenario with a new tree.

Every authored change contains a unique marker with the scenario, client, and sequence, for example:

```text
s05 bob 002 2026-08-02T17:30:00Z
```

For each scenario, record:

- Arbor Git commit on all four machines;
- scenario ID, `TreeID`, canonical URL, and starting authority ref;
- each client's path, `findmnt` result, and `stat -c '%d:%i %n'` for the tree root;
- exact file bytes or a sorted SHA-256 manifest before the fault, during it, and after recovery;
- each client's visible sync state;
- ending authority ref and the order in which clients reconnected;
- whether the result matched the expected outcome.

Never call a test passed based only on the green **Up to date** label. The refs and file hashes must also agree.

## Baseline: every synchronization direction

Create `s01` on Alice, promote it beneath the owner profile, and place the same `TreeID` on Bob and Carol at their local paths. Wait until all three byte manifests match.

The community authority is a mediator, not a fourth filesystem writer. “Server to client” is therefore covered by every peer receiving a ref already accepted by the authority, plus the fresh-placement case that materializes the authority's current ref without copying from another client.

Then run these serially from a clean, converged ref:

| Scenario | Author | Required receivers | Change |
|---|---|---|---|
| `s01-a-to-all` | Alice | Bob, Carol | Create a Markdown file and an ordinary binary file |
| `s02-b-to-all` | Bob | Alice, Carol | Edit Markdown and rename the binary file |
| `s03-c-to-all` | Carol | Alice, Bob | Add a directory, move the Markdown file into it, and edit it |
| `s04-fresh-pull` | Authority via the winning client | A new placement | Remove and recreate one client's placement at a new empty path |

For every row, require exact convergence on all three clients before starting the next row. Also restart the authoring client's arbord after its change and verify that restart does not create a new `TreeID` or duplicate canonical boundary.

Repeat the A/B/C ring once with changes made directly through the filesystem and once through Arbor web or REST mutations. This distinguishes filesystem observation from protocol mutation behavior.

## Outage and degraded-network scenarios

Use Linux fault injection for client-specific failures and `hcloud` power controls for whole-machine failures. Do not change the cloud topology between scenarios.

### Client-specific partition

On one client, block only the community gateway while leaving SSH available:

```sh
arbor_community_ip="$(getent ahostsv4 arbor-community | awk 'NR == 1 { print $1 }')"
sudo iptables -I OUTPUT \
  -d "$arbor_community_ip" \
  -p tcp --dport 4318 \
  -j REJECT
```

Confirm Arbor reports **Offline**, make a local edit, and verify no remote client receives it. Remove the exact rule with the corresponding `iptables -D` command and verify the edit eventually reaches the authority and both peers if no other writer advanced the tree.

If a rule is entered incorrectly, `hcloud server reboot arbor-<client>` is the recovery path; the injected `iptables` and `tc` rules are deliberately not persistent.

### Asymmetric timeout

On the community VM, drop input from exactly one client's Tailscale IP on port 4318. Other clients must continue synchronizing. Use `DROP`, not `REJECT`, to exercise timeout behavior. Remove the exact rule after the observation window.

### Complete community outage

```sh
hcloud server poweroff arbor-community
```

Verify that all clients become visibly offline while retaining readable local files. Test both:

- no local changes during the outage, followed by `hcloud server poweron arbor-community`;
- independent local changes on A, B, and C, followed by reconnecting clients one at a time in a recorded order.

The first case must converge without conflict. In the second case, the first accepted update advances the authority. Later Markdown candidates must preserve all independent additions through the authority merge. Unsafe candidates must remain complete on their originating client, receive a complete draft, and leave no authority history entry until the client explicitly resolves them with a new update.

Repeat the divergent case with reconnect orders `A → B → C`, `C → B → A`, and `B → A → C`. Use fresh trees for each order.

### Process crash and VM reboot

Test these separately because they have different failure surfaces:

1. Stop the Arbor community process while the VM and Tailscale remain reachable.
2. Kill the process during repeated client writes and let systemd restart it.
3. Run `hcloud server reboot arbor-community`.
4. Reboot each client once with a clean tree and once with an unpushed local edit.

After each case, the authority must expose either the complete old ref or the complete new ref, never a partially materialized snapshot. A client-local edit must remain present until it is pushed or explicitly resolved.

### Latency, loss, and reordering

On one client at a time, use `tc netem` on `tailscale0` to add approximately 600 ms latency with jitter, then packet loss, then reordering. Run these as separate scenarios before combining them. Keep A and B healthy while degrading C so healthy-client progress remains observable.

The pass condition is eventual convergence after `tc qdisc del dev tailscale0 root`, without duplicated files, corrupted Markdown, partial binary content, or a false permanent conflict when no concurrent writer existed.

## Conflict matrix

Each row begins from a shared, recorded base ref. Isolate the named clients, make both changes, restore connectivity, and reconnect them in both orders across two fresh trees.

| Scenario | Side A | Side B | Required safe outcome |
|---|---|---|---|
| Same Markdown slot | Add distinct lines at the same anchor | Add different lines | Accepted merge contains every line; approximate placement is reported when ordering is not exact |
| Different Markdown blocks | Edit the introduction | Edit a later section | Automatic accepted merge contains both edits |
| Different files | Edit `a.md` | Edit `b.md` | Automatic accepted merge contains both files |
| Create/create Markdown | Create different `notes.md` content | Create different `notes.md` content | Loss-averse Markdown merge, or a structured conflict if protected structure is incompatible |
| Frontmatter/frontmatter | Change one protected value | Change it differently | Client-owned `frontmatter-conflict`; complete draft; no authority history entry |
| Edit/delete | Edit `notes.md` | Delete `notes.md` | Edited alternative stays in the complete client draft; explicit resolution required |
| Rename/edit | Rename `notes.md` | Edit it at the old path | Structured path conflict; neither alternative disappears from client-owned state |
| Nested boundary | Change a registered boundary | Change content beneath it independently | `nested-boundary-conflict`; parent update never absorbs the child tree |
| Binary/binary | Replace a binary with A bytes | Replace it with B bytes | `binary-conflict`; local bytes and complete draft survive restart; no server conflict record |
| Three writers | A, B, and C add unique Markdown lines offline | Reconnect in a chosen order | All markers converge into accepted history regardless of reconnect order |

Also exercise Arbor-specific boundaries:

- edit a parent directory while another client promotes a nested subtree;
- attempt to replace a registered nested boundary and require `reserved-boundary` rather than ordinary overwrite;
- edit the parent and nested Arbor tree independently and confirm the two `TreeID` scopes do not contaminate one another;
- revoke a client's write access while it is offline with local edits, then reconnect it and require that the authority reject its update while its local bytes remain readable;
- restart the community during repeated semantic update submissions, verifying that accepted history/ref advancement remains atomic and a canonical-digest replay creates no duplicate accepted update.

Do not reinterpret a conflict as corruption. Record separately:

- **expected conflict:** the authority retains no conflict record; the submitting client persists its complete local/draft/remote context and attention is visible;
- **false conflict:** no concurrent remote advance occurred;
- **data loss:** authored bytes disappear from both the authority and the originating client;
- **corruption:** a ref resolves to an incomplete graph or partial file;
- **liveness failure:** a non-divergent tree never converges after the fault is removed.

## Optional different-filesystem pass

Only after the baseline is stable, create loop-backed filesystems inside Bob and Carol. This adds real Linux device/filesystem boundaries without adding cloud resources.

- Bob: an ext4 image mounted at `/srv/arbor-ext4`.
- Carol: an XFS image mounted at `/mnt/arbor-xfs`.

Create sparse image files, format them, mount them with loop devices, and verify with `findmnt`, `lsblk`, and `stat -c '%d'`. Then repeat:

1. A/B/C serial synchronization.
2. A same-filesystem path move.
3. A cross-filesystem move into or out of the loop mount.
4. Unmount/remount while arbord is stopped.
5. Unmount while arbord is running, then restore it.

The expected identity behavior must be stated before each move. Do not let a missing mount silently turn its mountpoint directory into a new empty placement, and do not accept a guessed identity when the stored device/inode evidence is ambiguous.

NFS, SMB, S3/FUSE, macOS, and iCloud are separate later labs. They should not be added to this four-VM baseline.

## Completion gate

The first lab is complete when:

- all A→B/C, B→A/C, and C→A/B serial cases converge by ref and byte manifest;
- a fresh placement materializes the exact current tree at a new path;
- single-client, asymmetric, and complete-community outages show correct offline state and recover;
- non-divergent offline edits eventually propagate;
- every automatic Markdown case preserves all authored markers in one accepted root;
- every unsafe conflict preserves the originating local bytes and complete returned draft across restart, adds no server history entry, and can be resolved only as a new accepted update;
- successful semantic replay adds exactly one private accepted-history item, while repeating a conflict is recomputed and remains stateless on the authority;
- `/push` is absent and pairing, device attribution, and revocation behave correctly;
- all three reconnect orders produce recorded, explainable results;
- server process crashes and VM reboots retain authority identity and committed refs;
- any false conflicts, data loss, corruption, or permanent liveness failures are captured as reproducible defects with their scenario evidence.

Different filesystems are a second completion gate, not a prerequisite for declaring the baseline network/sync run complete. The baseline accepted-update gate must pass and its evidence must be collected before Plan 011 can mutate Railway.

## Tear down

First collect the scenario log, systemd logs, final manifests, relevant `system:trees` state, and the community authority database if a failure needs local diagnosis. Then delete only the four explicitly named servers:

```sh
for arbor_lab_node in community alice bob carol; do
  hcloud server delete "arbor-${arbor_lab_node}"
done
```

Remove the four machines from Tailscale if they were not configured as ephemeral nodes. Delete the dedicated Hetzner project token when the project is no longer needed. The test content and account credential must not be reused for a real community.
