# World Chat tests

Three suites, all run against the real code — no mocks of the chat module itself.

| Suite | What it covers | How to run |
|---|---|---|
| `protocol-test.py` | The Python backend over a live WebSocket: acks, replies, edits, deletes, pins, reactions, renames, whispers, every command, validation, rate limiting, presence | start the server, then `python3 tests/protocol-test.py` |
| `ui-test.mjs` | The chat client in jsdom, driving the real `docs/index.html` markup: rendering, grouping, dividers, markdown, XSS safety, search, autocomplete, emoji picker, unread/toasts, offline outbox, retry | `node tests/ui-test.mjs` |
| `e2e-test.mjs` | Two real chat UIs wired to the real server over live WebSockets | start the server, then `node tests/e2e-test.mjs` |

## Setup

```bash
npm install jsdom ws          # for the two Node suites
pip install websockets        # for the Python suite
```

## Running everything

```bash
python3 tools/build-parts.py --check     # parts match their sources
python3 server/server.py &               # start the backend
python3 tests/protocol-test.py
node tests/e2e-test.mjs
node tests/ui-test.mjs                   # no server needed
```

`tools/build-parts.py --check` is the guard that would have caught the v4.2.1
corruption that disabled chat entirely — run it before every deploy.
