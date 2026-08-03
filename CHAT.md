# World Chat — v4.2.0

World Chat is the primary social interface for Voxel Multiplayer Hills. It uses the game's existing WebSocket connection, so movement and chat share one multiplayer session.

## Panel behavior

- Chat opens expanded on first visit and occupies approximately 42% of the left side of the screen.
- Click the chevron in the chat header to collapse it into the left-edge chat tab.
- Click the tab to expand chat again.
- The collapsed/expanded preference is saved in `localStorage`.
- The client keeps the latest 100 messages locally. The server keeps the latest 500 messages in memory and sends them to newly connected players.

## Notifications

When chat is collapsed, each incoming message creates its own toast in the upper-right corner.

- Toasts show the sender, an 80-character preview, and the message time.
- A toast closes automatically after four seconds.
- Click a toast to open chat and scroll to that message.
- Click the `×` button to dismiss only that toast.
- Toasts are suppressed while the local player is actively typing.
- Notification sound can be toggled with the bell button in the chat header. The setting is stored locally.

## Keyboard controls

| Shortcut | Action |
|---|---|
| `Enter` | Focus chat, or send while the composer is focused |
| `Shift+Enter` | Insert a line break |
| `Escape` | Clear the composer; press again to collapse chat |
| `Ctrl+F` / `⌘F` | Search chat messages |
| `/` | Focus chat and begin a command |
| `Tab` | Accept the first visible @mention suggestion |

Clicking the game canvas returns keyboard control to movement.

## Commands

| Command | Behavior |
|---|---|
| `/here` | Posts that you are online and includes your current chunk |
| `/status [text]` | Sets the status shown in the player list; omit text to clear it |
| `/tp [player-name]` | Teleports you to an online player's current location |
| `/location` | Posts your current chunk as a clickable location message |
| `/list` | Privately lists all online players and their chunks |
| `/goto [message-index]` | Teleports to the location stored in a numbered message |
| `/help` | Shows the command list |

## Message interactions

- Click a message to open its interaction tray.
- Messages with location data include a location chip. Clicking it teleports to that location.
- Hovering a player name highlights that player in the world for a short period.
- Reactions supported in the MVP: 👍 ❤️ 😂 🎉 👀 🔥 ✅ ❓.
- URLs beginning with `http://` or `https://` become links.
- Typing `@` opens online-player suggestions.
- Messages that mention your exact player name are visually highlighted.

## Presence and delivery

- Green presence dot: online.
- Gray presence dot: offline; the list shows the last-seen time.
- Join and leave events are saved as system messages.
- `✓` means accepted/sent to the server.
- `✓✓` means broadcast by the server.
- Failed messages show `!` and a diagnostic tooltip.

## Backend limits

- Global room chat only.
- Maximum message length: 500 characters.
- Rate limit: 2 messages per second per player.
- Server history: last 500 messages, stored in memory.
- Render free-tier sleep or a backend restart clears server-side history and offline-presence memory. Local browser history remains available.

## Network event types

The current project uses native JSON-over-WebSocket rather than Socket.io. Chat events use Socket.io-style names:

- Client → server: `chat:send`, `chat:user-status`, `chat:location-update`, `chat:typing`, `chat:reaction`, `chat:history`
- Server → client: `chat:message`, `chat:history`, `chat:ack`, `chat:error`, `chat:user-status`, `chat:users`, `chat:presence`, `chat:typing`, `chat:reaction`, `chat:teleport`
