#!/usr/bin/env bash
set -euo pipefail

node_name="${1:?node name is required}"
bun_version="${2:?Bun version is required}"
case "$node_name" in
  arbor-community|arbor-alice|arbor-bob|arbor-carol) ;;
  *) printf 'Unexpected lab node: %s\n' "$node_name" >&2; exit 2 ;;
esac

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
  ca-certificates curl git jq openssl sqlite3 sudo ufw \
  iptables iproute2 libsecret-1-0 gnome-keyring dbus-x11

if ! id arbor >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash arbor
fi
install -d -o arbor -g arbor -m 0700 /home/arbor/.arbor
install -d -o root -g root -m 0755 /opt/arbor-releases

if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
systemctl enable --now tailscaled
hostnamectl set-hostname "$node_name"

installed_bun="$(sudo -u arbor -H /home/arbor/.bun/bin/bun --version 2>/dev/null || true)"
if [[ "$installed_bun" != "$bun_version" ]]; then
  sudo -u arbor -H bash -lc "curl -fsSL https://bun.sh/install | bash -s -- bun-v${bun_version}"
fi
ln -sfn /home/arbor/.bun/bin/bun /usr/local/bin/bun

ufw default deny incoming
ufw allow OpenSSH
ufw allow in on tailscale0
ufw --force enable
