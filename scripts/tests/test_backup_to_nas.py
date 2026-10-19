from __future__ import annotations

import json
import shlex
import sqlite3
import subprocess
import tempfile
import unittest
from contextlib import closing
from pathlib import Path, PurePosixPath
from unittest.mock import patch

from scripts.backup_to_nas import (
    BackupConfig,
    UNGROUPED_DIRECTORY,
    backup,
    directory_rsync_command,
    discover_projects,
    file_rsync_command,
    group_components,
    project_timestamp_paths,
    run_checked,
    rsync_output_has_changes,
    sanitize_component,
    sqlite_snapshot,
    touch_remote_directories,
    validate_remote_root,
)


class BackupPathTests(unittest.TestCase):
    def test_nested_group_builds_nas_only_hierarchy(self):
        with tempfile.TemporaryDirectory() as temporary:
            projects_dir = Path(temporary)
            source = projects_dir / "專案 A"
            source.mkdir()
            (source / "project.json").write_text(json.dumps({
                "id": "project-a",
                "name": "專案 A",
                "group": "日期 / Camera 1 / 第一批",
            }, ensure_ascii=False), encoding="utf-8")

            projects, warnings = discover_projects(projects_dir, PurePosixPath("/volume1/label_tool_backup"))

            self.assertEqual(warnings, [])
            self.assertEqual(len(projects), 1)
            self.assertEqual(
                projects[0].destination,
                PurePosixPath("/volume1/label_tool_backup/projects/日期/Camera 1/第一批/專案 A"),
            )
            self.assertEqual(projects[0].source, source)

    def test_ungrouped_project_uses_dedicated_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            projects_dir = Path(temporary)
            source = projects_dir / "test"
            source.mkdir()
            (source / "project.json").write_text('{"name":"test","group":""}', encoding="utf-8")

            projects, _warnings = discover_projects(projects_dir, PurePosixPath("/volume1/label_tool_backup"))

            self.assertEqual(
                projects[0].destination,
                PurePosixPath(f"/volume1/label_tool_backup/projects/{UNGROUPED_DIRECTORY}/test"),
            )

    def test_unsafe_group_segments_are_sanitized(self):
        self.assertEqual(group_components("群組 / .. / cam:1"), ["群組", "未命名群組", "cam_1"])
        self.assertEqual(sanitize_component("../../bad", "fallback"), "_.._bad")

    def test_remote_root_must_be_narrow_absolute_path(self):
        for invalid in ("relative/path", "/", "/volume1", "/volume1/../tmp"):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    validate_remote_root(invalid)
        self.assertEqual(
            validate_remote_root("/volume1/label_tool_backup"),
            PurePosixPath("/volume1/label_tool_backup"),
        )

    def test_rsync_commands_never_delete_remote_data(self):
        config = BackupConfig(
            host="192.168.1.3",
            user="admin",
            port=22,
            remote_root=PurePosixPath("/volume1/label_tool_backup"),
            identity_file=Path("backup-key"),
            projects_dir=Path("projects"),
            access_database=Path("access_control.db"),
            users_database=Path("users.db"),
        )
        commands = [
            directory_rsync_command(config, Path("project"), config.remote_root / "projects" / "project"),
            file_rsync_command(config, Path("users.db"), config.remote_root / "system"),
        ]
        for command in commands:
            with self.subTest(command=command):
                self.assertFalse(any(argument.startswith("--delete") for argument in command))
                self.assertNotIn("--remove-source-files", command)
                self.assertIn("--rsync-path=/usr/bin/rsync", command)
                self.assertIn("--itemize-changes", command)
                self.assertIn("--out-format=CHANGE:%i", command)
                remote_shell = command[command.index("-e") + 1]
                self.assertIn("IdentitiesOnly=yes", remote_shell)
                self.assertIn("ServerAliveInterval=30", remote_shell)
        self.assertIn("--omit-dir-times", commands[0])
        self.assertNotIn("--omit-dir-times", commands[1])

    def test_rsync_change_output_distinguishes_updated_and_unchanged(self):
        self.assertFalse(rsync_output_has_changes(""))
        self.assertFalse(rsync_output_has_changes(None))
        self.assertTrue(rsync_output_has_changes("CHANGE:>f++++++++++\n"))
        self.assertTrue(rsync_output_has_changes("sending incremental file list\nCHANGE:.f..t......\n"))

    def test_project_timestamp_paths_include_project_groups_and_projects_root(self):
        projects_root = PurePosixPath("/volume1/label_tool_backup/projects")
        destination = projects_root / "日期" / "Camera 1" / "專案 A"

        self.assertEqual(
            project_timestamp_paths(destination, projects_root),
            [
                destination,
                projects_root / "日期" / "Camera 1",
                projects_root / "日期",
                projects_root,
            ],
        )

    def test_touch_remote_directories_uses_absolute_touch_command(self):
        config = BackupConfig(
            host="192.168.1.3",
            user="admin",
            port=22,
            remote_root=PurePosixPath("/volume1/label_tool_backup"),
            identity_file=Path("backup-key"),
            projects_dir=Path("projects"),
            access_database=Path("access_control.db"),
            users_database=Path("users.db"),
        )
        paths = [
            config.remote_root / "projects" / "群組 A" / "專案 O'Reilly",
            config.remote_root / "projects" / "群組 A",
            config.remote_root / "projects",
        ]

        with patch("scripts.backup_to_nas.run_checked") as run:
            touch_remote_directories(config, paths)

        command = run.call_args.args[0]
        self.assertEqual(command[-2], config.remote_target)
        self.assertTrue(command[-1].startswith("/bin/touch -m "))
        self.assertIn(shlex.quote(str(paths[0])), command[-1])
        self.assertEqual(run.call_args.kwargs["attempts"], 3)


class BackupSummaryTests(unittest.TestCase):
    def test_only_changed_projects_are_listed_and_touched(self):
        with tempfile.TemporaryDirectory() as temporary:
            projects_dir = Path(temporary) / "projects"
            projects_dir.mkdir()
            for directory_name, project_name in (("project-a", "專案 A"), ("project-b", "專案 B")):
                source = projects_dir / directory_name
                source.mkdir()
                (source / "project.json").write_text(
                    json.dumps({"name": project_name, "group": "群組"}, ensure_ascii=False),
                    encoding="utf-8",
                )
            config = BackupConfig(
                host="192.168.1.3",
                user="admin",
                port=22,
                remote_root=PurePosixPath("/volume1/label_tool_backup"),
                identity_file=Path("backup-key"),
                projects_dir=projects_dir,
                access_database=Path(temporary) / "missing-access.db",
                users_database=Path(temporary) / "missing-users.db",
            )

            with patch("scripts.backup_to_nas.log") as logger, \
                    patch("scripts.backup_to_nas.verify_requirements"), \
                    patch("scripts.backup_to_nas.acquire_lock") as acquire_lock, \
                    patch("scripts.backup_to_nas.ensure_remote_directories"), \
                    patch("scripts.backup_to_nas.rsync_directory", side_effect=[True, False]), \
                    patch("scripts.backup_to_nas.touch_remote_directories") as touch:
                self.assertEqual(backup(config), 0)

        touch.assert_called_once()
        touched_paths = touch.call_args.args[1]
        self.assertEqual(touched_paths[-1], config.remote_root / "projects")
        messages = [call.args[0] for call in logger.call_args_list]
        self.assertIn("專案備份統計：有更新 1 個，無更新 1 個，共 2 個", messages)
        self.assertIn(
            "  - 專案 A（群組）→ /volume1/label_tool_backup/projects/群組/project-a",
            messages,
        )
        self.assertNotIn(
            "  - 專案 B（群組）→ /volume1/label_tool_backup/projects/群組/project-b",
            messages,
        )
        acquire_lock.return_value.close.assert_called_once()

    def test_unchanged_projects_do_not_touch_nas_dates(self):
        with tempfile.TemporaryDirectory() as temporary:
            projects_dir = Path(temporary) / "projects"
            source = projects_dir / "project-a"
            source.mkdir(parents=True)
            (source / "project.json").write_text(
                json.dumps({"name": "專案 A", "group": "群組"}, ensure_ascii=False),
                encoding="utf-8",
            )
            config = BackupConfig(
                host="192.168.1.3",
                user="admin",
                port=22,
                remote_root=PurePosixPath("/volume1/label_tool_backup"),
                identity_file=Path("backup-key"),
                projects_dir=projects_dir,
                access_database=Path(temporary) / "missing-access.db",
                users_database=Path(temporary) / "missing-users.db",
            )

            with patch("scripts.backup_to_nas.log") as logger, \
                    patch("scripts.backup_to_nas.verify_requirements"), \
                    patch("scripts.backup_to_nas.acquire_lock"), \
                    patch("scripts.backup_to_nas.ensure_remote_directories"), \
                    patch("scripts.backup_to_nas.rsync_directory", return_value=False), \
                    patch("scripts.backup_to_nas.touch_remote_directories") as touch:
                self.assertEqual(backup(config), 0)

        touch.assert_not_called()
        messages = [call.args[0] for call in logger.call_args_list]
        self.assertIn("專案備份統計：有更新 0 個，無更新 1 個，共 1 個", messages)
        self.assertIn("本次沒有專案需要更新", messages)


class DatabaseSnapshotTests(unittest.TestCase):
    def test_sqlite_snapshot_is_readable_and_complete(self):
        with tempfile.TemporaryDirectory() as temporary:
            temporary_dir = Path(temporary)
            source = temporary_dir / "source.db"
            destination = temporary_dir / "snapshot.db"
            with closing(sqlite3.connect(source)) as database:
                database.execute("CREATE TABLE records (value TEXT)")
                database.execute("INSERT INTO records VALUES ('saved')")
                database.commit()

            sqlite_snapshot(source, destination)

            with closing(sqlite3.connect(destination)) as database:
                self.assertEqual(database.execute("SELECT value FROM records").fetchone()[0], "saved")


class RetryTests(unittest.TestCase):
    def test_protocol_error_is_retried(self):
        failure = subprocess.CalledProcessError(12, ["rsync"])
        with patch("scripts.backup_to_nas.subprocess.run", side_effect=[failure, None]) as run:
            with patch("scripts.backup_to_nas.time.sleep") as sleep:
                run_checked(
                    ["rsync"],
                    "備份測試",
                    attempts=3,
                    retry_codes=frozenset({12}),
                )
        self.assertEqual(run.call_count, 2)
        sleep.assert_called_once_with(5)


if __name__ == "__main__":
    unittest.main()
