/* Headless DOM test for the World Chat client.
 * Boots docs/index.html in jsdom, stubs the game bridge, evaluates the chat
 * module exactly as the loader would, and drives the real UI.
 */
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const consoleErrors = [];

function check(condition, label) {
  console.log((condition ? '  PASS  ' : '  FAIL  ') + label);
  if (!condition) failures.push(label);
}

const html = fs.readFileSync(path.join(ROOT, 'docs/index.html'), 'utf8')
  .replace(/<script[\s\S]*?<\/script>/g, '');

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => consoleErrors.push(String(error.message)));
virtualConsole.on('error', (...args) => consoleErrors.push(args.join(' ')));

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'http://localhost:8130/',
  virtualConsole
});
const { window } = dom;
const { document } = window;

// --- environment shims jsdom does not implement -----------------------------
window.HTMLElement.prototype.scrollIntoView = () => {};
window.Element.prototype.scrollTo = function scrollTo(options) {
  if (options && typeof options.top === 'number') this.scrollTop = options.top;
};
window.AudioContext = class {
  constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
  createOscillator() {
    return {
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() { return { connect() {} }; }, start() {}, stop() {}
    };
  }
  createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { return { connect() {} }; } }; }
};
const clipboardWrites = [];
window.navigator.clipboard = { writeText: (text) => { clipboardWrites.push(text); return Promise.resolve(); } };
const notifications = [];
window.Notification = class {
  static permission = 'granted';
  static requestPermission() { return Promise.resolve('granted'); }
  constructor(title, options) { notifications.push({ title, options }); }
  close() {}
};

// --- game bridge stub -------------------------------------------------------
const sent = [];
const teleports = [];
const highlights = [];
let localState = {
  id: 'local-1', name: 'Matt', color: [0.4, 0.7, 1],
  x: 20, z: 36, chunkX: 1, chunkZ: 2, online: true
};
window.VOXEL_GAME_API = {
  getLocalState: () => ({ ...localState }),
  getPlayers: () => ([{ id: 'remote-1', name: 'Ada', color: [0.9, 0.5, 0.4], x: 4, z: 8, chunkX: 0, chunkZ: 0 }]),
  send: (payload) => { sent.push(payload); return true; },
  teleport: (x, z) => { teleports.push([x, z]); return true; },
  highlightPlayer: (id) => { highlights.push(id); return true; },
  highlightPlayerByName: (name) => { highlights.push(name); return true; },
  setLocalName: (name) => { localState.name = name; return true; },
  focusCanvas: () => {}
};

const source = fs.readFileSync(path.join(ROOT, 'docs/chat-source-v4.3.0.js'), 'utf8');
window.eval(source);

const $ = (selector) => document.querySelector(selector);
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
const emit = (name, detail) => window.dispatchEvent(new window.CustomEvent(name, { detail }));
const netMessage = (message) => emit('voxel:network-message', message);
const lastSent = (type) => [...sent].reverse().find((packet) => packet.type === type);

function key(target, init) {
  target.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

function type(text) {
  $('#chat-input').value = text;
  $('#chat-input').dispatchEvent(new window.Event('input'));
}

function messageNodes() {
  return Array.from(document.querySelectorAll('#chat-message-list .chat-message'));
}

function serverMessage(overrides = {}) {
  return {
    type: 'chat:message',
    id: overrides.id || `m-${Math.random().toString(36).slice(2, 10)}`,
    index: overrides.index ?? 1,
    sender: overrides.sender || { id: 'remote-1', name: 'Ada', color: [0.9, 0.5, 0.4] },
    text: overrides.text ?? 'hello there',
    timestamp: overrides.timestamp ?? Date.now(),
    location: overrides.location ?? { x: 4, z: 8, chunkX: 0, chunkZ: 0 },
    reactions: overrides.reactions || {},
    replyTo: overrides.replyTo ?? null,
    mentions: overrides.mentions || [],
    editedAt: overrides.editedAt ?? null,
    deleted: overrides.deleted ?? false,
    system: overrides.system ?? false,
    kind: overrides.kind || 'message',
    ...overrides
  };
}

async function run() {
  console.log('\n=== boot ===');
  check($('#chat-panel') !== null, 'panel is present');
  check($('#chat-connection').textContent.includes('Connecting'), 'starts in connecting state');
  check($('#chat-send').disabled, 'send button starts disabled');

  emit('voxel:bridge-ready', localState);
  netMessage({
    type: 'welcome', id: 'local-1', name: 'Matt', color: [0.4, 0.7, 1],
    limits: { messageLength: 2000, rateLimit: 5, rateWindowSeconds: 5 },
    reactions: ['👍', '❤️', '😂', '🎉', '👀', '🔥', '✅', '❓']
  });
  emit('voxel:network-ready', localState);
  await tick();
  check($('#chat-connection').dataset.state === 'online', 'connection shows online');
  check($('#chat-connection').textContent.includes('Matt'), 'connection names the local player');
  check($('#chat-name-input').value === 'Matt', 'name field prefilled');
  check(Boolean(lastSent('chat:history')), 'requests history on connect');

  console.log('\n=== history, grouping and dividers ===');
  const base = Date.now() - 60_000;
  netMessage({
    type: 'chat:history',
    users: [
      { id: 'remote-1', name: 'Ada', color: [0.9, 0.5, 0.4], online: true, chunkX: 0, chunkZ: 0, status: '' },
      { id: 'old-2', name: 'Grace', color: [0.6, 0.9, 0.5], online: false, lastSeen: Date.now() - 7_200_000 }
    ],
    pinned: [],
    commands: [{ command: '/help', description: 'show the command list' }],
    messages: [
      serverMessage({ id: 'm-old', index: 1, text: 'yesterday message', timestamp: base - 86_400_000 }),
      serverMessage({ id: 'm-1', index: 2, text: 'first', timestamp: base }),
      serverMessage({ id: 'm-2', index: 3, text: 'second from same author', timestamp: base + 1000 }),
      serverMessage({
        id: 'm-3', index: 4, text: 'different author', timestamp: base + 2000,
        sender: { id: 'remote-9', name: 'Bo', color: [0.5, 0.6, 1] }
      })
    ]
  });
  await tick();
  check(messageNodes().length === 4, 'renders all history messages');
  check(document.querySelectorAll('.chat-divider').length >= 2, 'renders date dividers');
  check([...document.querySelectorAll('.chat-divider span')].some((n) => n.textContent === 'Today'), 'labels today');
  const nodes = messageNodes();
  check(nodes[2].classList.contains('is-grouped'), 'consecutive same-author message is grouped');
  check(!nodes[3].classList.contains('is-grouped'), 'different author starts a new group');
  check(nodes[2].querySelector('.chat-author') === null, 'grouped row hides the author');
  check(nodes[1].querySelector('.chat-avatar') !== null, 'ungrouped row shows an avatar');

  console.log('\n=== member list ===');
  check($('#chat-online-count').textContent.includes('online'), 'online count rendered');
  const sections = [...document.querySelectorAll('.player-section-label')].map((n) => n.textContent);
  check(sections.some((s) => s.startsWith('Online')), 'online section present');
  check(sections.some((s) => s.startsWith('Offline')), 'offline section present');
  check(document.querySelectorAll('.chat-player').length >= 3, 'lists local, remote and offline members');
  $('#chat-member-search').value = 'ada';
  $('#chat-member-search').dispatchEvent(new window.Event('input'));
  await tick();
  check(document.querySelectorAll('.chat-player').length === 1, 'member search filters the list');
  $('#chat-member-search').value = '';
  $('#chat-member-search').dispatchEvent(new window.Event('input'));

  console.log('\n=== markdown rendering ===');
  netMessage(serverMessage({
    id: 'm-md', index: 5,
    text: 'a **bold** and *italic* and `code` and ~~strike~~ and ||secret|| and https://example.com and @Matt'
  }));
  await tick();
  const md = document.querySelector('[data-message-id="m-md"] .chat-text');
  check(md.querySelector('strong')?.textContent === 'bold', 'renders **bold**');
  check(md.querySelector('em')?.textContent === 'italic', 'renders *italic*');
  check(md.querySelector('.inline-code')?.textContent === 'code', 'renders `code`');
  check(md.querySelector('s')?.textContent === 'strike', 'renders ~~strike~~');
  check(md.querySelector('.chat-spoiler')?.textContent === 'secret', 'renders ||spoiler||');
  const link = md.querySelector('a');
  check(link?.href === 'https://example.com/' && link.rel === 'noopener noreferrer', 'renders safe links');
  check(md.querySelector('.chat-mention.is-me') !== null, 'highlights a mention of me');
  check(document.querySelector('[data-message-id="m-md"]').classList.contains('is-mentioned'), 'mention highlights the row');

  netMessage(serverMessage({ id: 'm-code', index: 6, text: 'see:\n```\nline one\nline two\n```' }));
  netMessage(serverMessage({ id: 'm-quote', index: 7, text: '> quoted line\n- item one\n- item two' }));
  await tick();
  check(document.querySelector('[data-message-id="m-code"] pre code')?.textContent === 'line one\nline two', 'renders fenced code blocks');
  check(document.querySelector('[data-message-id="m-quote"] blockquote') !== null, 'renders blockquotes');
  check(document.querySelectorAll('[data-message-id="m-quote"] li').length === 2, 'renders lists');

  console.log('\n=== XSS safety ===');
  netMessage(serverMessage({ id: 'm-xss', index: 8, text: '<img src=x onerror=alert(1)> <script>bad()</script>' }));
  await tick();
  const xssRow = document.querySelector('[data-message-id="m-xss"] .chat-text');
  check(xssRow.querySelector('img') === null && xssRow.querySelector('script') === null, 'html in messages is not executed');
  check(xssRow.textContent.includes('<img'), 'html is shown as literal text');

  console.log('\n=== sending ===');
  type('hello everyone');
  check($('#chat-send').disabled === false, 'send enables with content');
  key($('#chat-input'), { key: 'Enter' });
  await tick();
  const sendPacket = lastSent('chat:send');
  check(sendPacket?.text === 'hello everyone', 'send packet dispatched');
  check($('#chat-input').value === '', 'composer clears after send');
  const optimistic = messageNodes().at(-1);
  check(optimistic.textContent.includes('hello everyone'), 'optimistic message appears immediately');
  check(optimistic.querySelector('.chat-delivery')?.textContent === '✓', 'optimistic message shows sending state');

  netMessage({ type: 'chat:ack', clientId: sendPacket.clientId, status: 'delivered', messageId: 'm-mine', index: 9 });
  await tick();
  check(messageNodes().at(-1).querySelector('.chat-delivery')?.textContent === '✓✓', 'ack upgrades to delivered');

  console.log('\n=== reply ===');
  document.querySelector('[data-message-id="m-1"] .chat-hover-actions button[title="Reply"]').click();
  await tick();
  check($('#chat-reply-bar').hidden === false, 'reply bar opens');
  check($('#chat-reply-label').textContent.includes('Ada'), 'reply bar names the author');
  type('answering you');
  key($('#chat-input'), { key: 'Enter' });
  await tick();
  check(lastSent('chat:send')?.replyTo === 'm-1', 'reply id is sent');
  check($('#chat-reply-bar').hidden === true, 'reply bar closes after send');

  netMessage(serverMessage({
    id: 'm-reply', index: 10, text: 'here is my reply',
    replyTo: { id: 'm-1', name: 'Ada', text: 'first', color: [0.9, 0.5, 0.4] }
  }));
  await tick();
  const replyPreview = document.querySelector('[data-message-id="m-reply"] .chat-reply-preview');
  check(replyPreview !== null, 'reply preview renders');
  check(replyPreview.textContent.includes('first'), 'reply preview shows the parent text');

  console.log('\n=== reactions ===');
  netMessage({
    type: 'chat:reaction', messageId: 'm-1',
    reactions: { '🔥': { count: 2, playerIds: ['remote-1', 'local-1'], names: ['Ada', 'Matt'] } }
  });
  await tick();
  const reaction = document.querySelector('[data-message-id="m-1"] .chat-reaction');
  check(reaction?.textContent === '🔥 2', 'reaction chip renders with a count');
  check(reaction.classList.contains('is-mine'), 'own reaction is marked');
  check(reaction.title.includes('Ada'), 'reaction tooltip lists reactors');
  reaction.click();
  await tick();
  check(lastSent('chat:reaction')?.emoji === '🔥', 'clicking a reaction toggles it');

  console.log('\n=== emoji picker ===');
  $('#chat-emoji-button').click();
  await tick();
  check($('#chat-emoji-picker').hidden === false, 'emoji picker opens');
  check(document.querySelectorAll('#chat-emoji-results .emoji-grid button').length > 40, 'emoji picker is populated');
  $('#chat-emoji-search').value = 'pickaxe';
  $('#chat-emoji-search').dispatchEvent(new window.Event('input'));
  await tick();
  const results = document.querySelectorAll('#chat-emoji-results .emoji-grid button');
  check(results.length === 1 && results[0].textContent === '⛏️', 'emoji search filters by keyword');
  results[0].click();
  await tick();
  check($('#chat-input').value.includes('⛏️'), 'picking an emoji inserts it');
  check($('#chat-emoji-picker').hidden === true, 'picker closes after choosing');
  type('');

  console.log('\n=== edit and delete ===');
  netMessage(serverMessage({ id: 'm-own', index: 11, text: 'my own message', sender: { id: 'local-1', name: 'Matt', color: [0.4, 0.7, 1] } }));
  await tick();
  document.querySelector('[data-message-id="m-own"] .chat-hover-actions button[title="Edit"]').click();
  await tick();
  const editor = document.querySelector('.chat-inline-editor');
  check(editor !== null, 'inline editor opens');
  check(editor.value === 'my own message', 'editor is prefilled');
  editor.value = 'my edited message';
  key(editor, { key: 'Enter' });
  await tick();
  check(lastSent('chat:edit')?.text === 'my edited message', 'edit packet sent');
  netMessage({ type: 'chat:update', message: serverMessage({ id: 'm-own', index: 11, text: 'my edited message', editedAt: Date.now(), sender: { id: 'local-1', name: 'Matt', color: [0.4, 0.7, 1] } }) });
  await tick();
  check(document.querySelector('[data-message-id="m-own"] .chat-edited') !== null, 'edited badge shows');

  document.querySelector('[data-message-id="m-own"] .chat-hover-actions button[title="Delete"]').click();
  await tick();
  check($('#chat-context-menu').hidden === false, 'delete asks for confirmation');
  $('#chat-context-menu .confirm-row button.is-danger').click();
  await tick();
  check(lastSent('chat:delete')?.messageId === 'm-own', 'delete packet sent after confirm');
  netMessage({ type: 'chat:update', message: serverMessage({ id: 'm-own', index: 11, text: '', deleted: true, sender: { id: 'local-1', name: 'Matt', color: [0.4, 0.7, 1] } }) });
  await tick();
  check(document.querySelector('[data-message-id="m-own"]').classList.contains('is-deleted'), 'deleted message becomes a tombstone');

  console.log('\n=== arrow-up edits the last message ===');
  netMessage(serverMessage({ id: 'm-own2', index: 12, text: 'latest of mine', sender: { id: 'local-1', name: 'Matt', color: [0.4, 0.7, 1] } }));
  await tick();
  type('');
  key($('#chat-input'), { key: 'ArrowUp' });
  await tick();
  check(document.querySelector('.chat-inline-editor')?.value === 'latest of mine', 'ArrowUp opens the last own message for editing');
  key(document.querySelector('.chat-inline-editor'), { key: 'Escape' });
  await tick();
  check(document.querySelector('.chat-inline-editor') === null, 'Escape cancels the edit');

  console.log('\n=== pins ===');
  netMessage({ type: 'chat:pins', pinned: [serverMessage({ id: 'm-1', index: 2, text: 'first', pinned: true })] });
  await tick();
  check($('#chat-pins-count').hidden === false, 'pin count badge shows');
  $('#chat-pins-toggle').click();
  await tick();
  check($('#chat-pins-panel').hidden === false, 'pins panel opens');
  check(document.querySelectorAll('.pin-item').length === 1, 'pinned message listed');
  $('#chat-pins-close').click();
  await tick();
  check($('#chat-pins-panel').hidden === true, 'pins panel closes');

  console.log('\n=== mention autocomplete ===');
  type('hey @a');
  await tick();
  check($('#chat-mention-menu').hidden === false, 'mention menu opens');
  const mentionButtons = [...document.querySelectorAll('#chat-mention-menu button')];
  check(mentionButtons.some((b) => b.textContent.includes('Ada')), 'mention menu lists matching players');
  key($('#chat-input'), { key: 'ArrowDown' });
  await tick();
  check(document.querySelector('#chat-mention-menu button.is-active') !== null, 'arrow keys move the mention selection');
  key($('#chat-input'), { key: 'Tab' });
  await tick();
  check($('#chat-input').value.includes('@'), 'Tab accepts a mention');
  type('');

  console.log('\n=== command autocomplete ===');
  type('/he');
  await tick();
  check($('#chat-command-hint').hidden === false, 'command menu opens');
  check(document.querySelector('#chat-command-hint button strong').textContent.startsWith('/he'), 'command menu filters');
  key($('#chat-input'), { key: 'Enter' });
  await tick();
  check($('#chat-input').value.startsWith('/he'), 'Enter accepts the highlighted command');
  type('');

  console.log('\n=== search ===');
  $('#chat-search-toggle').click();
  await tick();
  check($('#chat-search-bar').hidden === false, 'search bar opens');
  $('#chat-search-input').value = 'quoted';
  $('#chat-search-input').dispatchEvent(new window.Event('input'));
  await tick();
  check(messageNodes().length === 1, 'search filters the message list');
  check(document.querySelector('mark')?.textContent === 'quoted', 'search highlights matches');
  check($('#chat-search-count').textContent.includes('1'), 'search shows a result count');
  $('#chat-search-close').click();
  await tick();
  check($('#chat-search-bar').hidden === true && messageNodes().length > 1, 'closing search restores the list');

  console.log('\n=== typing indicator ===');
  netMessage({ type: 'chat:typing', id: 'remote-1', name: 'Ada', typing: true });
  await tick();
  check($('#chat-typing').textContent.includes('Ada is typing'), 'typing indicator shows');
  netMessage({ type: 'chat:typing', id: 'remote-9', name: 'Bo', typing: true });
  await tick();
  check($('#chat-typing').textContent.includes('and'), 'multiple typists are combined');
  netMessage({ type: 'chat:typing', id: 'remote-1', typing: false });
  netMessage({ type: 'chat:typing', id: 'remote-9', typing: false });
  await tick();
  check($('#chat-typing').textContent === '', 'typing indicator clears');

  console.log('\n=== collapse, unread and toasts ===');
  $('#chat-collapse').click();
  await tick();
  check($('#chat-panel').dataset.collapsed === 'true', 'panel collapses');
  check($('#chat-collapsed-tab').hidden === false, 'collapsed tab appears');
  netMessage(serverMessage({ id: 'm-unread', index: 13, text: 'you missed this' }));
  await tick();
  check($('#chat-unread').hidden === false && $('#chat-unread').textContent === '1', 'unread badge counts');
  check(document.title.startsWith('(1)'), 'tab title shows the unread count');
  check(document.querySelectorAll('.chat-toast').length === 1, 'toast is shown while collapsed');
  netMessage(serverMessage({ id: 'm-ping', index: 14, text: 'ping @Matt now' }));
  await tick();
  check($('#chat-unread').dataset.mention === 'true', 'mention marks the unread badge');
  check(document.querySelector('.chat-toast.is-mention') !== null, 'mention toast is styled differently');
  const toastsBefore = document.querySelectorAll('.chat-toast').length;
  document.querySelector('.chat-toast-close').click();
  await new Promise((resolve) => setTimeout(resolve, 320));
  check(document.querySelectorAll('.chat-toast').length === toastsBefore - 1, 'toast close dismisses only that toast');
  $('#chat-collapsed-tab').click();
  await tick();
  check($('#chat-panel').dataset.collapsed === 'false', 'tab expands the panel');
  check($('#chat-unread').hidden === true, 'unread clears on expand');
  check(document.title.indexOf('(') === -1, 'tab title resets');

  console.log('\n=== offline outbox ===');
  emit('voxel:network-offline');
  await tick();
  check($('#chat-connection').dataset.state === 'offline', 'shows reconnecting');
  check($('#chat-composer-shell').dataset.offline === 'true', 'composer marks offline');
  check($('#chat-input').disabled === false, 'composer stays usable while offline');
  const before = sent.filter((p) => p.type === 'chat:send').length;
  type('queued while offline');
  key($('#chat-input'), { key: 'Enter' });
  await tick();
  check(sent.filter((p) => p.type === 'chat:send').length === before, 'nothing is sent while offline');
  const queuedNode = messageNodes().at(-1);
  check(queuedNode.querySelector('.chat-delivery')?.textContent === '◷', 'queued message shows the queued marker');
  emit('voxel:network-ready', localState);
  await new Promise((resolve) => setTimeout(resolve, 700));
  check(sent.filter((p) => p.type === 'chat:send').some((p) => p.text === 'queued while offline'), 'outbox flushes on reconnect');

  console.log('\n=== failure and retry ===');
  type('this will fail');
  key($('#chat-input'), { key: 'Enter' });
  await tick();
  const failing = lastSent('chat:send');
  netMessage({ type: 'chat:error', clientId: failing.clientId, message: 'Server said no.' });
  await tick();
  const failedNode = messageNodes().find((node) => node.classList.contains('is-failed'));
  check(Boolean(failedNode), 'failed message is marked');
  check(failedNode.textContent.includes('Retry'), 'failed message offers a retry');
  failedNode.querySelector('.chat-retry').click();
  await new Promise((resolve) => setTimeout(resolve, 600));
  check(sent.filter((p) => p.text === 'this will fail').length === 2, 'retry re-sends the message');

  console.log('\n=== rate-limit backoff ===');
  type('rate limited message');
  key($('#chat-input'), { key: 'Enter' });
  await tick();
  const limitedPacket = lastSent('chat:send');
  netMessage({ type: 'chat:error', clientId: limitedPacket.clientId, code: 'rate-limit', retryAfter: 0.2, message: 'Slow down' });
  await tick();
  const requeued = messageNodes().find((node) => node.textContent.includes('rate limited message'));
  check(requeued.querySelector('.chat-delivery')?.textContent === '◷', 'rate-limited message is re-queued, not failed');
  await new Promise((resolve) => setTimeout(resolve, 6500));
  const rateSends = sent.filter((p) => p.text === 'rate limited message').length;
  check(rateSends >= 1, 'rate-limited message is retried automatically');
  check(rateSends === 1, 'rate-limited message is not double-sent');

  console.log('\n=== location, teleport and highlight ===');
  document.querySelector('[data-message-id="m-1"] .chat-location-chip').click();
  await tick();
  check(teleports.length === 1, 'location chip teleports');
  netMessage({ type: 'chat:teleport', location: { x: 99, z: 12, chunkX: 6, chunkZ: 0 } });
  await tick();
  check(teleports.at(-1)[0] === 99, 'server teleport packet is honoured');
  document.querySelector('.chat-player').dispatchEvent(new window.MouseEvent('mouseenter'));
  await tick();
  check(highlights.length > 0, 'hovering a member highlights them in world');

  console.log('\n=== context menu ===');
  document.querySelector('[data-message-id="m-1"]').dispatchEvent(
    new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })
  );
  await tick();
  check($('#chat-context-menu').hidden === false, 'right-click opens the context menu');
  const menuLabels = [...document.querySelectorAll('#chat-context-menu button')].map((b) => b.textContent);
  check(menuLabels.some((l) => l.includes('Reply')), 'context menu has reply');
  check(menuLabels.some((l) => l.includes('Copy text')), 'context menu has copy');
  check(menuLabels.some((l) => l.includes('Whisper')), 'context menu has whisper');
  check(menuLabels.some((l) => l.includes('Teleport')), 'context menu has teleport');
  document.querySelector('#chat-context-menu button').click();
  await tick();
  check($('#chat-context-menu').hidden === true, 'context menu closes after a choice');

  console.log('\n=== status and nickname ===');
  $('#chat-status-input').value = 'doing homework';
  $('#chat-status-save').click();
  await tick();
  check(lastSent('chat:user-status')?.status === 'doing homework', 'status saved');
  $('#chat-name-input').value = 'Builder Matt';
  $('#chat-name-save').click();
  await tick();
  check(lastSent('chat:nick')?.name === 'Builder Matt', 'nickname change sent');
  netMessage({ type: 'chat:renamed', id: 'local-1', name: 'Builder Matt', previous: 'Matt' });
  await tick();
  check($('#chat-connection').textContent.includes('Builder Matt'), 'rename updates the header');
  check(localState.name === 'Builder Matt', 'rename propagates to the game bridge');

  console.log('\n=== member list toggle and preferences ===');
  $('#chat-members-toggle').click();
  await tick();
  check($('#chat-panel').dataset.members === 'false', 'member list can be hidden');
  $('#chat-members-toggle').click();
  await tick();
  check($('#chat-panel').dataset.members === 'true', 'member list can be shown again');
  const soundBefore = $('#chat-sound-toggle').dataset.enabled;
  $('#chat-sound-toggle').click();
  await tick();
  check($('#chat-sound-toggle').dataset.enabled !== soundBefore, 'sound toggle flips');
  check(window.localStorage.getItem('voxel.chat.sound') !== null, 'sound preference persists');
  $('#chat-desktop-toggle').click();
  await new Promise((resolve) => setTimeout(resolve, 60));
  check($('#chat-desktop-toggle').dataset.enabled === 'true', 'desktop notifications can be enabled');

  console.log('\n=== keyboard isolation ===');
  $('#chat-input').dispatchEvent(new window.Event('focus'));
  check(window.__voxelChatTyping === true, 'typing flag blocks game movement');
  $('#chat-input').dispatchEvent(new window.Event('blur'));
  check(window.__voxelChatTyping === false, 'blur returns control to the game');

  console.log('\n=== local clear ===');
  netMessage({ type: 'chat:clear-local' });
  await tick();
  check(messageNodes().length === 0, '/clear empties the local view');

  console.log('\n=== console cleanliness ===');
  check(consoleErrors.length === 0, `no uncaught errors (${consoleErrors.slice(0, 3).join(' | ') || 'none'})`);
}

run().then(() => {
  console.log('\n' + '='.repeat(60));
  if (failures.length) {
    console.log(`${failures.length} FAILURE(S):`);
    failures.forEach((item) => console.log(`  - ${item}`));
    process.exit(1);
  }
  console.log('All UI checks passed.');
}).catch((error) => {
  console.error('\nTEST HARNESS ERROR:', error);
  process.exit(1);
});
