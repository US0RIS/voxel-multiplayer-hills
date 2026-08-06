/* Ridgewood v0.9.0 delta loader: physical marketplace hub.
 *
 * This extends the existing v0.8 loader chain without replacing the renderer.
 * The injected functions generate twenty deterministic voxel stalls in chunk
 * 0,0 and make them participate in collision and cursor raycasting.
 */
const LOADER_URL = './game-loader-v0.8.0.js?v=0.9.0-base';

const response = await fetch(LOADER_URL, { cache: 'no-store' });
if (!response.ok) throw new Error(`Ridgewood v0.8.0 loader failed to load (${response.status}).`);
let loader = await response.text();

function replaceRequired(search, replacement, label) {
  if (!loader.includes(search)) throw new Error(`Ridgewood v0.9.0 upgrade failed (${label}).`);
  loader = loader.replace(search, replacement);
}

const MARKETPLACE_FUNCTIONS = String.raw`
function marketplacePublicStalls() {
  const supplied = window.RIDGEWOOD_MARKETPLACE?.getStalls?.();
  if (Array.isArray(supplied) && supplied.length) return supplied;
  const stalls = [];
  for (let number = 1; number <= 20; number += 1) {
    stalls.push({
      id: number,
      stall_number: number,
      name: 'Stall ' + number,
      claimed: false,
      owner_id: null,
      listings: [],
      location: {
        chunk_x: 0,
        chunk_z: 0,
        x: 1.5 + ((number - 1) % 5) * 3,
        y: 0,
        z: 1.5 + Math.floor((number - 1) / 5) * 4
      }
    });
  }
  return stalls;
}

let marketplaceVoxelCache = { signature: '', voxels: new Map() };

function marketplaceListingBlock(stall) {
  const type = String(stall?.listings?.[0]?.item_type || '').toLowerCase();
  if (type === 'resource') return BLOCK_STONE;
  if (type === 'house') return BLOCK_DIRT;
  return BLOCK_GRASS;
}

function marketplaceVoxelMap() {
  const stalls = marketplacePublicStalls();
  const signature = stalls.map(stall => [
    stall.id, stall.owner_id || '', stall.name || '',
    ...(stall.listings || []).map(listing => listing.id + ':' + listing.item_type)
  ].join(':')).join('|') + ':' + terrain.seed;
  if (marketplaceVoxelCache.signature === signature) return marketplaceVoxelCache.voxels;

  const voxels = new Map();
  const put = (worldX, y, worldZ, type, stall) => {
    voxels.set(worldX + ':' + y + ':' + worldZ, {
      kind: 'marketplace', type, stallNumber: Number(stall.stall_number), stallId: stall.id
    });
  };

  for (const stall of stalls) {
    const centerX = Math.floor(Number(stall.location?.x ?? stall.stall_x ?? 0));
    const centerZ = Math.floor(Number(stall.location?.z ?? stall.stall_z ?? 0));
    if (centerX < 0 || centerX >= CHUNK_SIZE || centerZ < 0 || centerZ >= CHUNK_SIZE) continue;
    const ground = baseTerrainHeightForBuild(centerX, centerZ);
    const displayType = marketplaceListingBlock(stall);

    for (const x of [centerX - 1, centerX]) {
      put(x, ground, centerZ, BLOCK_STONE, stall);
      put(x, ground, centerZ + 1, BLOCK_STONE, stall);
      put(x, ground + 3, centerZ + 1, stall.claimed ? BLOCK_GRASS : BLOCK_STONE, stall);
    }
    put(centerX - 1, ground + 1, centerZ + 1, BLOCK_DIRT, stall);
    put(centerX, ground + 1, centerZ + 1, BLOCK_DIRT, stall);
    put(centerX - 1, ground + 2, centerZ + 1, BLOCK_DIRT, stall);
    put(centerX, ground + 2, centerZ + 1, BLOCK_DIRT, stall);
    put(centerX, ground + 1, centerZ, displayType, stall);
  }

  marketplaceVoxelCache = { signature, voxels };
  return voxels;
}

function marketplaceVoxelAt(worldX, y, worldZ) {
  return marketplaceVoxelMap().get(worldX + ':' + y + ':' + worldZ) || null;
}

function appendMarketplaceStructures(instances, cx, cz) {
  if (cx !== 0 || cz !== 0) return;
  for (const [key, value] of marketplaceVoxelMap()) {
    const [worldX, y, worldZ] = key.split(':').map(Number);
    instances.push(worldX + 0.5, y + 0.5, worldZ + 0.5, value.type);
  }
}

function refreshMarketplaceHub() {
  marketplaceVoxelCache.signature = '';
  if (terrain?.chunks?.has('0,0')) rebuildWorldChunk(0, 0);
}
`;

const EXTRA_PATCHES = [
  [
    "  chunkBorderSignature: ''\n};",
    "  chunkBorderSignature: '',\n  marketplaceHover: null\n};",
    'marketplace hover state'
  ],
  [
    "function worldChunkKey(cx, cz) { return String(cx) + ',' + String(cz); }",
    "function worldChunkKey(cx, cz) { return String(cx) + ',' + String(cz); }\n" + MARKETPLACE_FUNCTIONS,
    'marketplace voxel functions'
  ],
  [
    `function occupiedVoxelAt(worldX, y, worldZ) {
  if (![worldX, y, worldZ].every(Number.isFinite)) return null;
  const entry = worldVoxelEntry(worldX, y, worldZ);
  if (entry.value?.action === 'remove') return null;
  if (entry.value?.action === 'place') {
    return {
      kind: 'placed',
      type: BLOCK_NAME_TO_TYPE[entry.value?.block?.type] ?? BLOCK_STONE,
      ...entry
    };
  }
  const height = baseTerrainHeightForBuild(worldX, worldZ);
  if (y >= WORLD_FLOOR && y < height) {
    return { kind: y === WORLD_FLOOR ? 'bedrock' : 'terrain', type: baseVoxelType(worldX, y, worldZ, height), ...entry };
  }
  return null;
}`,
    `function occupiedVoxelAt(worldX, y, worldZ) {
  if (![worldX, y, worldZ].every(Number.isFinite)) return null;
  const entry = worldVoxelEntry(worldX, y, worldZ);
  if (entry.value?.action === 'remove') return null;
  if (entry.value?.action === 'place') {
    return {
      kind: 'placed',
      type: BLOCK_NAME_TO_TYPE[entry.value?.block?.type] ?? BLOCK_STONE,
      ...entry
    };
  }
  const marketplace = marketplaceVoxelAt(worldX, y, worldZ);
  if (marketplace) return { ...marketplace, ...entry };
  const height = baseTerrainHeightForBuild(worldX, worldZ);
  if (y >= WORLD_FLOOR && y < height) {
    return { kind: y === WORLD_FLOOR ? 'bedrock' : 'terrain', type: baseVoxelType(worldX, y, worldZ, height), ...entry };
  }
  return null;
}`,
    'marketplace collision and raycast'
  ],
  [
    `  const result = raycastWorld(worldState.pointerX, worldState.pointerY);
  if (!result) return null;
  const cell = worldState.buildMode === 'delete'`,
    `  const result = raycastWorld(worldState.pointerX, worldState.pointerY);
  if (!result) {
    worldState.marketplaceHover = null;
    return null;
  }
  worldState.marketplaceHover = result.hit?.occupied?.kind === 'marketplace'
    ? { stallNumber: result.hit.occupied.stallNumber, stallId: result.hit.occupied.stallId }
    : null;
  const cell = worldState.buildMode === 'delete'`,
    'marketplace pointer target'
  ],
  [
    `  reconcileWorldVoxels(instances, cx, cz);
  const instanceData = new Float32Array(instances);`,
    `  reconcileWorldVoxels(instances, cx, cz);
  appendMarketplaceStructures(instances, cx, cz);
  const instanceData = new Float32Array(instances);`,
    'marketplace terrain instances'
  ],
  [
    `  focusCanvas() { canvas.focus(); }`,
    `  getMarketplaceHover() { return worldState.marketplaceHover ? { ...worldState.marketplaceHover } : null; },
  refreshMarketplaceHub,
  focusCanvas() { canvas.focus(); }`,
    'marketplace game API'
  ]
];

replaceRequired(
  'const GAME_PATCHES = [',
  'const GAME_PATCHES = [\n' + EXTRA_PATCHES.map(item => '  ' + JSON.stringify(item) + ',').join('\n'),
  'marketplace game patches'
);
replaceRequired("'RIDGEWOOD v0.8.0 ALPHA'", "'RIDGEWOOD v0.9.0 ALPHA'", 'build label');
replaceRequired("'ridgewood-0-8-0'", "'ridgewood-0-9-0'", 'source label');

const blobUrl = URL.createObjectURL(new Blob([loader], { type: 'text/javascript' }));
try { await import(blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
