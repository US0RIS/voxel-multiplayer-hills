# World Chat — v4.3.0

World Chat is the primary social interface for Voxel Multiplayer Hills. It uses the game's existing WebSocket connection, so movement and chat share one multiplayer session.

## Panel behavior

- Chat opens expanded on first visit and occupies roughly 42% of the right side of the screen.
- Click the chevron in the chat header to collapse it into the edge chat tab.
- Click the tab to expand chat again.
- The collapsed/expanded preference, member-list visibility, sound, desktop-notification, and draft state are saved in `localStorage`.
- The client keeps the latest 300 messages locally and merges them with server history on reconnect. The server keeps the latest 500 messages and persists them to `server/chat-state.json`, so history survives a restart.

## Message layout

- Consecutive messages from the same author within five minutes are grouped; grouped rows show a timestamp on hover instead of repeating the avatar and name.
- Date dividers separate days and are labelled `Today`, `Yesterday`, or the full date.
- A red **New messages** divider marks where you left off.
- When you scroll up, a **Jump to present** button appears and turns into an `N new messages` counter.
- Failed messages stay in place with **Retry** and **Discard** actions.

## Notifications

- When chat is collapsed, each incoming message creates its own toast in the upper-right corner (maximum four at a time).
- Toasts show the sender, a 96-character preview, and the message time. A toast closes automatically after roughly four seconds.
- Click a toast to open chat and scroll to that message; click `×` to dismiss just that one.
- Toasts are suppressed while you are actively typing.
- The 🔔 button toggles the notification sound; mentions use a brighter tone.
- The 🖥 button toggles desktop notifications (requests browser permission on first use); these only fire when the tab is hidden or chat is collapsed.
- Unread counts appear on the collapsed tab and in the browser tab title. Mentions turn the badge yellow.

## Keyboard controls

| Shortcut | Action |
|---|---|
| `Enter` | Focus chat, or send while the composer is focused |
| `Shift+Enter` | Insert a line break |
| `↑` (empty composer) | Edit your most recent message |
| `Escape` | Cancel edit → cancel reply → clear composer → close search → collapse chat |
| `Ctrl+F` / `⌘F` | Search chat messages |
| `Ctrl+Shift+P` / `⌘⇧P` | Open pinned messages |
| `/` | Focus chat and begin a command |
| `↑` / `↓` | Move through @mention and command suggestions |
| `Tab` / `Enter` | Accept the highlighted suggestion |

Clicking the game canvas returns keyboard control to movement. WASD and the arrow keys never get swallowed by the composer.

## Message formatting

| Syntax | Result |
|---|---|
| `**bold**` | **bold** |
| `*italic*` or `_italic_` | *italic* |
| `__underline__` | underlined |
| `~~strike~~` | struck through |
| `` `code` `` | inline code |
| ```` ```block``` ```` | code block |
| `> quote` | blockquote |
| `- item` | bullet list |
| `\|\|spoiler\|\|` | hidden until clicked |
| `@name` | mention (also `@everyone` / `@here`) |
| `https://…` | link (opens in a new tab, `rel="noopener noreferrer"`) |
| `:fire:`, `<3`, `:)` | emoji shortcodes |

Message text is always inserted as text nodes, never as HTML, so pasted markup cannot execute.

## Message interactions

- Hover a message for the action bar: react, reply, edit (your own), pin, delete (your own), and a `⋯` menu.
- Right-click a message for the full menu: reply, mention, whisper, copy text, copy `/goto` command, teleport, pin, edit, delete.
- Messages with location data show a location chip; clicking it teleports you there.
- Replies render a clickable preview of the parent message.
- Edited messages show an `(edited)` badge; deleted messages leave a tombstone.
- Pinned messages appear in the 📌 panel with jump and unpin actions.
- Reactions: 20 server-approved emoji, with a searchable picker. Hovering a reaction shows who reacted.
- Hovering a player name or member row highlights that player in the world.
- Messages that mention you are highlighted and raise a mention badge.

## Commands

| Command | Behavior |
|---|---|
| `/help` | Shows the command list |
| `/nick [name]` | Change your display name (2–24 characters, must be unique) |
| `/me [action]` | Post an action message |
| `/status [text]` | Sets the status shown in the member list; omit text to clear it |
| `/here` | Posts that you are online and includes your current chunk |
| `/location` | Posts your current chunk as a clickable location message |
| `/list` | Privately lists all online players and their chunks |
| `/tp [player]` | Teleports you to an online player's current location |
| `/goto [message-index]` | Teleports to the location stored in a numbered message |
| `/w [player] [text]` | Sends a private message (aliases: `/whisper`, `/msg`, `/dm`) |
| `/roll [sides]` | Rolls a die and announces the result |
| `/shrug [text]` | Appends `¯\_(ツ)_/¯` |
| `/pins` | Lists pinned messages |
| `/clear` | Clears your local message view |

Start a message with `//` to send a literal leading slash instead of running a command.

## Presence and delivery

- Members are grouped into **Online** and **Offline** sections with a search box.
- Green presence dot: online. Gray: offline, with a last-seen time.
- Custom statuses replace the chunk readout in the member list.
- Join, leave, rename, and pin events are saved as system messages.
- `✓` means accepted/sent, `✓✓` means broadcast by the server, `◷` means queued locally, `!` means failed.
- Messages typed while disconnected are queued and sent automatically on reconnect.
- If the server rate-limits you, the message is re-queued and retried rather than lost.

## Backend limits

- Global room chat plus private whispers.
- Maximum message length: 2000 characters.
- Rate limit: 5 messages per 5 seconds per player.
- Server history: last 500 messages, persisted to `server/chat-state.json` (override with `CHAT_STATE_PATH`).
- Edit window: 1 hour by default (`CHAT_EDIT_WINDOW`, in seconds; `0` disables the limit).
- Pinned messages: 50 maximum.

## Network event types

The project uses native JSON-over-WebSocket rather than Socket.io. Chat events use Socket.io-style names:

- Client → server: `chat:send`, `chat:edit`, `chat:delete`, `chat:pin`, `chat:pins`, `chat:nick`, `chat:user-status`, `chat:location-update`, `chat:typing`, `chat:reaction`, `chat:history`
- Server → client: `chat:message`, `chat:history`, `chat:update`, `chat:ack`, `chat:error`, `chat:user-status`, `chat:users`, `chat:presence`, `chat:typing`, `chat:reaction`, `chat:pins`, `chat:renamed`, `chat:teleport`, `chat:clear-local`

## Editing the chat module

`docs/chat-source-v4.3.0.js` and `server/server-source.py` are the readable sources of truth. They ship as base64 parts in `docs/chat-parts/` and `server/parts/`. After changing either source, run:

```bash
python3 tools/build-parts.py          # regenerate parts
python3 tools/build-parts.py --check  # verify parts match the sources
```

Each part is independently valid base64, so a damaged part now fails loudly at load time instead of silently corrupting the module.
