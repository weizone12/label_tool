from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

from flask import Flask, current_app, g, jsonify, request


PROTECTED_PREFIX = "/api/projects"
MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def register_auth_integration(app: Flask) -> None:
    """Protect annotation APIs through the standalone Auth service."""

    @app.before_request
    def verify_auth_session():
        if not request.path.startswith(PROTECTED_PREFIX) or request.method == "OPTIONS":
            return None
        if current_app.config.get("AUTH_DISABLED_FOR_TESTS") is True:
            return None

        auth_url = os.environ.get("LABEL_TOOL_AUTH_SERVICE_URL", "http://127.0.0.1:5002").rstrip("/")
        verify_method = "POST" if request.method in MUTATING_METHODS else "GET"
        headers = {"Cookie": request.headers.get("Cookie", "")}
        csrf_token = request.headers.get("X-CSRF-Token")
        if csrf_token:
            headers["X-CSRF-Token"] = csrf_token
        verification = urllib.request.Request(
            f"{auth_url}/api/auth/verify", data=b"" if verify_method == "POST" else None,
            headers=headers, method=verify_method,
        )
        try:
            with urllib.request.urlopen(verification, timeout=3) as response:
                payload = json.loads(response.read().decode("utf-8"))
                g.current_user = payload["user"]
        except urllib.error.HTTPError as exc:
            try:
                message = json.loads(exc.read().decode("utf-8")).get("error", "驗證失敗")
            except (ValueError, UnicodeDecodeError):
                message = "驗證失敗"
            return jsonify({"error": message}), exc.code
        except (urllib.error.URLError, TimeoutError, OSError):
            return jsonify({"error": "登入服務目前無法使用"}), 503

        return None
