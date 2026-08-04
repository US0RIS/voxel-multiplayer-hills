#!/usr/bin/env python3
"""Server-authoritative world persistence for Ridgewood v0.6.0.

Coordinates, chunk ownership and sparse voxel overlays are durable in
Supabase. Position writes are coalesced on a background thread so movement and
chat never wait on database latency.
"""
from __future__ import annotations

import math
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Iterable

from supabase_store import (
    MAX_CHUNK_CLAIMS,
    PUBLIC_WORLD_ID,
    STORE,
    SupabaseError,
)


CHUNK_SIZE = 16
MAX_WORLD_COORDINATE = 1_000_000.0
MAX_BUILD_HEIGHT = 96
MAX_BUILD_DISTANCE = 8.0
WORLD_FLOOR = 0
PLAYER_RADIUS = 0.34
PLAYER_HEIGHT = 1.72
POSITION_SAVE_SECONDS = 6.0
CHUNK_CACHE_SECONDS = 20.0
ALLOWED_BLOCKS = {"grass", "dirt", "stone"}


def _finite(value: Any, *, minimum: float, maximum: float) -> float:
    number = float(value)
    if not math.isfinite(number) or number < minimum or number > maximum:
        raise ValueError("number is outside the allowed range")
    return number


def _integer(value: Any, *, minimum: int, maximum: int) -> int:
    number = int(value)
    if number < minimum or number > maximum:
        raise ValueError("integer is outside the allowed range")
    return number


def public_chunk(row: dict[str, Any] | None, chunk_x: int, chunk_z: int) -> dict[str, Any]:
    row = row or {}
    return {
        "worldId": str(row.get("world_id") or PUBLIC_WORLD_ID),
        "chunkX": int(row.get("chunk_x", chunk_x)),
        "chunkZ": int(row.get("chunk_z", chunk_z)),
        "ownerId": row.get("owner_id"),
        "claimedAt": row.get("claimed_at"),
        "voxelData": row.get("voxel_data") if isinstance(row.get("voxel_data"), dict) else {},
        "revision": int(row.get("revision") or 0),
        "updatedAt": row.get("updated_at"),
    }


@dataclass
class _CachedChunk:
    expires_at: float
    value: dict[str, Any]


class _PositionWriter:
    """Coalesces frequent movement updates into durable Supabase upserts."""

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._pending: dict[str, dict[str, Any]] = {}
        self._stopped = False
        self._thread = threading.Thread(
            target=self._run,
            name="ridgewood-position-writer",
            daemon=True,
        )
        self._thread.start()

    def submit(self, user_id: str, position: dict[str, Any]) -> None:
        if not user_id or not STORE.ready:
            return
        with self._condition:
            self._pending[user_id] = dict(position)
            self._condition.notify()

    def save_now(self, user_id: str, position: dict[str, Any]) -> None:
        if not user_id or not STORE.ready:
            return
        STORE.save_position(user_id, **position)
        with self._condition:
            self._pending.pop(user_id, None)

    def _run(self) -> None:
        while True:
            with self._condition:
                while not self._pending and not self._stopped:
                    self._condition.wait(timeout=2.0)
                if self._stopped:
                    return
                user_id, position = self._pending.popitem()
            try:
                STORE.save_position(user_id, **position)
            except (SupabaseError, ValueError) as exc:
                print(f"Position persistence failed for {user_id}: {exc}", flush=True)
                with self._condition:
                    self._pending.setdefault(user_id, position)
                time.sleep(1.0)


class WorldPersistence:
    def __init__(self) -> None:
        self.world_id = PUBLIC_WORLD_ID
        self.claim_limit = MAX_CHUNK_CLAIMS
        self._cache_lock = threading.RLock()
        self._chunk_cache: dict[tuple[int, int], _CachedChunk] = {}
        self._position_writer = _PositionWriter()

    @property
    def ready(self) -> bool:
        return STORE.ready

    def load_position(self, user_id: str) -> dict[str, Any] | None:
        if not self.ready or not user_id:
            return None
        row = STORE.load_position(user_id, self.world_id)
        if not row:
            return None
        try:
            return {
                "x": _finite(row.get("x"), minimum=-MAX_WORLD_COORDINATE, maximum=MAX_WORLD_COORDINATE),
                "y": _finite(row.get("y"), minimum=-128.0, maximum=MAX_BUILD_HEIGHT + 128.0),
                "z": _finite(row.get("z"), minimum=-MAX_WORLD_COORDINATE, maximum=MAX_WORLD_COORDINATE),
                "yaw": _finite(row.get("yaw", 0), minimum=-1000.0, maximum=1000.0),
                "lastUpdated": row.get("last_updated"),
            }
        except (TypeError, ValueError):
            return None

    def position_payload(self, client: Any) -> dict[str, Any]:
        return {
            "x": _finite(client.x, minimum=-MAX_WORLD_COORDINATE, maximum=MAX_WORLD_COORDINATE),
            "y": _finite(getattr(client, "y", 0.0), minimum=-128.0, maximum=MAX_BUILD_HEIGHT + 128.0),
            "z": _finite(client.z, minimum=-MAX_WORLD_COORDINATE, maximum=MAX_WORLD_COORDINATE),
            "yaw": _finite(client.angle, minimum=-1000.0, maximum=1000.0),
            "world_id": self.world_id,
        }

    def maybe_save_position(self, client: Any, *, force: bool = False) -> None:
        user_id = str(getattr(client, "user_id", "") or "")
        if not user_id or not self.ready:
            return
        now = time.monotonic()
        chunk = (math.floor(client.x / CHUNK_SIZE), math.floor(client.z / CHUNK_SIZE))
        last_saved_at = float(getattr(client, "last_position_save", 0.0) or 0.0)
        last_chunk = getattr(client, "last_saved_chunk", None)
        if not force and chunk == last_chunk and now - last_saved_at < POSITION_SAVE_SECONDS:
            return
        payload = self.position_payload(client)
        client.last_position_save = now
        client.last_saved_chunk = chunk
        if force:
            self._position_writer.save_now(user_id, payload)
        else:
            self._position_writer.submit(user_id, payload)

    def _cache_set(self, chunk: dict[str, Any]) -> dict[str, Any]:
        public = public_chunk(
            chunk,
            int(chunk.get("chunk_x", chunk.get("chunkX", 0))),
            int(chunk.get("chunk_z", chunk.get("chunkZ", 0))),
        )
        key = (public["chunkX"], public["chunkZ"])
        with self._cache_lock:
            self._chunk_cache[key] = _CachedChunk(time.monotonic() + CHUNK_CACHE_SECONDS, public)
        return dict(public)

    def _cache_get(self, chunk_x: int, chunk_z: int) -> dict[str, Any] | None:
        key = (int(chunk_x), int(chunk_z))
        with self._cache_lock:
            cached = self._chunk_cache.get(key)
            if cached and cached.expires_at > time.monotonic():
                return dict(cached.value)
            self._chunk_cache.pop(key, None)
        return None

    def get_chunks(self, coordinates: Iterable[tuple[int, int]]) -> list[dict[str, Any]]:
        unique = list(dict.fromkeys((int(x), int(z)) for x, z in coordinates))[:121]
        if not unique:
            return []
        output: dict[tuple[int, int], dict[str, Any]] = {}
        missing: list[tuple[int, int]] = []
        for chunk_x, chunk_z in unique:
            cached = self._cache_get(chunk_x, chunk_z)
            if cached is None:
                missing.append((chunk_x, chunk_z))
            else:
                output[(chunk_x, chunk_z)] = cached
        if missing and self.ready:
            for row in STORE.get_chunks(missing, self.world_id):
                public = self._cache_set(row)
                output[(public["chunkX"], public["chunkZ"])] = public
        return [output.get(pair, public_chunk(None, *pair)) for pair in unique]

    def claims_for_user(self, user_id: str) -> list[dict[str, Any]]:
        if not self.ready or not user_id:
            return []
        return [self._cache_set(row) for row in STORE.claims_for_user(user_id, self.world_id)]

    def claim_chunk(self, user_id: str, chunk_x: int, chunk_z: int) -> dict[str, Any]:
        if not self.ready:
            return {"ok": False, "error": "persistence_unavailable"}
        result = STORE.claim_chunk(
            user_id=user_id,
            chunk_x=int(chunk_x),
            chunk_z=int(chunk_z),
            world_id=self.world_id,
            claim_limit=self.claim_limit,
        )
        if isinstance(result.get("chunk"), dict):
            result = dict(result)
            result["chunk"] = self._cache_set(result["chunk"])
        return result

    def validate_edit(self, client: Any, message: dict[str, Any]) -> dict[str, Any]:
        action = str(message.get("action") or "").lower()
        if action not in {"place", "remove"}:
            raise ValueError("invalid_action")
        chunk_x = _integer(message.get("chunkX"), minimum=-62500, maximum=62500)
        chunk_z = _integer(message.get("chunkZ"), minimum=-62500, maximum=62500)
        local_x = _integer(message.get("localX"), minimum=0, maximum=CHUNK_SIZE - 1)
        local_z = _integer(message.get("localZ"), minimum=0, maximum=CHUNK_SIZE - 1)
        y = _integer(message.get("y"), minimum=WORLD_FLOOR, maximum=MAX_BUILD_HEIGHT)

        world_x = chunk_x * CHUNK_SIZE + local_x + 0.5
        world_z = chunk_z * CHUNK_SIZE + local_z + 0.5
        client_y = float(getattr(client, "y", y))
        if math.dist((float(client.x), client_y, float(client.z)), (world_x, y + 0.5, world_z)) > MAX_BUILD_DISTANCE:
            raise ValueError("too_far")

        raw_action_id = str(message.get("clientActionId") or "")
        try:
            action_id = str(uuid.UUID(raw_action_id))
        except (ValueError, AttributeError) as exc:
            raise ValueError("invalid_action_id") from exc

        if action == "remove" and y <= WORLD_FLOOR:
            raise ValueError("bedrock")

        block: dict[str, Any] | None = None
        if action == "place":
            source = message.get("block") if isinstance(message.get("block"), dict) else {}
            block_type = str(source.get("type") or "").lower()
            if block_type not in ALLOWED_BLOCKS:
                raise ValueError("invalid_block")
            world_min_x = chunk_x * CHUNK_SIZE + local_x
            world_min_z = chunk_z * CHUNK_SIZE + local_z
            client_x = float(client.x)
            client_y = float(getattr(client, "y", y))
            client_z = float(client.z)
            intersects_player = (
                world_min_x + 1 > client_x - PLAYER_RADIUS
                and world_min_x < client_x + PLAYER_RADIUS
                and world_min_z + 1 > client_z - PLAYER_RADIUS
                and world_min_z < client_z + PLAYER_RADIUS
                and y + 1 > client_y + 0.02
                and y < client_y + PLAYER_HEIGHT - 0.02
            )
            if intersects_player:
                raise ValueError("intersects_player")
            block = {"type": block_type}

        return {
            "action": action,
            "chunk_x": chunk_x,
            "chunk_z": chunk_z,
            "local_x": local_x,
            "local_z": local_z,
            "y": y,
            "block": block,
            "client_action_id": action_id,
        }

    def apply_edit(self, user_id: str, edit: dict[str, Any]) -> dict[str, Any]:
        if not self.ready:
            return {"ok": False, "error": "persistence_unavailable"}
        result = STORE.apply_voxel_edit(
            user_id=user_id,
            chunk_x=edit["chunk_x"],
            chunk_z=edit["chunk_z"],
            action=edit["action"],
            local_x=edit["local_x"],
            y=edit["y"],
            local_z=edit["local_z"],
            block=edit["block"],
            client_action_id=edit["client_action_id"],
            world_id=self.world_id,
        )
        if isinstance(result.get("chunk"), dict):
            result = dict(result)
            result["chunk"] = self._cache_set(result["chunk"])
        return result


WORLD = WorldPersistence()
