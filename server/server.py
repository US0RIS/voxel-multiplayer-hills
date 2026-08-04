#!/usr/bin/env python3
"""Bootstrap Ridgewood v0.5.0 alpha from the generated multiplayer runtime."""
from __future__ import annotations

import base64
import binascii
import sys
from pathlib import Path

import auth_env  # Loads Render's /etc/secrets/.env before config imports.
import auth_supabase as auth
from auth_runtime_patch import patch_auth_runtime
from world_runtime_patch import patch_world_runtime

# The generated runtime imports `auth`; expose the durable implementation under
# that module name without changing the generated source.
sys.modules["auth"] = auth

root = Path(__file__).resolve().parent
parts = sorted((root / "parts").glob("part*.b64"))
if not parts:
    raise SystemExit("No generated server parts found. Run: python3 tools/build-parts.py")

chunks: list[bytes] = []
for part in parts:
    encoded = "".join(part.read_text(encoding="ascii").split())
    try:
        chunks.append(base64.b64decode(encoded, validate=True))
    except (binascii.Error, ValueError) as exc:
        raise SystemExit(f"Corrupt generated server part {part.name}: {exc}") from exc

source = b"".join(chunks).decode("utf-8")
source = patch_auth_runtime(source)
source = patch_world_runtime(source)

exec(
    compile(source, str(root / "ridgewood-v0.5.0-runtime.py"), "exec"),
    globals(),
    globals(),
)
