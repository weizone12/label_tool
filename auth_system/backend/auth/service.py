from __future__ import annotations

import os
import secrets
import string

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .models import User, db_session, utc_now


password_hasher = PasswordHasher()


def normalize_username(value: object) -> str:
    return str(value or "").strip().lower()


def validate_password(password: object) -> str:
    value = str(password or "")
    if len(value) < 12:
        raise ValueError("密碼至少需要 12 個字元")
    return value


def generate_temporary_password() -> str:
    alphabet = string.ascii_letters + string.digits + "!@#$%_-"
    return "".join(secrets.choice(alphabet) for _ in range(18))


def find_user_by_username(username: object) -> User | None:
    return db_session.scalar(select(User).where(User.username == normalize_username(username)))


def create_user(*, username: object, password: object | None = None, email: object = None,
                display_name: object = None, is_admin: bool = False) -> tuple[User, str]:
    normalized = normalize_username(username)
    if not normalized or len(normalized) > 80:
        raise ValueError("username 必填且不可超過 80 個字元")
    temporary_password = validate_password(password or generate_temporary_password())
    user = User(
        username=normalized,
        email=str(email).strip() or None if email is not None else None,
        display_name=str(display_name).strip() or None if display_name is not None else None,
        password_hash=password_hasher.hash(temporary_password),
        status="active",
        must_change_password=True,
        is_admin=bool(is_admin),
    )
    db_session.add(user)
    try:
        db_session.commit()
    except IntegrityError as error:
        db_session.rollback()
        raise ValueError("username 已被使用") from error
    return user, temporary_password


def authenticate(username: object, password: object) -> User | None:
    user = find_user_by_username(username)
    if not user or user.status != "active":
        return None
    try:
        password_hasher.verify(user.password_hash, str(password or ""))
    except VerifyMismatchError:
        return None
    if password_hasher.check_needs_rehash(user.password_hash):
        user.password_hash = password_hasher.hash(str(password))
    user.last_login_at = utc_now()
    db_session.commit()
    return user


def change_password(user: User, current_password: object, new_password: object) -> None:
    try:
        password_hasher.verify(user.password_hash, str(current_password or ""))
    except VerifyMismatchError as error:
        raise ValueError("目前密碼錯誤") from error
    password = validate_password(new_password)
    if str(current_password) == password:
        raise ValueError("新密碼不可與目前密碼相同")
    user.password_hash = password_hasher.hash(password)
    user.must_change_password = False
    user.updated_at = utc_now()
    db_session.commit()


def reset_password(user: User, password: object | None = None) -> str:
    temporary_password = validate_password(password or generate_temporary_password())
    user.password_hash = password_hasher.hash(temporary_password)
    user.must_change_password = True
    user.updated_at = utc_now()
    db_session.commit()
    return temporary_password


def bootstrap_admin() -> None:
    username = os.environ.get("AUTH_BOOTSTRAP_ADMIN_USERNAME")
    password = os.environ.get("AUTH_BOOTSTRAP_ADMIN_PASSWORD")
    if username and password and find_user_by_username(username) is None:
        create_user(username=username, password=password, display_name="Administrator", is_admin=True)
