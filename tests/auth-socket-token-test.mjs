/* The session token must reach the WebSocket, even if the game starts early.
 *
 * The home screen's "Public Server" button calls RIDGEWOOD_AUTH_API.startGame()
 * directly, while auth-v0.5.0.js is still awaiting /auth/me. The WebSocket
 * wrapper that appends ?token= used to be installed only after that request
 * resolved, so clicking Play first meant the game opened its socket with no
 * token. The server saw an anonymous connection, named the player "Player 1",
 * and gave them no role -- which looks exactly like "the admin panel is broken".
 *
 * On a cold free-tier server /auth/me can take many seconds, so the race was
 * usually lost. These tests pin the fix: the wrapper is installed at load and
 * reads the token per connection.
 *
 *     npm install --no-save jsdom
 *     node tests/auth-socket-token-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.error('This suite needs jsdom:\n\n  npm install --no-save jsdom\n');
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = 'https://voxel-multiplayer-hills-410-server.onrender.com';
const SOCKET = 'wss://voxel-multiplayer-hills-410-server.onrender.com/ws';
const TOKEN_KEY = 'ridgewood.session_token';

const results = [];
const check = (ok, label, detail = '') => results.push([ok, label, detail]);

/** Boot auth-v0.5.0.js in a fresh DOM, with /auth/me suspended until released. */
function boot({ token }) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://us0ris.github.io/voxel-multiplayer-hills/docs/' });
  const { window } = dom;

  const store = new Map();
  if (token) store.set(TOKEN_KEY, token);

  let releaseAuthMe;
  const authMeGate = new Promise((resolve) => { releaseAuthMe = resolve; });
  const opened = [];

  class FakeSocket {
    constructor(url) { opened.push(String(url)); this.url = String(url); }
    addEventListener() {} close() {} send() {}
  }
  FakeSocket.CONNECTING = 0; FakeSocket.OPEN = 1; FakeSocket.CLOSING = 2; FakeSocket.CLOSED = 3;

  // jsdom defines localStorage as a getter-only property, so it has to be
  // redefined rather than assigned.
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    }
  });

  Object.assign(window, {
    VOXEL_CONFIG: { AUTH_SERVER_URL: SERVER, PUBLIC_WEBSOCKET_URL: SOCKET },
    WebSocket: FakeSocket,
    fetch: async (url) => {
      if (String(url).includes('/auth/me')) {
        await authMeGate;                       // held open on purpose
        return { ok: true, status: 200, json: async () => ({ authenticated: true, user: { username: 'Admin', role: 'admin' } }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    }
  });

  // These stay installed for the rest of the block: startGame() runs later and
  // still needs `document`. Each boot() replaces them with its own window.
  for (const key of ['document', 'localStorage', 'fetch', 'WebSocket', 'location',
                     'history', 'CustomEvent', 'URL', 'HTMLInputElement',
                     'HTMLTextAreaElement']) {
    globalThis[key] = window[key];
  }
  globalThis.window = window;
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

  new Function(fs.readFileSync(path.join(ROOT, 'docs', 'auth-v0.5.0.js'), 'utf8'))();

  return { window, opened, releaseAuthMe, store };
}

// --- 1. The race: Play clicked before /auth/me resolves ---------------------
{
  const { window, opened } = boot({ token: 'session-token-abc' });
  // /auth/me is deliberately still pending here.
  window.RIDGEWOOD_AUTH_API.startGame();
  new window.WebSocket(SOCKET);            // what the game module does

  const url = opened[0] || '';
  check(url.includes('token=session-token-abc'),
    'token is attached when Play is clicked before /auth/me resolves',
    url.replace(SERVER.replace('https://', 'wss://'), '') || '(no socket opened)');
}

// --- 2. Signed out: no token, and none invented ------------------------------
{
  const { window, opened } = boot({ token: null });
  new window.WebSocket(SOCKET);
  const url = opened[0] || '';
  check(!url.includes('token='), 'no token is sent when signed out', url.slice(0, 70));
}

// --- 3. Token acquired after the wrapper was installed ----------------------
{
  const { window, opened, store } = boot({ token: null });
  new window.WebSocket(SOCKET);                       // guest connection
  store.set(TOKEN_KEY, 'token-after-login');          // user logs in
  new window.WebSocket(SOCKET);                       // reconnect
  check(!opened[0].includes('token='), 'pre-login socket carries no token');
  check(opened[1].includes('token=token-after-login'),
    'a socket opened after login carries the new token');
}

// --- 4. Third-party sockets are untouched ------------------------------------
{
  const { window, opened } = boot({ token: 'secret-token' });
  new window.WebSocket('wss://example.com/socket');
  check(!opened[0].includes('secret-token'),
    'the token is never leaked to another origin', opened[0]);
}

// --- 5. An explicit token is not overwritten --------------------------------
{
  const { window, opened } = boot({ token: 'stored-token' });
  new window.WebSocket(`${SOCKET}?token=explicit`);
  check(opened[0].includes('token=explicit') && !opened[0].includes('stored-token'),
    'an explicitly supplied token wins', opened[0].split('?')[1]);
}

console.log();
let failed = 0;
for (const [ok, label, detail] of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -> ${detail}` : ''}`);
  if (!ok) failed += 1;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
