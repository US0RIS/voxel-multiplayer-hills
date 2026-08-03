#!/usr/bin/env python3
"""Voxel Multiplayer Hills v4.3.0 — movement + full-featured group chat.

Protocol: JSON messages over the existing native WebSocket connection.
The service intentionally uses only Python's standard library so the existing
Render deployment does not need a package-install step.

This file is the readable source of truth. `server/server.py` boots a base64
copy of it from `server/parts/`. Rebuild the parts after editing:

    python3 tools/build-parts.py
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import random
import re
import socket
import socketserver
import struct
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

VERSION = "4.3.0"
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
CHAT_HISTORY_LIMIT = 500
CHAT_MESSAGE_LIMIT = 2000
CHAT_RATE_LIMIT = 5
CHAT_RATE_WINDOW_SECONDS = 5.0
CHAT_EDIT_WINDOW_SECONDS = float(os.environ.get("CHAT_EDIT_WINDOW", "3600"))
RECENT_USER_LIMIT = 128
PINNED_LIMIT = 50
NAME_PATTERN = re.compile(r"^[A-Za-z0-9 _.\-]{2,24}$")
STATE_PATH = Path(os.environ.get("CHAT_STATE_PATH", str(Path(__file__).resolve().parent / "chat-state.json")))
STATE_SAVE_INTERVAL = 5.0

PLAYER_COLORS = [
    [0.96, 0.60, 0.42], [0.42, 0.72, 1.00], [0.68, 0.92, 0.48],
    [0.86, 0.56, 0.96], [1.00, 0.82, 0.38], [0.42, 0.94, 0.84],
    [1.00, 0.52, 0.70], [0.72, 0.70, 1.00],
]
SPAWN_POINTS = [
    [0.5, 0.5], [2.5, 0.5], [-1.5, 0.5], [0.5, 2.5],
    [0.5, -1.5], [2.5, 2.5], [-1.5, -1.5], [2.5, -1.5],
]
ALLOWED_REACTIONS = {
    "👍", "👎", "❤️", "😂", "😮", "😢", "🎉", "👀", "🔥", "✅", "❓", "💀",
    "🙏", "👋", "🧱", "⛏️", "🌲", "💎", "🚀", "😎",
}


def now_ms() -> int:
    return int(time.time() * 1000)


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
    first, second = recv_exact(sock, 2)
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


def chunk_for(x: float, z: float) -> tuple[int, int]:
    return math.floor(x / 16), math.floor(z / 16)


def preview_text(text: str, limit: int = 120) -> str:
    value = " ".join(str(text or "").split())
    return value if len(value) <= limit else value[: limit - 1] + "…"


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
    status: str = ""
    typing: bool = False
    last_update: float = field(default_factory=time.monotonic)
    connected_at: int = field(default_factory=now_ms)
    message_times: deque[float] = field(default_factory=deque)

    def public_state(self) -> dict[str, Any]:
        cx, cz = chunk_for(self.x, self.z)
        return {
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "x": self.x,
            "z": self.z,
            "chunkX": cx,
            "chunkZ": cz,
            "angle": self.angle,
            "moving": self.moving,
            "status": self.status,
            "online": True,
            "lastSeen": now_ms(),
        }

    def send(self, payload: dict[str, Any]) -> None:
        frame = websocket_frame(json_bytes(payload))
        with self.send_lock:
            self.sock.sendall(frame)

    def send_control(self, payload: bytes, opcode: int) -> None:
        with self.send_lock:
            self.sock.sendall(websocket_frame(payload, opcode=opcode))


class Room:
    """Shared world + chat state. Every public method is thread safe."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.clients: dict[str, Client] = {}
        self.next_player_number = 1
        self.next_message_index = 1
        self.history: deque[dict[str, Any]] = deque(maxlen=CHAT_HISTORY_LIMIT)
        self.message_by_id: dict[str, dict[str, Any]] = {}
        self.known_users: dict[str, dict[str, Any]] = {}
        self.pinned_ids: list[str] = []
        self.dirty = False
        self.load_state()

    # ---------------------------------------------------------------- players

    def add(self, sock: socket.socket, address: tuple[str, int]) -> tuple[Client | None, list[dict[str, Any]]]:
        with self.lock:
            if len(self.clients) >= MAX_PLAYERS:
                return None, []
            occupied = {client.slot for client in self.clients.values()}
            slot = next((i for i in range(MAX_PLAYERS) if i not in occupied), 0)
            number = self.next_player_number
            self.next_player_number += 1
            spawn_x, spawn_z = SPAWN_POINTS[slot % len(SPAWN_POINTS)]
            client = Client(
                id=uuid.uuid4().hex[:10],
                name=self._unique_name(f"Player {number}"),
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
            self.clients[client.id] = client
            self._remember_user(client, online=True)
            return client, existing

    def _unique_name(self, preferred: str) -> str:
        taken = {client.name.lower() for client in self.clients.values()}
        if preferred.lower() not in taken:
            return preferred
        for suffix in range(2, 999):
            candidate = f"{preferred} {suffix}"
            if candidate.lower() not in taken:
                return candidate
        return preferred

    def rename(self, client: Client, requested: str) -> tuple[bool, str]:
        name = " ".join(str(requested or "").split())
        if not NAME_PATTERN.match(name):
            return False, "Names must be 2–24 characters (letters, numbers, spaces, . _ -)."
        with self.lock:
            if any(other.id != client.id and other.name.lower() == name.lower() for other in self.clients.values()):
                return False, f"“{name}” is already in use."
            previous = client.name
            self.known_users.pop(previous, None)
            client.name = name
            self._remember_user(client, online=True)
            self.dirty = True
            return True, previous

    def remove(self, player_id: str) -> Client | None:
        with self.lock:
            client = self.clients.pop(player_id, None)
            if client:
                self._remember_user(client, online=False)
            return client

    def _remember_user(self, client: Client, online: bool) -> None:
        cx, cz = chunk_for(client.x, client.z)
        self.known_users[client.name] = {
            "id": client.id,
            "name": client.name,
            "color": client.color,
            "status": client.status,
            "online": online,
            "lastSeen": now_ms(),
            "x": client.x,
            "z": client.z,
            "chunkX": cx,
            "chunkZ": cz,
        }
        if len(self.known_users) > RECENT_USER_LIMIT:
            oldest = min(self.known_users, key=lambda name: self.known_users[name].get("lastSeen", 0))
            self.known_users.pop(oldest, None)

    def update_known_user(self, client: Client) -> None:
        with self.lock:
            self._remember_user(client, online=True)

    def users_snapshot(self) -> list[dict[str, Any]]:
        with self.lock:
            online_names = {client.name for client in self.clients.values()}
            users = []
            for user in self.known_users.values():
                item = dict(user)
                item["online"] = item["name"] in online_names
                users.append(item)
            users.sort(key=lambda u: (not u["online"], str(u["name"]).lower()))
            return users

    def online_names(self) -> list[str]:
        with self.lock:
            return [client.name for client in self.clients.values()]

    # --------------------------------------------------------------- messages

    def history_snapshot(self) -> list[dict[str, Any]]:
        with self.lock:
            return [self._serialise_message(message) for message in self.history]

    def pinned_snapshot(self) -> list[dict[str, Any]]:
        with self.lock:
            items = []
            for message_id in self.pinned_ids:
                message = self.message_by_id.get(message_id)
                if message and not message.get("deleted"):
                    items.append(self._serialise_message(message))
            return items

    def _serialise_message(self, message: dict[str, Any]) -> dict[str, Any]:
        result = dict(message)
        reactions = message.get("reactions", {})
        result["reactions"] = {
            emoji: {
                "count": len(value.get("ids", ())),
                "playerIds": sorted(value.get("ids", ())),
                "names": sorted(value.get("names", ())),
            }
            for emoji, value in reactions.items()
            if value.get("ids")
        }
        result["pinned"] = message["id"] in self.pinned_ids
        return result

    def mentions_in(self, text: str) -> list[str]:
        lowered = str(text or "")
        found: list[str] = []
        if re.search(r"(^|\s)@(everyone|here)\b", lowered, re.IGNORECASE):
            found.append("@everyone")
        for name in self.online_names():
            if re.search(rf"(^|\s)@{re.escape(name)}\b", lowered, re.IGNORECASE):
                found.append(name)
        return found

    def add_message(
        self,
        *,
        sender: Client | None,
        text: str,
        location: dict[str, Any] | None = None,
        system: bool = False,
        kind: str = "message",
        reply_to: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        with self.lock:
            message_id = f"m-{uuid.uuid4().hex[:12]}"
            message = {
                "type": "chat:message",
                "id": message_id,
                "index": self.next_message_index,
                "sender": {
                    "id": sender.id if sender else "system",
                    "name": sender.name if sender else "World",
                    "color": sender.color if sender else [0.58, 0.68, 0.62],
                },
                "text": text,
                "timestamp": now_ms(),
                "location": location,
                "system": system,
                "kind": kind,
                "reactions": {},
                "replyTo": reply_to,
                "mentions": self.mentions_in(text) if not system else [],
                "editedAt": None,
                "deleted": False,
            }
            self.next_message_index += 1
            if self.history.maxlen and len(self.history) == self.history.maxlen and self.history:
                evicted = self.history[0]
                self.message_by_id.pop(evicted["id"], None)
                if evicted["id"] in self.pinned_ids:
                    self.pinned_ids.remove(evicted["id"])
            self.history.append(message)
            self.message_by_id[message_id] = message
            self.dirty = True
            return self._serialise_message(message)

    def reply_stub(self, message_id: str) -> dict[str, Any] | None:
        with self.lock:
            message = self.message_by_id.get(message_id)
            if not message or message.get("deleted"):
                return None
            return {
                "id": message["id"],
                "index": message.get("index"),
                "name": message["sender"]["name"],
                "color": message["sender"]["color"],
                "text": preview_text(message.get("text", "")),
            }

    def edit_message(self, message_id: str, player_id: str, text: str) -> tuple[dict[str, Any] | None, str]:
        with self.lock:
            message = self.message_by_id.get(message_id)
            if not message:
                return None, "That message is no longer available."
            if message.get("deleted"):
                return None, "That message was deleted."
            if message["sender"].get("id") != player_id:
                return None, "You can only edit your own messages."
            if message.get("system"):
                return None, "System messages cannot be edited."
            age = (now_ms() - int(message.get("timestamp", 0))) / 1000
            if CHAT_EDIT_WINDOW_SECONDS > 0 and age > CHAT_EDIT_WINDOW_SECONDS:
                return None, "That message is too old to edit."
            message["text"] = text
            message["editedAt"] = now_ms()
            message["mentions"] = self.mentions_in(text)
            self.dirty = True
            return self._serialise_message(message), ""

    def delete_message(self, message_id: str, player_id: str) -> tuple[dict[str, Any] | None, str]:
        with self.lock:
            message = self.message_by_id.get(message_id)
            if not message:
                return None, "That message is no longer available."
            if message["sender"].get("id") != player_id:
                return None, "You can only delete your own messages."
            message["deleted"] = True
            message["text"] = ""
            message["reactions"] = {}
            message["mentions"] = []
            if message_id in self.pinned_ids:
                self.pinned_ids.remove(message_id)
            self.dirty = True
            return self._serialise_message(message), ""

    def set_pinned(self, message_id: str, pinned: bool) -> tuple[dict[str, Any] | None, str]:
        with self.lock:
            message = self.message_by_id.get(message_id)
            if not message or message.get("deleted"):
                return None, "That message is no longer available."
            if pinned:
                if message_id in self.pinned_ids:
                    return self._serialise_message(message), ""
                if len(self.pinned_ids) >= PINNED_LIMIT:
                    return None, f"Only {PINNED_LIMIT} messages can be pinned."
                self.pinned_ids.append(message_id)
            elif message_id in self.pinned_ids:
                self.pinned_ids.remove(message_id)
            self.dirty = True
            return self._serialise_message(message), ""

    def add_reaction(self, message_id: str, emoji: str, player_id: str, player_name: str) -> dict[str, Any] | None:
        with self.lock:
            message = self.message_by_id.get(message_id)
            if not message or message.get("deleted"):
                return None
            reactions = message.setdefault("reactions", {})
            entry = reactions.setdefault(emoji, {"ids": set(), "names": set()})
            if player_id in entry["ids"]:
                entry["ids"].discard(player_id)
                entry["names"].discard(player_name)
            else:
                entry["ids"].add(player_id)
                entry["names"].add(player_name)
            if not entry["ids"]:
                reactions.pop(emoji, None)
            self.dirty = True
            return self._serialise_message(message)

    def split_target(self, argument: str) -> tuple[str, str]:
        """Split "Ada Lovelace hello there" into ("Ada Lovelace", "hello there").

        Display names may contain spaces, so a plain partition(" ") would eat
        part of the name. Online names are matched longest-first; if none match
        we fall back to the first whitespace-delimited token.
        """
        text = argument.strip()
        if not text:
            return "", ""
        with self.lock:
            names = sorted((client.name for client in self.clients.values()), key=len, reverse=True)
        lowered = text.lower()
        for name in names:
            candidate = name.lower()
            if lowered == candidate:
                return name, ""
            if lowered.startswith(candidate + " "):
                return name, text[len(name):].strip()
        head, _, tail = text.partition(" ")
        return head, tail.strip()

    def find_player(self, query: str) -> Client | None:
        needle = query.strip().lstrip("@").lower()
        if not needle:
            return None
        with self.lock:
            exact = next((c for c in self.clients.values() if c.name.lower() == needle), None)
            if exact:
                return exact
            matches = [c for c in self.clients.values() if c.name.lower().startswith(needle)]
            return matches[0] if len(matches) == 1 else None

    def find_message_index(self, index: int) -> dict[str, Any] | None:
        with self.lock:
            return next((m for m in self.history if m.get("index") == index), None)

    def broadcast(self, payload: dict[str, Any], exclude: str | None = None) -> int:
        with self.lock:
            recipients = [c for pid, c in self.clients.items() if pid != exclude]
        failed: list[str] = []
        delivered = 0
        for client in recipients:
            try:
                client.send(payload)
                delivered += 1
            except OSError:
                failed.append(client.id)
        for player_id in failed:
            self.remove(player_id)
        return delivered

    def count(self) -> int:
        with self.lock:
            return len(self.clients)

    # ------------------------------------------------------------ persistence

    def load_state(self) -> None:
        if not STATE_PATH.exists():
            return
        try:
            raw = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"! Could not read chat state: {exc}", flush=True)
            return
        messages = raw.get("messages") or []
        for message in messages[-CHAT_HISTORY_LIMIT:]:
            reactions = {}
            for emoji, value in (message.get("reactions") or {}).items():
                ids = set(value.get("playerIds") or value.get("ids") or [])
                names = set(value.get("names") or [])
                if ids:
                    reactions[emoji] = {"ids": ids, "names": names}
            message["reactions"] = reactions
            message.setdefault("replyTo", None)
            message.setdefault("mentions", [])
            message.setdefault("editedAt", None)
            message.setdefault("deleted", False)
            self.history.append(message)
            self.message_by_id[message["id"]] = message
        self.next_message_index = int(raw.get("nextMessageIndex") or (len(self.history) + 1))
        self.next_player_number = int(raw.get("nextPlayerNumber") or 1)
        self.pinned_ids = [mid for mid in (raw.get("pinnedIds") or []) if mid in self.message_by_id]
        for user in raw.get("users") or []:
            user["online"] = False
            self.known_users[user["name"]] = user
        print(f"· Restored {len(self.history)} chat messages from {STATE_PATH.name}", flush=True)

    def save_state(self) -> None:
        with self.lock:
            if not self.dirty:
                return
            payload = {
                "version": VERSION,
                "savedAt": now_ms(),
                "nextMessageIndex": self.next_message_index,
                "nextPlayerNumber": self.next_player_number,
                "pinnedIds": list(self.pinned_ids),
                "messages": [self._serialise_message(message) for message in self.history],
                "users": [dict(user, online=False) for user in self.known_users.values()],
            }
            self.dirty = False
        try:
            temporary = STATE_PATH.with_suffix(".tmp")
            temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            temporary.replace(STATE_PATH)
        except OSError as exc:
            print(f"! Could not save chat state: {exc}", flush=True)


ROOM = Room()


def location_for(client: Client) -> dict[str, Any]:
    cx, cz = chunk_for(client.x, client.z)
    return {"x": client.x, "z": client.z, "chunkX": cx, "chunkZ": cz}


def system_private(client: Client, text: str, *, location: dict[str, Any] | None = None, kind: str = "system") -> None:
    try:
        client.send({
            "type": "chat:message",
            "id": f"private-{uuid.uuid4().hex[:10]}",
            "index": None,
            "sender": {"id": "system", "name": "World", "color": [0.58, 0.68, 0.62]},
            "text": text,
            "timestamp": now_ms(),
            "location": location,
            "system": True,
            "kind": kind,
            "reactions": {},
            "replyTo": None,
            "mentions": [],
            "editedAt": None,
            "deleted": False,
            "private": True,
        })
    except OSError:
        pass


COMMAND_HELP = [
    ("/help", "show this list"),
    ("/nick [name]", "change your display name"),
    ("/me [action]", "post an action message"),
    ("/status [text]", "set your status (blank clears it)"),
    ("/here", "announce that you are online at your chunk"),
    ("/location", "post your current location"),
    ("/list", "list everyone online"),
    ("/tp [player]", "teleport to a player"),
    ("/goto [index]", "teleport to a numbered message's location"),
    ("/w [player] [text]", "send a private message"),
    ("/roll [sides]", "roll a die"),
    ("/shrug [text]", "append ¯\\_(ツ)_/¯"),
    ("/pins", "list pinned messages"),
    ("/clear", "clear your local view"),
]


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
                if client:
                    self._run_websocket(client)
                return
            if method != "GET":
                self._send_http(405, b"Method not allowed.\n", "text/plain; charset=utf-8")
                return
            if path == "/health":
                self._send_http(200, json_bytes({
                    "status": "ok", "version": VERSION, "players": ROOM.count(),
                    "maxPlayers": MAX_PLAYERS, "worldSeed": WORLD_SEED,
                    "chatMessages": len(ROOM.history), "pinned": len(ROOM.pinned_ids),
                }), "application/json; charset=utf-8")
                return
            if path == "/":
                body = (
                    f"Voxel Multiplayer Hills server v{VERSION} is online.\n"
                    f"Players: {ROOM.count()}/{MAX_PLAYERS}\n"
                    f"Chat messages: {len(ROOM.history)}/{CHAT_HISTORY_LIMIT}\n"
                    "WebSocket endpoint: /ws\n"
                ).encode("utf-8")
                self._send_http(200, body, "text/plain; charset=utf-8")
                return
            self._send_http(404, b"Not found.\n", "text/plain; charset=utf-8")
        except (ConnectionError, OSError, TimeoutError, ValueError, socket.timeout):
            pass
        finally:
            if client is not None:
                removed = ROOM.remove(client.id)
                if removed:
                    ROOM.broadcast({"type": "left", "id": client.id})
                    ROOM.broadcast({"type": "chat:typing", "id": client.id, "name": client.name, "typing": False})
                    leave = ROOM.add_message(sender=None, text=f"{client.name} left the server.", system=True, kind="leave")
                    ROOM.broadcast(leave)
                    ROOM.broadcast({"type": "chat:users", "users": ROOM.users_snapshot()})
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
        headers: dict[str, str] = {}
        for line in lines[1:]:
            if ":" in line:
                name, value = line.split(":", 1)
                headers[name.strip().lower()] = value.strip()
        return request_parts[0].upper(), request_parts[1], headers

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
            "Connection: close\r\n\r\n"
        ).encode("ascii") + body
        self.request.sendall(response)

    def _upgrade_websocket(self, headers: dict[str, str]) -> Client | None:
        key = headers.get("sec-websocket-key")
        if not key or headers.get("sec-websocket-version") != "13":
            self._send_http(403, b"Invalid WebSocket handshake.\n", "text/plain; charset=utf-8")
            return None
        accept = base64.b64encode(hashlib.sha1((key + WEBSOCKET_GUID).encode("ascii")).digest()).decode("ascii")
        self.request.sendall((
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
        ).encode("ascii"))
        self.request.settimeout(SOCKET_IDLE_SECONDS)

        client, existing = ROOM.add(self.request, self.client_address)
        if client is None:
            self.request.sendall(websocket_frame(json_bytes({"type": "error", "message": f"This room is full ({MAX_PLAYERS} players)."})))
            self.request.sendall(websocket_frame(struct.pack("!H", 1008), opcode=0x8))
            return None

        client.send({
            "type": "welcome", "version": VERSION, "id": client.id, "name": client.name,
            "color": client.color, "seed": WORLD_SEED, "maxPlayers": MAX_PLAYERS,
            "spawn": {"x": client.spawn_x, "z": client.spawn_z}, "players": existing,
            "limits": {
                "messageLength": CHAT_MESSAGE_LIMIT,
                "rateLimit": CHAT_RATE_LIMIT,
                "rateWindowSeconds": CHAT_RATE_WINDOW_SECONDS,
                "historyLimit": CHAT_HISTORY_LIMIT,
                "editWindowSeconds": CHAT_EDIT_WINDOW_SECONDS,
            },
            "reactions": sorted(ALLOWED_REACTIONS),
        })
        self._send_history(client)
        ROOM.broadcast({"type": "joined", "player": client.public_state()}, exclude=client.id)
        join = ROOM.add_message(sender=None, text=f"{client.name} joined the server.", location=location_for(client), system=True, kind="join")
        ROOM.broadcast(join)
        ROOM.broadcast({"type": "chat:users", "users": ROOM.users_snapshot()})
        print(f"+ {client.name} from {self.client_address[0]} ({ROOM.count()}/{MAX_PLAYERS})", flush=True)
        return client

    def _send_history(self, client: Client) -> None:
        client.send({
            "type": "chat:history",
            "messages": ROOM.history_snapshot(),
            "users": ROOM.users_snapshot(),
            "pinned": ROOM.pinned_snapshot(),
            "commands": [{"command": c, "description": d} for c, d in COMMAND_HELP],
        })

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
            if isinstance(message, dict):
                self._handle_message(client, message)

    def _handle_message(self, client: Client, message: dict[str, Any]) -> None:
        message_type = message.get("type")
        if message_type == "state":
            self._apply_state(client, message)
        elif message_type == "chat:send":
            self._chat_send(client, message)
        elif message_type == "chat:edit":
            self._chat_edit(client, message)
        elif message_type == "chat:delete":
            self._chat_delete(client, message)
        elif message_type == "chat:pin":
            self._chat_pin(client, message)
        elif message_type == "chat:pins":
            client.send({"type": "chat:pins", "pinned": ROOM.pinned_snapshot()})
        elif message_type == "chat:nick":
            self._chat_nick(client, str(message.get("name") or ""))
        elif message_type == "chat:user-status":
            self._chat_status(client, message)
        elif message_type == "chat:location-update":
            self._chat_location(client, message)
        elif message_type == "chat:typing":
            typing = bool(message.get("typing"))
            client.typing = typing
            ROOM.broadcast({"type": "chat:typing", "id": client.id, "name": client.name, "typing": typing}, exclude=client.id)
        elif message_type == "chat:reaction":
            self._chat_reaction(client, message)
        elif message_type == "chat:history":
            self._send_history(client)

    def _apply_state(self, client: Client, message: dict[str, Any]) -> None:
        try:
            x, z, angle = float(message.get("x")), float(message.get("z")), float(message.get("angle"))
        except (TypeError, ValueError):
            return
        if not all(math.isfinite(value) for value in (x, z, angle)):
            return
        now = time.monotonic()
        elapsed = max(0.01, min(now - client.last_update, 1.0))
        max_distance = 8.0 * elapsed + 1.5
        dx, dz = x - client.x, z - client.z
        distance = math.hypot(dx, dz)
        if distance > max_distance and distance > 0:
            scale = max_distance / distance
            x, z = client.x + dx * scale, client.z + dz * scale
        client.x = max(-1_000_000.0, min(1_000_000.0, x))
        client.z = max(-1_000_000.0, min(1_000_000.0, z))
        client.angle = ((angle + math.pi) % (2 * math.pi)) - math.pi
        client.moving = bool(message.get("moving"))
        client.last_update = now
        ROOM.update_known_user(client)
        ROOM.broadcast({
            "type": "state", "id": client.id, "x": client.x, "z": client.z,
            "angle": client.angle, "moving": client.moving, "serverTime": time.time(),
        }, exclude=client.id)

    def _rate_limited(self, client: Client, client_id: str) -> bool:
        current = time.monotonic()
        while client.message_times and current - client.message_times[0] >= CHAT_RATE_WINDOW_SECONDS:
            client.message_times.popleft()
        if len(client.message_times) >= CHAT_RATE_LIMIT:
            retry_after = max(0.0, CHAT_RATE_WINDOW_SECONDS - (current - client.message_times[0]))
            client.send({
                "type": "chat:error", "clientId": client_id, "code": "rate-limit",
                "retryAfter": round(retry_after, 2),
                "message": f"Slow down — {CHAT_RATE_LIMIT} messages per {int(CHAT_RATE_WINDOW_SECONDS)} seconds.",
            })
            return True
        client.message_times.append(current)
        return False

    def _chat_send(self, client: Client, message: dict[str, Any]) -> None:
        client_id = str(message.get("clientId") or uuid.uuid4().hex[:10])[:80]
        text = str(message.get("text") or "").strip()
        if not text:
            return
        if len(text) > CHAT_MESSAGE_LIMIT:
            client.send({
                "type": "chat:error", "clientId": client_id, "code": "too-long",
                "message": f"Messages are limited to {CHAT_MESSAGE_LIMIT} characters.",
            })
            return
        if self._rate_limited(client, client_id):
            return

        if text.startswith("/") and not text.startswith("//"):
            self._chat_command(client, client_id, text)
            return
        if text.startswith("//"):
            text = text[1:]

        reply_to = ROOM.reply_stub(str(message.get("replyTo") or "")) if message.get("replyTo") else None
        client.send({"type": "chat:ack", "clientId": client_id, "status": "sent", "timestamp": now_ms()})
        chat_message = ROOM.add_message(sender=client, text=text, location=location_for(client), reply_to=reply_to)
        delivered = ROOM.broadcast(chat_message)
        client.send({
            "type": "chat:ack", "clientId": client_id, "messageId": chat_message["id"],
            "index": chat_message["index"], "status": "delivered", "deliveredTo": delivered,
            "timestamp": chat_message["timestamp"],
        })

    def _chat_edit(self, client: Client, message: dict[str, Any]) -> None:
        text = str(message.get("text") or "").strip()
        message_id = str(message.get("messageId") or "")
        if not text:
            self._chat_delete(client, {"messageId": message_id})
            return
        if len(text) > CHAT_MESSAGE_LIMIT:
            client.send({"type": "chat:error", "code": "too-long", "message": f"Messages are limited to {CHAT_MESSAGE_LIMIT} characters."})
            return
        updated, error = ROOM.edit_message(message_id, client.id, text)
        if not updated:
            system_private(client, error, kind="error")
            return
        ROOM.broadcast({"type": "chat:update", "message": updated})

    def _chat_delete(self, client: Client, message: dict[str, Any]) -> None:
        updated, error = ROOM.delete_message(str(message.get("messageId") or ""), client.id)
        if not updated:
            system_private(client, error, kind="error")
            return
        ROOM.broadcast({"type": "chat:update", "message": updated})
        ROOM.broadcast({"type": "chat:pins", "pinned": ROOM.pinned_snapshot()})

    def _chat_pin(self, client: Client, message: dict[str, Any]) -> None:
        pinned = bool(message.get("pinned", True))
        updated, error = ROOM.set_pinned(str(message.get("messageId") or ""), pinned)
        if not updated:
            system_private(client, error, kind="error")
            return
        ROOM.broadcast({"type": "chat:update", "message": updated})
        ROOM.broadcast({"type": "chat:pins", "pinned": ROOM.pinned_snapshot()})
        note = ROOM.add_message(
            sender=None,
            text=f"{client.name} {'pinned' if pinned else 'unpinned'} a message from {updated['sender']['name']}.",
            system=True,
            kind="pin",
        )
        ROOM.broadcast(note)

    def _chat_nick(self, client: Client, requested: str) -> None:
        ok, detail = ROOM.rename(client, requested)
        if not ok:
            system_private(client, detail, kind="error")
            return
        client.send({"type": "chat:renamed", "id": client.id, "name": client.name, "previous": detail})
        ROOM.broadcast({"type": "chat:renamed", "id": client.id, "name": client.name, "previous": detail}, exclude=client.id)
        ROOM.broadcast({"type": "chat:users", "users": ROOM.users_snapshot()})
        note = ROOM.add_message(sender=None, text=f"{detail} is now known as {client.name}.", system=True, kind="rename")
        ROOM.broadcast(note)

    def _chat_command(self, client: Client, client_id: str, text: str) -> None:
        command, _, argument = text.partition(" ")
        command = command.lower()
        argument = argument.strip()
        location = location_for(client)

        if command in {"/here", "/location"}:
            label = "is online at" if command == "/here" else "is at"
            msg = ROOM.add_message(
                sender=client,
                text=f"{client.name} {label} chunk {location['chunkX']}, {location['chunkZ']}.",
                location=location,
                system=True,
                kind="location",
            )
            ROOM.broadcast(msg)
        elif command == "/status":
            client.status = argument[:80]
            ROOM.update_known_user(client)
            ROOM.broadcast({"type": "chat:user-status", "id": client.id, "name": client.name, "status": client.status, "timestamp": now_ms()})
            ROOM.broadcast({"type": "chat:users", "users": ROOM.users_snapshot()})
            system_private(client, f"Status set to “{client.status}”." if client.status else "Status cleared.")
        elif command == "/nick":
            self._chat_nick(client, argument)
        elif command == "/me":
            if not argument:
                system_private(client, "Usage: /me [action]", kind="error")
            else:
                msg = ROOM.add_message(sender=client, text=f"{client.name} {argument}", location=location, kind="emote")
                ROOM.broadcast(msg)
        elif command == "/shrug":
            msg = ROOM.add_message(sender=client, text=f"{argument} ¯\\_(ツ)_/¯".strip(), location=location)
            ROOM.broadcast(msg)
        elif command == "/roll":
            try:
                sides = max(2, min(1000, int(argument or 6)))
            except ValueError:
                sides = 6
            msg = ROOM.add_message(
                sender=None,
                text=f"🎲 {client.name} rolled {random.randint(1, sides)} (d{sides}).",
                system=True,
                kind="roll",
            )
            ROOM.broadcast(msg)
        elif command == "/list":
            players = [c.public_state() for c in ROOM.clients.values()]
            listing = ", ".join(f"{p['name']} ({p['chunkX']}, {p['chunkZ']})" for p in players) or "Nobody is online."
            system_private(client, f"Online now: {listing}", kind="list")
        elif command == "/pins":
            pins = ROOM.pinned_snapshot()
            if not pins:
                system_private(client, "No messages are pinned yet.", kind="list")
            else:
                listing = " · ".join(f"#{p.get('index')} {p['sender']['name']}: {preview_text(p.get('text', ''), 50)}" for p in pins)
                system_private(client, f"Pinned: {listing}", kind="list")
        elif command in {"/w", "/whisper", "/msg", "/dm"}:
            target_name, body = ROOM.split_target(argument)
            target = ROOM.find_player(target_name)
            if not target:
                system_private(client, f"Player “{target_name}” was not found online.", kind="error")
            elif target.id == client.id:
                system_private(client, "You cannot whisper to yourself.", kind="error")
            elif not body:
                system_private(client, "Usage: /w [player] [message]", kind="error")
            else:
                stamp = now_ms()
                payload = {
                    "type": "chat:message",
                    "id": f"dm-{uuid.uuid4().hex[:10]}",
                    "index": None,
                    "sender": {"id": client.id, "name": client.name, "color": client.color},
                    "text": body,
                    "timestamp": stamp,
                    "location": None,
                    "system": False,
                    "kind": "dm",
                    "reactions": {},
                    "replyTo": None,
                    "mentions": [target.name],
                    "editedAt": None,
                    "deleted": False,
                    "private": True,
                    "dm": {"fromId": client.id, "fromName": client.name, "toId": target.id, "toName": target.name},
                }
                try:
                    target.send(payload)
                except OSError:
                    pass
                client.send(dict(payload, id=f"{payload['id']}-echo"))
        elif command == "/tp":
            target = ROOM.find_player(argument)
            if not target:
                system_private(client, f"Player “{argument}” was not found online.", kind="error")
            else:
                target_location = location_for(target)
                client.send({"type": "chat:teleport", "location": target_location, "target": target.public_state(), "timestamp": now_ms()})
                system_private(client, f"Teleporting to {target.name} at chunk {target_location['chunkX']}, {target_location['chunkZ']}.", location=target_location, kind="teleport")
        elif command == "/goto":
            try:
                index = int(argument.lstrip("#"))
            except ValueError:
                index = -1
            target_message = ROOM.find_message_index(index)
            target_location = target_message.get("location") if target_message else None
            if not target_location:
                system_private(client, f"Message #{argument} does not contain a location.", kind="error")
            else:
                client.send({"type": "chat:teleport", "location": target_location, "messageId": target_message["id"], "timestamp": now_ms()})
                system_private(client, f"Jumping to the location from message #{index}.", location=target_location, kind="teleport")
        elif command in {"/help", "/commands"}:
            listing = "\n".join(f"{c} — {d}" for c, d in COMMAND_HELP)
            system_private(client, f"Available commands:\n{listing}", kind="help")
        elif command == "/clear":
            client.send({"type": "chat:clear-local"})
        else:
            system_private(client, f"Unknown command: {command}. Type /help for the list.", kind="error")
        client.send({"type": "chat:ack", "clientId": client_id, "status": "delivered", "timestamp": now_ms()})

    def _chat_status(self, client: Client, message: dict[str, Any]) -> None:
        client.status = str(message.get("status") or "").strip()[:80]
        ROOM.update_known_user(client)
        ROOM.broadcast({"type": "chat:user-status", "id": client.id, "name": client.name, "status": client.status, "timestamp": now_ms()})
        ROOM.broadcast({"type": "chat:users", "users": ROOM.users_snapshot()})

    def _chat_location(self, client: Client, message: dict[str, Any]) -> None:
        try:
            x, z = float(message.get("x")), float(message.get("z"))
        except (TypeError, ValueError):
            return
        if math.isfinite(x) and math.isfinite(z):
            client.x = max(-1_000_000.0, min(1_000_000.0, x))
            client.z = max(-1_000_000.0, min(1_000_000.0, z))
            ROOM.update_known_user(client)

    def _chat_reaction(self, client: Client, message: dict[str, Any]) -> None:
        message_id = str(message.get("messageId") or "")
        emoji = str(message.get("emoji") or "")
        if emoji not in ALLOWED_REACTIONS:
            return
        updated = ROOM.add_reaction(message_id, emoji, client.id, client.name)
        if updated:
            ROOM.broadcast({"type": "chat:reaction", "messageId": message_id, "reactions": updated["reactions"]})


class MultiplayerServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 128


def start_autosave() -> threading.Event:
    stop = threading.Event()

    def loop() -> None:
        while not stop.wait(STATE_SAVE_INTERVAL):
            ROOM.save_state()

    threading.Thread(target=loop, name="chat-autosave", daemon=True).start()
    return stop


def main() -> None:
    try:
        server = MultiplayerServer((HOST, PORT), MultiplayerHandler)
    except OSError as exc:
        raise SystemExit(f"Could not bind multiplayer server to {HOST}:{PORT}: {exc}") from exc
    stop_autosave = start_autosave()
    print("=" * 72, flush=True)
    print(f"VOXEL MULTIPLAYER HILLS SERVER v{VERSION}", flush=True)
    print(f"Listening: http://{HOST}:{PORT}", flush=True)
    print(f"WebSocket: ws://localhost:{PORT}/ws", flush=True)
    print(f"World seed: {WORLD_SEED}", flush=True)
    print(f"Room limit: {MAX_PLAYERS}", flush=True)
    print(f"Chat history: {CHAT_HISTORY_LIMIT} messages · state file {STATE_PATH}", flush=True)
    print(f"Allowed origins: {', '.join(sorted(ALLOWED_ORIGINS)) if ALLOWED_ORIGINS else 'all'}", flush=True)
    print("=" * 72, flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("\nStopping multiplayer server…", flush=True)
    finally:
        stop_autosave.set()
        ROOM.dirty = True
        ROOM.save_state()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
