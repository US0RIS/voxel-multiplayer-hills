#!/usr/bin/env python3
"""Regression suite for the Ridgewood staff permission model.

Runs entirely offline against a stubbed Supabase, so it is safe in CI and does
not need credentials. It asserts the rules that actually matter: who may act on
whom, that denied attempts change nothing, that bans revoke sessions, and that
every successful action is audited.

    python3 tests/admin-permissions-test.py
"""
import sys, uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import auth_supabase as auth
sys.modules['auth'] = auth
import admin
from supabase_store import STORE

USERS = {}
def mkuser(name, role='player', banned_until=None):
    uid = str(uuid.uuid4())
    USERS[uid] = {"id": uid, "display_name": name, "role": role, "banned_until": banned_until,
                  "ban_reason": None, "discord_id": None, "discord_username": None,
                  "avatar_url": "", "coins": 0, "banned_at": None, "banned_by": None}
    return USERS[uid]

CALLS = []
STORE.find_users_by_name = lambda n, limit=8: [dict(u) for u in USERS.values() if u["display_name"].lower() == n.lower()]
def set_ban(uid, *, banned_until, reason, actor_id):
    USERS[uid].update(banned_until=banned_until, ban_reason=reason, banned_by=actor_id)
    CALLS.append(("set_ban", USERS[uid]["display_name"], banned_until is not None))
    return dict(USERS[uid])
def set_role(uid, role):
    USERS[uid]["role"] = role; CALLS.append(("set_role", USERS[uid]["display_name"], role)); return dict(USERS[uid])
STORE.set_user_ban = set_ban
STORE.set_user_role = set_role
STORE.delete_sessions_for_user = lambda uid: CALLS.append(("revoke_sessions", USERS[uid]["display_name"], True))
STORE.log_admin_action = lambda **kw: CALLS.append(("log", kw.get("action"), kw.get("target_name")))

def actor(row):
    return {"user_id": row["id"], "username": row["display_name"], "role": row["role"]}

admin_row = mkuser("Admin", "admin")
mod_row   = mkuser("Mod", "moderator")
mod2_row  = mkuser("Mod2", "moderator")
player    = mkuser("Griefer")

results = []
def check(label, fn, expect_code=None):
    try:
        out = fn()
        ok = expect_code is None
        results.append((ok, label, "allowed" if ok else f"ALLOWED but expected {expect_code}"))
        return out
    except admin.AdminError as e:
        ok = e.code == expect_code
        results.append((ok, label, f"blocked: {e.code}" + ("" if ok else f" (expected {expect_code})")))

# --- who may act ------------------------------------------------------------
check("player tries to ban",            lambda: admin.ban_account(actor(player), "Griefer", "1h"), "forbidden")
check("moderator bans a player",        lambda: admin.ban_account(actor(mod_row), "Griefer", "24h", "griefing"))
check("moderator bans another mod",     lambda: admin.ban_account(actor(mod_row), "Mod2", "1h"), "outranked")
check("moderator bans the admin",       lambda: admin.ban_account(actor(mod_row), "Admin", "1h"), "outranked")
check("admin bans a moderator",         lambda: admin.ban_account(actor(admin_row), "Mod2", "7d"))
check("admin bans self",                lambda: admin.ban_account(actor(admin_row), "Admin", "1h"), "self_target")
check("ban unknown account",            lambda: admin.ban_account(actor(admin_row), "Nobody", "1h"), "unknown_player")

# --- roles ------------------------------------------------------------------
check("moderator promotes",             lambda: admin.set_account_role(actor(mod_row), "Griefer", "admin"), "forbidden")
check("admin promotes a player",        lambda: admin.set_account_role(actor(admin_row), "Griefer", "moderator"))
check("admin demotes self",             lambda: admin.set_account_role(actor(admin_row), "Admin", "player"), "self_target")
check("admin sets a bogus role",        lambda: admin.set_account_role(actor(admin_row), "Mod", "owner"), "invalid_role")

# --- durations --------------------------------------------------------------
check("bad duration text",              lambda: admin.ban_account(actor(admin_row), "Mod", "banana"), "invalid_duration")
check("unban someone not banned",       lambda: admin.unban_account(actor(admin_row), "Mod"), "not_banned")
check("unban a banned account",         lambda: admin.unban_account(actor(admin_row), "Griefer"))

# --- ban state --------------------------------------------------------------
banned = mkuser("Temp", "player", "2099-01-01T00:00:00Z")
expired = mkuser("Old", "player", "2001-01-01T00:00:00Z")
results.append((auth.ban_state(admin._target_payload(banned)) is not None, "future ban is active", ""))
results.append((auth.ban_state(admin._target_payload(expired)) is None, "expired ban is inactive", ""))
results.append((admin.parse_duration("7d") == 604800, "7d parses to 604800s", ""))
results.append((admin.parse_duration("forever") is None, "forever is permanent", ""))

# --- side effects -----------------------------------------------------------
revoked = [c for c in CALLS if c[0] == "revoke_sessions"]
results.append((len(revoked) == 2, f"bans revoke sessions ({len(revoked)} of 2)", ""))
logged = [c for c in CALLS if c[0] == "log"]
results.append((len(logged) == 4 and sorted(c[1] for c in logged) == ["ban","ban","set_role","unban"], f"only successful actions are audited ({len(logged)}: {sorted(c[1] for c in logged)})", ""))

print()
fails = 0
for ok, label, detail in results:
    print(f"  {'PASS' if ok else 'FAIL'}  {label:<32} {detail}")
    fails += 0 if ok else 1
print(f"\n{len(results) - fails}/{len(results)} passed")
sys.exit(1 if fails else 0)
