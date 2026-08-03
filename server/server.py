#!/usr/bin/env python3
"""Bootstrap the v4.2.0 multiplayer and World Chat server."""
from __future__ import annotations

import base64
from pathlib import Path

PARTS = [
    "parts/part01.b64",
    "parts/part02.b64",
    "parts/part03.b64",
    "parts/part04.b64",
    "parts/part05.b64",
]

root = Path(__file__).resolve().parent
encoded = "".join((root / part).read_text(encoding="ascii").strip() for part in PARTS)
source = base64.b64decode(encoded).decode("utf-8")
exec(compile(source, str(root / "server-v4.2.0-runtime.py"), "exec"), globals(), globals())
