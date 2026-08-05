/* Guard against infinite recursion in the terrain height chain.
 *
 * This reproduces a real outage. The v4.3.0 loader wraps one terrain function
 * in overlayColumnHeight() so placed blocks raise the effective ground. Its
 * anchor is `return clamp(height, MIN_HEIGHT, MAX_HEIGHT);` and it replaces the
 * FIRST match. v0.6.0 later injected baseTerrainHeightForBuild(), which ends in
 * that same line and sits earlier in the file, so the wrapper landed on the
 * wrong function. v0.6.0 also rewrote overlayColumnHeight() to call
 * occupiedVoxelAt(), which calls baseTerrainHeightForBuild(), closing a loop:
 *
 *   baseTerrainHeightForBuild -> overlayColumnHeight
 *                             -> occupiedVoxelAt -> baseTerrainHeightForBuild
 *
 * It recursed on the very first terrain lookup. Because that lookup happens in
 * regenerateTerrain() inside handleWelcome(), the RangeError fired before the
 * promise that hides the loading overlay resolved, and every player sat on
 * "Connecting to multiplayer room..." forever.
 *
 * Reading the source is not enough to catch this -- the patches all applied
 * cleanly and every assertion passed. So this suite actually EXECUTES the
 * terrain functions from the fully assembled game module.
 *
 *     node tests/terrain-recursion-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');

// ---------------------------------------------------------- build the module

const blobs = new Map();
let depth = 0;
let game = null;

globalThis.fetch = async (url) => {
  const file = path.join(DOCS, String(url).split('?')[0].replace(/^\.\//, ''));
  return fs.existsSync(file)
    ? { ok: true, status: 200, text: async () => fs.readFileSync(file, 'utf8') }
    : { ok: false, status: 404, text: async () => '' };
};
globalThis.Blob = class { constructor(parts) { this._text = parts.join(''); } };
globalThis.URL.createObjectURL = (b) => { const id = `blob:${blobs.size}`; blobs.set(id, b._text); return id; };
globalThis.URL.revokeObjectURL = () => {};
const stub = () => new Proxy({ dataset: {}, style: {} }, {
  get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; }
});
globalThis.document = { createElement: stub, head: { append() {} }, body: { append() {} },
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {} };
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.addEventListener = () => {};

async function run(text) {
  return new Function('__i', `return (async () => { ${text.replace(/await import\(/g, 'await __i(')} })();`)(
    async (u) => { const t = blobs.get(u); depth += 1;
      try { if (depth >= 3) { game = t; return {}; } await run(t); return {}; } finally { depth -= 1; } });
}

await run(fs.readFileSync(path.join(DOCS, 'game-loader-v0.8.0.js'), 'utf8'));
if (!game) { console.error('loader chain produced no game module'); process.exit(1); }

// ------------------------------------------- extract the pure terrain layer

function extract(name) {
  const i = game.indexOf(`function ${name}(`);
  if (i < 0) return null;
  let depthBrace = 0;
  for (let k = game.indexOf('{', i); k < game.length; k++) {
    if (game[k] === '{') depthBrace += 1;
    else if (game[k] === '}') { depthBrace -= 1; if (!depthBrace) return game.slice(i, k + 1); }
  }
  return null;
}

const NAMES = ['fbm', 'valueNoise', 'hashGrid', 'smoothCurve', 'smoothstep', 'mix', 'clamp',
  'getBaseTerrainHeight', 'getTerrainCellHeight', 'getTerrainHeight', 'baseTerrainHeightForBuild',
  'overlayColumnHeight', 'occupiedVoxelAt', 'worldVoxelEntry', 'baseVoxelType', 'getSurfaceType',
  'supportHeightAt', 'worldChunkKey', 'positiveLocal', 'reconcileWorldVoxels', 'canOccupyPlayerAt',
  'resolvePlayerGround'];

const missing = [];
let code = '';
for (const n of NAMES) { const body = extract(n); if (body) code += body + '\n'; else missing.push(n); }
if (missing.length) { console.error('missing functions:', missing.join(', ')); process.exit(1); }

const prelude = `
const MIN_HEIGHT=2, MAX_HEIGHT=14, CHUNK_SIZE=16, WORLD_FLOOR=0, MAX_STEP_HEIGHT=1.05;
const PLAYER_RADIUS=0.34, PLAYER_HEIGHT=1.72;
const PLAYER_COLLISION_SAMPLES=[[0,0],[PLAYER_RADIUS,0],[-PLAYER_RADIUS,0],[0,PLAYER_RADIUS],[0,-PLAYER_RADIUS],
  [PLAYER_RADIUS*0.72,PLAYER_RADIUS*0.72],[PLAYER_RADIUS*0.72,-PLAYER_RADIUS*0.72],
  [-PLAYER_RADIUS*0.72,PLAYER_RADIUS*0.72],[-PLAYER_RADIUS*0.72,-PLAYER_RADIUS*0.72]];
const player={x:0.5,y:7,z:0.5,groundY:7};
const BLOCK_GRASS=0, BLOCK_DIRT=1, BLOCK_STONE=2;
const BLOCK_NAME_TO_TYPE={grass:0,dirt:1,stone:2};
const terrain={seed:4102026,chunks:new Map()};
const worldState={chunks:new Map()};
`;
const api = new Function(prelude + code +
  `return { baseTerrainHeightForBuild, getTerrainHeight, getTerrainCellHeight, occupiedVoxelAt,
            supportHeightAt, reconcileWorldVoxels, canOccupyPlayerAt, resolvePlayerGround };`)();

// ---------------------------------------------------------------- exercise

const results = [];
function check(label, fn) {
  try { const v = fn(); results.push([Number.isFinite(v) || typeof v === 'boolean' || v === null || typeof v === 'object', label, v]); }
  catch (e) { results.push([false, label, `${e.name}: ${e.message}`]); }
}

check('baseTerrainHeightForBuild(0, 0)', () => api.baseTerrainHeightForBuild(0, 0));
check('getTerrainCellHeight(0, 0)',      () => api.getTerrainCellHeight(0, 0));
check('getTerrainHeight(0.5, 0.5)',      () => api.getTerrainHeight(0.5, 0.5));
check('supportHeightAt(0, 0, 12)',       () => api.supportHeightAt(0, 0, 12));
check('supportHeightAt at fly height',   () => api.supportHeightAt(0, 0, 180));

// A spread of columns, including the blended spawn clearing and far terrain.
let sampled = 0;
const started = Date.now();
try {
  for (let x = -64; x <= 64; x += 8) {
    for (let z = -64; z <= 64; z += 8) {
      const b = api.baseTerrainHeightForBuild(x, z);
      const g = api.getTerrainHeight(x + 0.5, z + 0.5);
      if (!Number.isFinite(b) || !Number.isFinite(g)) throw new Error(`non-finite at ${x},${z}`);
      sampled += 1;
    }
  }
  results.push([true, `${sampled} columns sampled in ${Date.now() - started}ms`, 'no RangeError']);
} catch (e) {
  results.push([false, `column sweep (failed after ${sampled})`, `${e.name}: ${e.message}`]);
}

// reconcileWorldVoxels() is the function that actually threw in production: it
// runs for every chunk inside regenerateTerrain(), which handleWelcome() calls.
// Exercising it is the closest thing to reproducing the original hang.
try {
  const began = Date.now();
  let cells = 0;
  for (const [cx, cz] of [[0, 0], [1, 0], [-1, 2], [3, -4]]) {
    const instances = [];
    api.reconcileWorldVoxels(instances, cx, cz);
    if (instances.length % 4 !== 0) throw new Error('malformed instance buffer');
    cells += instances.length / 4;
  }
  results.push([cells > 0, `reconcileWorldVoxels over 4 chunks in ${Date.now() - began}ms`,
    `${cells} voxels emitted`]);
} catch (e) {
  results.push([false, 'reconcileWorldVoxels (the function that crashed)', `${e.name}: ${e.message}`]);
}

check('canOccupyPlayerAt(0.5, 0.5, 7)', () => api.canOccupyPlayerAt(0.5, 0.5, 7));
check('resolvePlayerGround(0.5, 0.5, 7)', () => api.resolvePlayerGround(0.5, 0.5, 7));

// The loop must not come back: nothing may call overlayColumnHeight from
// baseTerrainHeightForBuild ever again.
const owner = (() => {
  const m = /return overlayColumnHeight\(/.exec(game);
  if (!m) return 'nobody';
  const s = game.lastIndexOf('function ', m.index);
  return game.slice(s, game.indexOf('(', s)).replace('function ', '').trim();
})();
results.push([owner === 'getTerrainCellHeight', `overlayColumnHeight wrapped into ${owner}`,
  owner === 'getTerrainCellHeight' ? 'correct target' : 'WRONG TARGET — recursion risk']);

console.log();
let failed = 0;
for (const [ok, label, detail] of results) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail !== undefined ? `  -> ${detail}` : ''}`);
  if (!ok) failed += 1;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
