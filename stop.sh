#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_PATH="$PROJECT_ROOT/.runtime"
STOPPED=0

stop_service() {
  local name="$1"
  local pid_path="$RUNTIME_PATH/$name.pid"
  [[ -f "$pid_path" ]] || return 0

  local process_id
  process_id="$(<"$pid_path")"
  if [[ "$process_id" =~ ^[0-9]+$ ]] && kill -0 "$process_id" 2>/dev/null; then
    local process_directory
    process_directory="$(readlink -f "/proc/$process_id/cwd" 2>/dev/null || true)"
    if [[ "$process_directory" != "$PROJECT_ROOT"/* ]]; then
      echo "Refusing to stop $name: PID $process_id is outside this project." >&2
      return 1
    fi
    kill -TERM -- "-$process_id" 2>/dev/null || kill -TERM "$process_id" 2>/dev/null || true
    for _attempt in $(seq 1 20); do
      kill -0 "$process_id" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$process_id" 2>/dev/null; then
      kill -KILL -- "-$process_id" 2>/dev/null || kill -KILL "$process_id" 2>/dev/null || true
    fi
    echo "Stopped $name (PID $process_id)."
    STOPPED=1
  fi
  rm -f -- "$pid_path"
}

stop_service label-frontend
stop_service label-backend
stop_service auth-frontend
stop_service auth-backend

if [[ "$STOPPED" -eq 0 ]]; then
  echo "No Linux services started by this project are running."
else
  echo "All Linux services stopped."
fi
