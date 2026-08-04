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
        users = self._request(
            "GET",
            "game_users",
            query={
                "select": "id,discord_id,discord_username,display_name,avatar_url,coins",
                "id": f"eq.{session['user_id']}",
                "limit": "1",
            },
        )
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
            },
        )
        if not isinstance(result, dict):
            raise SupabaseError("apply_voxel_edit returned an invalid result", payload=result)
        return result


STORE = SupabaseStore()
