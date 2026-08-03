#!/usr/bin/env python3
"""Discord OAuth and local session storage for Voxel Multiplayer Hills.

Pure Python standard library. The multiplayer server calls ``handle_request``
for HTTP auth routes and ``authenticate_session`` for optional WebSocket
identity attachment.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional


@dataclass(frozen=True)
class AuthResponse:
    status: int
    body: dict[str, Any]
    headers: dict[str, str]


DISCORD_API_BASE = "https://discord.com/api/v10"
DISCORD_CLIENT_ID = os.getenv("DISCORD_CLIENT_ID", "").strip()
DISCORD_CLIENT_SECRET = os.getenv("DISCORD_CLIENT_SECRET", "").strip()
GAME_URL = os.getenv(
    "GAME_URL", "https://us0ris.github.io/voxel-multiplayer-hills/"
).strip()
SERVER_URL = os.getenv(
    "SERVER_URL", "https://voxel-multiplayer-hills-410-server.onrender.com"
).strip().rstrip("/")
REDIRECT_URI = os.getenv(
    "DISCORD_REDIRECT_URI", f"{SERVER_URL}/auth/discord/callback"
).strip()
AUTH_REQUIRED = os.getenv("AUTH_REQUIRED", "0").strip().lower() in {
    "1", "true", "yes", "on"
}
DB_PATH = Path(
    os.getenv("AUTH_DB_PATH", str(Path(__file__).resolve().parent / "ridgewood.db"))
)
SESSION_TTL_SECONDS = max(
    3600, int(os.getenv("AUTH_SESSION_TTL_SECONDS", str(30 * 24 * 60 * 60)))
)
OAUTH_STATE_TTL_SECONDS = max(
    60, int(os.getenv("AUTH_STATE_TTL_SECONDS", "600"))
)
DISCORD_HTTP_TIMEOUT_SECONDS = max(
    2.0, float(os.getenv("DISCORD_HTTP_TIMEOUT_SECONDS", "10"))
)
COOKIE_NAME = os.getenv("AUTH_COOKIE_NAME", "voxel_session").strip() or "voxel_session"

_DB_LOCK = threading.RLock()


def _now() -> int:
    return int(time.time())


def _hash_secret(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=8.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 8000")
    return conn


def init_db() -> None:
    """Create the auth tables without colliding with earlier prototype tables."""
    with _DB_LOCK, _connect() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS auth_users (
                id TEXT PRIMARY KEY,
                discord_id TEXT UNIQUE NOT NULL,
                discord_username TEXT NOT NULL,
                discord_global_name TEXT,
                avatar_url TEXT NOT NULL DEFAULT '',
                coins INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS auth_sessions (
                token_hash TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                last_seen_at INTEGER NOT NULL,
                client_ip TEXT NOT NULL DEFAULT '',
                FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS auth_oauth_states (
                state_hash TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                client_ip TEXT NOT NULL DEFAULT ''
            );

            CREATE INDEX IF NOT EXISTS auth_sessions_user_id
                ON auth_sessions(user_id);
            CREATE INDEX IF NOT EXISTS auth_sessions_expires_at
                ON auth_sessions(expires_at);
            """
        )
        _cleanup_locked(conn)


def configured() -> bool:
    return bool(DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET and REDIRECT_URI)


def handle_request(
    method: str,
    path: str,
    headers: dict[str, str],
    body: bytes,
    client_ip: str,
) -> Optional[AuthResponse]:
    """Route auth requests. Return ``None`` for non-auth endpoints."""
    del body  # Reserved for future account-management endpoints.
    method = method.upper()
    parsed = urllib.parse.urlsplit(path)
    clean_path = parsed.path
    query_string = headers.get("query_string", parsed.query)

    if clean_path == "/auth/discord" and method == "GET":
        return handle_discord_login(client_ip)
    if clean_path == "/auth/discord/callback" and method == "GET":
        return handle_discord_callback(query_string, client_ip)
    if clean_path == "/auth/me" and method == "GET":
        token = extract_session_token(headers, query_string)
        user = authenticate_session(token)
        if not user:
            return _json_response(401, {"authenticated": False, "error": "unauthorized"})
        return _json_response(200, {"authenticated": True, "user": user})
    if clean_path == "/auth/logout" and method == "POST":
        token = extract_session_token(headers, query_string)
        if token:
            revoke_session(token)
        return AuthResponse(
            status=204,
            body={},
            headers={
                "Set-Cookie": _expired_cookie(),
                "Cache-Control": "no-store",
            },
        )
    if clean_path == "/auth/status" and method == "GET":
        return _json_response(
            200,
            {
                "configured": configured(),
                "provider": "discord",
                "authRequired": AUTH_REQUIRED,
                "redirectUri": REDIRECT_URI if configured() else None,
            },
        )
    return None


def handle_discord_login(client_ip: str = "") -> AuthResponse:
    """Create a one-time OAuth state and redirect to Discord."""
    if not configured():
        return _json_response(
            503,
            {
                "error": "discord_auth_not_configured",
                "message": "DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are required.",
            },
        )

    state = secrets.token_urlsafe(32)
    now = _now()
    with _DB_LOCK, _connect() as conn:
        _cleanup_locked(conn)
        conn.execute(
            "INSERT INTO auth_oauth_states (state_hash, created_at, expires_at, client_ip) "
            "VALUES (?, ?, ?, ?)",
            (_hash_secret(state), now, now + OAUTH_STATE_TTL_SECONDS, client_ip or ""),
        )

    auth_url = "https://discord.com/oauth2/authorize?" + urllib.parse.urlencode(
        {
            "client_id": DISCORD_CLIENT_ID,
            "redirect_uri": REDIRECT_URI,
            "response_type": "code",
            "scope": "identify",
            "state": state,
        }
    )
    return AuthResponse(
        status=302,
        body={},
        headers={"Location": auth_url, "Cache-Control": "no-store"},
    )


def handle_discord_callback(query_string: str, client_ip: str = "") -> AuthResponse:
    """Validate OAuth state, exchange the code, and create a local session."""
    params = urllib.parse.parse_qs(query_string, keep_blank_values=True)
    if params.get("error"):
        return _redirect_to_game(error="discord_denied")

    code = (params.get("code") or [""])[0]
    state = (params.get("state") or [""])[0]
    if not code:
        return _redirect_to_game(error="no_code")
    if not state or not _consume_oauth_state(state, client_ip):
        return _redirect_to_game(error="invalid_state")
    if not configured():
        return _redirect_to_game(error="auth_not_configured")

    try:
        token_response = _discord_form_post(
            "/oauth2/token",
            {
                "client_id": DISCORD_CLIENT_ID,
                "client_secret": DISCORD_CLIENT_SECRET,
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": REDIRECT_URI,
            },
        )
        access_token = str(token_response["access_token"])
        discord_user = _discord_json_get(
            "/users/@me", {"Authorization": f"Bearer {access_token}"}
        )

        discord_id = str(discord_user["id"])
        discord_username = str(discord_user.get("username") or "Discord user")
        global_name = str(discord_user.get("global_name") or "").strip()
        display_name = global_name or discord_username
        avatar_hash = str(discord_user.get("avatar") or "")
        avatar_url = (
            f"https://cdn.discordapp.com/avatars/{discord_id}/{avatar_hash}.webp?size=128"
            if avatar_hash
            else ""
        )
        user_id = f"discord_{discord_id}"
        now = _now()

        with _DB_LOCK, _connect() as conn:
            _cleanup_locked(conn)
            conn.execute(
                """
                INSERT INTO auth_users (
                    id, discord_id, discord_username, discord_global_name,
                    avatar_url, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(discord_id) DO UPDATE SET
                    discord_username = excluded.discord_username,
                    discord_global_name = excluded.discord_global_name,
                    avatar_url = excluded.avatar_url,
                    updated_at = excluded.updated_at
                """,
                (
                    user_id,
                    discord_id,
                    discord_username,
                    global_name or None,
                    avatar_url,
                    now,
                    now,
                ),
            )
            session_token = secrets.token_urlsafe(48)
            conn.execute(
                """
                INSERT INTO auth_sessions (
                    token_hash, user_id, created_at, expires_at, last_seen_at, client_ip
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    _hash_secret(session_token),
                    user_id,
                    now,
                    now + SESSION_TTL_SECONDS,
                    now,
                    client_ip or "",
                ),
            )

        return _redirect_to_game(
            token=session_token,
            username=display_name,
            headers={"Set-Cookie": _session_cookie(session_token)},
        )
    except (KeyError, ValueError, urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as exc:
        print(f"Discord auth failed: {type(exc).__name__}: {exc}", flush=True)
        return _redirect_to_game(error="auth_failed")
    except sqlite3.Error as exc:
        print(f"Discord auth database error: {exc}", flush=True)
        return _redirect_to_game(error="auth_storage_failed")


def extract_session_token(headers: dict[str, str], query_string: str = "") -> str:
    """Read a session from Bearer auth, the server cookie, or ``?token=``."""
    authorization = headers.get("authorization", "").strip()
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()

    cookie_header = headers.get("cookie", "")
    for item in cookie_header.split(";"):
        name, separator, value = item.strip().partition("=")
        if separator and name == COOKIE_NAME:
            return urllib.parse.unquote(value)

    if query_string:
        params = urllib.parse.parse_qs(query_string, keep_blank_values=True)
        return (params.get("token") or [""])[0]
    return ""


def authenticate_session(session_token: str) -> Optional[dict[str, Any]]:
    """Verify a session token and return public account data."""
    token = str(session_token or "").strip()
    if not token:
        return None
    now = _now()
    try:
        with _DB_LOCK, _connect() as conn:
            row = conn.execute(
                """
                SELECT u.id, u.discord_id, u.discord_username,
                       u.discord_global_name, u.avatar_url, u.coins,
                       s.expires_at
                FROM auth_sessions s
                JOIN auth_users u ON s.user_id = u.id
                WHERE s.token_hash = ?
                """,
                (_hash_secret(token),),
            ).fetchone()
            if not row or int(row["expires_at"]) <= now:
                if row:
                    conn.execute(
                        "DELETE FROM auth_sessions WHERE token_hash = ?",
                        (_hash_secret(token),),
                    )
                return None
            conn.execute(
                "UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?",
                (now, _hash_secret(token)),
            )
            return {
                "user_id": row["id"],
                "discord_id": row["discord_id"],
                "username": row["discord_global_name"] or row["discord_username"],
                "discord_username": row["discord_username"],
                "avatar_url": row["avatar_url"],
                "coins": int(row["coins"]),
                "expires_at": int(row["expires_at"]),
            }
    except sqlite3.Error as exc:
        print(f"Session auth error: {exc}", flush=True)
        return None


def revoke_session(session_token: str) -> None:
    token = str(session_token or "").strip()
    if not token:
        return
    with _DB_LOCK, _connect() as conn:
        conn.execute(
            "DELETE FROM auth_sessions WHERE token_hash = ?", (_hash_secret(token),)
        )


def websocket_user(headers: dict[str, str], query_string: str = "") -> Optional[dict[str, Any]]:
    """Resolve an optional authenticated identity for a WebSocket upgrade."""
    return authenticate_session(extract_session_token(headers, query_string))


def safe_display_name(user: Optional[dict[str, Any]]) -> str:
    """Convert a Discord display name to the game's current 24-char name rules."""
    raw = str((user or {}).get("username") or "Discord Player")
    cleaned = "".join(
        char for char in raw
        if (char.isascii() and char.isalnum()) or char in " ._-"
    )
    cleaned = " ".join(cleaned.split()).strip(" ._-")
    return (cleaned or "Discord Player")[:24]


def _consume_oauth_state(state: str, client_ip: str) -> bool:
    now = _now()
    state_hash = _hash_secret(state)
    with _DB_LOCK, _connect() as conn:
        row = conn.execute(
            "SELECT expires_at, client_ip FROM auth_oauth_states WHERE state_hash = ?",
            (state_hash,),
        ).fetchone()
        conn.execute(
            "DELETE FROM auth_oauth_states WHERE state_hash = ?", (state_hash,)
        )
        if not row or int(row["expires_at"]) <= now:
            return False
        # The IP is retained for audit/debugging but is not part of the OAuth
        # state check; mobile networks and privacy relays can change it during
        # the Discord round trip.
        return True


def _cleanup_locked(conn: sqlite3.Connection) -> None:
    now = _now()
    conn.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", (now,))
    conn.execute("DELETE FROM auth_oauth_states WHERE expires_at <= ?", (now,))


def _discord_form_post(path: str, values: dict[str, str]) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{DISCORD_API_BASE}{path}",
        data=urllib.parse.urlencode(values).encode("utf-8"),
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "User-Agent": "VoxelMultiplayerHills/0.4.2",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=DISCORD_HTTP_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))


def _discord_json_get(path: str, headers: dict[str, str]) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{DISCORD_API_BASE}{path}",
        headers={
            **headers,
            "Accept": "application/json",
            "User-Agent": "VoxelMultiplayerHills/0.4.2",
        },
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=DISCORD_HTTP_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))


def _json_response(status: int, body: dict[str, Any]) -> AuthResponse:
    return AuthResponse(
        status=status,
        body=body,
        headers={"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"},
    )


def _redirect_to_game(
    *,
    token: str = "",
    username: str = "",
    error: str = "",
    headers: Optional[dict[str, str]] = None,
) -> AuthResponse:
    split = urllib.parse.urlsplit(GAME_URL)
    fragment_values: dict[str, str] = {}
    if token:
        fragment_values["auth_token"] = token
        fragment_values["username"] = username
        fragment_values["provider"] = "discord"
    if error:
        fragment_values["auth_error"] = error
    location = urllib.parse.urlunsplit(
        (split.scheme, split.netloc, split.path, split.query, urllib.parse.urlencode(fragment_values))
    )
    response_headers = {"Location": location, "Cache-Control": "no-store"}
    if headers:
        response_headers.update(headers)
    return AuthResponse(status=302, body={}, headers=response_headers)


def _session_cookie(token: str) -> str:
    return (
        f"{COOKIE_NAME}={urllib.parse.quote(token)}; Path=/; Max-Age={SESSION_TTL_SECONDS}; "
        "HttpOnly; Secure; SameSite=None"
    )


def _expired_cookie() -> str:
    return f"{COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None"


init_db()
