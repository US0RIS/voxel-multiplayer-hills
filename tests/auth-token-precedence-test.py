#!/usr/bin/env python3
"""A stale cookie must never mask a valid ?token= on the WebSocket.

Discord login sets a `voxel_session` cookie on the server domain; password
login does not -- it returns the token in JSON and the browser appends it as
?token=. extract_session_token() checked the cookie BEFORE the query string, so
a leftover Discord cookie shadowed a perfectly valid password token. Those
players silently connected as anonymous guests named "Player 1" with no role,
while Discord players -- whose session IS the cookie -- worked fine. It looked
exactly like "the admin panel is broken".

The fix collects every supplied token, query string first, and authenticates
with whichever one actually resolves.

    python3 tests/auth-token-precedence-test.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import auth_supabase as auth

VALID = "valid-password-token"
STALE = "stale-discord-cookie"
auth.authenticate_session = lambda t: {"user_id": "u1", "username": "Admin", "role": "admin"} if t == VALID else None

results = []
def check(ok, label, detail=""):
    results.append((ok, label, detail))

# The exact production shape: a leftover Discord cookie plus a fresh query token.
headers = {"cookie": f"{auth.COOKIE_NAME}={STALE}; other=1"}
query = f"token={VALID}"

order = auth.session_token_candidates(headers, query)
check(order and order[0] == VALID, "query token is tried before the cookie", str(order))

user = auth.websocket_user(headers, query)
check(user is not None, "connection authenticates despite the stale cookie",
      f"resolved as {user.get('username') if user else None} / {user.get('role') if user else None}")

# Cookie-only (Discord) must still work.
check(auth.websocket_user({"cookie": f"{auth.COOKIE_NAME}={VALID}"}, "") is not None,
      "cookie-only sessions still authenticate")

# Bearer header still works.
check(auth.websocket_user({"authorization": f"Bearer {VALID}"}, "") is not None,
      "bearer header still authenticates")

# Nothing valid anywhere -> genuine guest.
check(auth.websocket_user({"cookie": f"{auth.COOKIE_NAME}={STALE}"}, "token=also-bad") is None,
      "no valid token still means guest")

# No duplicate work when the same token arrives twice.
dupes = auth.session_token_candidates({"cookie": f"{auth.COOKIE_NAME}={VALID}"}, f"token={VALID}")
check(len(dupes) == 1, "identical tokens are de-duplicated", str(dupes))

print()
failed = 0
for ok, label, detail in results:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  -> {detail}" if detail else ""))
    failed += 0 if ok else 1
print(f"\n{len(results)-failed}/{len(results)} passed")
sys.exit(1 if failed else 0)
