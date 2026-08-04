# Ridgewood v0.5.0 alpha — persistent mutable world

This work is isolated on `feature/persistent-world-v0.5.0` and draft PR #2.
It is not deployed and has not changed `main`.

## Implemented

- Discord users and hashed game sessions stored in Supabase
- Short-lived in-memory session cache; Supabase remains the source of truth
- Player position, height and facing saved periodically, on chunk changes and on disconnect
- Saved position restored when the authenticated player reconnects
- One persistent public world using the existing procedural seed
- Atomic chunk claims through `claim_chunk`
- Four claims per player by default (`MAX_CHUNK_CLAIMS`)
- Sparse per-chunk voxel overlays in `chunks.voxel_data`
- Server-authoritative placement/removal with ownership, range and rate validation
- Atomic chunk mutation plus append-only `building_log` through `apply_voxel_edit`
- Real-time voxel and claim broadcasts to all connected players
- In-game ownership/build HUD

## Alpha controls

| Control | Action |
| --- | --- |
| `C` | Claim the chunk currently occupied by the player |
| `1` | Select grass |
| `2` | Select dirt |
| `3` | Select stone |
| `B` | Place the selected block one cell in front of the player |
| `N` | Remove the highest player-placed block one cell in front of the player |

Players may only build in chunks they own. The alpha build removes player-placed
blocks; mining the deterministic base terrain is intentionally deferred.

## Required Render secrets

```text
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SECRET_KEY=...
AUTH_REQUIRED=1
```

The secret key must remain server-side. Do not add it to browser code or GitHub.

## Verification checklist

1. Deploy this branch to a separate Render preview service.
2. Confirm `/health` includes:
   - `supabase: true`
   - `persistentWorld: true`
   - `authRequired: true`
3. Sign in with Discord again; legacy SQLite sessions are intentionally not migrated.
4. Walk to another chunk, wait at least seven seconds, close the tab, and reconnect.
5. Confirm the player returns to the saved location.
6. Claim the current chunk with `C`.
7. Place blocks with `B` and remove one with `N`.
8. Open a second authenticated browser and confirm edits appear in real time.
9. Restart the preview Render service.
10. Confirm the position, chunk owner and blocks are restored from Supabase.
11. Inspect `building_log` and confirm accepted edits have audit rows.

## Validation

GitHub Actions runs:

```text
python3 tools/validate-persistent-world.py
node --check docs/game-loader-v4.3.0.js
node --check docs/auth-v0.5.0.js
node --check docs/home-v0.5.0.js
```

The workflow applies the auth and world patches to the generated server source,
compiles the resulting runtime and checks required persistence markers.
