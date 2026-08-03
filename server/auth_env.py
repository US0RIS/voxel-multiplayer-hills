#!/usr/bin/env python3
"""Load auth settings from Render's secret `.env` file.

Render secret files are mounted as files (normally `/etc/secrets/.env`); they
are not automatically expanded into process environment variables. Import this
module before importing `auth` so the existing pure-stdlib auth module can keep
using `os.getenv`.
"""
from __future__ import annotations

import ast
import os
import re
from pathlib import Path

_KEY_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _parse_value(raw: str) -> str:
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        try:
            parsed = ast.literal_eval(value)
            return str(parsed)
        except (SyntaxError, ValueError):
            return value[1:-1]
    return value


def load_secret_env() -> list[Path]:
    """Load available `.env` files without overriding real environment vars."""
    candidates = [
        Path("/etc/secrets/.env"),
        Path(__file__).resolve().parent / ".env",
        Path.cwd() / ".env",
    ]
    loaded: list[Path] = []
    seen: set[Path] = set()

    for candidate in candidates:
        try:
            path = candidate.resolve()
        except OSError:
            path = candidate
        if path in seen or not path.is_file():
            continue
        seen.add(path)

        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError as exc:
            print(f"Could not read auth secret file {path}: {exc}", flush=True)
            continue

        for line in lines:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.startswith("export "):
                stripped = stripped[7:].lstrip()
            key, separator, raw_value = stripped.partition("=")
            key = key.strip()
            if not separator or not _KEY_PATTERN.fullmatch(key):
                continue
            os.environ.setdefault(key, _parse_value(raw_value))

        loaded.append(path)

    return loaded


LOADED_ENV_FILES = load_secret_env()
