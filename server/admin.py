#!/usr/bin/env python3
"""Ridgewood staff roles and moderation, v0.8.0.

Every permission decision in the game is made here, on the server, from the
role stored in Supabase. The client's admin panel only sends intent — it never
carries authority — so a modified client gains nothing.

Role ranks
    player     0   ordinary account
    moderator  1   can kick and ban players
    admin      2   can also promote, demote, and reassign chunk claims

An actor may only act on a target of strictly lower rank, which means a
moderator cannot ban another moderator and nobody can ban an admin.
"""
from __future__ import annotations

import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import auth_supabase as auth
from supabase_store import STORE, SupabaseError

ROLE_PLAYER = "player"
ROLE_MODERATOR = "moderator"
ROLE_ADMIN = "admin"
ROLE_RANK = {ROLE_PLAYER: 0, ROLE_MODERATOR: 1, ROLE_ADMIN: 2}
STAFF_ROLES = (ROLE_MODERATOR, ROLE_ADMIN)

# A "permanent" ban is stored as a real timestamp a century out. Postgres keeps
# comparisons simple and the ban can still be lifted with /unban.
PERMANENT_BAN_YEARS = 100
MAX_BAN_SECONDS = PERMANENT_BAN_YEARS * 365 * 86400

# Staff build reach, in blocks. Ordinary players are limited to 8.
ADMIN_BUILD_DISTANCE = max(
    8.0, min(128.0, float(os.getenv("ADMIN_BUILD_DISTANCE", "48")))
)
# Movement ceiling for a flying staff member. Kept below the 224-block limit
# that player_positions accepts so a flight is always persistable.
ADMIN_MAX_FLY_HEIGHT = max(
    32.0, min(200.0, float(os.getenv("ADMIN_MAX_FLY_HEIGHT", "180")))
)
ADMIN_MAX_SPEED_MULTIPLIER = max(
    1.0, min(20.0, float(os.getenv("ADMIN_MAX_SPEED_MULTIPLIER", "6")))
)

DURATION_RE = re.compile(r"^(\d+)\s*([smhdw])$", re.IGNORECASE)
DURATION_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400, "w": 604800}
PERMANENT_WORDS = {"forever", "permanent", "perm", "never", "infinite", "inf"}


class AdminError(RuntimeError):
    """A moderation action the actor is not allowed to take, or cannot resolve."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ------------------------------------------------------------------- roles


def role_of(user: Optional[dict[str, Any]]) -> str:
    if not user:
        return ROLE_PLAYER
    return auth.normalize_role(user.get("role"))


def rank_of(user: Optional[dict[str, Any]]) -> int:
    return ROLE_RANK.get(role_of(user), 0)


def is_staff(user: Optional[dict[str, Any]]) -> bool:
    return role_of(user) in STAFF_ROLES


def is_admin(user: Optional[dict[str, Any]]) -> bool:
    return role_of(user) == ROLE_ADMIN


def client_role(client: Any) -> str:
    return auth.normalize_role(getattr(client, "role", ROLE_PLAYER))


def client_is_staff(client: Any) -> bool:
    return client_role(client) in STAFF_ROLES


def client_is_admin(client: Any) -> bool:
    return client_role(client) == ROLE_ADMIN


def require_staff(actor: Optional[dict[str, Any]]) -> None:
    if not is_staff(actor):
        raise AdminError("forbidden", "You do not have permission to do that.")


def capabilities(role: str) -> dict[str, Any]:
    """The client renders its panel from this, so both sides agree on limits."""
    staff = role in STAFF_ROLES
    return {
        "role": role,
        "staff": staff,
        "canKick": staff,
        "canBan": staff,
        "canSetRole": role == ROLE_ADMIN,
        "canBuildAnywhere": staff,
        "canFly": staff,
        "buildDistance": ADMIN_BUILD_DISTANCE if staff else 8.0,
        "maxSpeedMultiplier": ADMIN_MAX_SPEED_MULTIPLIER if staff else 1.0,
        "maxFlyHeight": ADMIN_MAX_FLY_HEIGHT if staff else 0.0,
    }


# --------------------------------------------------------------- durations


def parse_duration(text: Any) -> Optional[int]:
    """Parse '30m', '24h', '7d', '2w' or 'forever'.

    Returns seconds, or None for a permanent ban. Raises AdminError when the
    text cannot be understood, so a typo never silently becomes a permaban.
    """
    raw = str(text or "").strip().lower()
    if not raw:
        raise AdminError("invalid_duration", "Specify a duration, for example 24h, 7d, or forever.")
    if raw in PERMANENT_WORDS:
        return None
    match = DURATION_RE.match(raw)
    if not match:
        raise AdminError(
            "invalid_duration",
            "Durations look like 30m, 12h, 7d, 2w, or forever.",
        )
    amount = int(match.group(1))
    seconds = amount * DURATION_UNITS[match.group(2).lower()]
    if seconds <= 0:
        raise AdminError("invalid_duration", "The duration must be longer than zero.")
    return min(seconds, MAX_BAN_SECONDS)


def _iso_after(seconds: Optional[int]) -> str:
    delta = timedelta(days=PERMANENT_BAN_YEARS * 365) if seconds is None else timedelta(seconds=seconds)
    return (datetime.now(timezone.utc) + delta).isoformat().replace("+00:00", "Z")


def describe_duration(seconds: Optional[int]) -> str:
    if seconds is None:
        return "permanently"
    for unit, label, size in (
        ("w", "week", 604800),
        ("d", "day", 86400),
        ("h", "hour", 3600),
        ("m", "minute", 60),
    ):
        if seconds >= size and seconds % size == 0:
            count = seconds // size
            return f"for {count} {label}{'s' if count != 1 else ''}"
    return f"for {seconds} seconds"


# ----------------------------------------------------------------- targets


def resolve_target(query: str) -> dict[str, Any]:
    """Find one account by display name or password username."""
    needle = str(query or "").strip()
    if not needle:
        raise AdminError("no_target", "Name the player you want to act on.")
    try:
        # Login username wins: it is unique and cannot be changed with /nick,
        # so it can never resolve to the wrong account.
        exact_login = STORE.find_user_by_password_username(needle)
        if exact_login:
            return dict(exact_login)
        matches = STORE.find_users_by_name(needle)
    except SupabaseError as exc:
        raise AdminError("lookup_failed", f"Account lookup failed: {exc}") from exc
    if not matches:
        raise AdminError("unknown_player", f"No account named “{needle}” exists.")
    exact = [row for row in matches if str(row.get("display_name") or "").lower() == needle.lower()]
    if len(matches) > 1 and len(exact) != 1:
        names = ", ".join(str(row.get("display_name")) for row in matches[:5])
        raise AdminError("ambiguous_player", f"“{needle}” matches several accounts: {names}.")
    return dict(exact[0] if exact else matches[0])


def _target_payload(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "user_id": str(row.get("id") or ""),
        "username": str(row.get("display_name") or "Player"),
        "role": auth.normalize_role(row.get("role")),
        "banned_until": row.get("banned_until"),
        "ban_reason": row.get("ban_reason"),
    }


def _assert_outranks(actor: dict[str, Any], target_row: dict[str, Any]) -> None:
    if str(actor.get("user_id") or "") == str(target_row.get("id") or ""):
        raise AdminError("self_target", "You cannot use that on your own account.")
    if rank_of(actor) <= ROLE_RANK.get(auth.normalize_role(target_row.get("role")), 0):
        raise AdminError(
            "outranked",
            f"{target_row.get('display_name')} has an equal or higher role than you.",
        )


def _log(actor: dict[str, Any], action: str, target: dict[str, Any] | None, detail: dict[str, Any]) -> None:
    try:
        STORE.log_admin_action(
            actor_id=str(actor.get("user_id") or "") or None,
            actor_name=str(actor.get("username") or "") or None,
            action=action,
            target_id=str((target or {}).get("id") or "") or None,
            target_name=str((target or {}).get("display_name") or "") or None,
            detail=detail,
        )
    except SupabaseError as exc:
        # An audit write failing must never block the moderation action itself.
        print(f"Admin audit log failed ({action}): {exc}", flush=True)


# ---------------------------------------------------------------- actions


def ban_account(
    actor: dict[str, Any],
    query: str,
    duration_text: str,
    reason: str = "",
) -> dict[str, Any]:
    require_staff(actor)
    seconds = parse_duration(duration_text)
    target_row = resolve_target(query)
    _assert_outranks(actor, target_row)

    until = _iso_after(seconds)
    clean_reason = str(reason or "").strip()[:200]
    try:
        updated = STORE.set_user_ban(
            str(target_row["id"]),
            banned_until=until,
            reason=clean_reason,
            actor_id=str(actor.get("user_id") or "") or None,
        )
        STORE.delete_sessions_for_user(str(target_row["id"]))
    except SupabaseError as exc:
        raise AdminError("ban_failed", f"The ban could not be saved: {exc}") from exc

    auth.invalidate_user(str(target_row["id"]))
    _log(actor, "ban", target_row, {
        "durationSeconds": seconds,
        "permanent": seconds is None,
        "until": until,
        "reason": clean_reason,
    })
    return {
        "target": _target_payload(updated),
        "until": until,
        "permanent": seconds is None,
        "reason": clean_reason,
        "durationLabel": describe_duration(seconds),
    }


def unban_account(actor: dict[str, Any], query: str) -> dict[str, Any]:
    require_staff(actor)
    target_row = resolve_target(query)
    if not auth.ban_state(_target_payload(target_row)):
        raise AdminError("not_banned", f"{target_row.get('display_name')} is not banned.")
    try:
        updated = STORE.set_user_ban(
            str(target_row["id"]), banned_until=None, reason=None, actor_id=None
        )
    except SupabaseError as exc:
        raise AdminError("unban_failed", f"The ban could not be lifted: {exc}") from exc
    auth.invalidate_user(str(target_row["id"]))
    _log(actor, "unban", target_row, {})
    return {"target": _target_payload(updated)}


def set_account_role(actor: dict[str, Any], query: str, role: str) -> dict[str, Any]:
    if not is_admin(actor):
        raise AdminError("forbidden", "Only an admin can change roles.")
    next_role = auth.normalize_role(role)
    if str(role or "").strip().lower() not in ROLE_RANK:
        raise AdminError("invalid_role", "Roles are player, moderator, or admin.")
    target_row = resolve_target(query)
    if str(actor.get("user_id") or "") == str(target_row.get("id") or ""):
        raise AdminError("self_target", "You cannot change your own role.")
    if auth.normalize_role(target_row.get("role")) == next_role:
        raise AdminError(
            "no_change", f"{target_row.get('display_name')} is already {next_role}."
        )
    try:
        updated = STORE.set_user_role(str(target_row["id"]), next_role)
    except (SupabaseError, ValueError) as exc:
        raise AdminError("role_failed", f"The role could not be saved: {exc}") from exc
    auth.invalidate_user(str(target_row["id"]))
    _log(actor, "set_role", target_row, {
        "from": auth.normalize_role(target_row.get("role")),
        "to": next_role,
    })
    return {"target": _target_payload(updated), "role": next_role}


def set_chunk_owner(
    actor: dict[str, Any],
    chunk_x: int,
    chunk_z: int,
    owner_query: str | None,
    world_id: str,
) -> dict[str, Any]:
    if not is_admin(actor):
        raise AdminError("forbidden", "Only an admin can reassign chunk claims.")
    owner_row = resolve_target(owner_query) if owner_query else None
    try:
        result = STORE.set_chunk_owner(
            actor_id=str(actor.get("user_id") or ""),
            chunk_x=int(chunk_x),
            chunk_z=int(chunk_z),
            owner_id=str(owner_row["id"]) if owner_row else None,
            world_id=world_id,
        )
    except SupabaseError as exc:
        raise AdminError("chunk_failed", f"The chunk could not be updated: {exc}") from exc
    if not result.get("ok"):
        raise AdminError(str(result.get("error") or "chunk_failed"), "The chunk could not be updated.")
    return {
        "chunk": result.get("chunk"),
        "owner": _target_payload(owner_row) if owner_row else None,
    }


def recent_actions(actor: dict[str, Any], limit: int = 20) -> list[dict[str, Any]]:
    require_staff(actor)
    try:
        return STORE.recent_admin_actions(limit)
    except SupabaseError as exc:
        raise AdminError("log_failed", f"The audit log could not be read: {exc}") from exc


def log_kick(actor: dict[str, Any], target_name: str, target_user_id: str, reason: str) -> None:
    _log(
        actor,
        "kick",
        {"id": target_user_id, "display_name": target_name},
        {"reason": str(reason or "").strip()[:200]},
    )


# --------------------------------------------------------------- bootstrap


def bootstrap_admins() -> None:
    """Promote the accounts named in ADMIN_USERNAMES on startup.

    This is what makes the very first admin exist. It is idempotent, and it
    never demotes anyone — removing a name from the variable does not strip
    that account's role, so the audit trail stays truthful.
    """
    if not ADMIN_BOOTSTRAP_NAMES or not STORE.ready:
        return
    for username in ADMIN_BOOTSTRAP_NAMES:
        try:
            # ADMIN_USERNAMES names LOGIN usernames. Resolve those first so a
            # stranger cannot inherit admin merely by setting their display
            # name to "Admin". Discord accounts have no login username, so
            # fall back to display name only when no credential matches.
            match = STORE.find_user_by_password_username(username)
            matches = [match] if match else STORE.find_users_by_name(username)
        except SupabaseError as exc:
            print(f"Admin bootstrap lookup failed for {username}: {exc}", flush=True)
            continue
        if not matches:
            print(
                f"Admin bootstrap: no account with the username “{username}” yet — "
                "register it, then restart the service.",
                flush=True,
            )
            continue
        for row in matches:
            if auth.normalize_role(row.get("role")) == ROLE_ADMIN:
                print(
                    f"Admin bootstrap: “{username}” is already admin "
                    f"(account {row.get('id')}, display name “{row.get('display_name')}”).",
                    flush=True,
                )
                continue
            try:
                STORE.set_user_role(str(row["id"]), ROLE_ADMIN)
                STORE.log_admin_action(
                    actor_id=None,
                    actor_name="ADMIN_USERNAMES",
                    action="set_role",
                    target_id=str(row["id"]),
                    target_name=str(row.get("display_name") or username),
                    detail={"from": auth.normalize_role(row.get("role")), "to": ROLE_ADMIN, "source": "bootstrap"},
                )
                auth.invalidate_user(str(row["id"]))
                print(
                    f"Admin bootstrap: promoted “{username}” to admin "
                    f"(account {row.get('id')}, display name “{row.get('display_name')}”).",
                    flush=True,
                )
            except (SupabaseError, ValueError) as exc:
                print(f"Admin bootstrap failed for {username}: {exc}", flush=True)


ADMIN_BOOTSTRAP_NAMES = tuple(getattr(auth, "ADMIN_USERNAMES", ()))


def schema_status() -> str:
    from supabase_store import schema_status as _status
    return _status()


def probe_schema() -> None:
    """Touch game_users once so the migration state is known before first login.

    Without this, /health reports "ready" until somebody's session lookup
    happens to discover the columns are missing.
    """
    if not STORE.ready:
        return
    try:
        STORE.select_users({"limit": "1"})
    except SupabaseError as exc:
        print(f"Schema probe failed: {exc}", flush=True)


def start_bootstrap() -> None:
    """Run startup work off the request path so a slow Supabase never blocks boot."""

    def run() -> None:
        time.sleep(1.0)
        try:
            probe_schema()
            if schema_status() != "ready":
                print(
                    "Staff roles are INACTIVE: run "
                    "SUPABASE_MIGRATION_005_ADMIN_ROLES.sql, then redeploy.",
                    flush=True,
                )
            elif ADMIN_BOOTSTRAP_NAMES:
                bootstrap_admins()
        except Exception as exc:  # pragma: no cover - defensive
            print(f"Admin startup crashed: {type(exc).__name__}: {exc}", flush=True)

    threading.Thread(target=run, name="ridgewood-admin-bootstrap", daemon=True).start()
