# Multiplayer + Chat Backend v4.2.0

Standard-library Python WebSocket server for movement and World Chat.

Endpoints:

- `GET /health` — health/status JSON
- `GET /` — human-readable status
- `WS /ws` — shared movement and chat protocol

The server keeps the last 500 chat messages in memory and rate-limits each player to two messages per second.
