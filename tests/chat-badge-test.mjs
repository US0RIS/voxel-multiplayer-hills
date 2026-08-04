/* Verify staff chat prominence without touching the chat module.
 *
 * admin-v0.8.0.js decorates the rendered chat DOM instead of modifying the chat
 * client, so this suite builds the DOM the chat client actually produces, feeds
 * the script the same network events the server sends, and asserts the badges
 * and rails land in the right places.
 *
 * Requires jsdom:  npm install --no-save jsdom
 *     node tests/chat-badge-test.mjs
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

/* The markup below mirrors createMessageElement / createPlayerRow in
 * docs/chat-source-v4.3.0.js. If the chat client's class names ever change,
 * this suite fails — which is the point. */
const dom = new JSDOM(`<!doctype html><html><body>
  <div id="chat-message-list">
    <article class="chat-message" data-message-id="m1">
      <div class="chat-message-body"><div class="chat-message-meta">
        <button class="chat-author">Admin</button>
      </div><div class="chat-text">first</div></div>
    </article>
    <article class="chat-message is-grouped" data-message-id="m2">
      <div class="chat-message-body"><div class="chat-text">grouped follow-up</div></div>
    </article>
    <article class="chat-message" data-message-id="m3">
      <div class="chat-message-body"><div class="chat-message-meta">
        <button class="chat-author">Griefer</button>
      </div><div class="chat-text">hello</div></div>
    </article>
    <article class="chat-message" data-message-id="m4">
      <div class="chat-message-body"><div class="chat-message-meta">
        <button class="chat-author">Mod</button>
      </div><div class="chat-text">behave</div></div>
    </article>
    <article class="chat-message is-system" data-message-id="m5">
      <div class="chat-message-body"><div class="chat-message-meta">
        <button class="chat-author">World</button>
      </div><div class="chat-text">Griefer was kicked by Admin.</div></div>
    </article>
  </div>
  <div id="chat-player-list">
    <button class="chat-player"><span class="player-details"><strong>Admin (you)</strong><span>Chunk 0, 0</span></span></button>
    <button class="chat-player"><span class="player-details"><strong>Griefer</strong><span>Chunk 3, 1</span></span></button>
  </div>
</body></html>`, { pretendToBeVisual: true });

const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLInputElement = window.HTMLInputElement;
globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
globalThis.MutationObserver = window.MutationObserver;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.addEventListener = window.addEventListener.bind(window);
globalThis.CustomEvent = window.CustomEvent;

// The script self-registers on window; run it in this context.
const source = fs.readFileSync(path.join(ROOT, 'docs', 'admin-v0.8.0.js'), 'utf8');
new Function(source)();

function emit(detail) {
  window.dispatchEvent(new window.CustomEvent('voxel:network-message', { detail }));
}

// Exactly what the patched server sends.
emit({
  type: 'chat:users',
  users: [
    { id: 'u1', name: 'Admin', role: 'admin' },
    { id: 'u2', name: 'Griefer', role: 'player' },
    { id: 'u3', name: 'Mod', role: 'moderator' }
  ]
});

await new Promise((resolve) => setTimeout(resolve, 20));

const results = [];
const check = (label, actual, expected) =>
  results.push([JSON.stringify(actual) === JSON.stringify(expected), label,
                `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`]);

const msg = (id) => window.document.querySelector(`[data-message-id="${id}"]`);
const badgeText = (node) => node.querySelector('[data-ridgewood-role-badge]')?.textContent ?? null;

check('admin message gets the admin rail', msg('m1').dataset.senderRole, 'admin');
check('admin message gets an ADMIN badge', badgeText(msg('m1')), 'ADMIN');
check('grouped follow-up inherits the rail', msg('m2').dataset.senderRole, 'admin');
check('grouped follow-up has no duplicate badge', badgeText(msg('m2')), null);
check('ordinary player gets no rail', msg('m3').dataset.senderRole, undefined);
check('ordinary player gets no badge', badgeText(msg('m3')), null);
check('moderator gets the mod rail', msg('m4').dataset.senderRole, 'moderator');
check('moderator gets a MOD badge', badgeText(msg('m4')), 'MOD');
check('system notice is left alone', msg('m5').dataset.senderRole, undefined);

const rows = [...window.document.querySelectorAll('.chat-player')];
check('member list badges the admin', rows[0].dataset.memberRole, 'admin');
check('"(you)" suffix still resolves', badgeText(rows[0]), 'ADMIN');
check('member list leaves players plain', rows[1].dataset.memberRole, undefined);

// A demotion must clear the badge, not leave it stuck.
emit({ type: 'chat:users', users: [{ id: 'u1', name: 'Admin', role: 'player' }] });
await new Promise((resolve) => setTimeout(resolve, 20));
check('demotion clears the rail', msg('m1').dataset.senderRole, undefined);
check('demotion removes the badge', badgeText(msg('m1')), null);
check('demotion clears the grouped rail', msg('m2').dataset.senderRole, undefined);

// Re-promotion must not stack duplicate badges.
emit({ type: 'chat:users', users: [{ id: 'u1', name: 'Admin', role: 'admin' }] });
await new Promise((resolve) => setTimeout(resolve, 20));
check('re-promotion restores one badge',
  msg('m1').querySelectorAll('[data-ridgewood-role-badge]').length, 1);

console.log();
let failed = 0;
for (const [ok, label, detail] of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  — ${detail}`}`);
  if (!ok) failed += 1;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
