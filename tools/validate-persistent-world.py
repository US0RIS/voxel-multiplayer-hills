#!/usr/bin/env python3
"""Static validation for the v0.5.0 persistent-world branch."""
from __future__ import annotations

import base64
import binascii
import py_compile
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server"
sys.path.insert(0, str(SERVER))

from auth_runtime_patch import patch_auth_runtime  # noqa: E402
from world_runtime_patch import patch_world_runtime  # noqa: E402


for filename in (
    "auth_env.py",
    "auth_supabase.py",
    "supabase_store.py",
    "world_persistence.py",
    "auth_runtime_patch.py",
    "world_runtime_patch.py",
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
spawn_before = '"spawn": {"x": client.spawn_x, "z": client.spawn_z}'
if spawn_before not in source:
    raise SystemExit("Persistent spawn patch target is absent")
source = source.replace(
    spawn_before,
    '"spawn": {"x": client.spawn_x, "y": getattr(client, "y", 0.0), "z": client.spawn_z, "angle": client.angle}',
    1,
)
compile(source, str(SERVER / "ridgewood-v0.5.0-runtime.py"), "exec")

required = (
    'elif message_type == "world:chunks"',
    'elif message_type == "world:claim"',
    'elif message_type == "world:edit"',
    '"persistentWorld": WORLD.ready',
    'WORLD.maybe_save_position(client, force=True)',
)
for marker in required:
    if marker not in source:
        raise SystemExit(f"Missing patched runtime marker: {marker}")

print("Persistent-world Python and runtime patches validated.")
