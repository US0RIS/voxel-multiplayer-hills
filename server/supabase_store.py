#!/usr/bin/env python3
"""Pure-stdlib Supabase persistence client for Ridgewood.

The browser never receives the Supabase secret. All calls are made by the
Render game server through Supabase's PostgREST API.
"""
from __future__ import annotations

import json
import math
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any, Iterable


SUPABASE_URL = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_SECRET_KEY = (
    os.getenv("SUPABASE_SECRET_KEY", "").strip()
    or os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
)
SUPABASE_TIMEOUT_SECONDS = max(
    2.0, float(os.getenv("SUPABASE_TIMEOUT_SECONDS", "12"))
)
PUBLIC_WORLD_ID = os.getenv("WORLD_ID", "public").strip() or "public"
MAX_CHUNK_CLAIMS = max(1, min(100, int(os.getenv("MAX_CHUNK_CLAIMS", "4"))))

# Every account read goes through this list so role and ban state are always
# available to the auth layer. Adding a column here is the only change needed.
USER_COLUMNS = (
    "id,discord_id,discord_username,display_name,avatar_url,coins,"
    "role,banned_until,ban_reason,banned_at,banned_by"
)
# The column set before migration 005. Used as an automatic fallback so the
# server keeps authenticating people when it is deployed ahead of the
# migration. Without this, a missing column turns every session lookup into an
# error and locks every account out of the game.
LEGACY_USER_COLUMNS = "id,discord_id,discord_username,display_name,avatar_url,coins"
STAFF_ROLES = ("moderator", "admin")

_COLUMN_STATE = {"extended": True, "warned": False}


def user_columns() -> str:
    return USER_COLUMNS if _COLUMN_STATE["extended"] else LEGACY_USER_COLUMNS


def schema_status() -> str:
    """Reported by /health so the migration state is visible from outside."""
    return "ready" if _COLUMN_STATE["extended"] else "migration_005_missing"


def _looks_like_missing_column(error: "SupabaseError") -> bool:
    text = f"{error} {error.payload}".lower()
    return "does not exist" in text or "42703" in text or "column" in text and "schema cache" in text


def _downgrade_columns(error: "SupabaseError") -> None:
    if _COLUMN_STATE["extended"]:
        _COLUMN_STATE["extended"] = False
    if not _COLUMN_STATE["warned"]:
        _COLUMN_STATE["warned"] = True
        print(
            "WARNING: game_users is missing the migration 005 columns "
            f"({error}). Falling back to the pre-005 column set so logins keep "
            "working. Staff roles and bans stay inactive until you run "
            "SUPABASE_MIGRATION_005_ADMIN_ROLES.sql.",
            flush=True,
        )


class SupabaseError(RuntimeError):
    """Raised when Supabase returns an error or an invalid response."""

    def __init__(self, message: str, *, status: int | None = None, payload: Any = None):
        super().__init__(message)
        self.status = status
        self.payload = payload


def configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SECRET_KEY)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _finite(value: Any, *, minimum: float = -1_000_000.0, maximum: float = 1_000_000.0) -> float:
    number = float(value)
    if not math.isfinite(number) or number < minimum or number > maximum:
        raise ValueError("coordinate out of range")
    return number


class SupabaseStore:
    def __init__(self) -> None:
        self.base_url = f"{SUPABASE_URL}/rest/v1" if SUPABASE_URL else ""
        self.secret = SUPABASE_SECRET_KEY

    @property
    def ready(self) -> bool:
        return configured()

    def _request(
        self,
        method: str,
        resource: str,
        *,
        query: dict[str, str] | None = None,
        body: Any = None,
        prefer: str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> Any:
        if not self.ready:
            raise SupabaseError("Supabase is not configured")

        path = resource.lstrip("/")
        url = f"{self.base_url}/{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query, safe="(),.*:-_\"{}")

        data = None
        headers = {
            "apikey": self.secret,
            "Authorization": f"Bearer {self.secret}",
            "Accept": "application/json",
            "User-Agent": "RidgewoodServer/0.5.0",
        }
        if body is not None:
            data = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        if prefer:
            headers["Prefer"] = prefer
        if extra_headers:
            headers.update(extra_headers)

        request = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(request, timeout=SUPABASE_TIMEOUT_SECONDS) as response:
                raw = response.read()
                if not raw:
                    return None
                try:
                    return json.loads(raw.decode("utf-8"))
                except json.JSONDecodeError as exc:
                    raise SupabaseError("Supabase returned invalid JSON", status=response.status) from exc
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            payload: Any = None
            if raw:
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    payload = raw.decode("utf-8", errors="replace")
            message = "Supabase request failed"
            if isinstance(payload, dict):
                message = str(payload.get("message") or payload.get("hint") or payload.get("code") or message)
            elif payload:
                message = str(payload)
            raise SupabaseError(message, status=exc.code, payload=payload) from exc
        except urllib.error.URLError as exc:
            raise SupabaseError(f"Could not reach Supabase: {exc.reason}") from exc

    # --------------------------------------------------------------- accounts

    def upsert_discord_user(
        self,
        *,
        discord_id: str,
        discord_username: str,
        display_name: str,
        avatar_url: str,
    ) -> dict[str, Any]:
        rows = self._request(
            "POST",
            "game_users",
            query={"on_conflict": "discord_id", "select": "*"},
            body={
                "discord_id": str(discord_id),
                "discord_username": str(discord_username),
                "display_name": str(display_name or discord_username),
                "avatar_url": str(avatar_url or ""),
                "updated_at": utc_now_iso(),
            },
            prefer="resolution=merge-duplicates,return=representation",
        )
        if not isinstance(rows, list) or not rows:
            raise SupabaseError("Supabase did not return the Discord user")
        return dict(rows[0])

    def create_session(
        self,
        *,
        token_hash: str,
        user_id: str,
        expires_at: str,
    ) -> None:
        self._request(
            "POST",
            "game_sessions",
            body={
                "token_hash": token_hash,
                "user_id": user_id,
                "expires_at": expires_at,
                "last_seen_at": utc_now_iso(),
            },
            prefer="return=minimal",
        )

    def get_session(self, token_hash: str) -> dict[str, Any] | None:
        now = utc_now_iso()
        sessions = self._request(
            "GET",
            "game_sessions",
            query={
                "select": "token_hash,user_id,created_at,expires_at,last_seen_at",
                "token_hash": f"eq.{token_hash}",
                "expires_at": f"gt.{now}",
                "limit": "1",
            },
        )
        if not isinstance(sessions, list) or not sessions:
            return None
        session = dict(sessions[0])
        users = self.select_users({"id": f"eq.{session['user_id']}", "limit": "1"})
        if not isinstance(users, list) or not users:
            return None
        session["user"] = dict(users[0])
        return session

    def touch_session(self, token_hash: str) -> None:
        self._request(
            "PATCH",
            "game_sessions",
            query={"token_hash": f"eq.{token_hash}"},
            body={"last_seen_at": utc_now_iso()},
            prefer="return=minimal",
        )

    def delete_session(self, token_hash: str) -> None:
        self._request(
            "DELETE",
            "game_sessions",
            query={"token_hash": f"eq.{token_hash}"},
            prefer="return=minimal",
        )

    # --------------------------------------------------------------- position

    def load_position(self, user_id: str, world_id: str = PUBLIC_WORLD_ID) -> dict[str, Any] | None:
        rows = self._request(
            "GET",
            "player_positions",
            query={
                "select": "world_id,user_id,x,y,z,yaw,last_updated",
                "world_id": f"eq.{world_id}",
                "user_id": f"eq.{user_id}",
                "limit": "1",
            },
        )
        if not isinstance(rows, list) or not rows:
            return None
        return dict(rows[0])

    def save_position(
        self,
        user_id: str,
        *,
        x: float,
        y: float,
        z: float,
        yaw: float,
        world_id: str = PUBLIC_WORLD_ID,
    ) -> dict[str, Any]:
        payload = {
            "world_id": world_id,
            "user_id": user_id,
            "x": _finite(x),
            "y": _finite(y),
            "z": _finite(z),
            "yaw": _finite(yaw, minimum=-1000.0, maximum=1000.0),
            "last_updated": utc_now_iso(),
        }
        rows = self._request(
            "POST",
            "player_positions",
            query={"on_conflict": "world_id,user_id", "select": "*"},
            body=payload,
            prefer="resolution=merge-duplicates,return=representation",
        )
        if not isinstance(rows, list) or not rows:
            raise SupabaseError("Supabase did not return the saved position")
        return dict(rows[0])

    # ---------------------------------------------------------------- chunks

    def get_chunk(
        self,
        chunk_x: int,
        chunk_z: int,
        world_id: str = PUBLIC_WORLD_ID,
    ) -> dict[str, Any] | None:
        rows = self._request(
            "GET",
            "chunks",
            query={
                "select": "world_id,chunk_x,chunk_z,owner_id,claimed_at,voxel_data,revision,updated_at",
                "world_id": f"eq.{world_id}",
                "chunk_x": f"eq.{int(chunk_x)}",
                "chunk_z": f"eq.{int(chunk_z)}",
                "limit": "1",
            },
        )
        if not isinstance(rows, list) or not rows:
            return None
        return dict(rows[0])

    def get_chunks(
        self,
        coordinates: Iterable[tuple[int, int]],
        world_id: str = PUBLIC_WORLD_ID,
    ) -> list[dict[str, Any]]:
        pairs = {(int(x), int(z)) for x, z in coordinates}
        if not pairs:
            return []
        xs = sorted({x for x, _ in pairs})
        zs = sorted({z for _, z in pairs})
        rows = self._request(
            "GET",
            "chunks",
            query={
                "select": "world_id,chunk_x,chunk_z,owner_id,claimed_at,voxel_data,revision,updated_at",
                "world_id": f"eq.{world_id}",
                "chunk_x": "in.(" + ",".join(map(str, xs)) + ")",
                "chunk_z": "in.(" + ",".join(map(str, zs)) + ")",
            },
        )
        if not isinstance(rows, list):
            return []
        return [dict(row) for row in rows if (int(row["chunk_x"]), int(row["chunk_z"])) in pairs]

    def claims_for_user(self, user_id: str, world_id: str = PUBLIC_WORLD_ID) -> list[dict[str, Any]]:
        rows = self._request(
            "GET",
            "chunks",
            query={
                "select": "world_id,chunk_x,chunk_z,owner_id,claimed_at,revision,updated_at",
                "world_id": f"eq.{world_id}",
                "owner_id": f"eq.{user_id}",
                "order": "claimed_at.asc",
            },
        )
        return [dict(row) for row in rows] if isinstance(rows, list) else []

    def claim_chunk(
        self,
        *,
        user_id: str,
        chunk_x: int,
        chunk_z: int,
        world_id: str = PUBLIC_WORLD_ID,
        claim_limit: int = MAX_CHUNK_CLAIMS,
    ) -> dict[str, Any]:
        result = self._request(
            "POST",
            "rpc/claim_chunk",
            body={
                "p_world_id": world_id,
                "p_chunk_x": int(chunk_x),
                "p_chunk_z": int(chunk_z),
                "p_owner_id": user_id,
                "p_max_claims": int(claim_limit),
            },
        )
        if not isinstance(result, dict):
            raise SupabaseError("claim_chunk returned an invalid result", payload=result)
        return result

    def apply_voxel_edit(
        self,
        *,
        user_id: str,
        chunk_x: int,
        chunk_z: int,
        action: str,
        local_x: int,
        y: int,
        local_z: int,
        block: dict[str, Any] | None,
        client_action_id: str,
        world_id: str = PUBLIC_WORLD_ID,
        admin_override: bool = False,
    ) -> dict[str, Any]:
        result = self._request(
            "POST",
            "rpc/apply_voxel_edit",
            body={
                "p_world_id": world_id,
                "p_user_id": user_id,
                "p_chunk_x": int(chunk_x),
                "p_chunk_z": int(chunk_z),
                "p_action": action,
                "p_voxel_pos": {"x": int(local_x), "y": int(y), "z": int(local_z)},
                "p_block_data": block if action == "place" else None,
                "p_client_action_id": client_action_id,
                "p_admin_override": bool(admin_override),
            },
        )
        if not isinstance(result, dict):
            raise SupabaseError("apply_voxel_edit returned an invalid result", payload=result)
        return result

    def set_chunk_owner(
        self,
        *,
        actor_id: str,
        chunk_x: int,
        chunk_z: int,
        owner_id: str | None,
        world_id: str = PUBLIC_WORLD_ID,
    ) -> dict[str, Any]:
        result = self._request(
            "POST",
            "rpc/admin_set_chunk_owner",
            body={
                "p_world_id": world_id,
                "p_chunk_x": int(chunk_x),
                "p_chunk_z": int(chunk_z),
                "p_owner_id": owner_id,
                "p_actor_id": actor_id,
            },
        )
        if not isinstance(result, dict):
            raise SupabaseError("admin_set_chunk_owner returned an invalid result", payload=result)
        return result

    # ------------------------------------------------------ roles and bans

    def select_users(self, query: dict[str, str]) -> Any:
        """Read game_users, retrying without the migration-005 columns if needed."""
        try:
            return self._request("GET", "game_users", query={**query, "select": user_columns()})
        except SupabaseError as exc:
            if not _COLUMN_STATE["extended"] or not _looks_like_missing_column(exc):
                raise
            _downgrade_columns(exc)
            return self._request("GET", "game_users", query={**query, "select": user_columns()})

    def get_user(self, user_id: str) -> dict[str, Any] | None:
        rows = self.select_users({"id": f"eq.{user_id}", "limit": "1"})
        if not isinstance(rows, list) or not rows:
            return None
        return dict(rows[0])

    def find_user_by_password_username(self, username: str) -> dict[str, Any] | None:
        """Resolve an account by its login username.

        This is the authoritative identity for password accounts: it is unique,
        immutable, and stored normalized. Display names are neither -- players
        change them with /nick and two accounts can pick the same one -- so any
        decision about privilege must key off this, not display_name.
        """
        normalized = str(username or "").strip().lower()
        if not normalized:
            return None
        rows = self._request(
            "GET",
            "game_password_credentials",
            query={
                "select": "user_id,username",
                "username_normalized": f"eq.{normalized}",
                "limit": "1",
            },
        )
        if not isinstance(rows, list) or not rows:
            return None
        return self.get_user(str(rows[0]["user_id"]))

    def find_users_by_name(self, name: str, limit: int = 8) -> list[dict[str, Any]]:
        """Look an account up by display name, then by password username."""
        needle = str(name or "").strip()
        if not needle:
            return []
        escaped = needle.replace("\\", "\\\\").replace('"', '\\"')
        rows = self.select_users({"display_name": f'ilike."{escaped}"', "limit": str(int(limit))})
        found = [dict(row) for row in rows] if isinstance(rows, list) else []
        if found:
            return found

        credentials = self._request(
            "GET",
            "game_password_credentials",
            query={
                "select": "user_id,username",
                "username_normalized": f"eq.{needle.lower()}",
                "limit": "1",
            },
        )
        if not isinstance(credentials, list) or not credentials:
            return []
        user = self.get_user(str(credentials[0]["user_id"]))
        return [user] if user else []

    def list_staff(self) -> list[dict[str, Any]]:
        rows = self.select_users({
            "role": "in.(" + ",".join(STAFF_ROLES) + ")",
            "order": "display_name.asc",
            "limit": "200",
        })
        return [dict(row) for row in rows] if isinstance(rows, list) else []

    def set_user_role(self, user_id: str, role: str) -> dict[str, Any]:
        if role not in ("player", *STAFF_ROLES):
            raise ValueError(f"unsupported role: {role}")
        rows = self._request(
            "PATCH",
            "game_users",
            query={"id": f"eq.{user_id}", "select": USER_COLUMNS},
            body={"role": role, "updated_at": utc_now_iso()},
            prefer="return=representation",
        )
        if not isinstance(rows, list) or not rows:
            raise SupabaseError("Supabase did not return the updated account")
        return dict(rows[0])

    def set_user_ban(
        self,
        user_id: str,
        *,
        banned_until: str | None,
        reason: str | None,
        actor_id: str | None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "banned_until": banned_until,
            "ban_reason": (reason or None) if banned_until else None,
            "banned_at": utc_now_iso() if banned_until else None,
            "banned_by": (actor_id or None) if banned_until else None,
            "updated_at": utc_now_iso(),
        }
        rows = self._request(
            "PATCH",
            "game_users",
            query={"id": f"eq.{user_id}", "select": USER_COLUMNS},
            body=body,
            prefer="return=representation",
        )
        if not isinstance(rows, list) or not rows:
            raise SupabaseError("Supabase did not return the updated account")
        return dict(rows[0])

    def delete_sessions_for_user(self, user_id: str) -> None:
        """Revoke every session an account holds, used when banning."""
        self._request(
            "DELETE",
            "game_sessions",
            query={"user_id": f"eq.{user_id}"},
            prefer="return=minimal",
        )

    def log_admin_action(
        self,
        *,
        actor_id: str | None,
        actor_name: str | None,
        action: str,
        target_id: str | None = None,
        target_name: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> None:
        self._request(
            "POST",
            "admin_actions",
            body={
                "actor_id": actor_id or None,
                "actor_name": actor_name or None,
                "action": str(action)[:64],
                "target_id": target_id or None,
                "target_name": target_name or None,
                "detail": detail or {},
            },
            prefer="return=minimal",
        )

    def recent_admin_actions(self, limit: int = 20) -> list[dict[str, Any]]:
        rows = self._request(
            "GET",
            "admin_actions",
            query={
                "select": "id,actor_name,action,target_name,detail,created_at",
                "order": "created_at.desc",
                "limit": str(max(1, min(100, int(limit)))),
            },
        )
        return [dict(row) for row in rows] if isinstance(rows, list) else []


STORE = SupabaseStore()
