#!/usr/bin/env python3
"""Reconcile docs/chat-parts with docs/chat-source-v4.3.0.js.

The chat client ships as base64 parts generated from the source file. At the
time this tool was written the two had drifted apart in the repository: the
parts held 95,808 bytes while the source file held 94,392. Roughly 1.4 KB of
chat code was live in production but absent from the checked-in source, which
means someone shipped a change by regenerating the parts without committing the
regenerated source.

That is dangerous in one specific way: running `tools/build-parts.py` rebuilds
the parts *from the source*, so it would have silently deleted the difference.

This tool fixes the drift in the safe direction — the parts are what production
runs, so the parts win — by decoding them back into the source file. Afterwards
`build-parts.py` is safe again and
`validate-persistent-world.py --strict` will pass.

    python3 tools/reconcile-chat-parts.py            # report and fix
    python3 tools/reconcile-chat-parts.py --check    # report only
"""
from __future__ import annotations

import base64
import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs" / "chat-source-v4.3.0.js"
PARTS_DIR = ROOT / "docs" / "chat-parts"


def decode_parts() -> bytes:
    files = sorted(PARTS_DIR.glob("part*.b64"))
    if not files:
        raise SystemExit(f"No chat parts found in {PARTS_DIR}")
    chunks = []
    for part in files:
        encoded = "".join(part.read_text(encoding="ascii").split())
        try:
            chunks.append(base64.b64decode(encoded, validate=True))
        except Exception as exc:
            raise SystemExit(f"Corrupt chat part {part.name}: {exc}")
    return b"".join(chunks)


def main() -> int:
    check_only = "--check" in sys.argv

    source = SOURCE.read_bytes()
    parts = decode_parts()

    print(f"parts  (production) : {len(parts):>7,} bytes  sha256:{hashlib.sha256(parts).hexdigest()[:12]}")
    print(f"source (checked in) : {len(source):>7,} bytes  sha256:{hashlib.sha256(source).hexdigest()[:12]}")

    if parts == source:
        print("\nIn sync. Nothing to do.")
        return 0

    delta = len(parts) - len(source)
    print()
    if delta > 0:
        print(f"The source file is missing {delta:,} bytes that are live in production.")
    else:
        print(f"The source file has {-delta:,} bytes that were never built into the parts.")
        print("That is the unusual direction: someone edited the source and did not rebuild.")
        print("Review the diff by hand before continuing — this tool would discard those edits.")

    if check_only:
        print("\n--check: nothing written.")
        return 1

    if delta < 0:
        answer = input("\nOverwrite the source from the parts anyway? [y/N] ").strip().lower()
        if answer != "y":
            print("Aborted; nothing written.")
            return 1

    SOURCE.write_bytes(parts)
    print(f"\nWrote {SOURCE.relative_to(ROOT)} from the parts ({len(parts):,} bytes).")
    print("The two now agree. tools/build-parts.py is safe to run again.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
