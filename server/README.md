# Multiplayer + Chat Backend v4.3.0

Standard-library Python WebSocket server for movement and World Chat.

Endpoints:

- `GET /health` — health/status JSON
- `GET /` — human-readable status
- `WS /ws` — shared movement and chat protocol

`server.py` is a bootstrap that decodes `parts/*.b64`. The readable source is
`server-source.py`; regenerate the parts after editing it:

```bash
python3 ../tools/build-parts.py
```

## Behaviour

- Keeps the last 500 chat messages and persists them to `chat-state.json`, so
  history survives a restart.
- Rate-limits each player to 5 messages per 5 seconds and replies with a
  `retryAfter` hint so the client can re-queue instead of dropping the message.
- Supports replies, edits, deletes, pins, reactions, whispers, renames,
  statuses, typing indicators, and location-aware messages.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8131` | Listen port |
| `WORLD_SEED` | `4102026` | Terrain seed shared with clients |
| `MAX_PLAYERS` | `8` | Room capacity (1–64) |
| `ALLOWED_ORIGINS` | *(empty — all)* | Comma-separated allowlist for WebSocket origins |
| `CHAT_STATE_PATH` | `server/chat-state.json` | Where chat history is persisted |
| `CHAT_EDIT_WINDOW` | `3600` | Seconds a message stays editable (`0` = forever) |
