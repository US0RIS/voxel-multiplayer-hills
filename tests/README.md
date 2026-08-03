[README.md](https://github.com/user-attachments/files/30661912/README.md)
# World Chat tests

Four suites, all run against the real code — no mocks of the chat module itself.

| Suite | What it covers | How to run |
|---|---|---|
| `protocol-test.py` | The Python backend over a live WebSocket: acks, replies, edits, deletes, pins, reactions, renames, whispers, every command, validation, rate limiting, presence | start the server, then `python3 tests/protocol-test.py` |
| `ui-test.mjs` | The chat client in jsdom, driving the real `docs/index.html` markup: rendering, grouping, dividers, markdown, XSS safety, search, autocomplete, emoji picker, unread/toasts, offline outbox, retry | `node tests/ui-test.mjs` |
| `e2e-test.mjs` | Two real chat UIs wired to the real server over live WebSockets | start the server, then `node tests/e2e-test.mjs` |
| `css-isolation-test.mjs` | That `styles.css` cannot reach into the chat UI, and the chat stylesheet owns its own layout | `node tests/css-isolation-test.mjs` |

## Setup

```bash
npm install jsdom ws          # for the Node suites
pip install websockets        # for the Python suite
```

## Running everything

```bash
python3 tools/build-parts.py --check     # parts match their sources
python3 server/server.py &               # start the backend
python3 tests/protocol-test.py
node tests/e2e-test.mjs
node tests/ui-test.mjs                   # no server needed
node tests/css-isolation-test.mjs        # no server needed
```

## The two guards worth running before every deploy

- `tools/build-parts.py --check` catches the v4.2.1 base64 corruption that
  disabled chat entirely.
- `css-isolation-test.mjs` catches the v4.3.0 cascade collision, where a
  leftover `.chat-composer` grid rule in `styles.css` squeezed the message box
  down to one character wide.

Both failures were invisible to the other suites, because the module loaded and
every behaviour worked — the bugs were in packaging and in styling.
