#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
CONFIG_DIR="$CONFIG_HOME/label-tool"
CONFIG_PATH="$CONFIG_DIR/nas-backup.env"
UNIT_DIR="$CONFIG_HOME/systemd/user"
SERVICE_PATH="$UNIT_DIR/label-tool-nas-backup.service"
TIMER_PATH="$UNIT_DIR/label-tool-nas-backup.timer"

NAS_HOST="${NAS_BACKUP_HOST:-192.168.1.3}"
NAS_USER="${NAS_BACKUP_USER:-admin}"
NAS_PORT="${NAS_BACKUP_PORT:-22}"
NAS_ROOT="${NAS_BACKUP_ROOT:-/volume1/label_tool_backup}"
IDENTITY_FILE="${NAS_BACKUP_IDENTITY_FILE:-$HOME/.ssh/label_tool_nas_backup_ed25519}"

for command_name in python3 ssh ssh-keygen ssh-copy-id rsync systemctl; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "缺少必要指令：$command_name" >&2
    echo "Ubuntu/Debian 可執行：sudo apt install -y openssh-client rsync" >&2
    exit 1
  }
done

mkdir -p "$(dirname -- "$IDENTITY_FILE")"
chmod 700 "$(dirname -- "$IDENTITY_FILE")"
if [[ ! -f "$IDENTITY_FILE" ]]; then
  ssh-keygen -t ed25519 -N "" -C "label-tool NAS backup" -f "$IDENTITY_FILE"
fi

SSH_OPTIONS=(
  -o BatchMode=yes
  -o ConnectTimeout=15
  -o IdentitiesOnly=yes
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=6
  -p "$NAS_PORT"
  -i "$IDENTITY_FILE"
)
if ! ssh "${SSH_OPTIONS[@]}" "$NAS_USER@$NAS_HOST" true >/dev/null 2>&1; then
  echo "需要將備份金鑰加入 NAS；接下來請輸入一次 NAS 帳號密碼。"
  ssh-copy-id -i "$IDENTITY_FILE.pub" -p "$NAS_PORT" "$NAS_USER@$NAS_HOST"
fi

ssh "${SSH_OPTIONS[@]}" "$NAS_USER@$NAS_HOST" \
  "mkdir -p -- '$NAS_ROOT/projects' '$NAS_ROOT/system'"

mkdir -p "$CONFIG_DIR" "$UNIT_DIR"
cat >"$CONFIG_PATH" <<EOF
NAS_BACKUP_HOST='$NAS_HOST'
NAS_BACKUP_USER='$NAS_USER'
NAS_BACKUP_PORT='$NAS_PORT'
NAS_BACKUP_ROOT='$NAS_ROOT'
NAS_BACKUP_IDENTITY_FILE='$IDENTITY_FILE'
EOF
chmod 600 "$CONFIG_PATH"

PYTHON_BIN="$(command -v python3)"
cat >"$SERVICE_PATH" <<EOF
[Unit]
Description=Label Tool additive NAS backup
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile="$CONFIG_PATH"
Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
WorkingDirectory="$PROJECT_ROOT"
ExecStart="$PYTHON_BIN" "$PROJECT_ROOT/scripts/backup_to_nas.py"
UMask=0077
EOF

cat >"$TIMER_PATH" <<'EOF'
[Unit]
Description=Run Label Tool NAS backup every day at 02:00 Asia/Taipei

[Timer]
OnCalendar=*-*-* 02:00:00 Asia/Taipei
Persistent=true
AccuracySec=1min
RandomizedDelaySec=0
Unit=label-tool-nas-backup.service

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now label-tool-nas-backup.timer

echo
echo "NAS 備份排程已安裝：每天凌晨 02:00（Asia/Taipei）"
echo "手動備份：bash '$PROJECT_ROOT/scripts/backup_to_nas.sh'"
echo "預覽路徑：bash '$PROJECT_ROOT/scripts/backup_to_nas.sh' --dry-run"
echo "查看排程：systemctl --user list-timers label-tool-nas-backup.timer"
echo "查看紀錄：journalctl --user -u label-tool-nas-backup.service"
echo
echo "若這台電腦在使用者登出後仍要準時執行，請另外執行："
echo "sudo loginctl enable-linger '$USER'"
