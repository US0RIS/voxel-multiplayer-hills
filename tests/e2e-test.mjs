/* End-to-end test: two real chat UIs (jsdom) wired to the real Python server
 * over live WebSockets, through the same bridge contract the game provides.
 */
import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { WebSocket } from 'ws';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS_URL = 'ws://localhost:8131/ws';
const failures = [];

function check(condition, label) {
  console.log((condition ? '  PASS  ' : '  FAIL  ') + label);
  if (!condition) failures.push(label);
}

const html = fs.readFileSync(`${ROOT}/docs/index.html`, 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const chatSource = fs.readFileSync(`${ROOT}/docs/chat-source-v4.3.0.js`, 'utf8');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeClient(label, port) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (error) => errors.push(error.message));
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: `http://localhost:${port}/`,
    virtualConsole
  });
  const { window } = dom;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.Element.prototype.scrollTo = function scrollTo(options) {
    if (options && typeof options.top === 'number') this.scrollTop = options.top;
  };

  const client = {
    label, window, errors,
    document: window.document,
    socket: null,
    local: { id: null, name: null, color: [0.4, 0.7, 1], x: 8, z: 24, chunkX: 0, chunkZ: 1 },
    $: (selector) => window.document.querySelector(selector),
    all: (selector) => Array.from(window.document.querySelectorAll(selector)),
    type(text) {
      const input = client.$('#chat-input');
      input.value = text;
      input.dispatchEvent(new window.Event('input'));
    },
    press(target, key, init = {}) {
      target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    },
    send(text) {
      client.type(text);
      client.press(client.$('#chat-input'), 'Enter');
    },
    messages() {
      return client.all('#chat-message-list .chat-message');
    },
    text() {
      return client.$('#chat-message-list').textContent;
    }
  };

  window.VOXEL_GAME_API = {
    getLocalState: () => ({ ...client.local, online: true }),
    getPlayers: () => [],
    send(payload) {
      if (!client.socket || client.socket.readyState !== WebSocket.OPEN) return false;
      client.socket.send(JSON.stringify(payload));
      return true;
    },
    teleport(x, z) { client.local.x = x; client.local.z = z; return true; },
    highlightPlayer: () => true,
    highlightPlayerByName: () => true,
    setLocalName(name) { client.local.name = name; return true; },
    focusCanvas: () => {}
  };

  window.eval(chatSource);
  return client;
}

function connect(client) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL);
    client.socket = socket;
    socket.on('open', () => {
      client.window.dispatchEvent(new client.window.CustomEvent('voxel:bridge-ready', { detail: client.local }));
    });
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === 'welcome') {
        client.local.id = message.id;
        client.local.name = message.name;
      }
      client.window.dispatchEvent(new client.window.CustomEvent('voxel:network-message', { detail: message }));
      if (message.type === 'welcome') {
        client.window.dispatchEvent(new client.window.CustomEvent('voxel:network-ready', { detail: client.local }));
        resolve(client);
      }
    });
    socket.on('error', reject);
  });
}

async function run() {
  console.log('\n=== live connection ===');
  const alice = makeClient('alice', 8130);
  const bob = makeClient('bob', 8131);
  await connect(alice);
  await wait(300);
  await connect(bob);
  await wait(600);

  check(alice.$('#chat-connection').dataset.state === 'online', 'alice connects to the real server');
  check(bob.$('#chat-connection').dataset.state === 'online', 'bob connects to the real server');
  check(alice.$('#chat-connection').textContent.includes(alice.local.name), 'header shows the server-assigned name');
  check(alice.text().includes(`${bob.local.name} joined`), 'alice sees bob join');
  check(alice.all('.chat-player').length >= 2, 'member list shows both players');

  console.log('\n=== live message round trip ===');
  alice.send('hello from alice');
  await wait(500);
  check(bob.text().includes('hello from alice'), "bob receives alice's message");
  const aliceRow = alice.messages().find((n) => n.textContent.includes('hello from alice'));
  check(aliceRow.querySelector('.chat-delivery')?.textContent === '✓✓', 'alice sees a delivered receipt');
  check(alice.messages().filter((n) => n.textContent.includes('hello from alice')).length === 1, 'no duplicate from the optimistic copy');

  const bobRow = bob.messages().find((n) => n.textContent.includes('hello from alice'));
  const messageId = bobRow.dataset.messageId;
  check(messageId.startsWith('m-'), 'message carries a server id');
  check(bobRow.querySelector('.chat-location-chip') !== null, 'location chip renders from live data');

  console.log('\n=== live reply ===');
  bobRow.querySelector('.chat-hover-actions button[title="Reply"]').click();
  await wait(100);
  bob.send('replying live');
  await wait(500);
  const replyRow = alice.messages().find((n) => n.textContent.includes('replying live'));
  check(Boolean(replyRow), 'alice receives the reply');
  check(replyRow.querySelector('.chat-reply-preview')?.textContent.includes('hello from alice'), 'reply preview resolves via the server');

  console.log('\n=== live reaction ===');
  bobRow.querySelector('.chat-hover-actions button[title="Add reaction"]').click();
  await wait(150);
  const fire = bob.all('#chat-emoji-results .emoji-grid button').find((b) => b.textContent === '🔥');
  fire.click();
  await wait(500);
  const reactedAtAlice = alice.messages().find((n) => n.dataset.messageId === messageId);
  check(reactedAtAlice.querySelector('.chat-reaction')?.textContent === '🔥 1', 'reaction propagates to alice');
  check(reactedAtAlice.querySelector('.chat-reaction').title.includes(bob.local.name), 'reaction tooltip names the reactor');

  console.log('\n=== live edit and delete ===');
  const ownRow = alice.messages().find((n) => n.dataset.messageId === messageId);
  ownRow.querySelector('.chat-hover-actions button[title="Edit"]').click();
  await wait(120);
  const editor = alice.document.querySelector('.chat-inline-editor');
  editor.value = 'edited live';
  alice.press(editor, 'Enter');
  await wait(500);
  const editedAtBob = bob.messages().find((n) => n.dataset.messageId === messageId);
  check(editedAtBob.textContent.includes('edited live'), 'edit propagates to bob');
  check(editedAtBob.querySelector('.chat-edited') !== null, 'edited badge appears for bob');

  console.log('\n=== live pin ===');
  editedAtBob.querySelector('.chat-hover-actions button[title="Pin"]').click();
  await wait(500);
  check(alice.$('#chat-pins-count').hidden === false, 'pin badge appears for alice');
  alice.$('#chat-pins-toggle').click();
  await wait(120);
  check(alice.all('.pin-item').length === 1, 'pinned message listed for alice');
  check(alice.document.querySelector('.pin-item').textContent.includes('edited live'), 'pinned entry shows the edited text');
  alice.$('#chat-pins-close').click();

  console.log('\n=== live commands ===');
  alice.send('/nick Ada Lovelace');
  await wait(600);
  check(alice.$('#chat-connection').textContent.includes('Ada Lovelace'), 'rename applied for alice');
  check(alice.local.name === 'Ada Lovelace', 'rename reaches the game bridge');
  check(bob.text().includes('is now known as Ada Lovelace'), 'bob sees the rename system message');
  check(bob.all('.chat-player').some((n) => n.textContent.includes('Ada Lovelace')), 'member list updates after rename');

  await wait(5200);
  bob.send(`/w ${alice.local.name} secret message`);
  await wait(600);
  const dmRow = alice.messages().find((n) => n.classList.contains('is-dm'));
  check(Boolean(dmRow), 'alice receives the whisper');
  check(dmRow.textContent.includes('secret message'), 'whisper text delivered');
  check(!dmRow.textContent.includes('Lovelace secret'), 'multi-word name is not split into the whisper body');
  check(dmRow.classList.contains('is-mentioned'), 'whisper counts as a mention');

  await wait(5200);
  alice.send('/help');
  await wait(500);
  check(alice.text().includes('Available commands'), '/help renders privately for alice');
  check(!bob.text().includes('Available commands'), '/help is not broadcast to bob');

  console.log('\n=== live mention ===');
  await wait(5200);
  bob.send(`hey @${alice.local.name} ping`);
  await wait(600);
  const mentionRow = alice.messages().find((n) => n.textContent.includes('ping'));
  check(mentionRow.classList.contains('is-mentioned'), 'mention highlights the row for alice');
  check(mentionRow.querySelector('.chat-mention.is-me') !== null, 'mention token is marked as me');

  console.log('\n=== live delete ===');
  const toDelete = alice.messages().find((n) => n.dataset.messageId === messageId);
  toDelete.querySelector('.chat-hover-actions button[title="Delete"]').click();
  await wait(120);
  alice.document.querySelector('#chat-context-menu .confirm-row button.is-danger').click();
  await wait(600);
  const deletedAtBob = bob.messages().find((n) => n.dataset.messageId === messageId);
  check(deletedAtBob.classList.contains('is-deleted'), 'delete propagates to bob');
  check(bob.$('#chat-pins-count').hidden === true, 'deleting the pinned message clears the pin badge');

  console.log('\n=== live typing indicator ===');
  bob.type('typing something');
  await wait(600);
  check(alice.$('#chat-typing').textContent.includes(bob.local.name), 'alice sees bob typing');
  bob.type('');
  await wait(600);

  console.log('\n=== live disconnect ===');
  bob.socket.close();
  bob.window.dispatchEvent(new bob.window.CustomEvent('voxel:network-offline'));
  await wait(900);
  check(alice.text().includes(`${bob.local.name} left`), 'alice sees bob leave');
  check(bob.$('#chat-connection').dataset.state === 'offline', 'bob shows reconnecting');
  const offlineMembers = alice.all('.chat-player[data-online="false"]');
  check(offlineMembers.length >= 1, 'bob moves to the offline section for alice');

  console.log('\n=== console cleanliness ===');
  check(alice.errors.length === 0, `alice had no uncaught errors (${alice.errors.slice(0, 2).join(' | ') || 'none'})`);
  check(bob.errors.length === 0, `bob had no uncaught errors (${bob.errors.slice(0, 2).join(' | ') || 'none'})`);

  alice.socket.close();
}

run().then(() => {
  console.log('\n' + '='.repeat(60));
  if (failures.length) {
    console.log(`${failures.length} FAILURE(S):`);
    failures.forEach((item) => console.log(`  - ${item}`));
    process.exit(1);
  }
  console.log('All end-to-end checks passed.');
  process.exit(0);
}).catch((error) => {
  console.error('\nTEST HARNESS ERROR:', error);
  process.exit(1);
});
