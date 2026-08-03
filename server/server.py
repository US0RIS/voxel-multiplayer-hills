#!/usr/bin/env python3
"""Bootstrap the multiplayer server and integrate Discord OAuth.

The gameplay/chat runtime remains generated from ``server/server-source.py``.
This bootstrap applies a small, asserted integration patch before executing the
runtime so auth can be added without hand-editing generated base64 parts.
"""
from __future__ import annotations

import base64
import binascii
from pathlib import Path

import auth


def replace_required(source: str, search: str, replacement: str, label: str) -> str:
    if search not in source:
        raise SystemExit(
            f"Discord auth integration could not patch the server ({label}). "
            "The generated runtime no longer matches the expected v4.3.0 source."
        )
    return source.replace(search, replacement, 1)


root = Path(__file__).resolve().parent
parts_dir = root / "parts"
parts = sorted(parts_dir.glob("part*.b64"))

if not parts:
    raise SystemExit(f"No server parts found in {parts_dir}. Run: python3 tools/build-parts.py")

chunks: list[bytes] = []
for part in parts:
    encoded = "".join(part.read_text(encoding="ascii").split())
    try:
        chunks.append(base64.b64decode(encoded, validate=True))
    except (binascii.Error, ValueError) as exc:
        raise SystemExit(
            f"Server part {part.name} is corrupt ({exc}). Run: python3 tools/build-parts.py"
        ) from exc

source = b"".join(chunks).decode("utf-8")

source = replace_required(
    source,
    "import uuid\nfrom collections import deque",
    "import uuid\nimport auth\nfrom collections import deque",
    "auth import",
)

source = replace_required(
    source,
    '''            method, target, headers = self._read_http_request()
            path = urlsplit(target).path
            upgrade = headers.get("upgrade", "").lower()

            if method == "OPTIONS":
                self._send_http(204, b"", "text/plain; charset=utf-8")
                return
            if path in {"/ws", "/"} and upgrade == "websocket":
                origin = headers.get("origin", "").rstrip("/")
                if ALLOWED_ORIGINS and origin not in ALLOWED_ORIGINS:
                    self._send_http(403, b"Origin not allowed.\\n", "text/plain; charset=utf-8")
                    return
                client = self._upgrade_websocket(headers)
                if client:
                    self._run_websocket(client)
                return
            if method != "GET":
                self._send_http(405, b"Method not allowed.\\n", "text/plain; charset=utf-8")
                return
''',
    '''            method, target, headers, body = self._read_http_request()
            parsed_target = urlsplit(target)
            path = parsed_target.path
            headers["query_string"] = parsed_target.query
            upgrade = headers.get("upgrade", "").lower()

            if method == "OPTIONS":
                self._send_http(204, b"", "text/plain; charset=utf-8")
                return
            if path in {"/ws", "/"} and upgrade == "websocket":
                origin = headers.get("origin", "").rstrip("/")
                if ALLOWED_ORIGINS and origin not in ALLOWED_ORIGINS:
                    self._send_http(403, b"Origin not allowed.\\n", "text/plain; charset=utf-8")
                    return
                auth_user = auth.websocket_user(headers, parsed_target.query)
                if auth.AUTH_REQUIRED and not auth_user:
                    self._send_http(401, b"Authentication required.\\n", "text/plain; charset=utf-8")
                    return
                client = self._upgrade_websocket(headers, auth_user)
                if client:
                    self._run_websocket(client)
                return

            auth_response = auth.handle_request(
                method, path, headers, body, self.client_address[0]
            )
            if auth_response is not None:
                response_headers = dict(auth_response.headers)
                content_type = response_headers.pop(
                    "Content-Type", "application/json; charset=utf-8"
                )
                response_body = (
                    json_bytes(auth_response.body) if auth_response.body else b""
                )
                self._send_http(
                    auth_response.status,
                    response_body,
                    content_type,
                    response_headers,
                )
                return

            if method != "GET":
                self._send_http(405, b"Method not allowed.\\n", "text/plain; charset=utf-8")
                return
''',
    "HTTP auth routing",
)

source = replace_required(
    source,
    '''    def _read_http_request(self) -> tuple[str, str, dict[str, str]]:
        data = bytearray()
        while b"\\r\\n\\r\\n" not in data:
            chunk = self.request.recv(4096)
            if not chunk:
                raise ConnectionError("closed before request headers")
            data.extend(chunk)
            if len(data) > 64 * 1024:
                raise ValueError("request headers too large")
        text = data.decode("latin-1")
        lines = text.split("\\r\\n")
        request_parts = lines[0].split(" ")
        if len(request_parts) < 2:
            raise ValueError("invalid request line")
        headers: dict[str, str] = {}
        for line in lines[1:]:
            if ":" in line:
                name, value = line.split(":", 1)
                headers[name.strip().lower()] = value.strip()
        return request_parts[0].upper(), request_parts[1], headers

    def _send_http(self, status: int, body: bytes, content_type: str) -> None:
        reasons = {200: "OK", 204: "No Content", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed"}
        response = (
            f"HTTP/1.1 {status} {reasons.get(status, 'OK')}\\r\\n"
            f"Content-Type: {content_type}\\r\\n"
            f"Content-Length: {len(body)}\\r\\n"
            "Access-Control-Allow-Origin: *\\r\\n"
            "Access-Control-Allow-Methods: GET, OPTIONS\\r\\n"
            "Access-Control-Allow-Headers: Content-Type\\r\\n"
            "Cache-Control: no-store\\r\\n"
            "Connection: close\\r\\n\\r\\n"
        ).encode("ascii") + body
        self.request.sendall(response)

    def _upgrade_websocket(self, headers: dict[str, str]) -> Client | None:
''',
    '''    def _read_http_request(self) -> tuple[str, str, dict[str, str], bytes]:
        data = bytearray()
        marker = b"\\r\\n\\r\\n"
        while marker not in data:
            chunk = self.request.recv(4096)
            if not chunk:
                raise ConnectionError("closed before request headers")
            data.extend(chunk)
            if len(data) > 64 * 1024:
                raise ValueError("request headers too large")

        header_end = data.index(marker) + len(marker)
        text = bytes(data[:header_end]).decode("latin-1")
        lines = text.split("\\r\\n")
        request_parts = lines[0].split(" ")
        if len(request_parts) < 2:
            raise ValueError("invalid request line")
        headers: dict[str, str] = {}
        for line in lines[1:]:
            if ":" in line:
                name, value = line.split(":", 1)
                headers[name.strip().lower()] = value.strip()

        try:
            content_length = int(headers.get("content-length", "0") or "0")
        except ValueError as exc:
            raise ValueError("invalid content length") from exc
        if content_length < 0 or content_length > 1_000_000:
            raise ValueError("request body too large")

        body = bytearray(data[header_end:])
        while len(body) < content_length:
            chunk = self.request.recv(min(65536, content_length - len(body)))
            if not chunk:
                raise ConnectionError("closed before request body")
            body.extend(chunk)
        return (
            request_parts[0].upper(),
            request_parts[1],
            headers,
            bytes(body[:content_length]),
        )

    def _send_http(
        self,
        status: int,
        body: bytes,
        content_type: str,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        reasons = {
            200: "OK", 204: "No Content", 302: "Found", 400: "Bad Request",
            401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
            405: "Method Not Allowed", 500: "Internal Server Error",
            503: "Service Unavailable",
        }
        header_lines = [
            f"HTTP/1.1 {status} {reasons.get(status, 'OK')}",
            f"Content-Type: {content_type}",
            f"Content-Length: {len(body)}",
            "Access-Control-Allow-Origin: *",
            "Access-Control-Allow-Methods: GET, POST, OPTIONS",
            "Access-Control-Allow-Headers: Content-Type, Authorization",
            "Cache-Control: no-store",
            "Connection: close",
        ]
        for name, value in (extra_headers or {}).items():
            if "\\r" in name or "\\n" in name or "\\r" in value or "\\n" in value:
                continue
            if name.lower() in {"content-type", "content-length", "connection"}:
                continue
            header_lines.append(f"{name}: {value}")
        response = ("\\r\\n".join(header_lines) + "\\r\\n\\r\\n").encode("ascii") + body
        self.request.sendall(response)

    def _upgrade_websocket(
        self, headers: dict[str, str], auth_user: dict[str, Any] | None = None
    ) -> Client | None:
''',
    "HTTP body and response support",
)

source = replace_required(
    source,
    '''        client, existing = ROOM.add(self.request, self.client_address)
        if client is None:
''',
    '''        client, existing = ROOM.add(self.request, self.client_address)
        if client is not None and auth_user:
            preferred_name = auth.safe_display_name(auth_user)
            ROOM.rename(client, preferred_name)
            client.auth_user = auth_user
        if client is None:
''',
    "authenticated player identity",
)

source = replace_required(
    source,
    '''            "reactions": sorted(ALLOWED_REACTIONS),
        })
''',
    '''            "reactions": sorted(ALLOWED_REACTIONS),
            "auth": auth_user,
        })
''',
    "welcome auth payload",
)

source = replace_required(
    source,
    '''                    "chatMessages": len(ROOM.history), "pinned": len(ROOM.pinned_ids),
                }), "application/json; charset=utf-8")
''',
    '''                    "chatMessages": len(ROOM.history), "pinned": len(ROOM.pinned_ids),
                    "discordAuth": auth.configured(), "authRequired": auth.AUTH_REQUIRED,
                }), "application/json; charset=utf-8")
''',
    "health auth status",
)

source = replace_required(
    source,
    '''    print(f"Allowed origins: {', '.join(sorted(ALLOWED_ORIGINS)) if ALLOWED_ORIGINS else 'all'}", flush=True)
    print("=" * 72, flush=True)
''',
    '''    print(f"Allowed origins: {', '.join(sorted(ALLOWED_ORIGINS)) if ALLOWED_ORIGINS else 'all'}", flush=True)
    print(
        f"Discord auth: {'configured' if auth.configured() else 'not configured'} "
        f"· required={auth.AUTH_REQUIRED}",
        flush=True,
    )
    print("=" * 72, flush=True)
''',
    "auth startup status",
)

exec(
    compile(source, str(root / "server-v4.3.0-runtime.py"), "exec"),
    globals(),
    globals(),
)
