# Multiplayer backend

Start locally:

```bash
PORT=8131 python3 server.py
```

Endpoints:

- `GET /` — status text
- `GET /health` — JSON health response
- `WebSocket /ws` — multiplayer connection

No third-party Python packages are required.
