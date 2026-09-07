from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from flask import Blueprint, Flask, g, jsonify, request


access_blueprint = Blueprint("project_access", __name__)


def database_path() -> Path:
    backend_dir = Path(__file__).resolve().parent
    data_dir = Path(os.environ.get("LABEL_TOOL_DATA_DIR", backend_dir / "data")).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir / "access_control.db"


@contextmanager
def connection():
    db = sqlite3.connect(database_path())
    db.row_factory = sqlite3.Row
    try:
        with db:
            yield db
    finally:
        db.close()


def init_access_database() -> None:
    with connection() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS project_assignments (
                project_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                assigned_at TEXT NOT NULL,
                assigned_by TEXT NOT NULL,
                PRIMARY KEY (project_id, user_id)
            )
        """)


def assigned_project_ids(user_id: str) -> set[str]:
    with connection() as db:
        return {row["project_id"] for row in db.execute(
            "SELECT project_id FROM project_assignments WHERE user_id = ?", (user_id,)
        )}


def user_is_assigned(project_id: str, user_id: str) -> bool:
    with connection() as db:
        return db.execute(
            "SELECT 1 FROM project_assignments WHERE project_id = ? AND user_id = ?",
            (project_id, user_id),
        ).fetchone() is not None


def remove_project_assignments(project_id: str) -> None:
    with connection() as db:
        db.execute("DELETE FROM project_assignments WHERE project_id = ?", (project_id,))


def register_project_access(app: Flask) -> None:
    init_access_database()

    @app.before_request
    def enforce_project_access():
        if not request.path.startswith("/api/projects") or app.config.get("AUTH_DISABLED_FOR_TESTS") is True:
            return None
        user = getattr(g, "current_user", None)
        if not user:
            return jsonify({"error": "需要登入"}), 401
        if user.get("is_admin"):
            return None
        if request.path == "/api/projects" and request.method == "GET":
            return None
        if request.path == "/api/projects" and request.method == "POST":
            return jsonify({"error": "只有管理員可以建立專案"}), 403

        parts = request.path.split("/")
        project_id = parts[3] if len(parts) > 3 else ""
        if not user_is_assigned(project_id, user["id"]):
            return jsonify({"error": "你未被指派到此專案"}), 403

        suffix = "/".join(parts[4:])
        annotation_access = suffix.endswith("/annotation") and request.method in {"GET", "PUT"}
        read_access = request.method == "GET" and (
            suffix == "" or suffix == "images" or suffix == "download" or suffix.endswith("/content")
        )
        if annotation_access or read_access:
            return None
        return jsonify({"error": "一般使用者只能執行被指派專案的標註工作"}), 403

    app.register_blueprint(access_blueprint)


@access_blueprint.get("/api/projects/<project_id>/assignments")
def get_assignments(project_id: str):
    if not g.current_user.get("is_admin"):
        return jsonify({"error": "權限不足"}), 403
    with connection() as db:
        user_ids = [row["user_id"] for row in db.execute(
            "SELECT user_id FROM project_assignments WHERE project_id = ? ORDER BY assigned_at", (project_id,)
        )]
    return jsonify({"user_ids": user_ids})


@access_blueprint.put("/api/projects/<project_id>/assignments")
def replace_assignments(project_id: str):
    if not g.current_user.get("is_admin"):
        return jsonify({"error": "權限不足"}), 403
    body = request.get_json(silent=True) or {}
    user_ids = body.get("user_ids")
    if not isinstance(user_ids, list) or not all(isinstance(value, str) and value for value in user_ids):
        return jsonify({"error": "user_ids 必須是使用者 ID 陣列"}), 400
    now = datetime.now(timezone.utc).isoformat()
    with connection() as db:
        db.execute("DELETE FROM project_assignments WHERE project_id = ?", (project_id,))
        db.executemany(
            "INSERT INTO project_assignments (project_id, user_id, assigned_at, assigned_by) VALUES (?, ?, ?, ?)",
            [(project_id, user_id, now, g.current_user["id"]) for user_id in dict.fromkeys(user_ids)],
        )
    return jsonify({"user_ids": list(dict.fromkeys(user_ids))})
