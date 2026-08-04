#!/usr/bin/env python3
"""Asserted source patches that add Supabase world persistence to v4.3 runtime."""
from __future__ import annotations


def _replace(source: str, search: str, replacement: str, label: str) -> str:
    if search not in source:
        raise SystemExit(f"World persistence integration failed ({label}).")
    return source.replace(search, replacement, 1)


def patch_world_runtime(source: str) -> str:
    source = _replace(
        source,
        "import auth\nfrom collections import deque",
        "import auth\nfrom world_persistence import WORLD, SupabaseError\nfrom collections import deque",
        "world imports",
    )

    source = _replace(
        source,
        '''        client, existing = ROOM.add(self.request, self.client_address)
        if client is not None and auth_user:
            preferred_name = auth.safe_display_name(auth_user)
            ROOM.rename(client, preferred_name)
            client.auth_user = auth_user
        if client is None:
''',
        '''        client, existing = ROOM.add(self.request, self.client_address)
        if client is not None and auth_user:
            preferred_name = auth.safe_display_name(auth_user)
            ROOM.rename(client, preferred_name)
            client.auth_user = auth_user
            client.user_id = str(auth_user.get("user_id") or "")
            client.y = 0.0
            client.last_position_save = 0.0
            client.last_saved_chunk = None
            client.build_times = deque()
            try:
                saved_position = WORLD.load_position(client.user_id)
            except SupabaseError as exc:
                print(f"Could not load saved position for {client.user_id}: {exc}", flush=True)
                saved_position = None
            if saved_position:
                client.x = client.spawn_x = saved_position["x"]
                client.y = saved_position["y"]
                client.z = client.spawn_z = saved_position["z"]
                client.angle = saved_position["yaw"]
        if client is None:
''',
        "authenticated saved spawn",
    )

    source = _replace(
        source,
        '''            "reactions": sorted(ALLOWED_REACTIONS),
            "auth": auth_user,
        })
''',
        '''            "reactions": sorted(ALLOWED_REACTIONS),
            "auth": auth_user,
            "world": {
                "id": WORLD.world_id,
                "persistent": WORLD.ready,
                "chunkSize": 16,
                "claimLimit": WORLD.claim_limit,
                "claims": WORLD.claims_for_user(client.user_id) if getattr(client, "user_id", "") else [],
            },
        })
''',
        "welcome world payload",
    )

    source = _replace(
        source,
        '''        elif message_type == "chat:history":
            self._send_history(client)
''',
        '''        elif message_type == "chat:history":
            self._send_history(client)
        elif message_type == "world:chunks":
            self._world_chunks(client, message)
        elif message_type == "world:claim":
            self._world_claim(client, message)
        elif message_type == "world:edit":
            self._world_edit(client, message)
''',
        "world message routing",
    )

    source = _replace(
        source,
        '''        try:
            x, z, angle = float(message.get("x")), float(message.get("z")), float(message.get("angle"))
        except (TypeError, ValueError):
            return
        if not all(math.isfinite(value) for value in (x, z, angle)):
''',
        '''        try:
            x, z, angle = float(message.get("x")), float(message.get("z")), float(message.get("angle"))
            y = float(message.get("y", getattr(client, "y", 0.0)))
        except (TypeError, ValueError):
            return
        if not all(math.isfinite(value) for value in (x, y, z, angle)):
''',
        "state y parsing",
    )

    source = _replace(
        source,
        '''        client.z = max(-1_000_000.0, min(1_000_000.0, z))
        client.angle = ((angle + math.pi) % (2 * math.pi)) - math.pi
''',
        '''        client.z = max(-1_000_000.0, min(1_000_000.0, z))
        client.y = max(-128.0, min(224.0, y))
        client.angle = ((angle + math.pi) % (2 * math.pi)) - math.pi
''',
        "state y assignment",
    )

    source = _replace(
        source,
        '''        ROOM.update_known_user(client)
        ROOM.broadcast({
''',
        '''        ROOM.update_known_user(client)
        try:
            WORLD.maybe_save_position(client)
        except (SupabaseError, ValueError) as exc:
            print(f"Position queue failed for {getattr(client, 'user_id', '')}: {exc}", flush=True)
        ROOM.broadcast({
''',
        "position save scheduling",
    )

    source = _replace(
        source,
        '''        }, exclude=client.id)

    def _rate_limited(self, client: Client, client_id: str) -> bool:
''',
        '''        }, exclude=client.id)

    def _world_chunks(self, client: Client, message: dict[str, Any]) -> None:
        requested = message.get("chunks")
        if not isinstance(requested, list):
            return
        coordinates: list[tuple[int, int]] = []
        for item in requested[:121]:
            if not isinstance(item, dict):
                continue
            try:
                cx, cz = int(item.get("chunkX")), int(item.get("chunkZ"))
            except (TypeError, ValueError):
                continue
            if abs(cx) <= 62500 and abs(cz) <= 62500:
                coordinates.append((cx, cz))
        try:
            chunks = WORLD.get_chunks(coordinates)
            client.send({"type": "world:chunks", "worldId": WORLD.world_id, "chunks": chunks})
        except SupabaseError as exc:
            client.send({"type": "world:error", "error": "chunk_load_failed", "message": str(exc)})

    def _world_claim(self, client: Client, message: dict[str, Any]) -> None:
        user_id = str(getattr(client, "user_id", "") or "")
        if not user_id:
            client.send({"type": "world:claim-result", "ok": False, "error": "authentication_required"})
            return
        current_x, current_z = chunk_for(client.x, client.z)
        try:
            chunk_x, chunk_z = int(message.get("chunkX")), int(message.get("chunkZ"))
        except (TypeError, ValueError):
            return
        if (chunk_x, chunk_z) != (current_x, current_z):
            client.send({"type": "world:claim-result", "ok": False, "error": "stand_in_chunk_to_claim"})
            return
        try:
            result = WORLD.claim_chunk(user_id, chunk_x, chunk_z)
        except SupabaseError as exc:
            result = {"ok": False, "error": "claim_failed", "message": str(exc)}
        payload = {"type": "world:claim-result", **result}
        client.send(payload)
        if result.get("ok") and isinstance(result.get("chunk"), dict):
            ROOM.broadcast({"type": "world:chunk-updated", "chunk": result["chunk"]})

    def _world_edit(self, client: Client, message: dict[str, Any]) -> None:
        user_id = str(getattr(client, "user_id", "") or "")
        if not user_id:
            client.send({"type": "world:edit-result", "ok": False, "error": "authentication_required"})
            return
        now = time.monotonic()
        build_times = getattr(client, "build_times", None)
        if build_times is None:
            build_times = client.build_times = deque()
        while build_times and now - build_times[0] > 1.0:
            build_times.popleft()
        if len(build_times) >= 5:
            client.send({"type": "world:edit-result", "ok": False, "error": "rate_limited"})
            return
        build_times.append(now)
        try:
            edit = WORLD.validate_edit(client, message)
            result = WORLD.apply_edit(user_id, edit)
        except ValueError as exc:
            result = {"ok": False, "error": str(exc)}
        except SupabaseError as exc:
            result = {"ok": False, "error": "edit_failed", "message": str(exc)}
        client.send({"type": "world:edit-result", **result})
        if result.get("ok") and isinstance(result.get("chunk"), dict):
            ROOM.broadcast({
                "type": "world:voxel-updated",
                "chunk": result["chunk"],
                "edit": result.get("edit"),
                "clientActionId": result.get("clientActionId"),
            })

    def _rate_limited(self, client: Client, client_id: str) -> bool:
''',
        "world handlers",
    )

    source = _replace(
        source,
        '''            if client is not None:
                removed = ROOM.remove(client.id)
''',
        '''            if client is not None:
                try:
                    WORLD.maybe_save_position(client, force=True)
                except (SupabaseError, ValueError) as exc:
                    print(f"Final position save failed for {getattr(client, 'user_id', '')}: {exc}", flush=True)
                removed = ROOM.remove(client.id)
''',
        "disconnect position save",
    )

    source = _replace(
        source,
        '''                    "discordAuth": auth.configured(), "authRequired": auth.AUTH_REQUIRED,
''',
        '''                    "discordAuth": auth.configured(), "authRequired": auth.AUTH_REQUIRED,
                    "supabase": WORLD.ready, "persistentWorld": WORLD.ready,
''',
        "health persistence status",
    )

    source = source.replace('VERSION = "4.3.0"', 'VERSION = "0.5.0-alpha"', 1)
    return source
