#!/usr/bin/env python3
"""Additive label-tool backup to a Synology NAS over SSH/rsync."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath

try:
    import fcntl
except ImportError:  # pragma: no cover - the backup runner is Linux-only
    fcntl = None


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_NAS_HOST = "192.168.1.3"
DEFAULT_NAS_USER = "admin"
DEFAULT_NAS_PORT = 22
DEFAULT_NAS_ROOT = "/volume1/label_tool_backup"
DEFAULT_IDENTITY_FILE = Path.home() / ".ssh" / "label_tool_nas_backup_ed25519"
UNGROUPED_DIRECTORY = "未分群"


@dataclass(frozen=True)
class BackupConfig:
    host: str
    user: str
    port: int
    remote_root: PurePosixPath
    identity_file: Path
    projects_dir: Path
    access_database: Path
    users_database: Path
    dry_run: bool = False

    @property
    def remote_target(self) -> str:
        return f"{self.user}@{self.host}"


@dataclass(frozen=True)
class ProjectBackup:
    source: Path
    destination: PurePosixPath
    name: str
    group: str


def log(message: str) -> None:
    timestamp = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {message}", flush=True)


def local_path(value: str | os.PathLike[str], *, relative_to: Path = REPOSITORY_ROOT) -> Path:
    path = Path(value).expanduser()
    return (relative_to / path).resolve() if not path.is_absolute() else path.resolve()


def sanitize_component(value: object, fallback: str) -> str:
    text = str(value or "").strip()
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", text).strip(" .")
    if text in {"", ".", ".."}:
        return fallback
    return text


def group_components(group: object) -> list[str]:
    return [
        sanitize_component(component, "未命名群組")
        for component in str(group or "").split("/")
        if component.strip()
    ]


def validate_remote_root(value: str) -> PurePosixPath:
    root = PurePosixPath(value.strip())
    if not root.is_absolute() or len(root.parts) < 3 or ".." in root.parts:
        raise ValueError("NAS 備份根目錄必須是明確的絕對路徑，例如 /volume1/label_tool_backup")
    return root


def discover_projects(projects_dir: Path, remote_root: PurePosixPath) -> tuple[list[ProjectBackup], list[str]]:
    projects: list[ProjectBackup] = []
    warnings: list[str] = []
    if not projects_dir.is_dir():
        return projects, [f"找不到專案目錄：{projects_dir}"]

    for directory in sorted(projects_dir.iterdir(), key=lambda item: item.name.casefold()):
        config_path = directory / "project.json"
        if not directory.is_dir() or not config_path.is_file():
            continue
        try:
            project = json.loads(config_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            warnings.append(f"略過 {directory.name}：project.json 無法讀取（{error}）")
            continue

        group = str(project.get("group") or "").strip()
        grouped_path = group_components(group) or [UNGROUPED_DIRECTORY]
        project_directory = sanitize_component(directory.name, "未命名專案")
        destination = remote_root.joinpath("projects", *grouped_path, project_directory)
        projects.append(ProjectBackup(
            source=directory,
            destination=destination,
            name=str(project.get("name") or directory.name),
            group=group,
        ))
    return projects, warnings


def ssh_arguments(config: BackupConfig) -> list[str]:
    return [
        "ssh",
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=15",
        "-o", "IdentitiesOnly=yes",
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=6",
        "-p", str(config.port),
        "-i", str(config.identity_file),
    ]


def rsync_remote_shell(config: BackupConfig) -> str:
    return " ".join(shlex.quote(part) for part in ssh_arguments(config))


def run_checked(
    command: list[str],
    description: str,
    *,
    attempts: int = 1,
    retry_codes: frozenset[int] = frozenset(),
) -> None:
    for attempt in range(1, attempts + 1):
        try:
            subprocess.run(command, check=True)
            return
        except FileNotFoundError as error:
            raise RuntimeError(f"缺少必要指令：{command[0]}") from error
        except subprocess.CalledProcessError as error:
            if attempt < attempts and error.returncode in retry_codes:
                delay = 5 * attempt
                log(f"警告：{description}中斷（結束碼 {error.returncode}），{delay} 秒後重試 {attempt + 1}/{attempts}")
                time.sleep(delay)
                continue
            raise RuntimeError(f"{description}失敗（結束碼 {error.returncode}）") from error


def ensure_remote_directories(config: BackupConfig, directories: list[PurePosixPath]) -> None:
    unique = sorted({str(path) for path in directories})
    for index in range(0, len(unique), 40):
        chunk = unique[index:index + 40]
        remote_command = "mkdir -p -- " + " ".join(shlex.quote(path) for path in chunk)
        run_checked(
            [*ssh_arguments(config), config.remote_target, remote_command],
            "建立 NAS 備份目錄",
        )


def directory_rsync_command(config: BackupConfig, source: Path, destination: PurePosixPath) -> list[str]:
    source_with_separator = f"{source}{os.sep}"
    remote = f"{config.remote_target}:{destination}/"
    return [
        "rsync",
        "-a",
        "--partial",
        "--protect-args",
        "--rsync-path=/usr/bin/rsync",
        "-e", rsync_remote_shell(config),
        "--",
        source_with_separator,
        remote,
    ]


def rsync_directory(config: BackupConfig, source: Path, destination: PurePosixPath) -> None:
    run_checked(
        directory_rsync_command(config, source, destination),
        f"備份專案 {source.name}",
        attempts=3,
        retry_codes=frozenset({10, 12, 30, 35}),
    )


def file_rsync_command(config: BackupConfig, source: Path, destination: PurePosixPath) -> list[str]:
    remote = f"{config.remote_target}:{destination}/"
    return [
        "rsync",
        "-a",
        "--checksum",
        "--partial",
        "--protect-args",
        "--rsync-path=/usr/bin/rsync",
        "-e", rsync_remote_shell(config),
        "--",
        str(source),
        remote,
    ]


def rsync_file(config: BackupConfig, source: Path, destination: PurePosixPath) -> None:
    run_checked(
        file_rsync_command(config, source, destination),
        f"備份系統資料 {source.name}",
        attempts=3,
        retry_codes=frozenset({10, 12, 30, 35}),
    )


def sqlite_snapshot(source: Path, destination: Path) -> None:
    source_uri = f"file:{source.as_posix()}?mode=ro"
    with closing(sqlite3.connect(source_uri, uri=True, timeout=30)) as source_db:
        source_db.execute("PRAGMA busy_timeout = 30000")
        with closing(sqlite3.connect(destination)) as destination_db:
            source_db.backup(destination_db)


def acquire_lock():
    if fcntl is None:
        raise RuntimeError("自動備份僅支援 Linux")
    lock_path = Path(tempfile.gettempdir()) / f"label-tool-nas-backup-{os.getuid()}.lock"
    lock_file = lock_path.open("w", encoding="utf-8")
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        lock_file.close()
        raise RuntimeError("另一個備份工作仍在執行") from error
    return lock_file


def verify_requirements(config: BackupConfig) -> None:
    for command in ("ssh", "rsync"):
        if shutil.which(command) is None:
            raise RuntimeError(f"缺少必要指令：{command}")
    if not config.identity_file.is_file():
        raise RuntimeError(f"找不到 SSH 金鑰：{config.identity_file}，請先執行安裝腳本")


def backup(config: BackupConfig) -> int:
    projects, warnings = discover_projects(config.projects_dir, config.remote_root)
    for warning in warnings:
        log(f"警告：{warning}")

    log(f"掃描到 {len(projects)} 個專案")
    for project in projects:
        group_label = project.group or UNGROUPED_DIRECTORY
        log(f"規劃：{project.name}（{group_label}）→ {project.destination}")

    database_sources = [
        (config.access_database, "access_control.db"),
        (config.users_database, "users.db"),
    ]
    missing_databases = [str(path) for path, _name in database_sources if not path.is_file()]
    for path in missing_databases:
        log(f"警告：找不到系統資料庫，略過：{path}")

    if config.dry_run:
        log("預覽完成；未連線 NAS，也未寫入任何資料")
        return 0

    verify_requirements(config)
    lock_file = acquire_lock()
    try:
        remote_directories = [
            config.remote_root,
            config.remote_root / "projects",
            config.remote_root / "system",
            *(project.destination for project in projects),
        ]
        ensure_remote_directories(config, remote_directories)

        for index, project in enumerate(projects, 1):
            log(f"備份專案 {index}/{len(projects)}：{project.name}")
            rsync_directory(config, project.source, project.destination)

        with tempfile.TemporaryDirectory(prefix="label-tool-db-backup-") as temporary:
            temporary_dir = Path(temporary)
            for source, snapshot_name in database_sources:
                if not source.is_file():
                    continue
                log(f"建立並備份資料庫快照：{snapshot_name}")
                snapshot = temporary_dir / snapshot_name
                sqlite_snapshot(source, snapshot)
                rsync_file(config, snapshot, config.remote_root / "system")

        log("備份完成；NAS 上既有但本機已刪除的資料未被移除")
        return 0
    finally:
        lock_file.close()


def parse_arguments(argv: list[str] | None = None) -> BackupConfig:
    parser = argparse.ArgumentParser(description="將標註專案、帳號與權限增量備份至 NAS")
    parser.add_argument("--host", default=os.environ.get("NAS_BACKUP_HOST", DEFAULT_NAS_HOST))
    parser.add_argument("--user", default=os.environ.get("NAS_BACKUP_USER", DEFAULT_NAS_USER))
    parser.add_argument("--port", type=int, default=int(os.environ.get("NAS_BACKUP_PORT", DEFAULT_NAS_PORT)))
    parser.add_argument("--remote-root", default=os.environ.get("NAS_BACKUP_ROOT", DEFAULT_NAS_ROOT))
    parser.add_argument("--identity-file", default=os.environ.get("NAS_BACKUP_IDENTITY_FILE", str(DEFAULT_IDENTITY_FILE)))
    parser.add_argument("--projects-dir", default=os.environ.get("LABEL_TOOL_DATA_DIR", str(REPOSITORY_ROOT / "backend" / "data")))
    parser.add_argument("--auth-data-dir", default=os.environ.get("AUTH_DATA_DIR", str(REPOSITORY_ROOT / "auth_system" / "backend" / "auth_data")))
    parser.add_argument("--dry-run", action="store_true", help="只列出 NAS 路徑，不連線或傳送資料")
    args = parser.parse_args(argv)

    if not args.host.strip() or not args.user.strip():
        parser.error("NAS host 與 user 不可為空")
    if not 1 <= args.port <= 65535:
        parser.error("NAS SSH port 必須介於 1 到 65535")
    try:
        remote_root = validate_remote_root(args.remote_root)
    except ValueError as error:
        parser.error(str(error))

    data_dir = local_path(args.projects_dir)
    if data_dir.name != "projects":
        data_dir = data_dir / "projects"
    auth_data_dir = local_path(args.auth_data_dir)
    return BackupConfig(
        host=args.host.strip(),
        user=args.user.strip(),
        port=args.port,
        remote_root=remote_root,
        identity_file=local_path(args.identity_file, relative_to=Path.home()),
        projects_dir=data_dir,
        access_database=data_dir.parent / "access_control.db",
        users_database=auth_data_dir / "users.db",
        dry_run=args.dry_run,
    )


def main(argv: list[str] | None = None) -> int:
    try:
        return backup(parse_arguments(argv))
    except (OSError, RuntimeError, sqlite3.Error) as error:
        log(f"錯誤：{error}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
