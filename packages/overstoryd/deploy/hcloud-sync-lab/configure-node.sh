#!/usr/bin/env bash
set -euo pipefail

role="${1:?role is required}"
content_path="${2:-}"
lab=/opt/story-current/packages/overstoryd/deploy/hcloud-sync-lab
install -d -m 0755 /usr/local/libexec
install -m 0755 "$lab/story-headless-session" /usr/local/libexec/story-headless-session

if [[ "$role" == "community" ]]; then
  install -d -o story -g story -m 0700 /var/lib/overstoryd
  if [[ ! -f /etc/overstoryd.env ]]; then
    umask 077
    # The owner account's first device is a key device whose seed stays
    # root-only here; the lab runner reads it to open owner sessions.
    /usr/local/bin/bun "$lab/lab-node.ts" owner-device > /etc/overstoryd-owner.json
    printf "OVERSTORYD_ACCOUNTS_JSON='%s'\n" "$(/usr/local/bin/bun "$lab/lab-node.ts" owner-accounts < /etc/overstoryd-owner.json)" > /etc/overstoryd.env
  fi
  # An empty data directory creates the community only when its handle is set.
  if ! grep -q '^OVERSTORYD_COMMUNITY_HANDLE=' /etc/overstoryd.env; then
    printf 'OVERSTORYD_COMMUNITY_HANDLE=sync-lab\n' >> /etc/overstoryd.env
  fi
  cat > /etc/systemd/system/overstoryd.service <<'UNIT'
[Unit]
Description=Story hcloud sync-lab Canopy server
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=story
Group=story
WorkingDirectory=/opt/story-current
EnvironmentFile=/etc/overstoryd.env
ExecStart=/usr/local/bin/bun run overstoryd serve /var/lib/overstoryd --url http://story-community:4318 --hostname 0.0.0.0 --port 4318
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now overstoryd.service
  exit 0
fi

case "$role:$content_path" in
  alice:/home/story/lab|bob:/srv/story/lab|carol:/mnt/story/lab) ;;
  *) printf 'Unexpected client placement: %s:%s\n' "$role" "$content_path" >&2; exit 2 ;;
esac

# Standard input carries {owner, label, administrator}: the owner's device
# offers one pairing and is not written anywhere on this machine.
connect_request="$(cat)"
if [[ -z "$connect_request" ]]; then
  printf 'Client configuration requires the pairing request on stdin\n' >&2
  exit 2
fi
install -d -o story -g story -m 0700 "$content_path"
systemctl stop story-client.service 2>/dev/null || true
printf '%s\n' "$connect_request" | sudo -u story -H env \
  STORY_HOME=/home/story/.overstory \
  /usr/local/libexec/story-headless-session \
  /usr/local/bin/bun "$lab/lab-node.ts" connect >/dev/null

# The control service owns every placement in the data home; `story place`
# attaches to it on 127.0.0.1:4317.
cat > /etc/systemd/system/story-client.service <<UNIT
[Unit]
Description=Story hcloud sync-lab client ($role)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=story
Group=story
WorkingDirectory=/opt/story-current
Environment=HOME=/home/story
Environment=STORY_HOME=/home/story/.overstory
ExecStart=/usr/local/libexec/story-headless-session /usr/local/bin/bun run story-sync --control
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now story-client.service
