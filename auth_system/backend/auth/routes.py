from __future__ import annotations

import secrets
import threading
import time
from collections import defaultdict, deque
from functools import wraps

from flask import Blueprint, current_app, jsonify, request, session
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .models import User, db_session, utc_now
from .service import authenticate, change_password, create_user, normalize_username, reset_password


auth_blueprint = Blueprint("standalone_auth", __name__)
_login_attempts: dict[str, deque[float]] = defaultdict(deque)
_rate_lock = threading.Lock()
LOGIN_LIMIT = 5
LOGIN_WINDOW_SECONDS = 60


def error(message: str, status: int):
    return jsonify({"error": message}), status


def current_user() -> User | None:
    user_id = session.get("user_id")
    user = db_session.get(User, user_id) if user_id else None
    if user and user.status == "active":
        return user
    session.pop("user_id", None)
    return None


def require_user(handler):
    @wraps(handler)
    def wrapped(*args, **kwargs):
        user = current_user()
        if not user:
            return error("需要登入", 401)
        return handler(user, *args, **kwargs)
    return wrapped


def require_admin(handler):
    @require_user
    @wraps(handler)
    def wrapped(user, *args, **kwargs):
        if not user.is_admin:
            return error("權限不足", 403)
        if user.must_change_password:
            return error("請先修改密碼", 403)
        return handler(user, *args, **kwargs)
    return wrapped


@auth_blueprint.before_request
def protect_csrf():
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        expected = session.get("csrf_token")
        supplied = request.headers.get("X-CSRF-Token")
        if not expected or not supplied or not secrets.compare_digest(expected, supplied):
            return error("CSRF 驗證失敗", 403)


@auth_blueprint.get("/api/auth/csrf")
def csrf_token():
    token = session.get("csrf_token") or secrets.token_urlsafe(32)
    session["csrf_token"] = token
    return jsonify({"csrf_token": token})


def login_rate_limited(key: str) -> bool:
    now = time.monotonic()
    with _rate_lock:
        attempts = _login_attempts[key]
        while attempts and attempts[0] <= now - LOGIN_WINDOW_SECONDS:
            attempts.popleft()
        if len(attempts) >= LOGIN_LIMIT:
            return True
        attempts.append(now)
        return False


@auth_blueprint.post("/api/auth/login")
def login():
    body = request.get_json(silent=True) or {}
    key = f"{request.remote_addr or 'unknown'}:{str(body.get('username') or '').strip().lower()}"
    if login_rate_limited(key):
        return error("嘗試次數過多，請稍後再試", 429)
    user = authenticate(body.get("username"), body.get("password"))
    if not user:
        return error("帳號或密碼錯誤", 401)
    session.clear()
    current_app.session_interface.regenerate(session)
    session["user_id"] = user.id
    session["csrf_token"] = secrets.token_urlsafe(32)
    with _rate_lock:
        _login_attempts.pop(key, None)
    return jsonify({"user": user.public_dict(), "csrf_token": session["csrf_token"]})


@auth_blueprint.post("/api/auth/logout")
@require_user
def logout(_user):
    session.clear()
    return "", 204


@auth_blueprint.get("/api/auth/me")
@require_user
def me(user):
    return jsonify({"user": user.public_dict()})


@auth_blueprint.post("/api/auth/change-password")
@require_user
def update_own_password(user):
    body = request.get_json(silent=True) or {}
    try:
        change_password(user, body.get("current_password"), body.get("new_password"))
    except ValueError as exc:
        return error(str(exc), 400)
    return jsonify({"user": user.public_dict()})


@auth_blueprint.get("/api/admin/users")
@require_admin
def list_users(_admin):
    users = db_session.scalars(select(User).order_by(User.created_at.desc())).all()
    return jsonify({"users": [user.public_dict() for user in users]})


@auth_blueprint.post("/api/admin/users")
@require_admin
def add_user(_admin):
    body = request.get_json(silent=True) or {}
    try:
        user, temporary_password = create_user(
            username=body.get("username"), password=body.get("temporary_password"),
            display_name=body.get("display_name"), email=body.get("email"),
            is_admin=body.get("is_admin", False),
        )
    except ValueError as exc:
        return error(str(exc), 400)
    return jsonify({"user": user.public_dict(), "temporary_password": temporary_password}), 201


@auth_blueprint.patch("/api/admin/users/<user_id>")
@require_admin
def update_user(_admin, user_id: str):
    user = db_session.get(User, user_id)
    if not user:
        return error("找不到使用者", 404)
    body = request.get_json(silent=True) or {}
    if "username" in body:
        username = normalize_username(body["username"])
        if not username or len(username) > 80:
            return error("username 必填且不可超過 80 個字元", 400)
        user.username = username
    if "status" in body:
        if body["status"] not in {"active", "disabled"}:
            return error("status 必須是 active 或 disabled", 400)
        user.status = body["status"]
    for field in ("display_name", "email"):
        if field in body:
            setattr(user, field, str(body[field]).strip() or None)
    user.updated_at = utc_now()
    try:
        db_session.commit()
    except IntegrityError:
        db_session.rollback()
        return error("username 已被使用", 400)
    return jsonify({"user": user.public_dict()})


@auth_blueprint.post("/api/admin/users/<user_id>/reset-password")
@require_admin
def admin_reset_password(_admin, user_id: str):
    user = db_session.get(User, user_id)
    if not user:
        return error("找不到使用者", 404)
    body = request.get_json(silent=True) or {}
    try:
        temporary_password = reset_password(user, body.get("temporary_password"))
    except ValueError as exc:
        return error(str(exc), 400)
    return jsonify({"user": user.public_dict(), "temporary_password": temporary_password})
