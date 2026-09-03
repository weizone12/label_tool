from __future__ import annotations

import os
import secrets
from pathlib import Path

from cachelib.file import FileSystemCache
from flask import Flask, jsonify
from flask_cors import CORS
from flask_session import Session

from auth.models import db_session, init_database
from auth.routes import auth_blueprint
from auth.service import bootstrap_admin


BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("AUTH_DATA_DIR", BASE_DIR / "auth_data")).resolve()


def create_app() -> Flask:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=os.environ.get("AUTH_SECRET_KEY") or secrets.token_hex(32),
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        SESSION_COOKIE_SECURE=os.environ.get("AUTH_COOKIE_SECURE", "0") == "1",
        SESSION_TYPE="cachelib",
        SESSION_CACHELIB=FileSystemCache(cache_dir=str(DATA_DIR / "sessions")),
        SESSION_PERMANENT=False,
    )
    Session(app)
    CORS(app, resources={r"/api/*": {"origins": ["http://127.0.0.1:5174", "http://localhost:5174"]}}, supports_credentials=True)
    database_url = os.environ.get("AUTH_DATABASE_URL", f"sqlite:///{(DATA_DIR / 'users.db').as_posix()}")
    init_database(database_url)
    bootstrap_admin()
    app.register_blueprint(auth_blueprint)
    app.teardown_appcontext(lambda _error: db_session.remove())

    @app.get("/api/health")
    def health():
        return jsonify({"status": "ok", "service": "auth"})

    return app


app = create_app()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5002, debug=os.environ.get("AUTH_DEBUG") == "1")
