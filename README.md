# Voxel Multiplayer Hills — v4.2.0 World Chat

This release turns chat into the primary social interface while preserving the existing WebGL2 terrain, character, movement, and multiplayer systems.

## Included

- Expanded-by-default chat panel occupying about 42% of the left side
- Collapsed left-edge chat tab with unread badge
- Four-second stacked message toasts with click-to-open behavior
- Global chat, 500-message in-memory server history, 100-message client view/cache
- Online/offline player list, status text, last-seen time, typing indicators
- Server-side timestamps, 500-character validation, and 2 messages/second rate limiting
- Sent/delivered indicators, reactions, @mentions, search, link detection, and notification sound
- Location-aware messages and commands with real in-game teleportation
- Join/leave system messages

See [`CHAT.md`](CHAT.md) for commands and behavior.

## Folder structure

```text
voxel-multiplayer-hills-v4.2.0-chat/
├── docs/
│   ├── index.html
│   ├── config.js
│   ├── styles.css
│   ├── chat-v4.2.0.js
│   ├── game-loader-v4.2.0.js
│   ├── multiplayer-hills-v4.1.0.js   unchanged renderer, loaded through bridge
│   └── assets/voxel_adventurer.glb
├── server/server.py
├── CHAT.md
├── render.yaml
├── local-dev.py
├── start-local.command
└── start-local.bat
```

## Test locally

```bash
cd "/path/to/voxel-multiplayer-hills-v4.2.0-chat"
python3 local-dev.py
```

Open a second browser window to test multiplayer and chat.

## Deploy

1. Upload this folder's **contents** to the repository root, preserving `docs/` and `server/`.
2. GitHub Pages should publish either `/docs` or the repository root (the root `index.html` redirects to `/docs/`).
3. In Render, use **Manual Deploy → Deploy latest commit** because `autoDeployTrigger` is disabled.
4. Verify `https://voxel-multiplayer-hills-410-server.onrender.com/health` reports version `4.2.0`.

The current deployed project uses native JSON-over-WebSocket and a standard-library Python backend, not Socket.io. Event names follow the requested `chat:*` convention while reusing the existing connection and hosting model.
