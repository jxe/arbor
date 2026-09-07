#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
package_path="$repository_root/native/Packages/ArborQuagmire"
lock_path="$package_path/Package.resolved"
backup_root=$(mktemp -d)
backup_path="$backup_root/Package.resolved"

cp "$lock_path" "$backup_path"
restore_lock() {
  cp "$backup_path" "$lock_path"
  rm -rf "$backup_root"
}
trap restore_lock EXIT HUP INT TERM

swift test --package-path "$package_path" "$@"
