#!/usr/bin/env python3
"""Static validation for Ridgewood persistent world, admin, and economy layers."""
from __future__ import annotations

import base64
import binascii
import py_compile
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server"
sys.path.insert(0, str(SERVER))

from admin_runtime_patch import patch_admin_runtime  # noqa: E402
from auth_runtime_patch import patch_auth_runtime  # noqa: E402
from economy_runtime_patch import patch_economy_runtime  # noqa: E402
from world_runtime_patch import patch_world_runtime  # noqa: E402

for filename in (
    "admin.py", "admin_runtime_patch.py", "auth_env.py", "auth_supabase.py",
    "economy.py", "economy_runtime_patch.py", "supabase_store.py",
    "world_persistence.py", "auth_runtime_patch.py", "world_runtime_patch.py",
    "server.py",
):
    py_compile.compile(str(SERVER / filename), doraise=True)

parts = sorted((SERVER / "parts").glob("part*.b64"))
if not parts:
    raise SystemExit("No generated server parts found")
chunks: list[bytes] = []
for part in parts:
    encoded = "".join(part.read_text(encoding="ascii").split())
    try:
        chunks.append(base64.b64decode(encoded, validate=True))
    except (binascii.Error, ValueError) as exc:
        raise SystemExit(f"Invalid server part {part.name}: {exc}") from exc

source = b"".join(chunks).decode("utf-8")
source = patch_auth_runtime(source)
source = patch_world_runtime(source)
source = patch_admin_runtime(source)
source = patch_economy_runtime(source)
spawn_before = '"spawn": {"x": client.spawn_x, "z": client.spawn_z}'
if spawn_before not in source:
    raise SystemExit("Persistent spawn patch target is absent")
source = source.replace(
    spawn_before,
    '"spawn": {"x": client.spawn_x, "y": getattr(client, "y", 0.0), "z": client.spawn_z, "angle": client.angle}',
    1,
)
compile(source, str(SERVER / "ridgewood-v0.9.1-runtime.py"), "exec")

required = (
    'elif message_type == "world:chunks"',
    'elif message_type == "world:claim"',
    'elif message_type == "world:edit"',
    '"persistentWorld": WORLD.ready',
    'WORLD.maybe_save_position(client, force=True)',
    'elif message_type == "admin:action"',
    'def _admin_action(self, client: Client, message: dict[str, Any]) -> None:',
    'ban = auth.ban_state(auth_user)',
    'client.role = admin.role_of(auth_user)',
    '"admin": admin.capabilities(',
    'economy.handle_http_request(',
    'def _economy_action(self, client: Client, message: dict[str, Any]) -> None:',
    '"economy": economy.bootstrap_for_user(',
    '"marketplace": economy.configured()',
    'chunk_x == 0 and -2 <= chunk_z <= 1',
    'edit["chunk_x"] == 0 and -2 <= edit["chunk_z"] <= 1',
)
for marker in required:
    if marker not in source:
        raise SystemExit(f"Missing patched runtime marker: {marker}")

migration = (ROOT / "SUPABASE_MIGRATION_006_COINS_MARKETPLACE.sql").read_text(encoding="utf-8").lower()
for marker in (
    "create table if not exists public.coin_transactions",
    "create table if not exists public.marketplace_stalls",
    "create table if not exists public.marketplace_listings",
    "create table if not exists public.player_inventory",
    "create or replace function public.buy_marketplace_listing",
    "create or replace function public.spend_coins",
    "create or replace function public.grant_starter_coins",
):
    if marker not in migration:
        raise SystemExit(f"Missing economy migration marker: {marker}")

street_migration = (ROOT / "SUPABASE_MIGRATION_007_MARKET_STREET.sql").read_text(encoding="utf-8").lower()
for marker in (
    "then 4.0 else 13.0",
    "-20.25",
    "chunk_z between -2 and 1",
    "create or replace function public.guard_marketplace_chunk_owner",
):
    if marker not in street_migration:
        raise SystemExit(f"Missing market street migration marker: {marker}")

asset = (ROOT / "docs" / "assets" / "market-stall-v0.9.1.js").read_text(encoding="utf-8")
for marker in (
    "voxel_market_stall(1).glb",
    "c248fa1127454ab0b4b44c00d5f0ad7de3e17f63845d5bf9a59b8633359afeec",
    '"count":2544',
    '"encoding":"gzip+base64+uint8x4"',
):
    if marker not in asset:
        raise SystemExit(f"Missing supplied market stall asset marker: {marker}")

for filename in (
    "game-loader-v0.8.0.js", "game-loader-v0.8.0-base.js",
    "game-loader-v0.9.0.js", "marketplace-v0.9.0.js",
    "marketplace-v0.9.1.js", "marketplace-v0.9.0.css",
):
    if not (ROOT / "docs" / filename).exists():
        raise SystemExit(f"Missing marketplace client file: {filename}")

print("Persistent world, administration, economy, and market street validated.")

chat_source = (ROOT / "docs" / "chat-source-v4.3.0.js").read_bytes()
chat_parts = sorted((ROOT / "docs" / "chat-parts").glob("part*.b64"))
chat_bytes = b"".join(
    base64.b64decode("".join(part.read_text(encoding="ascii").split()), validate=True)
    for part in chat_parts
)
if chat_bytes != chat_source:
    message = (
        "WARNING: docs/chat-parts is out of sync with docs/chat-source-v4.3.0.js "
        f"({len(chat_bytes)} bytes in the parts vs {len(chat_source)} in the source).\n"
        "         The parts are what production runs, so the source is the stale copy.\n"
        "         Do NOT run tools/build-parts.py until this is reconciled.\n"
        "         Fix with: python3 tools/reconcile-chat-parts.py"
    )
    if "--strict" in sys.argv:
        raise SystemExit(message.replace("WARNING", "ERROR"))
    print(message)
else:
    print("Chat parts match the chat source.")

print("GLB-derived market stall asset and long-street layout validated.")
