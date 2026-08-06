/* Ridgewood v0.9.1 delta loader: GLB-derived market street. */
const LOADER_URL = './game-loader-v0.8.0.js?v=0.9.1-base';
const response = await fetch(LOADER_URL, { cache: 'no-store' });
if (!response.ok) throw new Error(`Ridgewood v0.8.0 loader failed to load (${response.status}).`);
let loader = await response.text();

function replaceRequired(search, replacement, label) {
  if (!loader.includes(search)) throw new Error(`Ridgewood v0.9.1 upgrade failed (${label}).`);
  loader = loader.replace(search, replacement);
}

const MARKETPLACE_FUNCTIONS = String.raw`
let marketStallProgram = null;
let marketStallVoxels = null;
let marketStallVao = null;
let marketStallInstanceBuffer = null;
let marketStallInstanceCount = 0;
let marketStallSignature = '';

function marketplaceStreetPlacement(stallOrNumber) {
  const number = Number(stallOrNumber?.stall_number ?? stallOrNumber?.stallNumber ?? stallOrNumber);
  const pair = number <= 10 ? number - 1 : number - 11;
  const west = number <= 10;
  return { number, x: west ? 4.0 : 13.0, z: -20.25 + pair * 4.5,
    angle: west ? -Math.PI / 2 : Math.PI / 2, chunkX: 0,
    chunkZ: Math.floor((-20.25 + pair * 4.5) / CHUNK_SIZE) };
}

function marketplacePublicStalls() {
  const supplied = window.RIDGEWOOD_MARKETPLACE?.getStalls?.();
  const source = Array.isArray(supplied) && supplied.length ? supplied : Array.from({ length: 20 }, (_, index) => ({
    id: index + 1, stall_number: index + 1, name: 'Stall ' + (index + 1),
    claimed: false, owner_id: null, listings: []
  }));
  return source.map(stall => {
    const placement = marketplaceStreetPlacement(stall);
    return { ...stall, stall_number: placement.number, location: {
      ...(stall.location || {}), world_id: 'public', chunk_x: placement.chunkX,
      chunk_z: placement.chunkZ, x: placement.x, y: 0, z: placement.z,
      angle: placement.angle
    }};
  });
}

async function decodeMarketStallAsset() {
  if (marketStallVoxels) return marketStallVoxels;
  const asset = window.RIDGEWOOD_MARKET_STALL_ASSET;
  if (!asset || asset.encoding !== 'gzip+base64+uint8x4') throw new Error('The supplied market stall asset is missing or invalid.');
  const binary = atob(asset.data);
  const compressed = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) compressed[index] = binary.charCodeAt(index);
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  if (bytes.length !== asset.count * 4) throw new Error('The market stall asset data is corrupt.');
  marketStallVoxels = bytes;
  return bytes;
}

function createMarketStallRenderer() {
  marketStallProgram = createProgram(marketStallVertexShader, marketStallFragmentShader);
  marketStallVao = gl.createVertexArray();
  gl.bindVertexArray(marketStallVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, terrain.positionBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, terrain.normalBuffer);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  marketStallInstanceBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, marketStallInstanceBuffer);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 16, 0);
  gl.vertexAttribDivisor(2, 1);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, terrain.indexBuffer);
}

function marketStallGround(placement) { return baseTerrainHeightForBuild(placement.x, placement.z); }

function rebuildMarketStallInstances() {
  if (!marketStallVoxels || !marketStallInstanceBuffer || !terrain) return;
  const asset = window.RIDGEWOOD_MARKET_STALL_ASSET;
  const stalls = marketplacePublicStalls();
  const signature = stalls.map(stall => [stall.id, stall.owner_id || '', stall.name || '',
    ...(stall.listings || []).map(listing => listing.id + ':' + listing.item_type)].join(':')).join('|') + ':' + terrain.seed;
  if (signature === marketStallSignature) return;
  marketStallSignature = signature;
  const values = new Float32Array(stalls.length * asset.count * 4);
  const origin = asset.origin;
  const size = asset.voxelSize;
  let cursor = 0;
  for (const stall of stalls) {
    const placement = marketplaceStreetPlacement(stall);
    const ground = marketStallGround(placement);
    const c = Math.cos(placement.angle), s = Math.sin(placement.angle);
    for (let index = 0; index < marketStallVoxels.length; index += 4) {
      const localX = origin[0] + marketStallVoxels[index] * size;
      const localY = origin[1] + marketStallVoxels[index + 1] * size;
      const localZ = origin[2] + marketStallVoxels[index + 2] * size;
      values[cursor++] = placement.x + c * localX + s * localZ;
      values[cursor++] = ground + localY - asset.bounds.min[1];
      values[cursor++] = placement.z - s * localX + c * localZ;
      values[cursor++] = marketStallVoxels[index + 3];
    }
  }
  marketStallInstanceCount = cursor / 4;
  gl.bindBuffer(gl.ARRAY_BUFFER, marketStallInstanceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, values, gl.STATIC_DRAW);
}

function renderMarketStalls() {
  if (!marketStallProgram || !marketStallInstanceCount) return;
  gl.useProgram(marketStallProgram.program);
  gl.bindVertexArray(marketStallVao);
  gl.uniformMatrix4fv(marketStallProgram.uniforms.uViewProjection, false, viewProjection);
  gl.uniform3f(marketStallProgram.uniforms.uLightDirection, -0.48, 0.82, 0.34);
  gl.uniform3f(marketStallProgram.uniforms.uCameraPosition, camera.position[0], camera.position[1], camera.position[2]);
  gl.uniform3f(marketStallProgram.uniforms.uFogColor, FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2]);
  gl.uniform1f(marketStallProgram.uniforms.uVoxelSize, window.RIDGEWOOD_MARKET_STALL_ASSET.voxelSize * 0.98);
  const colors = window.RIDGEWOOD_MARKET_STALL_ASSET.colors;
  for (let index = 0; index < colors.length; index += 1) gl.uniform4fv(marketStallProgram.uniforms['uColors[' + index + ']'], colors[index]);
  gl.drawElementsInstanced(gl.TRIANGLES, terrain.indexCount, gl.UNSIGNED_SHORT, 0, marketStallInstanceCount);
}

function marketplaceStallAtVoxel(worldX, y, worldZ) {
  for (const stall of marketplacePublicStalls()) {
    const placement = marketplaceStreetPlacement(stall);
    const ground = marketStallGround(placement);
    if (y < ground || y > ground + 3.35) continue;
    const dx = worldX + 0.5 - placement.x;
    const dz = worldZ + 0.5 - placement.z;
    const c = Math.cos(-placement.angle), s = Math.sin(-placement.angle);
    const localX = c * dx + s * dz;
    const localZ = -s * dx + c * dz;
    if (Math.abs(localX) <= 1.92 && Math.abs(localZ) <= 1.08) return {
      kind: 'marketplace', type: BLOCK_STONE, stallNumber: placement.number, stallId: stall.id
    };
  }
  return null;
}

function refreshMarketplaceHub() { marketStallSignature = ''; rebuildMarketStallInstances(); }
`;

const MARKETPLACE_SHADERS = String.raw`
const marketStallVertexShader = \`#version 300 es
precision highp float;
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aWorldAndMaterial;
uniform mat4 uViewProjection;
uniform float uVoxelSize;
out vec3 vWorldPosition;
out vec3 vNormal;
flat out int vMaterial;
void main() {
  vec3 world = aWorldAndMaterial.xyz + aPosition * uVoxelSize;
  vWorldPosition = world; vNormal = aNormal; vMaterial = int(aWorldAndMaterial.w + 0.5);
  gl_Position = uViewProjection * vec4(world, 1.0);
}\`;
const marketStallFragmentShader = \`#version 300 es
precision highp float;
precision highp int;
in vec3 vWorldPosition;
in vec3 vNormal;
flat in int vMaterial;
uniform vec4 uColors[10];
uniform vec3 uLightDirection;
uniform vec3 uCameraPosition;
uniform vec3 uFogColor;
out vec4 outColor;
void main() {
  vec3 normal = normalize(vNormal);
  float diffuse = max(dot(normal, normalize(uLightDirection)), 0.0);
  float hemisphere = normal.y * 0.5 + 0.5;
  vec3 color = uColors[clamp(vMaterial, 0, 9)].rgb * (0.42 + diffuse * 0.52 + hemisphere * 0.12);
  float fog = smoothstep(50.0, 92.0, distance(uCameraPosition, vWorldPosition));
  outColor = vec4(mix(color, uFogColor, fog), 1.0);
}\`;
`;

const EXTRA_PATCHES = [
  ["  chunkBorderSignature: ''\n};", "  chunkBorderSignature: '',\n  marketplaceHover: null\n};", 'marketplace hover state'],
  ["function worldChunkKey(cx, cz) { return String(cx) + ',' + String(cz); }", "function worldChunkKey(cx, cz) { return String(cx) + ',' + String(cz); }\n" + MARKETPLACE_FUNCTIONS, 'marketplace street functions'],
  [`function occupiedVoxelAt(worldX, y, worldZ) {
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
}`, `function occupiedVoxelAt(worldX, y, worldZ) {
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
  const marketplace = marketplaceStallAtVoxel(worldX, y, worldZ);
  if (marketplace) return { ...marketplace, ...entry };
  const height = baseTerrainHeightForBuild(worldX, worldZ);
  if (y >= WORLD_FLOOR && y < height) {
    return { kind: y === WORLD_FLOOR ? 'bedrock' : 'terrain', type: baseVoxelType(worldX, y, worldZ, height), ...entry };
  }
  return null;
}`, 'marketplace collision'],
  [`  const result = raycastWorld(worldState.pointerX, worldState.pointerY);
  if (!result) return null;
  const cell = worldState.buildMode === 'delete'`, `  const result = raycastWorld(worldState.pointerX, worldState.pointerY);
  if (!result) { worldState.marketplaceHover = null; return null; }
  worldState.marketplaceHover = result.hit?.occupied?.kind === 'marketplace'
    ? { stallNumber: result.hit.occupied.stallNumber, stallId: result.hit.occupied.stallId } : null;
  const cell = worldState.buildMode === 'delete'`, 'marketplace pointer target'],
  [`  renderTerrain();
  renderAllShadows();`, `  renderTerrain();
  renderMarketStalls();
  renderAllShadows();`, 'marketplace rendering'],
  [`  terrain = createTerrainGeometry();
  shadowVao = createShadowGeometry();`, `  terrain = createTerrainGeometry();
  shadowVao = createShadowGeometry();
  createMarketStallRenderer();
  loadingText.textContent = 'Loading marketplace stalls…';
  await decodeMarketStallAsset();`, 'marketplace asset loading'],
  [`  updateVisibleChunks(true);
}`, `  updateVisibleChunks(true);
  rebuildMarketStallInstances();
}`, 'marketplace rebuild'],
  [`  focusCanvas() { canvas.focus(); }`, `  getMarketplaceHover() { return worldState.marketplaceHover ? { ...worldState.marketplaceHover } : null; },
  refreshMarketplaceHub,
  focusCanvas() { canvas.focus(); }`, 'marketplace API'],
  ["const shadowVertexShader = `#version 300 es", MARKETPLACE_SHADERS + "\nconst shadowVertexShader = `#version 300 es", 'marketplace shaders']
];

replaceRequired('const GAME_PATCHES = [', 'const GAME_PATCHES = [\n' + EXTRA_PATCHES.map(item => '  ' + JSON.stringify(item) + ',').join('\n'), 'marketplace game patches');
replaceRequired("'RIDGEWOOD v0.8.0 ALPHA'", "'RIDGEWOOD v0.9.1 ALPHA'", 'build label');
replaceRequired("'ridgewood-0-8-0'", "'ridgewood-0-9-1'", 'source label');
const blobUrl = URL.createObjectURL(new Blob([loader], { type: 'text/javascript' }));
try { await import(blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
