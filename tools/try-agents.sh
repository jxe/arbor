#!/bin/sh
# Try Agents 001 by hand (presence, agent task blocks, Run) against a
# throwaway community on this Mac, so no real tree or host is involved.
#
#   tools/try-agents.sh host    # terminal 1: a local overstoryd with presence, at http://127.0.0.1:4318
#   tools/try-agents.sh seed    # after adding that host in Story: sample pages, placed at ~/agents-try
#   tools/try-agents.sh reset   # put the sample pages back as they started
#   tools/try-agents.sh clean   # stop using it: unplace hint, remove the community's data
#
# The community lives in ~/.story-agents-try; your founder account there is
# reserved for your own profile (`story me`), so Story joins it as a placement.
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
data="$HOME/.story-agents-try"
folder="$HOME/agents-try"
port=4318
handle="${STORY_TRY_HANDLE:-$(id -un)}"

profile() {
  story me | sed -n 's/^Profile TreeID: //p'
}

pages() {
  mkdir -p "$folder"
  cat > "$folder/Groceries.md" <<'PAGE'
# Groceries

> [!agent] Merge the duplicates and sort the list by aisle

- oat milk
- eggs
- Milk
- bananas
- milk
- spinach
- Eggs
PAGE
  cat > "$folder/Trip.md" <<'PAGE'
# Trip

## Packing

> [!agent] Turn these notes into a packing checklist with to-dos

passport, charger, two shirts, the good socks, sunscreen
also headphones and the blue notebook

## Plan

Saturday: arrive late, dinner near the station.
Sunday: museum in the morning, then the long walk.
PAGE
}

case "${1:-}" in
  host)
    if [ ! -d "$data" ]; then
      me=$(profile)
      [ -n "$me" ] || { echo "No identity: run \`story me create\` (or set one up in Story) first." >&2; exit 1; }
      bun "$repo/packages/overstoryd/src/cli.ts" init agentstry --founder "$handle=$me" --data "$data"
    fi
    echo "In Story: Sync & Accounts → Join Another Community… → I Don’t Have One → http://127.0.0.1:$port → Add Host"
    echo "Then run: tools/try-agents.sh seed"
    exec bun "$repo/packages/overstoryd/src/cli.ts" serve "$data" --port "$port" --hostname 127.0.0.1
    ;;
  seed)
    pages
    story place "$folder" "http://127.0.0.1:$port/~$handle/agents-try"
    echo "Placed $folder. Open it in Story (sidebar tree picker)."
    ;;
  reset)
    pages
    echo "Sample pages restored in $folder."
    ;;
  clean)
    echo "Stop the host (Ctrl-C in its terminal), remove the placement in Story's Sync & Accounts, then:"
    echo "  rm -rf \"$data\" \"$folder\""
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 64
    ;;
esac
