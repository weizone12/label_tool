#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_PATH="${XDG_CONFIG_HOME:-$HOME/.config}/label-tool/nas-backup.env"

if [[ -f "$CONFIG_PATH" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG_PATH"
  set +a
fi

exec python3 "$PROJECT_ROOT/scripts/backup_to_nas.py" "$@"
