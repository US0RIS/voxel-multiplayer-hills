#!/usr/bin/env python3
"""Public WebSocket relay for Voxel Multiplayer Hills v4.1.0.

The service uses only Python's standard library. It serves:
- GET /health: deployment health/status response
- GET /: plain-text service status
- WebSocket /ws: one anonymous multiplayer room

Environment variables:
- PORT: public listening port supplied by the hosting platform (default 8131)
- WORLD_SEED: deterministic shared terrain seed (default 4102026)
- MAX_PLAYERS: room capacity, clamped to 1..64 (default 8)
- ALLOWED_ORIGINS: optional comma-separated browser origins. Empty allows all.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import socket
import socketserver
import struct
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

VERSION = "4.1.0"
HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8131"))
WORLD_SEED = int(os.environ.get("WORLD_SEED", "4102026")) & 0x7FFFFFFF
MAX_PLAYERS = max(1, min(64, int(os.environ.get("MAX_PLAYERS", "8"))))
ALLOWED_ORIGINS = {
    origin.strip().rstrip("/")
    for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",")
    if origin.strip()
}
WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_FRAME_BYTES = 1_000_000
SOCKET_IDLE_SECONDS = 25

PLAYER_COLORS = [
    [0.96, 0.60, 0.42],
    [0.42, 0.72, 1.00],
    [0.68, 0.92, 0.48],
    [0.86, 0.56, 0.96],
    [1.00, 0.82, 0.38],
    [0.42, 0.94, 0.84],
    [1.00, 0.52, 0.70],
    [0.72, 0.70, 1.00],
]
SPAWN_POINTS = [
    [0.5, 0.5],
    [2.5, 0.5],
    [-1.5, 0.5],
    [0.5, 2.5],
    [0.5, -1.5],
    [2.5, 2.5],
    [-1.5, -1.5],
    [2.5, -1.5],
]


def json_bytes(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def websocket_frame(payload: bytes, opcode: int = 0x1) -> bytes:
    first = 0x80 | (opcode & 0x0F)
    length = len(payload)
    if length < 126:
        return bytes([first, length]) + payload
    if length <= 0xFFFF:
        return bytes([first, 126]) + struct.pack("!H", length) + payload
    return bytes([first, 127]) + struct.pack("!Q", length) + payload


def recv_exact(sock: socket.socket, length: int) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining:
        chunk = sock.recv(remaining)
        if not chunk:
            raise ConnectionError("socket closed")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_websocket_frame(sock: socket.socket) -> tuple[int, bytes]:
    header = recv_exact(sock, 2)
    first, second = header
    if not (first & 0x80):
        raise ValueError("fragmented frames are unsupported")
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    if length == 126:
        length = struct.unpack("!H", recv_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", recv_exact(sock, 8))[0]
    if length > MAX_FRAME_BYTES:
        raise ValueError("frame too large")
    mask = recv_exact(sock, 4) if masked else b""
    payload = recv_exact(sock, length)
    if masked:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return opcode, payload


@dataclass
class Client:
    id: str
    name: str
    color: list[float]
    slot: int
    sock: socket.socket
    address: tuple[str, int]
    spawn_x: float
    spawn_z: float
    send_lock: threading.Lock = field(default_factory=threading.Lock)
    x: float = 0.5
    z: float = 0.5
    angle: float = 0.0
    moving: bool = False
    last_update: float = field(default_factory=time.monotonic)

    def public_state(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "x": self.x,
            "z": self.z,
            "angle": self.angle,
            "moving": self.moving,
        }

    def send(self, payload: dict[str, Any]) -> None:
        frame = websocket_frame(json_bytes(payload))
        with self.send_lock:
            self.sock.sendall(frame)

    def send_control(self, payload: bytes, opcode: int) -> None:
        with self.send_lock:
            self.sock.sendall(websocket_frame(payload, opcode=opcode))


class Room:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.clients: dict[str, Client] = {}
        self.next_number = 1

    def add(
        self, sock: socket.socket, address: tuple[str, int]
    ) -> tuple[Client | None, list[dict[str, Any]]]:
        with self.lock:
            if len(self.clients) >= MAX_PLAYERS:
                return None, []

            occupied = {client.slot for client in self.clients.values()}
            slot = next((index for index in range(MAX_PLAYERS) if index not in occupied), 0)
            player_id = uuid.uuid4().hex[:10]
            number = self.next_number
            self.next_number += 1
            spawn_x, spawn_z = SPAWN_POINTS[slot % len(SPAWN_POINTS)]
            client = Client(
                id=player_id,
                name=f"Player {number}",
                color=PLAYER_COLORS[slot % len(PLAYER_COLORS)],
                slot=slot,
                sock=sock,
                address=address,
                spawn_x=spawn_x,
                spawn_z=spawn_z,
                x=spawn_x,
                z=spawn_z,
            )
            existing = [other.public_state() for other in self.clients.values()]
            self.clients[player_id] = client
            return client, existing

    def remove(self, player_id: str) -> None:
        with self.lock:
            self.clients.pop(player_id, None)

    def broadcast(self, payload: dict[str, Any], exclude: str | None = None) -> None:
        with self.lock:
            recipients = [client for pid, client in self.clients.items() if pid != exclude]
        failed: list[str] = []
        for client in recipients:
            try:
                client.send(payload)
            except OSError:
                failed.append(client.id)
        for player_id in failed:
            self.remove(player_id)

    def count(self) -> int:
        with self.lock:
            return len(self.clients)


ROOM = Room()


class MultiplayerHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        self.request.settimeout(15)
        client: Client | None = None
        try:
            method, target, headers = self._read_http_request()
            path = urlsplit(target).path
            upgrade = headers.get("upgrade", "").lower()

            if method == "OPTIONS":
                self._send_http(204, b"", "text/plain; charset=utf-8")
                return

            if path in {"/ws", "/"} and upgrade == "websocket":
                origin = headers.get("origin", "").rstrip("/")
                if ALLOWED_ORIGINS and origin not in ALLOWED_ORIGINS:
                    self._send_http(403, b"Origin not allowed.\n", "text/plain; charset=utf-8")
                    return
                client = self._upgrade_websocket(headers)
                if client is None:
                    return
                self._run_websocket(client)
                return

            if method != "GET":
                self._send_http(405, b"Method not allowed.\n", "text/plain; charset=utf-8")
                return

            if path == "/health":
                body = json_bytes({
                    "status": "ok",
                    "version": VERSION,
                    "players": ROOM.count(),
                    "maxPlayers": MAX_PLAYERS,
                    "worldSeed": WORLD_SEED,
                })
                self._send_http(200, body, "application/json; charset=utf-8")
                return

            if path == "/":
                body = (
                    f"Voxel Multiplayer Hills server v{VERSION} is online.\n"
                    f"Players: {ROOM.count()}/{MAX_PLAYERS}\n"
                    "WebSocket endpoint: /ws\n"
                ).encode("utf-8")
                self._send_http(200, body, "text/plain; charset=utf-8")
                return

            self._send_http(404, b"Not found.\n", "text/plain; charset=utf-8")
        except (ConnectionError, OSError, TimeoutError, ValueError, socket.timeout):
            pass
        finally:
            if client is not None:
                ROOM.remove(client.id)
                ROOM.broadcast({"type": "left", "id": client.id})
                print(f"- {client.name} ({ROOM.count()}/{MAX_PLAYERS})", flush=True)
            try:
                self.request.close()
            except OSError:
                pass

    def _read_http_request(self) -> tuple[str, str, dict[str, str]]:
        data = bytearray()
        while b"\r\n\r\n" not in data:
            chunk = self.request.recv(4096)
            if not chunk:
                raise ConnectionError("closed before request headers")
            data.extend(chunk)
            if len(data) > 64 * 1024:
                raise ValueError("request headers too large")

        text = data.decode("latin-1")
        lines = text.split("\r\n")
        request_parts = lines[0].split(" ")
        if len(request_parts) < 2:
            raise ValueError("invalid request line")
        method, target = request_parts[0].upper(), request_parts[1]
        headers: dict[str, str] = {}
        for line in lines[1:]:
            if ":" in line:
                name, value = line.split(":", 1)
                headers[name.strip().lower()] = value.strip()
        return method, target, headers

    def _send_http(self, status: int, body: bytes, content_type: str) -> None:
        reasons = {200: "OK", 204: "No Content", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed"}
        response = (
            f"HTTP/1.1 {status} {reasons.get(status, 'OK')}\r\n"
            f"Content-Type: {content_type}\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            "Access-Control-Allow-Methods: GET, OPTIONS\r\n"
            "Access-Control-Allow-Headers: Content-Type\r\n"
            "Cache-Control: no-store\r\n"
            "Connection: close\r\n"
            "\r\n"
        ).encode("ascii") + body
        self.request.sendall(response)

    def _upgrade_websocket(self, headers: dict[str, str]) -> Client | None:
        key = headers.get("sec-websocket-key")
        version = headers.get("sec-websocket-version")
        if not key or version != "13":
            self._send_http(403, b"Invalid WebSocket handshake.\n", "text/plain; charset=utf-8")
            return None

        accept = base64.b64encode(
            hashlib.sha1((key + WEBSOCKET_GUID).encode("ascii")).digest()
        ).decode("ascii")
        response = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n"
            "\r\n"
        )
        self.request.sendall(response.encode("ascii"))
        self.request.settimeout(SOCKET_IDLE_SECONDS)

        client, existing = ROOM.add(self.request, self.client_address)
        if client is None:
            self.request.sendall(websocket_frame(json_bytes({
                "type": "error",
                "message": f"This room is full ({MAX_PLAYERS} players).",
            })))
            self.request.sendall(websocket_frame(struct.pack("!H", 1008), opcode=0x8))
            return None

        client.send({
            "type": "welcome",
            "version": VERSION,
            "id": client.id,
            "name": client.name,
            "color": client.color,
            "seed": WORLD_SEED,
            "maxPlayers": MAX_PLAYERS,
            "spawn": {"x": client.spawn_x, "z": client.spawn_z},
            "players": existing,
        })
        ROOM.broadcast({"type": "joined", "player": client.public_state()}, exclude=client.id)
        print(
            f"+ {client.name} from {self.client_address[0]} ({ROOM.count()}/{MAX_PLAYERS})",
            flush=True,
        )
        return client

    def _run_websocket(self, client: Client) -> None:
        while True:
            try:
                opcode, payload = read_websocket_frame(self.request)
            except socket.timeout:
                client.send_control(str(time.time()).encode("ascii"), opcode=0x9)
                continue

            if opcode == 0x8:
                try:
                    client.send_control(payload[:125], opcode=0x8)
                except OSError:
                    pass
                break
            if opcode == 0x9:
                client.send_control(payload[:125], opcode=0xA)
                continue
            if opcode == 0xA:
                continue
            if opcode != 0x1:
                continue

            try:
                message = json.loads(payload.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if message.get("type") == "state":
                self._apply_state(client, message)

    def _apply_state(self, client: Client, message: dict[str, Any]) -> None:
        try:
            x = float(message.get("x"))
            z = float(message.get("z"))
            angle = float(message.get("angle"))
        except (TypeError, ValueError):
            return
        if not all(math.isfinite(value) for value in (x, z, angle)):
            return

        now = time.monotonic()
        elapsed = max(0.01, min(now - client.last_update, 1.0))
        max_distance = 8.0 * elapsed + 1.5
        dx = x - client.x
        dz = z - client.z
        distance = math.hypot(dx, dz)
        if distance > max_distance and distance > 0:
            scale = max_distance / distance
            x = client.x + dx * scale
            z = client.z + dz * scale

        client.x = max(-1_000_000.0, min(1_000_000.0, x))
        client.z = max(-1_000_000.0, min(1_000_000.0, z))
        client.angle = ((angle + math.pi) % (2 * math.pi)) - math.pi
        client.moving = bool(message.get("moving"))
        client.last_update = now

        ROOM.broadcast({
            "type": "state",
            "id": client.id,
            "x": client.x,
            "z": client.z,
            "angle": client.angle,
            "moving": client.moving,
            "serverTime": time.time(),
        }, exclude=client.id)


class MultiplayerServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    try:
        server = MultiplayerServer((HOST, PORT), MultiplayerHandler)
    except OSError as exc:
        raise SystemExit(f"Could not bind multiplayer server to {HOST}:{PORT}: {exc}") from exc

    print("=" * 72, flush=True)
    print(f"VOXEL MULTIPLAYER HILLS SERVER v{VERSION}", flush=True)
    print(f"Listening: http://{HOST}:{PORT}", flush=True)
    print(f"WebSocket: ws://localhost:{PORT}/ws", flush=True)
    print(f"World seed: {WORLD_SEED}", flush=True)
    print(f"Room limit: {MAX_PLAYERS}", flush=True)
    if ALLOWED_ORIGINS:
        print(f"Allowed origins: {', '.join(sorted(ALLOWED_ORIGINS))}", flush=True)
    else:
        print("Allowed origins: all", flush=True)
    print("=" * 72, flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping multiplayer server…", flush=True)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
