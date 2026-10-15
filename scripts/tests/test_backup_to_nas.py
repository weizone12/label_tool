from __future__ import annotations

import json
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
    directory_rsync_command,
    discover_projects,
    file_rsync_command,
    group_components,
    run_checked,
    rsync_output_has_changes,
    sanitize_component,
    sqlite_snapshot,
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

    def test_rsync_change_output_distinguishes_updated_and_unchanged(self):
        self.assertFalse(rsync_output_has_changes(""))
        self.assertFalse(rsync_output_has_changes(None))
        self.assertTrue(rsync_output_has_changes("CHANGE:>f++++++++++\n"))
        self.assertTrue(rsync_output_has_changes("sending incremental file list\nCHANGE:.f..t......\n"))


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
