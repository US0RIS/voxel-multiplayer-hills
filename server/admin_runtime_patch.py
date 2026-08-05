#!/usr/bin/env python3
"""Asserted source patches that add staff roles and moderation to the runtime.

Runs after patch_auth_runtime and patch_world_runtime, so every anchor below is
matched against the already-patched source. Each replacement asserts, which
means a mismatch fails the deploy loudly instead of silently shipping a server
where, say, bans are not enforced.
"""
from __future__ import annotations


def _replace(source: str, search: str, replacement: str, label: str) -> str:
    if search not in source:
        raise SystemExit(f"Admin integration failed ({label}).")
    return source.replace(search, replacement, 1)


def patch_admin_runtime(source: str) -> str:
    # ------------------------------------------------------------- imports
    source = _replace(
        source,
        "import auth\nfrom world_persistence import WORLD, SupabaseError\nfrom collections import deque",
        "import auth\nimport admin\nimport traceback\nfrom admin import AdminError\n"
        "from world_persistence import WORLD, SupabaseError\nfrom collections import deque",
        "admin imports",
    )

    # ------------------------------------------------- never fail silently
    #
    # handle() only caught ConnectionError/OSError/TimeoutError/ValueError, so
    # anything else -- AttributeError, TypeError, SupabaseError -- killed the
    # handler thread before the WebSocket handshake reply was written. The
    # browser saw a closed socket and reported a useless "bad response from the
    # server" with close code 1006, and nothing was logged. Now the traceback is
    # printed and the client gets a real status code.
    source = _replace(
        source,
        """        except (ConnectionError, OSError, TimeoutError, ValueError, socket.timeout):
            pass
        finally:""",
        """        except (ConnectionError, OSError, TimeoutError, ValueError, socket.timeout):
            pass
        except Exception:
            print("Unhandled error while serving a request:", flush=True)
            traceback.print_exc()
            if client is None:
                try:
                    self._send_http(
                        500, b"Internal server error.\\n", "text/plain; charset=utf-8"
                    )
                except OSError:
                    pass
        finally:""",
        "unhandled error reporting",
    )

    # -------------------------------------------------- role on the client
    source = _replace(
        source,
        '''    def public_state(self) -> dict[str, Any]:
        cx, cz = chunk_for(self.x, self.z)
        return {
            "id": self.id,
            "name": self.name,''',
        '''    def public_state(self) -> dict[str, Any]:
        cx, cz = chunk_for(self.x, self.z)
        return {
            "id": self.id,
            "name": self.name,
            "role": getattr(self, "role", "player"),
            "userId": getattr(self, "user_id", ""),''',
        "public state role",
    )

    source = _replace(
        source,
        '''        self.known_users[client.name] = {
            "id": client.id,
            "name": client.name,
            "color": client.color,''',
        '''        self.known_users[client.name] = {
            "id": client.id,
            "name": client.name,
            "role": getattr(client, "role", "player"),
            "userId": getattr(client, "user_id", ""),
            "color": client.color,''',
        "known user role",
    )

    # -------------------------------------------------- role on chat senders
    source = _replace(
        source,
        '''                "sender": {
                    "id": sender.id if sender else "system",
                    "name": sender.name if sender else "World",
                    "color": sender.color if sender else [0.58, 0.68, 0.62],
                },''',
        '''                "sender": {
                    "id": sender.id if sender else "system",
                    "name": sender.name if sender else "World",
                    "color": sender.color if sender else [0.58, 0.68, 0.62],
                    "role": getattr(sender, "role", "player") if sender else "system",
                },''',
        "chat sender role",
    )

    source = _replace(
        source,
        '''                    "sender": {"id": client.id, "name": client.name, "color": client.color},''',
        '''                    "sender": {
                        "id": client.id, "name": client.name, "color": client.color,
                        "role": getattr(client, "role", "player"),
                    },''',
        "whisper sender role",
    )

    # ------------------------------------------------ ban check on connect
    source = _replace(
        source,
        '''                auth_user = auth.websocket_user(headers, parsed_target.query)
                if auth.AUTH_REQUIRED and not auth_user:
                    self._send_http(401, b"Authentication required.\\n", "text/plain; charset=utf-8")
                    return''',
        '''                auth_user = auth.websocket_user(headers, parsed_target.query)
                # With AUTH_REQUIRED=0 an unusable token silently becomes a
                # guest connection, which looks identical to "the admin panel
                # is broken". Say so instead of hiding it.
                if not auth_user and auth.extract_session_token(headers, parsed_target.query):
                    print(
                        "A session token was supplied but did not resolve; "
                        "connecting as a guest with no role.",
                        flush=True,
                    )
                if auth.AUTH_REQUIRED and not auth_user:
                    self._send_http(401, b"Authentication required.\\n", "text/plain; charset=utf-8")
                    return
                ban = auth.ban_state(auth_user)
                if ban:
                    detail = f" Reason: {ban['reason']}" if ban.get("reason") else ""
                    self._send_http(
                        403,
                        f"This account is banned.{detail}\\n".encode("utf-8"),
                        "text/plain; charset=utf-8",
                    )
                    return''',
        "ban enforcement",
    )

    # ---------------------------------------------- role on the connection
    source = _replace(
        source,
        '''            client.auth_user = auth_user
            client.user_id = str(auth_user.get("user_id") or "")''',
        '''            client.auth_user = auth_user
            client.role = admin.role_of(auth_user)
            client.user_id = str(auth_user.get("user_id") or "")
            print(
                f"Authenticated {auth_user.get('username')} "
                f"(account {client.user_id}) as role={client.role}",
                flush=True,
            )''',
        "client role",
    )

    # -------------------------------------------------- welcome capabilities
    source = _replace(
        source,
        '''            "auth": auth_user,
            "world": {''',
        '''            "auth": auth_user,
            "role": getattr(client, "role", "player"),
            "admin": admin.capabilities(getattr(client, "role", "player")),
            "world": {''',
        "welcome capabilities",
    )

    # ------------------------------------------------------ message routing
    source = _replace(
        source,
        '''        elif message_type == "world:edit":
            self._world_edit(client, message)''',
        '''        elif message_type == "world:edit":
            self._world_edit(client, message)
        elif message_type == "admin:action":
            self._admin_action(client, message)''',
        "admin routing",
    )

    # ---------------------------------------- staff bypass the claim limit
    source = _replace(
        source,
        '''        if (chunk_x, chunk_z) != (current_x, current_z):
            client.send({"type": "world:claim-result", "ok": False, "error": "stand_in_chunk_to_claim"})
            return
        try:
            result = WORLD.claim_chunk(user_id, chunk_x, chunk_z)''',
        '''        staff = admin.client_is_staff(client)
        if (chunk_x, chunk_z) != (current_x, current_z) and not staff:
            client.send({"type": "world:claim-result", "ok": False, "error": "stand_in_chunk_to_claim"})
            return
        try:
            result = WORLD.claim_chunk(user_id, chunk_x, chunk_z, staff=staff)''',
        "staff claim",
    )

    # -------------------------------------------------- admin handler block
    source = _replace(
        source,
        "    def _rate_limited(self, client: Client, client_id: str) -> bool:",
        ADMIN_HANDLERS + "    def _rate_limited(self, client: Client, client_id: str) -> bool:",
        "admin handlers",
    )

    # ----------------------------------------------------- staff-only build
    # Staff editing at range is allowed, so the shared build rate limit is
    # raised for them only. Everyone else keeps the 5-edits-per-second cap.
    source = _replace(
        source,
        '''        if len(build_times) >= 5:
            client.send({"type": "world:edit-result", "ok": False, "error": "rate_limited"})
            return''',
        '''        if len(build_times) >= (25 if admin.client_is_staff(client) else 5):
            client.send({"type": "world:edit-result", "ok": False, "error": "rate_limited"})
            return''',
        "staff build rate",
    )

    # ------------------------------------------------------ admin commands
    source = _replace(
        source,
        '''        elif command in {"/help", "/commands"}:
            listing = "\\n".join(f"{c} — {d}" for c, d in COMMAND_HELP)
            system_private(client, f"Available commands:\\n{listing}", kind="help")''',
        ADMIN_COMMANDS + '''        elif command in {"/help", "/commands"}:
            listing = "\\n".join(f"{c} — {d}" for c, d in COMMAND_HELP)
            if admin.client_is_staff(client):
                staff_list = "\\n".join(f"{c} — {d}" for c, d in ADMIN_COMMAND_HELP)
                listing = f"{listing}\\n\\nStaff commands:\\n{staff_list}"
            system_private(client, f"Available commands:\\n{listing}", kind="help")''',
        "admin commands",
    )

    # ----------------------------------------------- helpers and constants
    source = _replace(
        source,
        "class MultiplayerHandler(socketserver.BaseRequestHandler):",
        ADMIN_SUPPORT + "class MultiplayerHandler(socketserver.BaseRequestHandler):",
        "admin support",
    )

    # --------------------------------------------------------- startup log
    source = _replace(
        source,
        '''                    "supabase": WORLD.ready, "persistentWorld": WORLD.ready,''',
        '''                    "supabase": WORLD.ready, "persistentWorld": WORLD.ready,
                    "adminRoles": True, "adminSchema": admin.schema_status(),''',
        "health admin status",
    )

    source = _replace(
        source,
        '''    print(f"Discord auth: {'configured' if auth.configured() else 'not configured'} · required={auth.AUTH_REQUIRED}", flush=True)''',
        '''    print(f"Discord auth: {'configured' if auth.configured() else 'not configured'} · required={auth.AUTH_REQUIRED}", flush=True)
    print(f"Admin bootstrap: {', '.join(admin.ADMIN_BOOTSTRAP_NAMES) if admin.ADMIN_BOOTSTRAP_NAMES else 'none configured'}", flush=True)
    admin.start_bootstrap()''',
        "admin startup",
    )

    return source


# --------------------------------------------------------------------------
# Code injected into the generated runtime.
# --------------------------------------------------------------------------

ADMIN_SUPPORT = '''ADMIN_COMMAND_HELP = [
    ("/kick [player] [reason]", "disconnect a player immediately"),
    ("/ban [player] [duration] [reason]", "ban an account, e.g. 24h, 7d, forever"),
    ("/unban [player]", "lift a ban"),
    ("/role [player] [role]", "set player, moderator, or admin (admin only)"),
    ("/staff", "list everyone with a staff role"),
    ("/modlog", "show the last moderation actions"),
    ("/panel", "open the admin control panel"),
]


def admin_actor(client: Client) -> dict[str, Any]:
    """The actor payload passed into the admin module for permission checks."""
    user = dict(getattr(client, "auth_user", None) or {})
    user.setdefault("user_id", getattr(client, "user_id", ""))
    user.setdefault("username", client.name)
    user["role"] = getattr(client, "role", "player")
    return user


def kick_client(target: Client, reason: str) -> None:
    """Tell a player why they are being removed, then close their socket."""
    try:
        target.send({
            "type": "admin:kicked",
            "reason": str(reason or "").strip() or "You were removed by a moderator.",
            "timestamp": now_ms(),
        })
    except OSError:
        pass
    try:
        # 1008 (policy violation) so the client can distinguish a kick from a
        # network drop and avoid its usual automatic reconnect.
        target.send_control(struct.pack("!H", 1008) + b"kicked", opcode=0x8)
    except OSError:
        pass
    try:
        target.sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass


def disconnect_banned(user_id: str, reason: str) -> int:
    """Kick every live connection belonging to a freshly banned account."""
    if not user_id:
        return 0
    targets = [
        other for other in list(ROOM.clients.values())
        if str(getattr(other, "user_id", "")) == str(user_id)
    ]
    for target in targets:
        kick_client(target, reason)
    return len(targets)


def announce_moderation(text: str) -> None:
    note = ROOM.add_message(sender=None, text=text, system=True, kind="moderation")
    ROOM.broadcast(note)


'''


ADMIN_HANDLERS = '''    def _admin_action(self, client: Client, message: dict[str, Any]) -> None:
        """Handle every admin:action packet from the control panel."""
        action = str(message.get("action") or "").lower()
        request_id = str(message.get("requestId") or "")[:64]

        def reply(ok: bool, **payload: Any) -> None:
            client.send({
                "type": "admin:result", "action": action, "requestId": request_id,
                "ok": ok, **payload,
            })

        if not admin.client_is_staff(client):
            reply(False, error="forbidden", message="You do not have permission to do that.")
            return

        actor = admin_actor(client)
        try:
            if action == "players":
                reply(True, players=[c.public_state() for c in list(ROOM.clients.values())])
            elif action == "kick":
                target = ROOM.find_player(str(message.get("player") or ""))
                if not target:
                    reply(False, error="unknown_player", message="That player is not online.")
                    return
                if target.id == client.id:
                    reply(False, error="self_target", message="You cannot kick yourself.")
                    return
                if admin.ROLE_RANK.get(getattr(target, "role", "player"), 0) >= admin.ROLE_RANK.get(getattr(client, "role", "player"), 0):
                    reply(False, error="outranked", message=f"{target.name} has an equal or higher role than you.")
                    return
                reason = str(message.get("reason") or "").strip()[:200]
                admin.log_kick(actor, target.name, str(getattr(target, "user_id", "")), reason)
                kick_client(target, reason or f"Kicked by {client.name}.")
                announce_moderation(f"{target.name} was kicked by {client.name}." + (f" ({reason})" if reason else ""))
                reply(True, message=f"{target.name} was kicked.", player=target.name)
            elif action == "ban":
                result = admin.ban_account(
                    actor,
                    str(message.get("player") or ""),
                    str(message.get("duration") or "forever"),
                    str(message.get("reason") or ""),
                )
                name = result["target"]["username"]
                reason = result.get("reason") or ""
                disconnect_banned(result["target"]["user_id"], reason or f"Banned by {client.name}.")
                announce_moderation(
                    f"{name} was banned {result['durationLabel']} by {client.name}."
                    + (f" ({reason})" if reason else "")
                )
                reply(True, message=f"{name} was banned {result['durationLabel']}.", **result)
            elif action == "unban":
                result = admin.unban_account(actor, str(message.get("player") or ""))
                name = result["target"]["username"]
                announce_moderation(f"{name} was unbanned by {client.name}.")
                reply(True, message=f"{name} was unbanned.", **result)
            elif action == "set-role":
                result = admin.set_account_role(
                    actor, str(message.get("player") or ""), str(message.get("role") or "")
                )
                name = result["target"]["username"]
                live = ROOM.find_player(name)
                if live:
                    live.role = result["role"]
                    live.send({"type": "admin:role", "role": live.role, "admin": admin.capabilities(live.role)})
                    ROOM.update_known_user(live)
                    ROOM.broadcast({"type": "chat:users", "users": ROOM.users_snapshot()})
                announce_moderation(f"{name} is now {result['role']} (set by {client.name}).")
                reply(True, message=f"{name} is now {result['role']}.", **result)
            elif action == "set-chunk-owner":
                result = admin.set_chunk_owner(
                    actor,
                    int(message.get("chunkX")),
                    int(message.get("chunkZ")),
                    str(message.get("player") or "") or None,
                    WORLD.world_id,
                )
                if isinstance(result.get("chunk"), dict):
                    ROOM.broadcast({"type": "world:chunk-updated", "chunk": WORLD._cache_set(result["chunk"])})
                owner = (result.get("owner") or {}).get("username") or "nobody"
                reply(True, message=f"Chunk owner set to {owner}.", **result)
            elif action == "modlog":
                reply(True, entries=admin.recent_actions(actor, int(message.get("limit") or 20)))
            else:
                reply(False, error="unknown_action", message=f"Unknown admin action: {action}")
        except AdminError as exc:
            reply(False, error=exc.code, message=exc.message)
        except (TypeError, ValueError) as exc:
            reply(False, error="invalid_request", message=str(exc))
        except SupabaseError as exc:
            reply(False, error="storage_error", message=str(exc))

'''


ADMIN_COMMANDS = '''        elif command in {"/kick", "/ban", "/unban", "/role", "/staff", "/modlog", "/panel"}:
            self._admin_command(client, command, argument)
'''


# The command bodies live in their own method so the big if/elif chain in
# _chat_command stays readable.
ADMIN_HANDLERS = ADMIN_HANDLERS + '''    def _admin_command(self, client: Client, command: str, argument: str) -> None:
        if not admin.client_is_staff(client):
            system_private(client, f"Unknown command: {command}. Type /help for the list.", kind="error")
            return
        actor = admin_actor(client)
        try:
            if command == "/panel":
                client.send({"type": "admin:open-panel"})
                system_private(client, "Opening the admin panel.", kind="admin")
            elif command == "/staff":
                rows = admin.STORE.list_staff()
                listing = ", ".join(f"{r.get('display_name')} ({r.get('role')})" for r in rows) or "No staff accounts yet."
                system_private(client, f"Staff: {listing}", kind="list")
            elif command == "/modlog":
                entries = admin.recent_actions(actor, 10)
                if not entries:
                    system_private(client, "No moderation actions recorded yet.", kind="list")
                else:
                    listing = "\\n".join(
                        f"{e.get('created_at', '')[:19].replace('T', ' ')} · {e.get('actor_name') or 'system'} "
                        f"{e.get('action')} {e.get('target_name') or ''}".strip()
                        for e in entries
                    )
                    system_private(client, f"Recent moderation:\\n{listing}", kind="list")
            elif command == "/kick":
                name, reason = ROOM.split_target(argument)
                target = ROOM.find_player(name)
                if not target:
                    system_private(client, f"Player “{name}” was not found online.", kind="error")
                    return
                if target.id == client.id:
                    system_private(client, "You cannot kick yourself.", kind="error")
                    return
                if admin.ROLE_RANK.get(getattr(target, "role", "player"), 0) >= admin.ROLE_RANK.get(getattr(client, "role", "player"), 0):
                    system_private(client, f"{target.name} has an equal or higher role than you.", kind="error")
                    return
                admin.log_kick(actor, target.name, str(getattr(target, "user_id", "")), reason)
                kick_client(target, reason or f"Kicked by {client.name}.")
                announce_moderation(f"{target.name} was kicked by {client.name}." + (f" ({reason})" if reason else ""))
            elif command == "/ban":
                name, rest = ROOM.split_target(argument)
                duration, _, reason = rest.partition(" ")
                result = admin.ban_account(actor, name, duration or "forever", reason.strip())
                banned = result["target"]["username"]
                disconnect_banned(result["target"]["user_id"], result.get("reason") or f"Banned by {client.name}.")
                announce_moderation(
                    f"{banned} was banned {result['durationLabel']} by {client.name}."
                    + (f" ({result['reason']})" if result.get("reason") else "")
                )
            elif command == "/unban":
                result = admin.unban_account(actor, argument)
                announce_moderation(f"{result['target']['username']} was unbanned by {client.name}.")
            elif command == "/role":
                name, _, role = argument.rpartition(" ")
                if not name:
                    system_private(client, "Usage: /role [player] [player|moderator|admin]", kind="error")
                    return
                result = admin.set_account_role(actor, name.strip(), role.strip())
                live = ROOM.find_player(result["target"]["username"])
                if live:
                    live.role = result["role"]
                    live.send({"type": "admin:role", "role": live.role, "admin": admin.capabilities(live.role)})
                    ROOM.update_known_user(live)
                    ROOM.broadcast({"type": "chat:users", "users": ROOM.users_snapshot()})
                announce_moderation(f"{result['target']['username']} is now {result['role']} (set by {client.name}).")
        except AdminError as exc:
            system_private(client, exc.message, kind="error")
        except SupabaseError as exc:
            system_private(client, f"Supabase error: {exc}", kind="error")

'''
