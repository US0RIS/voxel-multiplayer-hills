#!/usr/bin/env python3
"""Regenerate the base64 part files used by the chat client and the server.

The v4.2.x parts were produced by slicing an already-encoded base64 string at
arbitrary byte offsets. One slice ended up a single character long, which made
`atob()` throw and silently killed the entire chat module in the browser.

This script encodes each part independently from a 3-byte-aligned slice of the
source, so every part is valid base64 on its own *and* the concatenation of all
parts is valid base64 too. Both loaders therefore work, and a corrupt part is
detected instead of silently shifting every byte that follows it.

Usage:
    python3 tools/build-parts.py            # rebuild chat + server parts
    python3 tools/build-parts.py --check    # verify parts match the sources
"""
from __future__ import annotations

import base64
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Slice size must be a multiple of 3 so each encoded part is padding-free.
CHUNK_BYTES = 6000

TARGETS = [
    {
        "name": "chat client",
        "source": ROOT / "docs" / "chat-source-v4.3.0.js",
        "parts_dir": ROOT / "docs" / "chat-parts",
        "loader": ROOT / "docs" / "chat-v4.3.0.js",
    },
    {
        "name": "server",
        "source": ROOT / "server" / "server-source.py",
        "parts_dir": ROOT / "server" / "parts",
    },
]


def encode_parts(source: Path) -> list[str]:
    raw = source.read_bytes()
    slices = [raw[i : i + CHUNK_BYTES] for i in range(0, len(raw), CHUNK_BYTES)] or [b""]
    return [base64.b64encode(chunk).decode("ascii") for chunk in slices]


def verify(parts: list[str], raw: bytes, label: str) -> None:
    per_part = b"".join(base64.b64decode(part) for part in parts)
    joined = base64.b64decode("".join(parts))
    if per_part != raw:
        raise SystemExit(f"{label}: per-part decode does not match the source")
    if joined != raw:
        raise SystemExit(f"{label}: joined decode does not match the source")
    for index, part in enumerate(parts, start=1):
        if len(part) % 4:
            raise SystemExit(f"{label}: part{index:02d} is not a multiple of 4 characters")


def build(check_only: bool = False) -> int:
    changed = 0
    for target in TARGETS:
        source: Path = target["source"]
        parts_dir: Path = target["parts_dir"]
        if not source.exists():
            raise SystemExit(f"Missing source file: {source}")
        raw = source.read_bytes()
        parts = encode_parts(source)
        verify(parts, raw, target["name"])

        parts_dir.mkdir(parents=True, exist_ok=True)
        existing = sorted(parts_dir.glob("part*.b64"))
        wanted = {f"part{index:02d}.b64" for index in range(1, len(parts) + 1)}

        if check_only:
            current = b""
            try:
                current = b"".join(base64.b64decode(path.read_text().strip()) for path in existing)
            except Exception as exc:  # noqa: BLE001 - report any decode failure
                print(f"✗ {target['name']}: parts are corrupt ({exc})")
                changed += 1
                continue
            if current != raw:
                print(f"✗ {target['name']}: parts are stale — run tools/build-parts.py")
                changed += 1
            else:
                print(f"✓ {target['name']}: {len(existing)} parts match the source")
            continue

        for path in existing:
            if path.name not in wanted:
                path.unlink()
        for index, part in enumerate(parts, start=1):
            (parts_dir / f"part{index:02d}.b64").write_text(part, encoding="ascii")
        if target.get("loader"):
            sync_loader(target["loader"], len(parts))
        digest = hashlib.sha256(raw).hexdigest()[:12]
        print(f"✓ {target['name']}: {len(parts)} parts, {len(raw):,} bytes, sha256:{digest}")
    return changed


def sync_loader(loader: Path, count: int) -> None:
    """Keep the browser loader's PART_COUNT in step with the generated parts."""
    if not loader.exists():
        raise SystemExit(f"Missing loader file: {loader}")
    text = loader.read_text(encoding="utf-8")
    updated = re.sub(r"const PART_COUNT = \d+;", f"const PART_COUNT = {count};", text, count=1)
    if updated == text and f"const PART_COUNT = {count};" not in text:
        raise SystemExit(f"Could not update PART_COUNT in {loader}")
    if updated != text:
        loader.write_text(updated, encoding="utf-8")
        print(f"  · updated {loader.name} PART_COUNT to {count}")


if __name__ == "__main__":
    sys.exit(1 if build("--check" in sys.argv) else 0)
