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

from admin_runtime_patch import patch_admin_runtime  # noqa: E402
from auth_runtime_patch import patch_auth_runtime  # noqa: E402
from world_runtime_patch import patch_world_runtime  # noqa: E402


for filename in (
    "admin.py",
    "admin_runtime_patch.py",
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
source = patch_admin_runtime(source)
compile(source, str(SERVER / "ridgewood-v0.5.0-runtime.py"), "exec")

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
)
for marker in required:
    if marker not in source:
        raise SystemExit(f"Missing patched runtime marker: {marker}")

print("Persistent-world Python and runtime patches validated.")

# The chat module ships as base64 parts. If the parts and the source file ever
# disagree, the deployed game and the checked-in source are different programs,
# and rebuilding from the stale source silently deletes shipped code.
#
# This is a warning rather than a failure because the repository already has
# this defect and fixing it needs a deliberate decision about which copy wins.
# Pass --strict to turn it into a hard failure once it has been reconciled.
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
        "         Do NOT run tools/build-parts.py until this is reconciled -- it would\n"
        "         rebuild from the stale source and delete the difference.\n"
        "         Fix with: python3 tools/reconcile-chat-parts.py"
    )
    if "--strict" in sys.argv:
        raise SystemExit(message.replace("WARNING", "ERROR"))
    print(message)
else:
    print("Chat parts match the chat source.")

print("Admin roles and moderation patches validated.")
