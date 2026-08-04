/* Resolve the whole game-loader chain offline and assert the v0.8.0 admin
 * patches actually land on the game source.
 *
 * The loaders are four levels of text deltas:
 *
 *   game-loader-v0.8.0.js → v0.6.0 → v4.3.0 → multiplayer-hills-v4.1.0.js
 *
 * Every level asserts on its anchors, so a stale anchor throws here instead of
 * in a player's browser. `fetch`, `Blob`, `URL.createObjectURL` and the dynamic
 * import are stubbed; the game module itself is captured rather than executed,
 * because it needs WebGL.
 *
 *     node tests/loader-chain-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

const blobs = new Map();
const fetched = [];
let depth = 0;
let gameSource = null;

globalThis.fetch = async (url) => {
  const file = path.join(DOCS, String(url).split('?')[0].replace(/^\.\//, ''));
  fetched.push(path.basename(file));
  if (!fs.existsSync(file)) return { ok: false, status: 404, text: async () => '' };
  return { ok: true, status: 200, text: async () => fs.readFileSync(file, 'utf8') };
};

globalThis.Blob = class Blob { constructor(parts) { this._text = parts.join(''); } };
globalThis.URL.createObjectURL = (blob) => {
  const id = `blob:ridgewood-${blobs.size}`;
  blobs.set(id, blob._text);
  return id;
};
globalThis.URL.revokeObjectURL = () => {};

const stubElement = () => new Proxy({ dataset: {}, style: {} }, {
  get: (target, key) => (key in target ? target[key] : () => {}),
  set: (target, key, value) => { target[key] = value; return true; }
});

globalThis.document = {
  createElement: stubElement,
  head: { append() {} },
  body: { append() {} },
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}
};
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.addEventListener = () => {};

async function evaluate(text) {
  // The loaders end with `await import(blobUrl)`; route that to our stub.
  const source = text.replace(/await import\(/g, 'await __ridgewoodImport(');
  return new Function('__ridgewoodImport', `return (async () => { ${source} })();`)(ridgewoodImport);
}

async function ridgewoodImport(blobUrl) {
  const text = blobs.get(blobUrl);
  if (text == null) throw new Error(`Unknown blob: ${blobUrl}`);
  depth += 1;
  try {
    // Depth 3 is the game module itself. Capture it; running it needs WebGL.
    if (depth >= 3) { gameSource = text; return {}; }
    await evaluate(text);
    return {};
  } finally {
    depth -= 1;
  }
}

await evaluate(fs.readFileSync(path.join(DOCS, 'game-loader-v0.8.0.js'), 'utf8'));

if (!gameSource) {
  console.error('The loader chain never produced a game module.');
  process.exit(1);
}

const REQUIRED = [
  ['WALK_SPEED * (Number(window.__RIDGEWOOD_ADMIN?.speed) || 1) * dt', 'staff movement speed'],
  ['if (rwAdmin && rwAdmin.staff && rwAdmin.flying) {', 'flight collision bypass'],
  ['player.y = clamp(player.y + lift * climb * dt, 0.5, 180);', 'vertical flight'],
  ['const owns = worldOwnsChunk(record) || rwOverride;', 'build override'],
  ['distance <= rwMaxReach', 'staff build reach'],
  ['adminOverride: Boolean(window.__RIDGEWOOD_ADMIN?.buildOverride)', 'override flag on edits'],
  ['RIDGEWOOD v0.8.0 ALPHA', 'build label']
];

console.log(`loader chain: ${fetched.join(' -> ')}`);
console.log(`game module: ${gameSource.length.toLocaleString()} bytes`);

let failures = 0;
for (const [needle, label] of REQUIRED) {
  const count = gameSource.split(needle).length - 1;
  if (count < 1) { console.error(`  MISSING  ${label}`); failures += 1; }
  else console.log(`  ok (${count})  ${label}`);
}

// The game must never grant a power on its own: the flag is only ever read.
if (/__RIDGEWOOD_ADMIN\s*=/.test(gameSource)) {
  console.error('  The game module assigns __RIDGEWOOD_ADMIN; it must only read it.');
  failures += 1;
}

process.exit(failures ? 1 : 0);
