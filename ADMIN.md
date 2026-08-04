# Staff roles and moderation

Ridgewood v0.8.0 adds three account roles, a moderation toolset, and an in-game
control panel for staff.

| Role | Can build anywhere | Fly / speed | Kick | Ban | Change roles |
|---|---|---|---|---|---|
| `player` | — | — | — | — | — |
| `moderator` | ✅ | ✅ | ✅ | ✅ | — |
| `admin` | ✅ | ✅ | ✅ | ✅ | ✅ |

An actor may only act on someone of a **strictly lower** role. A moderator
cannot ban another moderator, nobody can ban an admin, and no one can act on
their own account.

---

## Deploy checklist

Do these in order. Steps 1 and 2 must both be finished before step 3, because
the new server calls a Supabase function that does not exist until you run the
migration.

### 1. Run the SQL migration

Open the Supabase SQL Editor and run
[`SUPABASE_MIGRATION_005_ADMIN_ROLES.sql`](SUPABASE_MIGRATION_005_ADMIN_ROLES.sql)
in full. It is safe to re-run.

It adds `role`, `banned_until`, `ban_reason`, `banned_at` and `banned_by` to
`game_users`, creates the `admin_actions` audit table, replaces
`apply_voxel_edit` with a nine-argument version that understands the staff
override, and adds `admin_set_chunk_owner`.

> The old eight-argument `apply_voxel_edit` is dropped. Between running this
> migration and deploying the new server, building will fail. Keep the gap
> short, or run the migration immediately before pushing.

### 2. Set the Render environment variable

In the Render service, add:

```text
ADMIN_USERNAMES=Admin
```

Optional tuning (defaults shown):

```text
ADMIN_BUILD_DISTANCE=48          # staff build reach in blocks; players get 8
ADMIN_MAX_FLY_HEIGHT=180         # flight ceiling
ADMIN_MAX_SPEED_MULTIPLIER=6     # cap on the speed slider
```

On startup the server promotes every account named in `ADMIN_USERNAMES` to
`admin`. Promotion is one way — removing a name later does **not** demote the
account, so the audit trail stays truthful. Demote with `/role NAME player`.

If the account does not exist yet, the log says so; register it, then restart
the service.

### 3. Deploy

Commit and push. GitHub Pages republishes `docs/`; Render needs a manual deploy
because `autoDeployTrigger` is off.

Pushing the client before the server is safe: without the new server, the welcome
packet carries no capability block, so the panel simply never appears and
everything else behaves exactly as it does today.

### 4. Verify

```bash
python3 tools/validate-persistent-world.py   # every runtime patch still applies
python3 tests/admin-permissions-test.py      # permission model, 20 checks
node tests/loader-chain-test.mjs             # loader chain reaches the game
npm install --no-save jsdom
node tests/chat-badge-test.mjs               # chat badges, 16 checks
```

Then log in as `Admin` and confirm the **⚙ Admin** button appears at the top
left. If it does not, the account is not admin yet — check the Render logs for
the `Admin bootstrap:` line.

---

## The chat module is untouched

Staff badges are applied by `docs/admin-v0.8.0.js`, which watches the rendered
chat DOM and decorates messages using the roles that already arrive on the wire.
Nothing in `docs/chat-parts/`, `docs/chat-source-v4.3.0.js` or
`docs/chat-v4.3.0.js` changes, so deploying this feature carries no risk to chat.

That was a deliberate choice, because the chat module has a **pre-existing
defect unrelated to this work**: its generated parts are roughly 1.4 KB ahead of
`chat-source-v4.3.0.js`. The parts are what production runs, so the checked-in
source is the stale copy — someone shipped a chat change by regenerating the
parts without committing the regenerated source.

The practical consequence: **do not run `tools/build-parts.py` until that is
reconciled.** It rebuilds the parts from the source and would delete the
difference. To repair it, whenever you like and independently of this feature:

```bash
python3 tools/reconcile-chat-parts.py --check   # report, change nothing
python3 tools/reconcile-chat-parts.py           # rewrite the source from the parts
```

`validate-persistent-world.py` prints a warning whenever the two disagree. Once
reconciled, run it with `--strict` in CI so it can never drift silently again.

---

## Using the control panel

The panel appears only for staff. The server decides that; the button does not
exist for anyone else.

| Key | Action |
|---|---|
| `F1` | Open or close the control panel |
| `F` | Toggle flight |
| `Space` / `Shift` | Rise / descend while flying |
| `R` | Cycle movement speed (1× → 2× → 4×) |
| `G` | Toggle **Build anywhere** |

**Powers** — flight, speed, and the build override. Build override is off by
default and persists per browser, so you build like an ordinary player until you
deliberately switch it on. That prevents accidentally editing someone's plot
while walking through it.

**Players** — everyone online, with their chunk, their role, a *Go to* teleport,
and *Kick*. Kick is disabled for anyone you do not outrank.

**Moderate** — ban with a duration (1 hour to permanent) and an optional reason,
lift a ban, and (admins only) set a role.

**Log** — the last 20 entries from `admin_actions`.

### Chat commands

Staff commands also work from chat and appear in `/help` only for staff:

```text
/kick  NAME [reason]
/ban   NAME 24h [reason]        # 30m, 12h, 7d, 2w, or forever
/unban NAME
/role  NAME moderator           # admin only
/staff                          # list staff accounts
/modlog                         # recent moderation actions
/panel                          # open the control panel
```

---

## Chat prominence

Admin and moderator messages get a coloured left rail, a tinted background, a
bright author name, and an `ADMIN` / `MOD` badge. The member list is badged the
same way. Roles travel with the message from the server, so they cannot be
spoofed by renaming yourself.

---

## How the permissions actually hold

The client is not trusted anywhere. Specifically:

- **The role lives in Supabase.** The server reads it when the WebSocket
  connects and stores it on the connection. `window.__RIDGEWOOD_ADMIN` in the
  browser is a rendering hint, nothing more.
- **Build override is re-checked twice.** The client sends
  `adminOverride: true`; the Python layer only honours it if the connection's
  role is staff, and `apply_voxel_edit` independently re-reads the role from
  `game_users` before bypassing the ownership check. Forging the flag from
  devtools gets a `not_owner` rejection.
- **Flight and speed are capped server-side.** Position updates are clamped, so
  a modified client cannot teleport or outrun the caps.
- **Bans are enforced at three points**: password login, `/auth/me`, and the
  WebSocket upgrade. Banning also deletes every session row for that account and
  disconnects any live connections immediately.
- **Everything successful is audited** in `admin_actions`, including each
  individual block edited under override, with the chunk owner recorded as the
  target.

Denied attempts are rejected but not audited, to keep the log readable.

---

## Rollback

The v0.8.0 client and server are independent of each other:

- **Client only**: point `startGameModule` in `docs/auth-v0.5.0.js` back at
  `game-loader-v0.6.0.js` and remove the `admin-v0.8.0.js` tag from
  `docs/index.html`. Staff powers disappear; nothing else changes.
- **Server only**: remove the `patch_admin_runtime` line from `server/server.py`.
  The panel will then be shown to nobody, because no welcome packet carries a
  staff capability block.

The migration does not need reverting in either case. The extra columns are
ignored by older code, with one exception: the old eight-argument
`apply_voxel_edit` is gone, so a v0.6.0 server would need
`SUPABASE_MIGRATION_003_TERRAIN_MINING.sql` re-run to restore it.
