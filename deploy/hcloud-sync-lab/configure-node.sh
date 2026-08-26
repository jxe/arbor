#!/usr/bin/env bash
set -euo pipefail

role="${1:?role is required}"
content_path="${2:-}"
install -d -m 0755 /usr/local/libexec
install -m 0755 /opt/arbor-current/deploy/hcloud-sync-lab/arbor-headless-session /usr/local/libexec/arbor-headless-session

if [[ "$role" == "community" ]]; then
  install -d -o arbor -g arbor -m 0700 /var/lib/arbor-canopy
  if [[ ! -f /etc/arbor-canopy.env ]]; then
    umask 077
    printf 'ARBOR_ACCOUNT_HANDLE=owner\nARBOR_ACCOUNT_TOKEN=%s\n' "$(openssl rand -hex 32)" > /etc/arbor-canopy.env
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
ExecStart=/usr/local/bin/bun run canopyd /var/lib/arbor-canopy --community sync-lab --url http://arbor-community:4318 --hostname 0.0.0.0 --port 4318
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

account_token="$(cat)"
if [[ -z "$account_token" ]]; then
  printf 'Client configuration requires the Arbor account token on stdin\n' >&2
  exit 2
fi
install -d -o arbor -g arbor -m 0700 "$content_path"
systemctl stop arbor-client.service 2>/dev/null || true
printf '%s\n' "$account_token" | sudo -u arbor -H env \
  ARBOR_DATA_HOME=/home/arbor/.arbor \
  /usr/local/libexec/arbor-headless-session \
  /usr/local/bin/bun /opt/arbor-current/packages/cli/src/index.ts connect http://arbor-community:4318

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
ExecStart=/usr/local/libexec/arbor-headless-session /usr/local/bin/bun run arborsync $content_path
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now arbor-client.service
