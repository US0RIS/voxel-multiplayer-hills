/* Resolve the complete Ridgewood loader chain offline.
 *
 * v0.9 keeps the existing v0.8 entry filename as a compatibility module,
 * imports the marketplace client, then resolves v0.9 -> v0.8 base -> v0.6 ->
 * v4.3 -> the WebGL game. Both file imports and generated blob imports are
 * supported here; the final game is identified by source markers rather than a
 * brittle hard-coded depth.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

const blobs = new Map();
const fetched = [];
let gameSource = null;

globalThis.fetch = async (url) => {
  const file = path.join(DOCS, String(url).split('?')[0].replace(/^\.\//, ''));
  fetched.push(path.basename(file));
  if (!fs.existsSync(file)) return { ok: false, status: 404, text: async () => '' };
  return { ok: true, status: 200, text: async () => fs.readFileSync(file, 'utf8') };
};

globalThis.Blob = class Blob { constructor(parts) { this._text = parts.join(''); } };
globalThis.URL.createObjectURL = blob => {
  const id = `blob:ridgewood-${blobs.size}`;
  blobs.set(id, blob._text);
  return id;
};
globalThis.URL.revokeObjectURL = () => {};

const stubElement = () => new Proxy({ dataset: {}, style: {} }, {
  get: (target, key) => {
    if (key in target) return target[key];
    if (key === 'querySelector') return () => null;
    if (key === 'querySelectorAll') return () => [];
    return () => {};
  },
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

globalThis.crypto = { randomUUID: () => '00000000-0000-4000-8000-000000000000' };

async function evaluate(text) {
  const source = text.replace(/await import\(/g, 'await __ridgewoodImport(');
  return new Function('__ridgewoodImport', `return (async () => { ${source} })();`)(ridgewoodImport);
}

function isGameSource(text) {
  return text.includes("const canvas = document.querySelector('#canvas')")
    && text.includes('function renderTerrain()')
    && text.includes('function connectMultiplayer()');
}

async function ridgewoodImport(reference) {
  const value = String(reference);
  let text = blobs.get(value);
  if (text == null && !value.startsWith('blob:')) {
    const file = path.join(DOCS, value.split('?')[0].replace(/^\.\//, ''));
    if (!fs.existsSync(file)) throw new Error(`Unknown imported file: ${value}`);
    fetched.push(path.basename(file));
    // marketplace-v0.9.0.js is an ordinary UI module, not a loader transform.
    // Syntax is checked separately; it does not need a DOM execution here.
    if (path.basename(file) === 'marketplace-v0.9.0.js') return {};
    text = fs.readFileSync(file, 'utf8');
  }
  if (text == null) throw new Error(`Unknown blob: ${value}`);
  if (isGameSource(text)) {
    gameSource = text;
    return {};
  }
  await evaluate(text);
  return {};
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
  ['appendMarketplaceStructures(instances, cx, cz);', 'marketplace voxel structures'],
  ["kind: 'marketplace'", 'marketplace raycast collision'],
  ['getMarketplaceHover()', 'marketplace pointer API'],
  ['RIDGEWOOD v0.9.0 ALPHA', 'v0.9 build label']
];

console.log(`loader chain: ${fetched.join(' -> ')}`);
console.log(`game module: ${gameSource.length.toLocaleString()} bytes`);

let failures = 0;
for (const [needle, label] of REQUIRED) {
  const count = gameSource.split(needle).length - 1;
  if (count < 1) { console.error(`  MISSING  ${label}`); failures += 1; }
  else console.log(`  ok (${count})  ${label}`);
}

if (/__RIDGEWOOD_ADMIN\s*=/.test(gameSource)) {
  console.error('  The game module assigns __RIDGEWOOD_ADMIN; it must only read it.');
  failures += 1;
}

process.exit(failures ? 1 : 0);
