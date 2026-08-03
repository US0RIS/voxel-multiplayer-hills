#!/usr/bin/env python3
"""Two-client protocol test for World Chat v4.3.0."""
import asyncio
import json
import sys

import websockets

URL = "ws://localhost:8131/ws"
FAILURES = []


def check(condition, label):
    print(("  PASS  " if condition else "  FAIL  ") + label)
    if not condition:
        FAILURES.append(label)


class Client:
    def __init__(self, socket, name):
        self.socket = socket
        self.label = name
        self.inbox = []
        self.id = None
        self.name = None

    async def pump(self, seconds=0.45):
        try:
            while True:
                raw = await asyncio.wait_for(self.socket.recv(), timeout=seconds)
                self.inbox.append(json.loads(raw))
        except (asyncio.TimeoutError, TimeoutError):
            pass

    async def send(self, payload):
        await self.socket.send(json.dumps(payload))

    def of(self, message_type):
        return [m for m in self.inbox if m.get("type") == message_type]

    def last(self, message_type):
        found = self.of(message_type)
        return found[-1] if found else None

    def clear(self):
        self.inbox = []


async def connect(label):
    socket = await websockets.connect(URL)
    client = Client(socket, label)
    await client.pump(0.6)
    welcome = client.last("welcome")
    client.id = welcome["id"]
    client.name = welcome["name"]
    return client, welcome


async def main():
    print("\n=== connect + welcome ===")
    alice, welcome_a = await connect("alice")
    check(welcome_a["version"] == "4.3.0", "welcome carries version 4.3.0")
    check(welcome_a["limits"]["messageLength"] == 2000, "welcome carries limits")
    check(len(welcome_a["reactions"]) > 8, "welcome carries reaction set")
    history = alice.last("chat:history")
    check(history is not None and "commands" in history, "history includes command list")

    bob, _ = await connect("bob")
    await alice.pump()
    check(alice.last("joined") is not None, "alice sees bob join")
    join_msgs = [m for m in alice.of("chat:message") if m.get("kind") == "join"]
    check(bool(join_msgs), "join system message broadcast")

    print("\n=== send + ack + broadcast ===")
    alice.clear(); bob.clear()
    await alice.send({"type": "chat:send", "clientId": "c1", "text": "hello **world**"})
    await asyncio.gather(alice.pump(), bob.pump())
    acks = alice.of("chat:ack")
    check(any(a["status"] == "sent" for a in acks), "sender gets 'sent' ack")
    delivered = [a for a in acks if a["status"] == "delivered"]
    check(bool(delivered), "sender gets 'delivered' ack")
    check(delivered[0].get("index") is not None, "delivered ack carries index")
    posted = [m for m in bob.of("chat:message") if m.get("text") == "hello **world**"]
    check(bool(posted), "recipient receives the message")
    message_id = posted[0]["id"]
    check(posted[0]["location"]["chunkX"] == 0, "message carries location")

    print("\n=== reply ===")
    alice.clear(); bob.clear()
    await bob.send({"type": "chat:send", "clientId": "c2", "text": "replying now", "replyTo": message_id})
    await asyncio.gather(alice.pump(), bob.pump())
    reply = [m for m in alice.of("chat:message") if m.get("text") == "replying now"]
    check(bool(reply), "reply is broadcast")
    check(reply[0]["replyTo"] and reply[0]["replyTo"]["id"] == message_id, "reply carries parent stub")
    check(reply[0]["replyTo"]["name"] == alice.name, "reply stub names the parent author")

    print("\n=== mentions ===")
    alice.clear(); bob.clear()
    await bob.send({"type": "chat:send", "clientId": "c3", "text": f"hey @{alice.name} look"})
    await asyncio.gather(alice.pump(), bob.pump())
    mention = [m for m in alice.of("chat:message") if "look" in (m.get("text") or "")]
    check(mention and alice.name in mention[0]["mentions"], "server flags @mention")

    print("\n=== reactions ===")
    alice.clear(); bob.clear()
    await bob.send({"type": "chat:reaction", "messageId": message_id, "emoji": "🔥"})
    await asyncio.gather(alice.pump(), bob.pump())
    reaction = alice.last("chat:reaction")
    check(reaction and reaction["reactions"]["🔥"]["count"] == 1, "reaction added")
    check(bob.name in reaction["reactions"]["🔥"]["names"], "reaction records the reactor name")
    alice.clear(); bob.clear()
    await bob.send({"type": "chat:reaction", "messageId": message_id, "emoji": "🔥"})
    await asyncio.gather(alice.pump(), bob.pump())
    check("🔥" not in (alice.last("chat:reaction") or {}).get("reactions", {}), "reaction toggles off")
    alice.clear()
    await bob.send({"type": "chat:reaction", "messageId": message_id, "emoji": "🦄"})
    await alice.pump(0.3)
    check(alice.last("chat:reaction") is None, "unlisted emoji rejected")

    print("\n=== edit ===")
    alice.clear(); bob.clear()
    await alice.send({"type": "chat:edit", "messageId": message_id, "text": "hello edited"})
    await asyncio.gather(alice.pump(), bob.pump())
    update = bob.last("chat:update")
    check(update and update["message"]["text"] == "hello edited", "edit broadcast to others")
    check(update["message"]["editedAt"] is not None, "edit sets editedAt")
    bob.clear()
    await bob.send({"type": "chat:edit", "messageId": message_id, "text": "hijacked"})
    await bob.pump()
    denied = [m for m in bob.of("chat:message") if m.get("kind") == "error"]
    check(bool(denied), "editing someone else's message is denied")

    print("\n=== pin ===")
    alice.clear(); bob.clear()
    await bob.send({"type": "chat:pin", "messageId": message_id, "pinned": True})
    await asyncio.gather(alice.pump(), bob.pump())
    pins = alice.last("chat:pins")
    check(pins and len(pins["pinned"]) == 1, "pin list broadcast")
    check(alice.last("chat:update")["message"]["pinned"] is True, "message marked pinned")
    alice.clear()
    await alice.send({"type": "chat:pins"})
    await alice.pump()
    check(len(alice.last("chat:pins")["pinned"]) == 1, "pins can be requested")

    print("\n=== rename ===")
    alice.clear(); bob.clear()
    await alice.send({"type": "chat:nick", "name": "Builder Matt"})
    await asyncio.gather(alice.pump(), bob.pump())
    renamed = alice.last("chat:renamed")
    check(renamed and renamed["name"] == "Builder Matt", "rename confirmed to sender")
    check(bob.last("chat:renamed") is not None, "rename broadcast to others")
    alice.name = "Builder Matt"
    alice.clear()
    await alice.send({"type": "chat:nick", "name": "!!"})
    await alice.pump()
    check(any(m.get("kind") == "error" for m in alice.of("chat:message")), "invalid nickname rejected")
    bob.clear()
    await bob.send({"type": "chat:nick", "name": "Builder Matt"})
    await bob.pump()
    check(any(m.get("kind") == "error" for m in bob.of("chat:message")), "duplicate nickname rejected")

    print("\n=== commands ===")
    alice.clear(); bob.clear()
    await alice.send({"type": "chat:send", "clientId": "c4", "text": "/help"})
    await alice.pump()
    check(any("Available commands" in (m.get("text") or "") for m in alice.of("chat:message")), "/help responds privately")

    alice.clear(); bob.clear()
    await alice.send({"type": "chat:send", "clientId": "c5", "text": f"/w {bob.name} psst"})
    await asyncio.gather(alice.pump(), bob.pump())
    dm_to_bob = [m for m in bob.of("chat:message") if m.get("kind") == "dm"]
    check(bool(dm_to_bob), "whisper delivered to target")
    check(dm_to_bob[0]["dm"]["toId"] == bob.id, "whisper carries dm envelope")
    check(any(m.get("kind") == "dm" for m in alice.of("chat:message")), "whisper echoed to sender")

    alice.clear(); bob.clear()
    await alice.send({"type": "chat:send", "clientId": "c6", "text": "/me waves"})
    await bob.pump()
    emote = [m for m in bob.of("chat:message") if m.get("kind") == "emote"]
    check(emote and emote[0]["text"].startswith("Builder Matt waves"), "/me posts an emote")

    alice.clear()
    await alice.send({"type": "chat:send", "clientId": "c7", "text": "/roll 20"})
    await alice.pump()
    check(any(m.get("kind") == "roll" for m in alice.of("chat:message")), "/roll works")

    alice.clear()
    await alice.send({"type": "chat:send", "clientId": "c8", "text": "/tp " + bob.name})
    await alice.pump()
    check(alice.last("chat:teleport") is not None, "/tp returns a teleport packet")

    await asyncio.sleep(5.2)
    alice.clear()
    await alice.send({"type": "chat:send", "clientId": "c9", "text": "/clear"})
    await alice.pump()
    check(alice.last("chat:clear-local") is not None, "/clear returns a local clear packet")

    await asyncio.sleep(5.2)
    alice.clear()
    await alice.send({"type": "chat:send", "clientId": "c10", "text": "/nope"})
    await alice.pump()
    check(any("Unknown command" in (m.get("text") or "") for m in alice.of("chat:message")), "unknown command reports back")

    await asyncio.sleep(5.2)
    alice.clear(); bob.clear()
    await alice.send({"type": "chat:send", "clientId": "c11", "text": "//not-a-command"})
    await bob.pump()
    check(any(m.get("text") == "/not-a-command" for m in bob.of("chat:message")), "// escapes a literal slash")

    print("\n=== validation + rate limit ===")
    alice.clear()
    await alice.send({"type": "chat:send", "clientId": "c12", "text": "x" * 2100})
    await alice.pump()
    error = alice.last("chat:error")
    check(error and error["code"] == "too-long", "over-length message rejected")

    alice.clear()
    for index in range(9):
        await alice.send({"type": "chat:send", "clientId": f"r{index}", "text": f"spam {index}"})
    await alice.pump(0.8)
    limited = [e for e in alice.of("chat:error") if e.get("code") == "rate-limit"]
    check(bool(limited), "rate limit triggers")
    check(limited[0].get("retryAfter") is not None, "rate-limit error carries retryAfter")

    print("\n=== typing + status + presence ===")
    alice.clear(); bob.clear()
    await alice.send({"type": "chat:typing", "typing": True})
    await bob.pump()
    check(bob.last("chat:typing") and bob.last("chat:typing")["typing"] is True, "typing relayed")
    check(alice.last("chat:typing") is None, "typing not echoed to sender")

    alice.clear(); bob.clear()
    await bob.send({"type": "chat:user-status", "status": "doing homework"})
    await alice.pump()
    check(alice.last("chat:user-status")["status"] == "doing homework", "status broadcast")
    users = alice.last("chat:users")["users"]
    check(any(u["status"] == "doing homework" for u in users), "status appears in user snapshot")

    print("\n=== delete ===")
    alice.clear(); bob.clear()
    await alice.send({"type": "chat:delete", "messageId": message_id})
    await asyncio.gather(alice.pump(), bob.pump())
    tombstone = bob.last("chat:update")["message"]
    check(tombstone["deleted"] is True and tombstone["text"] == "", "delete tombstones the message")
    check(len(bob.last("chat:pins")["pinned"]) == 0, "deleting a pinned message unpins it")

    print("\n=== persistence across restart ===")
    alice.clear()
    await alice.send({"type": "chat:send", "clientId": "c13", "text": "survives a restart"})
    await alice.pump()
    await alice.socket.close()
    await bob.socket.close()
    await asyncio.sleep(0.3)
    return True


if __name__ == "__main__":
    asyncio.run(main())
    print("\n" + ("=" * 60))
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for item in FAILURES:
            print(f"  - {item}")
        sys.exit(1)
    print("All protocol checks passed.")
