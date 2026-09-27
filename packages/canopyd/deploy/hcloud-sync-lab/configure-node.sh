#!/usr/bin/env bash
set -euo pipefail

role="${1:?role is required}"
content_path="${2:-}"
lab=/opt/arbor-current/packages/canopyd/deploy/hcloud-sync-lab
install -d -m 0755 /usr/local/libexec
install -m 0755 "$lab/arbor-headless-session" /usr/local/libexec/arbor-headless-session

if [[ "$role" == "community" ]]; then
  install -d -o arbor -g arbor -m 0700 /var/lib/arbor-canopy
  if [[ ! -f /etc/arbor-canopy.env ]]; then
    umask 077
    # The owner account's first device is a key device whose seed stays
    # root-only here; the lab runner reads it to open owner sessions.
    /usr/local/bin/bun "$lab/lab-node.ts" owner-device > /etc/arbor-canopy-owner.json
    printf "ARBOR_ACCOUNTS_JSON='%s'\n" "$(/usr/local/bin/bun "$lab/lab-node.ts" owner-accounts < /etc/arbor-canopy-owner.json)" > /etc/arbor-canopy.env
  fi
  # An empty data directory creates the community only when its handle is set.
  if ! grep -q '^ARBOR_COMMUNITY_HANDLE=' /etc/arbor-canopy.env; then
    printf 'ARBOR_COMMUNITY_HANDLE=sync-lab\n' >> /etc/arbor-canopy.env
  fi
  cat > /etc/systemd/system/arbor-canopy.service <<'UNIT'
[Unit]
Description=Arbor hcloud sync-lab Canopy server
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=arbor
Group=arbor
WorkingDirectory=/opt/arbor-current
EnvironmentFile=/etc/arbor-canopy.env
ExecStart=/usr/local/bin/bun run canopyd serve /var/lib/arbor-canopy --url http://arbor-community:4318 --hostname 0.0.0.0 --port 4318
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now arbor-canopy.service
  exit 0
fi

case "$role:$content_path" in
  alice:/home/arbor/lab|bob:/srv/arbor/lab|carol:/mnt/arbor/lab) ;;
  *) printf 'Unexpected client placement: %s:%s\n' "$role" "$content_path" >&2; exit 2 ;;
esac

# Standard input carries {owner, label, administrator}: the owner's device
# offers one pairing and is not written anywhere on this machine.
connect_request="$(cat)"
if [[ -z "$connect_request" ]]; then
  printf 'Client configuration requires the pairing request on stdin\n' >&2
  exit 2
fi
install -d -o arbor -g arbor -m 0700 "$content_path"
systemctl stop arbor-client.service 2>/dev/null || true
printf '%s\n' "$connect_request" | sudo -u arbor -H env \
  ARBOR_DATA_HOME=/home/arbor/.arbor \
  /usr/local/libexec/arbor-headless-session \
  /usr/local/bin/bun "$lab/lab-node.ts" connect >/dev/null

# The control service owns every placement in the data home; `arbor place`
# attaches to it on 127.0.0.1:4317.
cat > /etc/systemd/system/arbor-client.service <<UNIT
[Unit]
Description=Arbor hcloud sync-lab client ($role)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=arbor
Group=arbor
WorkingDirectory=/opt/arbor-current
Environment=HOME=/home/arbor
Environment=ARBOR_DATA_HOME=/home/arbor/.arbor
ExecStart=/usr/local/libexec/arbor-headless-session /usr/local/bin/bun run arborsync --control
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now arbor-client.service
