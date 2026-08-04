#!/usr/bin/env python3
"""Server-side username/password authentication for Ridgewood.

Passwords never leave the Render server except in the user's TLS-protected
request. Supabase stores only a per-account salt and a memory-hard scrypt hash.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from supabase_store import STORE, SupabaseError, utc_now_iso

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,24}$")
MIN_PASSWORD_LENGTH = 10
MAX_PASSWORD_LENGTH = 256
SCRYPT_N = 1 << 14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32
LOCK_AFTER_FAILURES = 8
LOCK_SECONDS = 15 * 60
WINDOW_SECONDS = 10 * 60
MAX_IP_ATTEMPTS = 30

_LOCK = threading.RLock()
_IP_ATTEMPTS: dict[str, list[float]] = {}


class PasswordAuthError(RuntimeError):
    def __init__(self, code: str, status: int = 400):
        super().__init__(code)
        self.code = code
        self.status = status


def normalize_username(username: Any) -> tuple[str, str]:
    display = str(username or "").strip()
    if not USERNAME_RE.fullmatch(display):
        raise PasswordAuthError("invalid_username")
    return display, display.lower()


def validate_password(password: Any) -> str:
    value = str(password or "")
    if len(value) < MIN_PASSWORD_LENGTH:
        raise PasswordAuthError("password_too_short")
    if len(value) > MAX_PASSWORD_LENGTH:
        raise PasswordAuthError("password_too_long")
    if value.isspace():
        raise PasswordAuthError("invalid_password")
    return value


def _hash_password(password: str, salt: bytes) -> str:
    derived = hashlib.scrypt(
        password.encode("utf-8"), salt=salt,
        n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_DKLEN,
    )
    return base64.urlsafe_b64encode(derived).decode("ascii")


def _decode_json(body: bytes) -> dict[str, Any]:
    if not body or len(body) > 16_384:
        raise PasswordAuthError("invalid_request")
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PasswordAuthError("invalid_json") from exc
    if not isinstance(value, dict):
        raise PasswordAuthError("invalid_request")
    return value


def _rate_limit(client_ip: str) -> None:
    now = time.time()
    key = str(client_ip or "unknown")
    with _LOCK:
        attempts = [stamp for stamp in _IP_ATTEMPTS.get(key, []) if now - stamp < WINDOW_SECONDS]
        if len(attempts) >= MAX_IP_ATTEMPTS:
            raise PasswordAuthError("too_many_attempts", 429)
        attempts.append(now)
        _IP_ATTEMPTS[key] = attempts
        for ip, stamps in list(_IP_ATTEMPTS.items()):
            retained = [stamp for stamp in stamps if now - stamp < WINDOW_SECONDS]
            if retained:
                _IP_ATTEMPTS[ip] = retained
            else:
                _IP_ATTEMPTS.pop(ip, None)


def _credential(normalized: str) -> dict[str, Any] | None:
    rows = STORE._request(
        "GET", "game_password_credentials",
        query={
            "select": "user_id,username,username_normalized,password_hash,password_salt,hash_algorithm,hash_params,failed_attempts,locked_until",
            "username_normalized": f"eq.{normalized}", "limit": "1",
        },
    )
    if not isinstance(rows, list) or not rows:
        return None
    return dict(rows[0])


def _user(user_id: str) -> dict[str, Any] | None:
    rows = STORE._request(
        "GET", "game_users",
        query={
            "select": "id,discord_id,discord_username,display_name,avatar_url,coins",
            "id": f"eq.{user_id}", "limit": "1",
        },
    )
    if not isinstance(rows, list) or not rows:
        return None
    return dict(rows[0])


def _is_locked(value: Any) -> bool:
    if not value:
        return False
    try:
        text = str(value).replace("Z", "+00:00")
        return datetime.fromisoformat(text).astimezone(timezone.utc) > datetime.now(timezone.utc)
    except ValueError:
        return False


def _record_failure(credential: dict[str, Any]) -> None:
    failures = int(credential.get("failed_attempts") or 0) + 1
    body: dict[str, Any] = {"failed_attempts": failures, "updated_at": utc_now_iso()}
    if failures >= LOCK_AFTER_FAILURES:
        body["locked_until"] = (
            datetime.now(timezone.utc) + timedelta(seconds=LOCK_SECONDS)
        ).isoformat().replace("+00:00", "Z")
        body["failed_attempts"] = 0
    STORE._request(
        "PATCH", "game_password_credentials",
        query={"user_id": f"eq.{credential['user_id']}"}, body=body,
        prefer="return=minimal",
    )


def _clear_failures(user_id: str) -> None:
    STORE._request(
        "PATCH", "game_password_credentials",
        query={"user_id": f"eq.{user_id}"},
        body={"failed_attempts": 0, "locked_until": None, "updated_at": utc_now_iso()},
        prefer="return=minimal",
    )


def register(body: bytes, client_ip: str) -> dict[str, Any]:
    _rate_limit(client_ip)
    payload = _decode_json(body)
    username, normalized = normalize_username(payload.get("username"))
    password = validate_password(payload.get("password"))

    if _credential(normalized):
        raise PasswordAuthError("username_taken", 409)

    salt = secrets.token_bytes(16)
    password_hash = _hash_password(password, salt)
    user_rows = STORE._request(
        "POST", "game_users", query={"select": "*"},
        body={
            "discord_id": None,
            "discord_username": None,
            "display_name": username,
            "avatar_url": "",
            "updated_at": utc_now_iso(),
        },
        prefer="return=representation",
    )
    if not isinstance(user_rows, list) or not user_rows:
        raise SupabaseError("Supabase did not return the created user")
    user = dict(user_rows[0])
    try:
        STORE._request(
            "POST", "game_password_credentials",
            body={
                "user_id": user["id"],
                "username": username,
                "username_normalized": normalized,
                "password_hash": password_hash,
                "password_salt": base64.urlsafe_b64encode(salt).decode("ascii"),
                "hash_algorithm": "scrypt",
                "hash_params": {"n": SCRYPT_N, "r": SCRYPT_R, "p": SCRYPT_P, "dklen": SCRYPT_DKLEN},
            },
            prefer="return=minimal",
        )
    except Exception:
        try:
            STORE._request("DELETE", "game_users", query={"id": f"eq.{user['id']}"}, prefer="return=minimal")
        except Exception:
            pass
        raise
    return user


def login(body: bytes, client_ip: str) -> dict[str, Any]:
    _rate_limit(client_ip)
    payload = _decode_json(body)
    _display, normalized = normalize_username(payload.get("username"))
    password = validate_password(payload.get("password"))
    credential = _credential(normalized)
    if not credential:
        hashlib.scrypt(password.encode("utf-8"), salt=b"ridgewood-missing", n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_DKLEN)
        raise PasswordAuthError("invalid_credentials", 401)
    if _is_locked(credential.get("locked_until")):
        raise PasswordAuthError("account_temporarily_locked", 423)
    try:
        salt = base64.urlsafe_b64decode(str(credential["password_salt"]).encode("ascii"))
        candidate = _hash_password(password, salt)
    except (ValueError, KeyError) as exc:
        raise SupabaseError("Stored password credential is invalid") from exc
    if not hmac.compare_digest(candidate, str(credential.get("password_hash") or "")):
        _record_failure(credential)
        raise PasswordAuthError("invalid_credentials", 401)
    _clear_failures(str(credential["user_id"]))
    user = _user(str(credential["user_id"]))
    if not user:
        raise PasswordAuthError("invalid_credentials", 401)
    return user
