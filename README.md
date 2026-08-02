# Voxel Multiplayer Hills — v4.1.0 Deployment

This folder separates the browser game from the multiplayer relay so the frontend can run on GitHub Pages and the WebSocket server can run on Render.

## Folder structure

```text
voxel-multiplayer-hills-v4.1.0-deployment/
├── docs/                 GitHub Pages frontend
│   ├── index.html
│   ├── config.js         One public server URL to edit
│   ├── styles.css
│   ├── multiplayer-hills-v4.1.0.js
│   └── assets/voxel_adventurer.glb
├── server/               Public multiplayer backend
│   └── server.py
├── render.yaml           Render Blueprint configuration
├── local-dev.py          Local frontend + backend launcher
├── start-local.command   macOS launcher
└── start-local.bat       Windows launcher
```

## Test locally

On macOS:

```bash
cd "/path/to/voxel-multiplayer-hills-v4.1.0-deployment"
python3 local-dev.py
```

The game opens at `http://localhost:8130`. The multiplayer backend runs at `ws://localhost:8131/ws`.

## Deploy the backend to Render

1. Create a GitHub repository and put the contents of this folder at the repository root.
2. In Render, create a Blueprint from the repository. Render will read `render.yaml`.
3. Wait for the service to deploy.
4. Open the Render service URL in a browser. It should say that the v4.1.0 server is online.
5. The health endpoint is `/health` and the WebSocket endpoint is `/ws`.

The server uses the hosting platform's `PORT` environment variable and requires no pip packages.

### Optional backend settings

- `WORLD_SEED`: shared deterministic terrain seed
- `MAX_PLAYERS`: room capacity, 1–64
- `ALLOWED_ORIGINS`: comma-separated allowed frontend origins; blank allows all

For example, after the GitHub Pages URL exists:

```text
ALLOWED_ORIGINS=https://YOUR-USERNAME.github.io
```

For a project site, browsers still report the origin without the repository path.

## Connect the frontend to Render

Open `docs/config.js` and replace:

```javascript
PUBLIC_WEBSOCKET_URL: 'wss://YOUR-RENDER-SERVICE.onrender.com/ws'
```

with the actual Render service address, for example:

```javascript
PUBLIC_WEBSOCKET_URL: 'wss://voxel-multiplayer-hills-410-server.onrender.com/ws'
```

Commit that change.

For temporary testing, the frontend also accepts a server URL in the query string:

```text
https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/?server=wss://YOUR-SERVICE.onrender.com/ws
```

## Publish the frontend with GitHub Pages

In the GitHub repository:

1. Open **Settings → Pages**.
2. Select **Deploy from a branch**.
3. Select the `main` branch.
4. Select the `/docs` folder.
5. Save.

The public game URL will normally be:

```text
https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/
```

Anyone opening that URL connects to the same eight-player room and shared terrain seed.

## Current scope

Included:

- Anonymous multiplayer for up to eight players by default
- Shared deterministic rolling-hills world
- Infinite chunk streaming on each client
- Position, facing, idle, and walk synchronization
- Remote-player interpolation
- Automatic reconnection with exponential backoff
- WebSocket keepalive ping/pong
- Health endpoint for deployment checks
- Basic server-side movement sanity limiting

Not included:

- Accounts
- Private rooms or invite codes
- Persistent player state
- Database storage
- Building, inventory, or chat
- Multiple server instances sharing one room

Keep the backend at one instance for this prototype because the room exists only in that process's memory.
