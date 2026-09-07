#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="$PROJECT_ROOT/network-config.json"
RUNTIME_PATH="$PROJECT_ROOT/.runtime"

for command_name in python3 npm curl setsid; do
  command -v "$command_name" >/dev/null 2>&1 || { echo "Missing required command: $command_name" >&2; exit 1; }
done

mapfile -t NETWORK_CONFIG < <(python3 - "$CONFIG_PATH" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as config_file:
    config = json.load(config_file)
for key in ("scheme", "publicHost", "frontendBindHost", "backendBindHost", "labelFrontendPort", "labelBackendPort", "authFrontendPort", "authBackendPort"):
    print(config[key])
PY
)

SCHEME="${NETWORK_CONFIG[0]}"
PUBLIC_HOST="${NETWORK_CONFIG[1]}"
FRONTEND_BIND_HOST="${NETWORK_CONFIG[2]}"
BACKEND_BIND_HOST="${NETWORK_CONFIG[3]}"
LABEL_FRONTEND_PORT="${NETWORK_CONFIG[4]}"
LABEL_BACKEND_PORT="${NETWORK_CONFIG[5]}"
AUTH_FRONTEND_PORT="${NETWORK_CONFIG[6]}"
AUTH_BACKEND_PORT="${NETWORK_CONFIG[7]}"
HEALTH_HOST="$BACKEND_BIND_HOST"
[[ "$HEALTH_HOST" == "0.0.0.0" ]] && HEALTH_HOST="127.0.0.1"

LABEL_PYTHON="$PROJECT_ROOT/backend/.venv/bin/python"
AUTH_PYTHON="$PROJECT_ROOT/auth_system/backend/.venv/bin/python"
[[ -x "$LABEL_PYTHON" ]] || { echo "Missing backend/.venv. Run: python3 -m venv backend/.venv && backend/.venv/bin/pip install -r backend/requirements.txt" >&2; exit 1; }
[[ -x "$AUTH_PYTHON" ]] || { echo "Missing auth_system/backend/.venv. Run: python3 -m venv auth_system/backend/.venv && auth_system/backend/.venv/bin/pip install -r auth_system/backend/requirements.txt" >&2; exit 1; }
[[ -d "$PROJECT_ROOT/frontend/node_modules" ]] || { echo "Missing frontend dependencies. Run: npm ci --prefix frontend" >&2; exit 1; }
[[ -d "$PROJECT_ROOT/auth_system/frontend/node_modules" ]] || { echo "Missing auth frontend dependencies. Run: npm ci --prefix auth_system/frontend" >&2; exit 1; }

port_in_use() {
  python3 - "$1" <<'PY'
import socket
import sys

with socket.socket() as sock:
    sys.exit(0 if sock.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
PY
}

for port in "$AUTH_BACKEND_PORT" "$AUTH_FRONTEND_PORT" "$LABEL_BACKEND_PORT" "$LABEL_FRONTEND_PORT"; do
  if port_in_use "$port"; then
    echo "Port $port is already in use." >&2
    exit 1
  fi
done

mkdir -p "$RUNTIME_PATH"

start_service() {
  local name="$1"
  local working_directory="$2"
  shift 2
  (
    cd "$working_directory"
    nohup setsid "$@" >"$RUNTIME_PATH/$name.log" 2>"$RUNTIME_PATH/$name-error.log" < /dev/null &
    echo "$!" >"$RUNTIME_PATH/$name.pid"
  )
}

cleanup_failed_start() {
  "$PROJECT_ROOT/stop.sh" >/dev/null 2>&1 || true
}
trap cleanup_failed_start ERR INT TERM

start_service auth-backend "$PROJECT_ROOT/auth_system/backend" env \
  AUTH_HOST="$BACKEND_BIND_HOST" \
  AUTH_PORT="$AUTH_BACKEND_PORT" \
  AUTH_CORS_ORIGINS="$SCHEME://$PUBLIC_HOST:$AUTH_FRONTEND_PORT,$SCHEME://localhost:$AUTH_FRONTEND_PORT" \
  "$AUTH_PYTHON" app.py

start_service auth-frontend "$PROJECT_ROOT/auth_system/frontend" \
  npm run dev -- --host "$FRONTEND_BIND_HOST" --strictPort

start_service label-backend "$PROJECT_ROOT/backend" env \
  LABEL_TOOL_HOST="$BACKEND_BIND_HOST" \
  LABEL_TOOL_PORT="$LABEL_BACKEND_PORT" \
  LABEL_TOOL_AUTH_SERVICE_URL="$SCHEME://$HEALTH_HOST:$AUTH_BACKEND_PORT" \
  LABEL_TOOL_CORS_ORIGINS="$SCHEME://$PUBLIC_HOST:$LABEL_FRONTEND_PORT,$SCHEME://localhost:$LABEL_FRONTEND_PORT" \
  "$LABEL_PYTHON" app.py

start_service label-frontend "$PROJECT_ROOT/frontend" \
  npm run dev -- --host "$FRONTEND_BIND_HOST" --strictPort

wait_for_url() {
  local url="$1"
  for _attempt in $(seq 1 40); do
    curl --fail --silent --show-error --max-time 2 "$url" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "Startup check failed: $url" >&2
  return 1
}

wait_for_url "$SCHEME://$HEALTH_HOST:$AUTH_BACKEND_PORT/api/health"
wait_for_url "$SCHEME://127.0.0.1:$AUTH_FRONTEND_PORT/login"
wait_for_url "$SCHEME://$HEALTH_HOST:$LABEL_BACKEND_PORT/api/health"
wait_for_url "$SCHEME://127.0.0.1:$LABEL_FRONTEND_PORT/"

trap - ERR INT TERM
echo "Authentication: $SCHEME://$PUBLIC_HOST:$AUTH_FRONTEND_PORT/login"
echo "Label tool:     $SCHEME://$PUBLIC_HOST:$LABEL_FRONTEND_PORT/"
echo "To stop all services, run: ./stop.sh"
