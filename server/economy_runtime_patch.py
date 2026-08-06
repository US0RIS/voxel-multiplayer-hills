#!/usr/bin/env python3
"""Asserted runtime patches for Ridgewood coins and marketplace."""
from __future__ import annotations


def _replace(source: str, search: str, replacement: str, label: str) -> str:
    if search not in source:
        raise SystemExit(f"Economy integration failed ({label}).")
    return source.replace(search, replacement, 1)


def patch_economy_runtime(source: str) -> str:
    source = _replace(
        source,
        "import auth\nimport admin\nimport traceback\nfrom admin import AdminError\n",
        "import auth\nimport admin\nimport economy\nimport traceback\nfrom admin import AdminError\n",
        "economy import",
    )

    source = _replace(
        source,
        '''            if auth_response is not None:
                response_headers = dict(auth_response.headers)
                content_type = response_headers.pop("Content-Type", "application/json; charset=utf-8")
                response_body = json_bytes(auth_response.body) if auth_response.body else b""
                self._send_http(auth_response.status, response_body, content_type, response_headers)
                return

            if method != "GET":''',
        '''            if auth_response is not None:
                response_headers = dict(auth_response.headers)
                content_type = response_headers.pop("Content-Type", "application/json; charset=utf-8")
                response_body = json_bytes(auth_response.body) if auth_response.body else b""
                self._send_http(auth_response.status, response_body, content_type, response_headers)
                return

            economy_response = economy.handle_http_request(
                method, target, headers, body, self.client_address[0]
            )
            if economy_response is not None:
                economy.dispatch_events(ROOM, economy_response.events)
                response_headers = dict(economy_response.headers)
                content_type = response_headers.pop("Content-Type", "application/json; charset=utf-8")
                response_body = json_bytes(economy_response.body) if economy_response.body else b""
                self._send_http(
                    economy_response.status, response_body, content_type, response_headers
                )
                return

            if method != "GET":''',
        "HTTP economy routing",
    )

    source = _replace(
        source,
        '''            200: "OK", 204: "No Content", 302: "Found", 400: "Bad Request",
            401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
            405: "Method Not Allowed", 500: "Internal Server Error",
            503: "Service Unavailable",''',
        '''            200: "OK", 201: "Created", 204: "No Content", 302: "Found",
            400: "Bad Request", 401: "Unauthorized", 403: "Forbidden",
            404: "Not Found", 405: "Method Not Allowed", 409: "Conflict",
            500: "Internal Server Error", 503: "Service Unavailable",''',
        "HTTP economy status reasons",
    )

    source = _replace(
        source,
        '''            "auth": auth_user,
            "role": getattr(client, "role", "player"),
            "admin": admin.capabilities(getattr(client, "role", "player")),
            "world": {''',
        '''            "auth": auth_user,
            "role": getattr(client, "role", "player"),
            "admin": admin.capabilities(getattr(client, "role", "player")),
            "economy": economy.bootstrap_for_user(client.user_id) if getattr(client, "user_id", "") else None,
            "world": {''',
        "welcome economy payload",
    )

    source = _replace(
        source,
        '''        elif message_type == "admin:action":
            self._admin_action(client, message)''',
        '''        elif message_type == "admin:action":
            self._admin_action(client, message)
        elif message_type in {
            "coins:balance", "coins:transactions", "marketplace:stalls",
            "marketplace:inventory", "marketplace:claim", "marketplace:unclaim",
            "marketplace:rename", "marketplace:list-item", "marketplace:buy",
            "marketplace:delist",
        }:
            self._economy_action(client, message)''',
        "WebSocket economy routing",
    )

    source = _replace(
        source,
        "    def _rate_limited(self, client: Client, client_id: str) -> bool:",
        ECONOMY_HANDLER + "    def _rate_limited(self, client: Client, client_id: str) -> bool:",
        "economy handler",
    )

    source = _replace(
        source,
        '''        staff = admin.client_is_staff(client)
        if (chunk_x, chunk_z) != (current_x, current_z) and not staff:''',
        '''        staff = admin.client_is_staff(client)
        if chunk_x == 0 and -2 <= chunk_z <= 1:
            client.send({
                "type": "world:claim-result", "ok": False,
                "error": "marketplace_reserved",
                "message": "This chunk is reserved for the public marketplace street."
            })
            return
        if (chunk_x, chunk_z) != (current_x, current_z) and not staff:''',
        "reserved marketplace claim",
    )

    source = _replace(
        source,
        '''        try:
            edit = WORLD.validate_edit(client, message)
            result = WORLD.apply_edit(user_id, edit)''',
        '''        try:
            edit = WORLD.validate_edit(client, message)
            if edit["chunk_x"] == 0 and -2 <= edit["chunk_z"] <= 1 and not (
                admin.client_is_staff(client) and bool(message.get("adminOverride"))
            ):
                raise ValueError("marketplace_reserved")
            result = WORLD.apply_edit(user_id, edit)''',
        "reserved marketplace building",
    )

    source = _replace(
        source,
        '''                    "adminRoles": True, "adminSchema": admin.schema_status(),''',
        '''                    "adminRoles": True, "adminSchema": admin.schema_status(),
                    "coins": economy.configured(), "marketplace": economy.configured(),''',
        "health economy status",
    )

    source = _replace(
        source,
        '''    print(f"Admin bootstrap: {', '.join(admin.ADMIN_BOOTSTRAP_NAMES) if admin.ADMIN_BOOTSTRAP_NAMES else 'none configured'}", flush=True)
    admin.start_bootstrap()''',
        '''    print(f"Admin bootstrap: {', '.join(admin.ADMIN_BOOTSTRAP_NAMES) if admin.ADMIN_BOOTSTRAP_NAMES else 'none configured'}", flush=True)
    print(
        f"Economy: {'configured' if economy.configured() else 'not configured'} "
        f"· starter={economy.STARTER_COINS}",
        flush=True,
    )
    admin.start_bootstrap()''',
        "economy startup status",
    )

    return source.replace('VERSION = "0.5.0-alpha"', 'VERSION = "0.9.1-alpha"', 1)


ECONOMY_HANDLER = '''    def _economy_action(self, client: Client, message: dict[str, Any]) -> None:
        user = dict(getattr(client, "auth_user", None) or {})
        user.setdefault("user_id", getattr(client, "user_id", ""))
        user.setdefault("role", getattr(client, "role", "player"))
        reply, events = economy.handle_websocket_action(user, message)
        client.send(reply)
        economy.dispatch_events(ROOM, events)

'''
