# Discord OAuth setup

The multiplayer backend now exposes a pure-standard-library Discord OAuth flow. Authentication is **optional by default**, so existing guest multiplayer and chat continue to work while the login UI is being built.

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/auth/discord` | GET | Starts Discord OAuth and redirects to Discord |
| `/auth/discord/callback` | GET | Validates OAuth state, exchanges the code, creates a local session, and redirects to the game |
| `/auth/status` | GET | Reports whether Discord OAuth is configured and whether auth is required |
| `/auth/me` | GET | Returns the current user for a Bearer token, session cookie, or `?token=` value |
| `/auth/logout` | POST | Revokes the current session and clears the session cookie |

The WebSocket endpoint accepts the same session through its Render-domain cookie or a `?token=` query parameter. When a valid session is present, the Discord display name is used as the initial in-game name and the welcome packet contains an `auth` object.

## Discord application

1. Create an application in the Discord Developer Portal.
2. Open **OAuth2**.
3. Add this redirect URI exactly:

```text
https://voxel-multiplayer-hills-410-server.onrender.com/auth/discord/callback
```

4. Copy the application’s **Client ID** and **Client Secret**.

## Render environment variables

The Blueprint declares the required keys but does not store the secret values in GitHub. In the Render service, set:

```text
DISCORD_CLIENT_ID=<Discord application client ID>
DISCORD_CLIENT_SECRET=<Discord application client secret>
```

These non-secret values are already declared in `render.yaml`:

```text
GAME_URL=https://us0ris.github.io/voxel-multiplayer-hills/
SERVER_URL=https://voxel-multiplayer-hills-410-server.onrender.com
DISCORD_REDIRECT_URI=https://voxel-multiplayer-hills-410-server.onrender.com/auth/discord/callback
AUTH_REQUIRED=0
```

Keep `AUTH_REQUIRED=0` until the browser client reliably carries the session into the WebSocket connection. Setting it to `1` rejects unauthenticated WebSocket upgrades.

## Session behavior

- OAuth requests use a cryptographically random, one-time `state` value to prevent login CSRF.
- Session tokens are cryptographically random and only SHA-256 hashes are stored in SQLite.
- Sessions expire after 30 days by default.
- The callback sends the token to the GitHub Pages client in the URL **fragment**, not the query string, so it is not included in ordinary HTTP request logs or referrer headers.
- The backend also sets a secure, HttpOnly Render-domain session cookie.

## Storage limitation on the current Render plan

`server/ridgewood.db` is SQLite on Render’s ephemeral filesystem. Users and sessions therefore survive while the instance remains intact, but they can be lost after a redeploy, restart, or free-instance replacement. This is acceptable for the alpha integration but is not durable account storage.

For durable production accounts, move the auth tables to PostgreSQL/Supabase or attach a persistent Render disk. The current `SUPABASE_URL` and `SUPABASE_ANON_KEY` values are not used by this implementation.

## Local development

Set environment variables before starting the backend:

```bash
export DISCORD_CLIENT_ID="..."
export DISCORD_CLIENT_SECRET="..."
export GAME_URL="http://localhost:8130/"
export SERVER_URL="http://localhost:8131"
export DISCORD_REDIRECT_URI="http://localhost:8131/auth/discord/callback"
python3 server/server.py
```

Add the local callback URI to the Discord application while testing locally.
