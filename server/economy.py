#!/usr/bin/env python3
"""Ridgewood coin balances and marketplace operations.

All state changes are delegated to atomic PostgreSQL functions in
SUPABASE_MIGRATION_006_COINS_MARKETPLACE.sql. This module only authenticates,
validates HTTP/WebSocket input, shapes public responses, and describes the
real-time events the multiplayer runtime should deliver.
"""
from __future__ import annotations

import json
import os
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Optional

import auth
from supabase_store import STORE, SupabaseError


STARTER_COINS = max(0, min(1_000_000, int(os.getenv("STARTER_COINS", "1000"))))
TRANSACTION_LIMIT = max(1, min(100, int(os.getenv("COIN_TRANSACTION_LIMIT", "30"))))
MARKETPLACE_LISTING_LIMIT = 24
ALLOWED_ITEM_TYPES = {"cosmetic", "house", "resource", "service", "other"}


@dataclass(frozen=True)
class EconomyResponse:
    status: int
    body: dict[str, Any]
    headers: dict[str, str] = field(default_factory=lambda: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    })
    events: tuple[dict[str, Any], ...] = ()


class EconomyError(RuntimeError):
    def __init__(self, code: str, status: int = 400, message: str = ""):
        super().__init__(message or code)
        self.code = code
        self.status = status
        self.message = message or code


def configured() -> bool:
    return STORE.ready


def _json(status: int, body: dict[str, Any], events: list[dict[str, Any]] | None = None) -> EconomyResponse:
    return EconomyResponse(status, body, events=tuple(events or ()))


def _parse_json(body: bytes) -> dict[str, Any]:
    if not body:
        return {}
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise EconomyError("invalid_json", 400, "Request body must be valid JSON.") from exc
    if not isinstance(value, dict):
        raise EconomyError("invalid_json", 400, "Request body must be a JSON object.")
    return value


def _integer(value: Any, *, minimum: int, maximum: int, code: str) -> int:
    if isinstance(value, bool):
        raise EconomyError(code)
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise EconomyError(code) from exc
    if number < minimum or number > maximum:
        raise EconomyError(code)
    return number


def _text(value: Any, *, minimum: int, maximum: int, code: str) -> str:
    text = " ".join(str(value or "").split())
    if len(text) < minimum or len(text) > maximum:
        raise EconomyError(code)
    return text


def _authenticated_user(headers: dict[str, str], query: str) -> dict[str, Any]:
    token = auth.extract_session_token(headers, query)
    user = auth.authenticate_session(token)
    if not user:
        raise EconomyError("unauthorized", 401, "Authentication required.")
    ban = auth.ban_state(user)
    if ban:
        raise EconomyError("account_banned", 403, "This account is banned.")
    return user


def _is_admin(user: dict[str, Any]) -> bool:
    return str(user.get("role") or "player").lower() == "admin"


def _rpc(name: str, body: dict[str, Any]) -> dict[str, Any]:
    result = STORE._request("POST", f"rpc/{name}", body=body)
    if not isinstance(result, dict):
        raise SupabaseError(f"{name} returned an invalid response", payload=result)
    return result


def _raise_result(result: dict[str, Any], *, default_status: int = 400) -> None:
    if result.get("ok"):
        return
    code = str(result.get("error") or "operation_failed")
    status = {
        "forbidden": 403,
        "unauthorized": 401,
        "unknown_user": 404,
        "unknown_buyer": 404,
        "unknown_seller": 404,
        "unknown_stall": 404,
        "unknown_listing": 404,
        "insufficient_coins": 409,
        "stall_claimed": 409,
        "already_has_stall": 409,
        "listing_unavailable": 409,
        "cannot_buy_own_listing": 409,
        "listing_limit": 409,
        "no_stall": 404,
    }.get(code, default_status)
    raise EconomyError(code, status, str(result.get("message") or code))


def ensure_starter_coins(user_id: str) -> dict[str, Any]:
    result = _rpc("grant_starter_coins", {
        "p_user_id": user_id,
        "p_amount": STARTER_COINS,
    })
    _raise_result(result)
    return result


def balance(user_id: str, *, grant_starter: bool = True) -> dict[str, Any]:
    if grant_starter:
        starter = ensure_starter_coins(user_id)
        coins = int(starter.get("coins") or 0)
    else:
        row = STORE.get_user(user_id)
        if not row:
            raise EconomyError("unknown_user", 404)
        coins = int(row.get("coins") or 0)
    return {"coins": coins, "user_id": user_id}


def transactions(user_id: str, limit: int = TRANSACTION_LIMIT) -> dict[str, Any]:
    rows = STORE._request("GET", "coin_transactions", query={
        "select": "id,user_id,amount,balance_after,type,reason,metadata,created_at",
        "user_id": f"eq.{user_id}",
        "order": "created_at.desc",
        "limit": str(max(1, min(100, int(limit)))),
    })
    output = [dict(row) for row in rows] if isinstance(rows, list) else []
    return {"transactions": output, "count": len(output)}


def inventory(user_id: str, limit: int = 100) -> dict[str, Any]:
    rows = STORE._request("GET", "player_inventory", query={
        "select": "id,item_type,item_name,quantity,source_listing_id,seller_id,metadata,acquired_at",
        "user_id": f"eq.{user_id}",
        "order": "acquired_at.desc",
        "limit": str(max(1, min(200, int(limit)))),
    })
    output = [dict(row) for row in rows] if isinstance(rows, list) else []
    return {"inventory": output, "count": len(output)}


def stalls_snapshot() -> dict[str, Any]:
    stalls = STORE._request("GET", "marketplace_stalls", query={
        "select": "id,owner_id,stall_number,world_id,chunk_x,chunk_z,stall_x,stall_y,stall_z,name,claimed_at,claimed,updated_at",
        "order": "stall_number.asc",
        "limit": "20",
    })
    listings = STORE._request("GET", "marketplace_listings", query={
        "select": "id,stall_id,seller_id,item_type,item_name,price,quantity,metadata,created_at,updated_at",
        "order": "created_at.asc",
        "limit": "480",
    })
    stall_rows = [dict(row) for row in stalls] if isinstance(stalls, list) else []
    listing_rows = [dict(row) for row in listings] if isinstance(listings, list) else []

    user_ids = {
        str(row.get("owner_id")) for row in stall_rows if row.get("owner_id")
    } | {
        str(row.get("seller_id")) for row in listing_rows if row.get("seller_id")
    }
    users: dict[str, dict[str, Any]] = {}
    if user_ids:
        rows = STORE.select_users({
            "id": "in.(" + ",".join(sorted(user_ids)) + ")",
            "limit": str(len(user_ids)),
        })
        if isinstance(rows, list):
            users = {str(row["id"]): dict(row) for row in rows}

    by_stall: dict[int, list[dict[str, Any]]] = {}
    for listing in listing_rows:
        seller = users.get(str(listing.get("seller_id")), {})
        listing["seller"] = {
            "id": listing.get("seller_id"),
            "name": seller.get("display_name") or seller.get("discord_username") or "Player",
        }
        by_stall.setdefault(int(listing["stall_id"]), []).append(listing)

    public_stalls: list[dict[str, Any]] = []
    for stall in stall_rows:
        owner = users.get(str(stall.get("owner_id")), {}) if stall.get("owner_id") else {}
        public_stalls.append({
            "id": stall["id"],
            "stall_number": stall["stall_number"],
            "owner_id": stall.get("owner_id"),
            "owner": {
                "id": stall.get("owner_id"),
                "name": owner.get("display_name") or owner.get("discord_username") or None,
            } if stall.get("owner_id") else None,
            "name": stall["name"],
            "claimed": bool(stall.get("claimed")),
            "claimed_at": stall.get("claimed_at"),
            "location": {
                "world_id": stall.get("world_id") or "public",
                "chunk_x": int(stall.get("chunk_x") or 0),
                "chunk_z": int(stall.get("chunk_z") or 0),
                "x": float(stall.get("stall_x") or 0),
                "y": float(stall.get("stall_y") or 0),
                "z": float(stall.get("stall_z") or 0),
            },
            "listings": by_stall.get(int(stall["id"]), []),
            "updated_at": stall.get("updated_at"),
        })
    return {"stalls": public_stalls, "count": len(public_stalls)}


def bootstrap_for_user(user_id: str) -> dict[str, Any]:
    result = balance(user_id, grant_starter=True)
    return {
        "coins": result["coins"],
        "starterCoins": STARTER_COINS,
        "marketplace": {"chunkX": 0, "chunkZ": 0, "stallCount": 20},
    }


def _coin_event(user_id: str, coins: int, reason: str, **extra: Any) -> dict[str, Any]:
    return {"kind": "coin", "userId": user_id, "coins": int(coins), "reason": reason, **extra}


def _market_event(reason: str, **extra: Any) -> dict[str, Any]:
    return {"kind": "marketplace", "reason": reason, **extra}


def _notify_event(user_id: str, event_type: str, **payload: Any) -> dict[str, Any]:
    return {"kind": "notify", "userId": user_id, "eventType": event_type, **payload}


def add_coins(actor: dict[str, Any], payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not _is_admin(actor):
        raise EconomyError("forbidden", 403)
    amount = _integer(payload.get("amount"), minimum=1, maximum=1_000_000_000, code="invalid_amount")
    target_id = str(payload.get("user_id") or actor.get("user_id") or "")
    if not target_id:
        raise EconomyError("unknown_user", 404)
    reason = _text(payload.get("reason") or "admin_grant", minimum=1, maximum=96, code="invalid_reason")
    result = _rpc("admin_add_coins", {
        "p_actor_id": str(actor["user_id"]),
        "p_target_user_id": target_id,
        "p_amount": amount,
        "p_reason": reason,
    })
    _raise_result(result)
    body = {
        "coins": int(result["coins"]),
        "user_id": target_id,
        "transaction_id": result.get("transactionId"),
    }
    return body, [_coin_event(target_id, body["coins"], reason)]


def spend(user_id: str, payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    amount = _integer(payload.get("amount"), minimum=1, maximum=1_000_000_000, code="invalid_amount")
    reason = _text(payload.get("reason"), minimum=1, maximum=96, code="invalid_reason")
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    result = _rpc("spend_coins", {
        "p_user_id": user_id,
        "p_amount": amount,
        "p_reason": reason,
        "p_metadata": metadata,
    })
    _raise_result(result)
    body = {
        "coins": int(result["coins"]),
        "success": True,
        "transaction_id": result.get("transactionId"),
    }
    return body, [_coin_event(user_id, body["coins"], reason)]


def claim_stall(user_id: str, payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    stall_number = _integer(payload.get("stall_number"), minimum=1, maximum=20, code="invalid_stall")
    name = payload.get("name")
    if name is not None:
        name = _text(name, minimum=1, maximum=48, code="invalid_name")
    result = _rpc("claim_marketplace_stall", {
        "p_user_id": user_id,
        "p_stall_number": stall_number,
        "p_name": name,
    })
    _raise_result(result)
    stall = dict(result["stall"])
    body = {
        "stall_id": stall["id"],
        "stall": stall,
        "location": {
            "chunk_x": stall["chunk_x"], "chunk_z": stall["chunk_z"],
            "x": stall["stall_x"], "y": stall["stall_y"], "z": stall["stall_z"],
        },
        "success": True,
    }
    return body, [_market_event("stall_claimed", stallId=stall["id"], userId=user_id)]


def unclaim_stall(user_id: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    result = _rpc("unclaim_marketplace_stall", {"p_user_id": user_id})
    _raise_result(result)
    stall = dict(result["stall"])
    return {"success": True, "stall": stall}, [
        _market_event("stall_unclaimed", stallId=stall["id"], userId=user_id)
    ]


def rename_stall(user_id: str, payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    name = _text(payload.get("name"), minimum=1, maximum=48, code="invalid_name")
    result = _rpc("rename_marketplace_stall", {"p_user_id": user_id, "p_name": name})
    _raise_result(result)
    stall = dict(result["stall"])
    return {"success": True, "stall": stall}, [
        _market_event("stall_renamed", stallId=stall["id"], userId=user_id)
    ]


def list_item(user_id: str, payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    stall_id = _integer(payload.get("stall_id"), minimum=1, maximum=9_223_372_036_854_775_807, code="invalid_stall")
    item_type = _text(payload.get("item_type"), minimum=1, maximum=32, code="invalid_item_type").lower()
    if item_type not in ALLOWED_ITEM_TYPES:
        raise EconomyError("invalid_item_type")
    item_name = _text(payload.get("item_name"), minimum=1, maximum=80, code="invalid_item_name")
    price = _integer(payload.get("price"), minimum=1, maximum=1_000_000_000, code="invalid_price")
    quantity = _integer(payload.get("quantity", 1), minimum=1, maximum=999, code="invalid_quantity")
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    result = _rpc("list_marketplace_item", {
        "p_user_id": user_id,
        "p_stall_id": stall_id,
        "p_item_type": item_type,
        "p_item_name": item_name,
        "p_price": price,
        "p_quantity": quantity,
        "p_metadata": metadata,
    })
    _raise_result(result)
    listing = dict(result["listing"])
    return {"listing_id": listing["id"], "listing": listing, "success": True}, [
        _market_event("listing_created", stallId=stall_id, listingId=listing["id"], userId=user_id)
    ]


def delist(user_id: str, payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    listing_id = _integer(payload.get("listing_id"), minimum=1, maximum=9_223_372_036_854_775_807, code="invalid_listing")
    result = _rpc("delist_marketplace_item", {"p_user_id": user_id, "p_listing_id": listing_id})
    _raise_result(result)
    return {"success": True, "listing_id": listing_id}, [
        _market_event("listing_removed", listingId=listing_id, userId=user_id)
    ]


def buy(user_id: str, payload: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    listing_id = _integer(payload.get("listing_id"), minimum=1, maximum=9_223_372_036_854_775_807, code="invalid_listing")
    result = _rpc("buy_marketplace_listing", {
        "p_buyer_id": user_id,
        "p_listing_id": listing_id,
    })
    _raise_result(result)
    seller_id = str(result["sellerId"])
    coins_remaining = int(result["coinsRemaining"])
    seller_coins = int(result["sellerCoins"])
    item = dict(result.get("item") or {})
    body = {
        "success": True,
        "coins_remaining": coins_remaining,
        "inventory_id": result.get("inventoryId"),
        "item": item,
        "stall_id": result.get("stallId"),
        "stall_name": result.get("stallName"),
        "listing_id": listing_id,
    }
    events = [
        _coin_event(user_id, coins_remaining, "marketplace_purchase"),
        _coin_event(seller_id, seller_coins, "marketplace_sale"),
        _market_event("listing_purchased", listingId=listing_id, buyerId=user_id, sellerId=seller_id),
        _notify_event(user_id, "marketplace:purchased", item=item, stallName=result.get("stallName")),
        _notify_event(seller_id, "marketplace:sold", item=item, buyerId=user_id),
    ]
    return body, events


def handle_http_request(
    method: str,
    path: str,
    headers: dict[str, str],
    body: bytes,
    client_ip: str,
) -> Optional[EconomyResponse]:
    del client_ip
    parsed = urllib.parse.urlsplit(path)
    clean = parsed.path
    query = headers.get("query_string", parsed.query)
    routes = {
        "/coins/balance", "/coins/add", "/coins/spend", "/coins/transactions",
        "/marketplace/stalls", "/marketplace/claim", "/marketplace/unclaim",
        "/marketplace/list-item", "/marketplace/buy", "/marketplace/delist",
        "/marketplace/rename", "/marketplace/inventory",
    }
    if clean not in routes:
        return None
    if not configured():
        return _json(503, {"error": "economy_not_configured"})

    try:
        if clean == "/marketplace/stalls" and method == "GET":
            return _json(200, stalls_snapshot())

        user = _authenticated_user(headers, query)
        user_id = str(user["user_id"])
        payload = _parse_json(body) if method == "POST" else {}

        if clean == "/coins/balance" and method == "GET":
            return _json(200, balance(user_id))
        if clean == "/coins/add" and method == "POST":
            result, events = add_coins(user, payload)
            return _json(200, result, events)
        if clean == "/coins/spend" and method == "POST":
            result, events = spend(user_id, payload)
            return _json(200, result, events)
        if clean == "/coins/transactions" and method == "GET":
            params = urllib.parse.parse_qs(query)
            limit = _integer((params.get("limit") or [TRANSACTION_LIMIT])[0], minimum=1, maximum=100, code="invalid_limit")
            return _json(200, transactions(user_id, limit))
        if clean == "/marketplace/inventory" and method == "GET":
            return _json(200, inventory(user_id))
        if clean == "/marketplace/claim" and method == "POST":
            result, events = claim_stall(user_id, payload)
            return _json(200, result, events)
        if clean == "/marketplace/unclaim" and method == "POST":
            result, events = unclaim_stall(user_id)
            return _json(200, result, events)
        if clean == "/marketplace/rename" and method == "POST":
            result, events = rename_stall(user_id, payload)
            return _json(200, result, events)
        if clean == "/marketplace/list-item" and method == "POST":
            result, events = list_item(user_id, payload)
            return _json(201, result, events)
        if clean == "/marketplace/buy" and method == "POST":
            result, events = buy(user_id, payload)
            return _json(200, result, events)
        if clean == "/marketplace/delist" and method == "POST":
            result, events = delist(user_id, payload)
            return _json(200, result, events)
        return _json(405, {"error": "method_not_allowed"})
    except EconomyError as exc:
        return _json(exc.status, {"error": exc.code, "message": exc.message})
    except SupabaseError as exc:
        print(f"Economy request failed: {exc}", flush=True)
        return _json(503, {"error": "economy_unavailable"})


def handle_websocket_action(user: dict[str, Any], message: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    action = str(message.get("type") or "")
    request_id = str(message.get("requestId") or "")[:64]
    user_id = str(user.get("user_id") or "")
    if not user_id:
        return {"type": "economy:result", "requestId": request_id, "ok": False, "error": "unauthorized"}, []

    try:
        if action == "coins:balance":
            payload = {"type": "coins:balance", **balance(user_id)}
            return payload, []
        if action == "coins:transactions":
            payload = {"type": "coins:transactions", **transactions(user_id, int(message.get("limit") or TRANSACTION_LIMIT))}
            return payload, []
        if action == "marketplace:stalls":
            return {"type": "marketplace:stalls", **stalls_snapshot()}, []
        if action == "marketplace:inventory":
            return {"type": "marketplace:inventory", **inventory(user_id)}, []
        if action == "marketplace:claim":
            body, events = claim_stall(user_id, message)
        elif action == "marketplace:unclaim":
            body, events = unclaim_stall(user_id)
        elif action == "marketplace:rename":
            body, events = rename_stall(user_id, message)
        elif action == "marketplace:list-item":
            body, events = list_item(user_id, message)
        elif action == "marketplace:buy":
            body, events = buy(user_id, message)
        elif action == "marketplace:delist":
            body, events = delist(user_id, message)
        else:
            return {"type": "economy:result", "requestId": request_id, "ok": False, "error": "unknown_action"}, []
        return {"type": "economy:result", "requestId": request_id, "action": action, "ok": True, **body}, events
    except EconomyError as exc:
        return {
            "type": "economy:result", "requestId": request_id, "action": action,
            "ok": False, "error": exc.code, "message": exc.message,
        }, []
    except SupabaseError as exc:
        print(f"Economy WebSocket action failed: {exc}", flush=True)
        return {
            "type": "economy:result", "requestId": request_id, "action": action,
            "ok": False, "error": "economy_unavailable",
        }, []


def dispatch_events(room: Any, events: list[dict[str, Any]] | tuple[dict[str, Any], ...]) -> None:
    if not events:
        return
    clients = list(room.clients.values())
    for event in events:
        kind = event.get("kind")
        if kind == "marketplace":
            room.broadcast({
                "type": "marketplace:updated",
                "reason": event.get("reason"),
                **{k: v for k, v in event.items() if k not in {"kind", "reason"}},
            })
            continue
        target_id = str(event.get("userId") or "")
        for client in clients:
            if str(getattr(client, "user_id", "")) != target_id:
                continue
            try:
                if kind == "coin":
                    client.send({
                        "type": "coins:balance",
                        "coins": int(event["coins"]),
                        "user_id": target_id,
                        "reason": event.get("reason"),
                    })
                elif kind == "notify":
                    client.send({
                        "type": event.get("eventType") or "marketplace:notification",
                        **{k: v for k, v in event.items() if k not in {"kind", "eventType", "userId"}},
                    })
            except OSError:
                pass
