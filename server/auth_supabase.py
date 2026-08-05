#!/usr/bin/env python3
"""Ridgewood authentication with Discord OAuth and username/password accounts."""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import password_auth
from password_auth import PasswordAuthError
from supabase_store import STORE, SupabaseError


@dataclass(frozen=True)
class AuthResponse:
    status: int
    body: dict[str, Any]
    headers: dict[str, str]


DISCORD_CLIENT_ID = os.getenv("DISCORD_CLIENT_ID", "").strip()
DISCORD_CLIENT_SECRET = os.getenv("DISCORD_CLIENT_SECRET", "").strip()
GAME_URL = os.getenv("GAME_URL", "https://us0ris.github.io/voxel-multiplayer-hills/").strip()
SERVER_URL = os.getenv("SERVER_URL", "https://voxel-multiplayer-hills-410-server.onrender.com").strip().rstrip("/")
REDIRECT_URI = os.getenv("DISCORD_REDIRECT_URI", f"{SERVER_URL}/auth/discord/callback").strip()
AUTH_REQUIRED = os.getenv("AUTH_REQUIRED", "1").lower() in {"1", "true", "yes", "on"}
PASSWORD_AUTH_ENABLED = os.getenv("PASSWORD_AUTH_ENABLED", "1").lower() in {"1", "true", "yes", "on"}
ADMIN_USERNAMES = tuple(
    name.strip().lower()
    for name in os.getenv("ADMIN_USERNAMES", "").split(",")
    if name.strip()
)
SESSION_TTL = max(3600, int(os.getenv("AUTH_SESSION_TTL_SECONDS", str(30 * 86400))))
STATE_TTL = max(60, int(os.getenv("AUTH_STATE_TTL_SECONDS", "600")))
CACHE_TTL = max(15, min(600, int(os.getenv("AUTH_SESSION_CACHE_SECONDS", "120"))))
COOKIE_NAME = os.getenv("AUTH_COOKIE_NAME", "voxel_session")
TIMEOUT = max(2.0, float(os.getenv("DISCORD_HTTP_TIMEOUT_SECONDS", "10")))

_LOCK = threading.RLock()
_STATES: dict[str, float] = {}
_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _iso_after(seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


def discord_configured() -> bool:
    return bool(DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET and REDIRECT_URI and STORE.ready)


def configured() -> bool:
    return bool(STORE.ready and (discord_configured() or PASSWORD_AUTH_ENABLED))


def handle_request(method: str, path: str, headers: dict[str, str], body: bytes, client_ip: str) -> Optional[AuthResponse]:
    method = method.upper()
    parsed = urllib.parse.urlsplit(path)
    clean = parsed.path
    query = headers.get("query_string", parsed.query)

    if clean == "/auth/discord" and method == "GET":
        return handle_discord_login()
    if clean == "/auth/discord/callback" and method == "GET":
        return handle_discord_callback(query)
    if clean == "/auth/password/register" and method == "POST":
        return handle_password_register(body, client_ip)
    if clean == "/auth/password/login" and method == "POST":
        return handle_password_login(body, client_ip)
    if clean == "/auth/me" and method == "GET":
        user = authenticate_session(extract_session_token(headers, query))
        if not user:
            return _json(401, {"authenticated": False, "error": "unauthorized"})
        ban = ban_state(user)
        if ban:
            return _json(403, {"authenticated": False, "error": "account_banned", "ban": ban})
        return _json(200, {"authenticated": True, "user": user})
    if clean == "/auth/logout" and method == "POST":
        revoke_session(extract_session_token(headers, query))
        return AuthResponse(204, {}, {"Set-Cookie": _expired_cookie(), "Cache-Control": "no-store"})
    if clean == "/auth/status" and method == "GET":
        return _json(200, {
            "configured": configured(),
            "providers": {
                "discord": discord_configured(),
                "password": bool(PASSWORD_AUTH_ENABLED and STORE.ready),
            },
            "authRequired": AUTH_REQUIRED,
            "storage": "supabase" if STORE.ready else "unavailable",
            "roles": True,
            "redirectUri": REDIRECT_URI if discord_configured() else None,
        })
    return None


def handle_password_register(body: bytes, client_ip: str) -> AuthResponse:
    if not PASSWORD_AUTH_ENABLED or not STORE.ready:
        return _json(503, {"error": "password_auth_not_configured"})
    try:
        row = password_auth.register(body, client_ip)
        raw_token, user = _issue_session(row, provider="password")
        return _json(201, {"authenticated": True, "token": raw_token, "user": user})
    except PasswordAuthError as exc:
        return _json(exc.status, {"error": exc.code})
    except SupabaseError as exc:
        print(f"Password registration error: {exc}", flush=True)
        return _json(503, {"error": "registration_unavailable"})


def handle_password_login(body: bytes, client_ip: str) -> AuthResponse:
    if not PASSWORD_AUTH_ENABLED or not STORE.ready:
        return _json(503, {"error": "password_auth_not_configured"})
    try:
        row = password_auth.login(body, client_ip)
        ban = ban_state(_public_user(row, None, provider="password"))
        if ban:
            return _json(403, {"authenticated": False, "error": "account_banned", "ban": ban})
        raw_token, user = _issue_session(row, provider="password")
        return _json(200, {"authenticated": True, "token": raw_token, "user": user})
    except PasswordAuthError as exc:
        return _json(exc.status, {"error": exc.code})
    except SupabaseError as exc:
        print(f"Password login error: {exc}", flush=True)
        return _json(503, {"error": "login_unavailable"})


def handle_discord_login() -> AuthResponse:
    if not discord_configured():
        return _json(503, {"error": "discord_not_configured"})
    state = secrets.token_urlsafe(32)
    with _LOCK:
        _cleanup()
        _STATES[_hash(state)] = time.time() + STATE_TTL
    location = "https://discord.com/oauth2/authorize?" + urllib.parse.urlencode({
        "client_id": DISCORD_CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": "identify",
        "state": state,
    })
    return AuthResponse(302, {}, {"Location": location, "Cache-Control": "no-store"})


def handle_discord_callback(query: str) -> AuthResponse:
    params = urllib.parse.parse_qs(query)
    if params.get("error"):
        return _redirect(error="discord_denied")
    code = (params.get("code") or [""])[0]
    state = (params.get("state") or [""])[0]
    with _LOCK:
        _cleanup()
        expires = _STATES.pop(_hash(state), 0) if state else 0
    if not code:
        return _redirect(error="no_code")
    if expires <= time.time():
        return _redirect(error="invalid_state")
    try:
        token = _discord_post("/oauth2/token", {
            "client_id": DISCORD_CLIENT_ID,
            "client_secret": DISCORD_CLIENT_SECRET,
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT_URI,
        })["access_token"]
        discord_user = _discord_get("/users/@me", {"Authorization": f"Bearer {token}"})
        username = str(discord_user.get("global_name") or discord_user.get("username") or "Discord Player")
        avatar = str(discord_user.get("avatar") or "")
        avatar_url = f"https://cdn.discordapp.com/avatars/{discord_user['id']}/{avatar}.webp?size=128" if avatar else ""
        row = STORE.upsert_discord_user(
            discord_id=str(discord_user["id"]),
            discord_username=str(discord_user.get("username") or username),
            display_name=username,
            avatar_url=avatar_url,
        )
        raw_token, user = _issue_session(row, provider="discord")
        return _redirect(token=raw_token, username=user["username"], provider="discord", headers={"Set-Cookie": _cookie(raw_token)})
    except (KeyError, ValueError, urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, SupabaseError) as exc:
        print(f"Discord auth error: {type(exc).__name__}: {exc}", flush=True)
        return _redirect(error="auth_failed")


def _issue_session(row: dict[str, Any], provider: str) -> tuple[str, dict[str, Any]]:
    raw_token = secrets.token_urlsafe(48)
    token_hash = _hash(raw_token)
    STORE.create_session(token_hash=token_hash, user_id=str(row["id"]), expires_at=_iso_after(SESSION_TTL))
    user = _public_user(row, int(time.time()) + SESSION_TTL, provider=provider)
    with _LOCK:
        _CACHE[token_hash] = (time.time() + CACHE_TTL, user)
    return raw_token, user


def session_token_candidates(headers: dict[str, str], query: str = "") -> list[str]:
    """Every token the caller might have supplied, best first.

    The explicit ?token= wins over the cookie. A stale Discord cookie used to
    shadow a perfectly valid password-login token, so password accounts silently
    connected as anonymous guests with no role while Discord accounts -- whose
    session IS the cookie -- worked fine.
    """
    candidates: list[str] = []

    if query:
        candidates.append((urllib.parse.parse_qs(query).get("token") or [""])[0])

    auth_header = headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        candidates.append(auth_header[7:].strip())

    for item in headers.get("cookie", "").split(";"):
        name, sep, value = item.strip().partition("=")
        if sep and name == COOKIE_NAME:
            candidates.append(urllib.parse.unquote(value))

    seen: set[str] = set()
    ordered: list[str] = []
    for token in candidates:
        if token and token not in seen:
            seen.add(token)
            ordered.append(token)
    return ordered


def extract_session_token(headers: dict[str, str], query: str = "") -> str:
    candidates = session_token_candidates(headers, query)
    return candidates[0] if candidates else ""


def authenticate_session(raw_token: str) -> Optional[dict[str, Any]]:
    if not raw_token or not STORE.ready:
        return None
    key = _hash(raw_token)
    now = time.time()
    with _LOCK:
        cached = _CACHE.get(key)
        if cached and cached[0] > now:
            return dict(cached[1])
        _CACHE.pop(key, None)
    try:
        session = STORE.get_session(key)
        if not session:
            return None
        row = session["user"]
        provider = "discord" if row.get("discord_id") else "password"
        user = _public_user(row, session.get("expires_at"), provider=provider)
        with _LOCK:
            _CACHE[key] = (now + CACHE_TTL, user)
        try:
            STORE.touch_session(key)
        except SupabaseError:
            pass
        return dict(user)
    except SupabaseError as exc:
        print(f"Session lookup failed: {exc}", flush=True)
        return None


def revoke_session(raw_token: str) -> None:
    if not raw_token:
        return
    key = _hash(raw_token)
    with _LOCK:
        _CACHE.pop(key, None)
    try:
        STORE.delete_session(key)
    except SupabaseError as exc:
        print(f"Session revoke failed: {exc}", flush=True)


def websocket_user(headers: dict[str, str], query: str = "") -> Optional[dict[str, Any]]:
    """Authenticate a socket using whichever supplied token actually resolves.

    Trying every candidate means one stale credential -- typically an expired
    cookie left over from an earlier Discord session -- cannot mask a valid one.
    """
    for token in session_token_candidates(headers, query):
        user = authenticate_session(token)
        if user:
            return user
    return None


def safe_display_name(user: Optional[dict[str, Any]]) -> str:
    raw = str((user or {}).get("username") or "Player")
    cleaned = "".join(c for c in raw if (c.isascii() and c.isalnum()) or c in " ._-")
    return (" ".join(cleaned.split()).strip(" ._-") or "Player")[:24]


def normalize_role(value: Any) -> str:
    role = str(value or "player").strip().lower()
    return role if role in {"player", "moderator", "admin"} else "player"


def _parse_timestamp(value: Any) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def ban_state(user: Optional[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """Return active ban details for a user payload, or None when not banned."""
    if not user:
        return None
    expires = _parse_timestamp(user.get("banned_until"))
    if not expires or expires <= datetime.now(timezone.utc):
        return None
    remaining = int((expires - datetime.now(timezone.utc)).total_seconds())
    return {
        "until": user.get("banned_until"),
        "reason": str(user.get("ban_reason") or "") or None,
        "permanent": remaining > 3600 * 24 * 3650,
        "secondsRemaining": remaining,
    }


def is_banned(user: Optional[dict[str, Any]]) -> bool:
    return ban_state(user) is not None


def invalidate_user(user_id: str) -> None:
    """Drop cached sessions for one account so role/ban changes apply at once."""
    target = str(user_id or "")
    if not target:
        return
    with _LOCK:
        for key, (_expires, user) in list(_CACHE.items()):
            if str(user.get("user_id") or "") == target:
                _CACHE.pop(key, None)


def _public_user(row: dict[str, Any], expires: Any, provider: str | None = None) -> dict[str, Any]:
    detected_provider = provider or ("discord" if row.get("discord_id") else "password")
    return {
        "user_id": str(row["id"]),
        "provider": detected_provider,
        "discord_id": str(row.get("discord_id") or ""),
        "username": str(row.get("display_name") or row.get("discord_username") or "Player"),
        "discord_username": str(row.get("discord_username") or ""),
        "avatar_url": str(row.get("avatar_url") or ""),
        "coins": int(row.get("coins") or 0),
        "role": normalize_role(row.get("role")),
        "banned_until": row.get("banned_until"),
        "ban_reason": row.get("ban_reason"),
        "expires_at": expires,
    }


def _cleanup() -> None:
    now = time.time()
    for key, expires in list(_STATES.items()):
        if expires <= now:
            _STATES.pop(key, None)
    for key, (expires, _user) in list(_CACHE.items()):
        if expires <= now:
            _CACHE.pop(key, None)


def _discord_post(path: str, values: dict[str, str]) -> dict[str, Any]:
    request = urllib.request.Request(
        "https://discord.com/api/v10" + path,
        data=urllib.parse.urlencode(values).encode(),
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json", "User-Agent": "Ridgewood/0.7.0"},
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return json.loads(response.read())


def _discord_get(path: str, headers: dict[str, str]) -> dict[str, Any]:
    request = urllib.request.Request(
        "https://discord.com/api/v10" + path,
        method="GET",
        headers={**headers, "Accept": "application/json", "User-Agent": "Ridgewood/0.7.0"},
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return json.loads(response.read())


def _json(status: int, body: dict[str, Any]) -> AuthResponse:
    return AuthResponse(status, body, {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"})


def _redirect(*, token: str = "", username: str = "", provider: str = "discord", error: str = "", headers: dict[str, str] | None = None) -> AuthResponse:
    split = urllib.parse.urlsplit(GAME_URL)
    fragment = {"auth_token": token, "username": username, "provider": provider} if token else {}
    if error:
        fragment["auth_error"] = error
    location = urllib.parse.urlunsplit((split.scheme, split.netloc, split.path, split.query, urllib.parse.urlencode(fragment)))
    output = {"Location": location, "Cache-Control": "no-store"}
    if headers:
        output.update(headers)
    return AuthResponse(302, {}, output)


def _cookie(token: str) -> str:
    return f"{COOKIE_NAME}={urllib.parse.quote(token)}; Path=/; Max-Age={SESSION_TTL}; HttpOnly; Secure; SameSite=None"


def _expired_cookie() -> str:
    return f"{COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=None"
