/* Ridgewood v0.5.1 loader: chat bridge + persistent cursor building. */
const GAME_SOURCE_URL = './multiplayer-hills-v4.1.0.js?v=0.5.1';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Ridgewood integration could not patch the game (${label}).`);
  return source.replace(search, replacement);
}

async function loadGame() {
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = 'world-v0.5.0.css?v=0.5.1';
  document.head.append(stylesheet);

  const response = await fetch(GAME_SOURCE_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Game source failed to load (${response.status}).`);
  let source = await response.text();

  source = replaceRequired(
    source,
    'const jointPalette = new Float32Array(JOINT_COUNT * 16);',
    `const jointPalette = new Float32Array(JOINT_COUNT * 16);

const worldState = {
  id: 'public',
  persistent: false,
  userId: '',
  claimLimit: 4,
  claims: new Map(),
  chunks: new Map(),
  selectedBlock: 'grass',
  buildMode: 'place',
  feedbackTimer: 0,
  lastChunkRequest: '',
  chunkLoadTimer: 0,
  chunksLoading: false,
  showChunkBorders: localStorage.getItem('ridgewood.showChunkBorders') === '1',
  hudCollapsed: localStorage.getItem('ridgewood.buildHudCollapsed') === '1',
  hud: null,
  loader: null,
  pointerInside: false,
  pointerX: 0,
  pointerY: 0,
  preview: null,
  interactionProgram: null,
  previewVao: null,
  previewLineVao: null,
  previewLineCount: 0,
  chunkBorderVao: null,
  chunkBorderBuffer: null,
  chunkBorderVertexCount: 0,
  chunkBorderSignature: ''
};

const BLOCK_NAME_TO_TYPE = { grass: BLOCK_GRASS, dirt: BLOCK_DIRT, stone: BLOCK_STONE };
const BLOCK_PREVIEW_COLORS = {
  grass: [0.38, 0.76, 0.22, 0.34],
  dirt: [0.48, 0.27, 0.12, 0.34],
  stone: [0.48, 0.50, 0.54, 0.34]
};

function worldChunkKey(cx, cz) { return String(cx) + ',' + String(cz); }
function worldOwnsChunk(record) { return Boolean(record?.ownerId && record.ownerId === worldState.userId); }
function positiveLocal(value) { return ((value % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE; }

function ensureWorldHud() {
  if (worldState.hud) return worldState.hud;
  const hud = document.createElement('section');
  hud.id = 'world-hud';
  hud.setAttribute('aria-label', 'Building controls');
  hud.dataset.collapsed = String(worldState.hudCollapsed);
  hud.innerHTML =
    '<div class="world-hud-head">' +
      '<div class="world-hud-title"><strong id="world-chunk-title">Chunk 0, 0</strong><span id="world-chunk-owner">Loading ownership…</span></div>' +
      '<div class="world-hud-head-actions"><button id="world-claim" type="button">Claim</button><button id="world-hud-toggle" type="button" aria-label="Show or hide building controls" title="Show or hide building controls (B)"><kbd>B</kbd></button></div>' +
    '</div>' +
    '<div class="world-hud-body">' +
      '<div class="world-mode" aria-label="Building mode">' +
        '<button id="world-place" class="world-action" type="button" aria-pressed="true">Place</button>' +
        '<button id="world-remove" class="world-action" type="button" aria-pressed="false">Delete <kbd>N</kbd></button>' +
      '</div>' +
      '<div class="world-tools" aria-label="Block palette">' +
        '<button class="world-block" data-world-block="grass" aria-pressed="true"><span class="world-swatch world-swatch--grass"></span>Grass <kbd>1</kbd></button>' +
        '<button class="world-block" data-world-block="dirt" aria-pressed="false"><span class="world-swatch world-swatch--dirt"></span>Dirt <kbd>2</kbd></button>' +
        '<button class="world-block" data-world-block="stone" aria-pressed="false"><span class="world-swatch world-swatch--stone"></span>Stone <kbd>3</kbd></button>' +
      '</div>' +
      '<div id="world-feedback">Select a block, point at the world, then click to place it.</div>' +
      '<div class="world-shortcuts"><kbd>C</kbd> claim · <kbd>B</kbd> hide/show panel · <kbd>N</kbd> delete mode · click the ghost block to build</div>' +
    '</div>';
  document.body.append(hud);
  hud.querySelector('#world-claim').addEventListener('click', claimCurrentChunk);
  hud.querySelector('#world-hud-toggle').addEventListener('click', toggleWorldHud);
  hud.querySelector('#world-place').addEventListener('click', () => setBuildMode('place'));
  hud.querySelector('#world-remove').addEventListener('click', () => setBuildMode('delete'));
  for (const button of hud.querySelectorAll('[data-world-block]')) {
    button.addEventListener('click', () => selectWorldBlock(button.dataset.worldBlock));
  }
  worldState.hud = hud;
  updateWorldHud();
  return hud;
}

function ensureWorldLoader() {
  if (worldState.loader) return worldState.loader;
  const loader = document.createElement('div');
  loader.id = 'world-block-loader';
  loader.hidden = true;
  loader.setAttribute('role', 'status');
  loader.setAttribute('aria-live', 'polite');
  loader.innerHTML = '<span class="world-loader-wheel" aria-hidden="true"></span><span>Loading player-built blocks…</span>';
  document.body.append(loader);
  worldState.loader = loader;
  return loader;
}

function setChunksLoading(active) {
  worldState.chunksLoading = Boolean(active);
  const loader = ensureWorldLoader();
  loader.hidden = !worldState.chunksLoading;
  clearTimeout(worldState.chunkLoadTimer);
  if (worldState.chunksLoading) {
    worldState.chunkLoadTimer = setTimeout(() => {
      worldState.chunksLoading = false;
      loader.hidden = true;
      worldFeedback('Player-built blocks are taking longer than expected to load.', 'error');
    }, 20000);
  }
}

function worldFeedback(text, state = '') {
  const hud = ensureWorldHud();
  const node = hud.querySelector('#world-feedback');
  node.textContent = text;
  node.dataset.state = state;
  clearTimeout(worldState.feedbackTimer);
  worldState.feedbackTimer = setTimeout(() => { node.dataset.state = ''; }, 3500);
}

function toggleWorldHud(force) {
  worldState.hudCollapsed = typeof force === 'boolean' ? force : !worldState.hudCollapsed;
  localStorage.setItem('ridgewood.buildHudCollapsed', worldState.hudCollapsed ? '1' : '0');
  ensureWorldHud().dataset.collapsed = String(worldState.hudCollapsed);
}

function setBuildMode(mode) {
  if (mode !== 'place' && mode !== 'delete') return;
  worldState.buildMode = mode;
  const hud = ensureWorldHud();
  hud.querySelector('#world-place').setAttribute('aria-pressed', String(mode === 'place'));
  hud.querySelector('#world-remove').setAttribute('aria-pressed', String(mode === 'delete'));
  canvas.dataset.buildMode = mode;
  worldFeedback(mode === 'place'
    ? 'Placement mode: click the ghost block to place it.'
    : 'Delete mode: click the red ghost block to remove it.');
}

function selectWorldBlock(type) {
  if (!(type in BLOCK_NAME_TO_TYPE)) return;
  worldState.selectedBlock = type;
  setBuildMode('place');
  for (const button of ensureWorldHud().querySelectorAll('[data-world-block]')) {
    button.setAttribute('aria-pressed', String(button.dataset.worldBlock === type));
  }
  worldFeedback('Selected ' + type + '. Point and click to place.');
}

function currentWorldChunk() {
  return { chunkX: Math.floor(player.x / CHUNK_SIZE), chunkZ: Math.floor(player.z / CHUNK_SIZE) };
}

function currentChunkRecord() {
  const current = currentWorldChunk();
  return worldState.chunks.get(worldChunkKey(current.chunkX, current.chunkZ)) || {
    chunkX: current.chunkX, chunkZ: current.chunkZ, ownerId: null, voxelData: {}, revision: 0
  };
}

function updateWorldHud() {
  const hud = ensureWorldHud();
  const current = currentWorldChunk();
  const record = currentChunkRecord();
  const owns = worldOwnsChunk(record);
  const claimed = Boolean(record.ownerId);
  hud.querySelector('#world-chunk-title').textContent = 'Chunk ' + current.chunkX + ', ' + current.chunkZ;
  hud.querySelector('#world-chunk-owner').textContent = owns
    ? 'Your claim · revision ' + String(record.revision || 0)
    : claimed ? 'Claimed by another player' : 'Unclaimed land';
  const claim = hud.querySelector('#world-claim');
  claim.disabled = claimed || !network.ready || !worldState.persistent;
  claim.textContent = owns ? 'Owned' : claimed ? 'Claimed' : 'Claim';
  hud.querySelector('#world-place').disabled = !network.ready;
  hud.querySelector('#world-remove').disabled = !network.ready;
  hud.querySelector('#world-place').setAttribute('aria-pressed', String(worldState.buildMode === 'place'));
  hud.querySelector('#world-remove').setAttribute('aria-pressed', String(worldState.buildMode === 'delete'));
}

function sendWorld(payload) {
  const socket = network.socket;
  if (!network.ready || !socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function claimCurrentChunk() {
  const current = currentWorldChunk();
  if (!sendWorld({ type: 'world:claim', chunkX: current.chunkX, chunkZ: current.chunkZ })) {
    worldFeedback('World server is not connected.', 'error');
  } else {
    worldFeedback('Claim request sent…');
  }
}

function actionId() {
  return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  });
}

function normalizeChunk(record) {
  const chunkX = Number(record?.chunkX ?? record?.chunk_x);
  const chunkZ = Number(record?.chunkZ ?? record?.chunk_z);
  return {
    worldId: record?.worldId ?? record?.world_id ?? worldState.id,
    chunkX, chunkZ,
    ownerId: record?.ownerId ?? record?.owner_id ?? null,
    claimedAt: record?.claimedAt ?? record?.claimed_at ?? null,
    voxelData: record?.voxelData ?? record?.voxel_data ?? {},
    revision: Number(record?.revision) || 0,
    updatedAt: record?.updatedAt ?? record?.updated_at ?? null
  };
}

function applyWorldChunk(record) {
  const chunk = normalizeChunk(record);
  if (!Number.isFinite(chunk.chunkX) || !Number.isFinite(chunk.chunkZ)) return;
  const key = worldChunkKey(chunk.chunkX, chunk.chunkZ);
  worldState.chunks.set(key, chunk);
  if (worldOwnsChunk(chunk)) worldState.claims.set(key, chunk);
  else worldState.claims.delete(key);
  if (terrain?.chunks?.has(key)) rebuildWorldChunk(chunk.chunkX, chunk.chunkZ);
  worldState.chunkBorderSignature = '';
  updateWorldHud();
}

function rebuildWorldChunk(cx, cz) {
  const key = worldChunkKey(cx, cz);
  const previous = terrain.chunks.get(key);
  if (previous) {
    gl.deleteBuffer(previous.instanceBuffer);
    gl.deleteVertexArray(previous.vao);
  }
  terrain.chunks.set(key, createTerrainChunk(cx, cz));
}

function appendWorldOverlay(instances, cx, cz) {
  const record = worldState.chunks.get(worldChunkKey(cx, cz));
  if (!record) return;
  for (const [key, value] of Object.entries(record.voxelData || {})) {
    const parts = key.split(':').map(Number);
    const localX = parts[0], y = parts[1], localZ = parts[2];
    if (![localX, y, localZ].every(Number.isFinite) || value?.action !== 'place') continue;
    const type = BLOCK_NAME_TO_TYPE[value?.block?.type] ?? BLOCK_STONE;
    instances.push(cx * CHUNK_SIZE + localX + 0.5, y + 0.5, cz * CHUNK_SIZE + localZ + 0.5, type);
  }
}

function overlayColumnHeight(worldCellX, worldCellZ, baseHeight) {
  const cx = Math.floor(worldCellX / CHUNK_SIZE);
  const cz = Math.floor(worldCellZ / CHUNK_SIZE);
  const localX = positiveLocal(worldCellX);
  const localZ = positiveLocal(worldCellZ);
  const record = worldState.chunks.get(worldChunkKey(cx, cz));
  let height = baseHeight;
  for (const [key, value] of Object.entries(record?.voxelData || {})) {
    const parts = key.split(':').map(Number);
    if (parts[0] === localX && parts[2] === localZ && value?.action === 'place') {
      height = Math.max(height, parts[1] + 1);
    }
  }
  return height;
}

function baseTerrainHeightForBuild(worldCellX, worldCellZ) {
  let height = getBaseTerrainHeight(worldCellX, worldCellZ);
  const distance = Math.hypot(worldCellX, worldCellZ);
  if (distance < 7) {
    const centerHeight = getBaseTerrainHeight(0, 0);
    const blend = smoothstep(2.0, 7.0, distance);
    height = Math.round(mix(centerHeight, height, blend));
  }
  return clamp(height, MIN_HEIGHT, MAX_HEIGHT);
}

function placedVoxelAt(worldX, y, worldZ) {
  const chunkX = Math.floor(worldX / CHUNK_SIZE);
  const chunkZ = Math.floor(worldZ / CHUNK_SIZE);
  const localX = positiveLocal(worldX);
  const localZ = positiveLocal(worldZ);
  const record = worldState.chunks.get(worldChunkKey(chunkX, chunkZ));
  const value = record?.voxelData?.[String(localX) + ':' + String(y) + ':' + String(localZ)];
  return value?.action === 'place' ? { kind: 'placed', value, record, chunkX, chunkZ, localX, localZ } : null;
}

function occupiedVoxelAt(worldX, y, worldZ) {
  const placed = placedVoxelAt(worldX, y, worldZ);
  if (placed) return placed;
  if (y < baseTerrainHeightForBuild(worldX, worldZ)) return { kind: 'terrain' };
  return null;
}

function invertWorldMatrix(out, a) {
  const a00=a[0],a01=a[1],a02=a[2],a03=a[3],a10=a[4],a11=a[5],a12=a[6],a13=a[7];
  const a20=a[8],a21=a[9],a22=a[10],a23=a[11],a30=a[12],a31=a[13],a32=a[14],a33=a[15];
  const b00=a00*a11-a01*a10,b01=a00*a12-a02*a10,b02=a00*a13-a03*a10,b03=a01*a12-a02*a11;
  const b04=a01*a13-a03*a11,b05=a02*a13-a03*a12,b06=a20*a31-a21*a30,b07=a20*a32-a22*a30;
  const b08=a20*a33-a23*a30,b09=a21*a32-a22*a31,b10=a21*a33-a23*a31,b11=a22*a33-a23*a32;
  let det=b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06;
  if (!det) return false;
  det=1/det;
  out[0]=(a11*b11-a12*b10+a13*b09)*det; out[1]=(a02*b10-a01*b11-a03*b09)*det;
  out[2]=(a31*b05-a32*b04+a33*b03)*det; out[3]=(a22*b04-a21*b05-a23*b03)*det;
  out[4]=(a12*b08-a10*b11-a13*b07)*det; out[5]=(a00*b11-a02*b08+a03*b07)*det;
  out[6]=(a32*b02-a30*b05-a33*b01)*det; out[7]=(a20*b05-a22*b02+a23*b01)*det;
  out[8]=(a10*b10-a11*b08+a13*b06)*det; out[9]=(a01*b08-a00*b10-a03*b06)*det;
  out[10]=(a30*b04-a31*b02+a33*b00)*det; out[11]=(a21*b02-a20*b04-a23*b00)*det;
  out[12]=(a11*b07-a10*b09-a12*b06)*det; out[13]=(a00*b09-a01*b07+a02*b06)*det;
  out[14]=(a31*b01-a30*b03-a32*b00)*det; out[15]=(a20*b03-a21*b01+a22*b00)*det;
  return true;
}

function unprojectWorld(inv, x, y, z) {
  const w = inv[3]*x + inv[7]*y + inv[11]*z + inv[15];
  if (!w) return null;
  return [
    (inv[0]*x + inv[4]*y + inv[8]*z + inv[12]) / w,
    (inv[1]*x + inv[5]*y + inv[9]*z + inv[13]) / w,
    (inv[2]*x + inv[6]*y + inv[10]*z + inv[14]) / w
  ];
}

function raycastWorld(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
  const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
  const inverse = new Float32Array(16);
  if (!invertWorldMatrix(inverse, viewProjection)) return null;
  const near = unprojectWorld(inverse, ndcX, ndcY, -1);
  const far = unprojectWorld(inverse, ndcX, ndcY, 1);
  if (!near || !far) return null;
  const dx = far[0]-near[0], dy = far[1]-near[1], dz = far[2]-near[2];
  const length = Math.hypot(dx, dy, dz) || 1;
  const direction = [dx/length, dy/length, dz/length];
  let previousEmpty = null;
  let previousKey = '';
  for (let t = 0; t <= 90; t += 0.07) {
    const worldX = Math.floor(near[0] + direction[0] * t);
    const y = Math.floor(near[1] + direction[1] * t);
    const worldZ = Math.floor(near[2] + direction[2] * t);
    const key = String(worldX) + ':' + String(y) + ':' + String(worldZ);
    if (key === previousKey) continue;
    previousKey = key;
    const occupied = occupiedVoxelAt(worldX, y, worldZ);
    if (occupied) return { hit: { worldX, y, worldZ, occupied }, place: previousEmpty };
    previousEmpty = { worldX, y, worldZ };
  }
  return null;
}

function targetFromPointer() {
  if (!worldState.pointerInside || !network.ready || window.__ridgewoodMenuOpen) return null;
  const result = raycastWorld(worldState.pointerX, worldState.pointerY);
  if (!result) return null;
  const cell = worldState.buildMode === 'delete'
    ? (result.hit?.occupied?.kind === 'placed' ? result.hit : null)
    : result.place;
  if (!cell) return null;
  const chunkX = Math.floor(cell.worldX / CHUNK_SIZE);
  const chunkZ = Math.floor(cell.worldZ / CHUNK_SIZE);
  const localX = positiveLocal(cell.worldX);
  const localZ = positiveLocal(cell.worldZ);
  const record = worldState.chunks.get(worldChunkKey(chunkX, chunkZ));
  const distance = Math.hypot(
    cell.worldX + 0.5 - player.x,
    cell.y + 0.5 - player.y,
    cell.worldZ + 0.5 - player.z
  );
  const owns = worldOwnsChunk(record);
  const valid = owns && distance <= 8.0 && cell.y >= -64 && cell.y <= 96;
  return {
    ...cell, chunkX, chunkZ, localX, localZ, record, distance, valid,
    reason: !owns ? 'You can only build inside one of your claimed chunks.'
      : distance > 8.0 ? 'Move closer to that block.' : 'That location cannot be edited.'
  };
}

function performBuildClick() {
  const target = worldState.preview;
  if (!target) return;
  if (!target.valid) return worldFeedback(target.reason, 'error');
  if (worldState.buildMode === 'delete') {
    sendWorld({
      type: 'world:edit', clientActionId: actionId(), action: 'remove',
      chunkX: target.chunkX, chunkZ: target.chunkZ, localX: target.localX,
      localZ: target.localZ, y: target.y
    });
    return;
  }
  sendWorld({
    type: 'world:edit', clientActionId: actionId(), action: 'place',
    chunkX: target.chunkX, chunkZ: target.chunkZ, localX: target.localX,
    localZ: target.localZ, y: target.y, block: { type: worldState.selectedBlock }
  });
}

function initWorldInteractionRendering() {
  const vertex = '#version 300 es\\nlayout(location=0) in vec3 aPosition;\\nuniform mat4 uViewProjection;\\nuniform vec3 uOffset;\\nvoid main(){gl_Position=uViewProjection*vec4(aPosition+uOffset,1.0);}';
  const fragment = '#version 300 es\\nprecision highp float;\\nuniform vec4 uColor;\\nout vec4 outColor;\\nvoid main(){outColor=uColor;}';
  worldState.interactionProgram = createProgram(vertex, fragment);

  const previewVao = gl.createVertexArray();
  gl.bindVertexArray(previewVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, terrain.positionBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, terrain.indexBuffer);
  worldState.previewVao = previewVao;

  const linePositions = new Float32Array([
    -.505,-.505,-.505, .505,-.505,-.505, .505,.505,-.505, -.505,.505,-.505,
    -.505,-.505,.505, .505,-.505,.505, .505,.505,.505, -.505,.505,.505
  ]);
  const lineIndices = new Uint16Array([
    0,1,1,2,2,3,3,0,4,5,5,6,6,7,7,4,0,4,1,5,2,6,3,7
  ]);
  const lineVao = gl.createVertexArray();
  gl.bindVertexArray(lineVao);
  const lineBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, linePositions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  const lineIndexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, lineIndexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lineIndices, gl.STATIC_DRAW);
  worldState.previewLineVao = lineVao;
  worldState.previewLineCount = lineIndices.length;

  const borderVao = gl.createVertexArray();
  gl.bindVertexArray(borderVao);
  const borderBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, borderBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, 4, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  worldState.chunkBorderVao = borderVao;
  worldState.chunkBorderBuffer = borderBuffer;
  gl.bindVertexArray(null);
}

function updateChunkBorderGeometry() {
  if (!worldState.showChunkBorders || !terrain?.chunks) return;
  const signature = Array.from(terrain.chunks.keys()).sort().join('|') + ':' + terrain.seed;
  if (signature === worldState.chunkBorderSignature) return;
  worldState.chunkBorderSignature = signature;
  const vertices = [];
  const addEdge = (x0, z0, x1, z1) => {
    const steps = Math.max(1, Math.round(Math.hypot(x1-x0, z1-z0)));
    for (let i=0;i<steps;i++) {
      const t0=i/steps,t1=(i+1)/steps;
      const ax=x0+(x1-x0)*t0, az=z0+(z1-z0)*t0;
      const bx=x0+(x1-x0)*t1, bz=z0+(z1-z0)*t1;
      const ay=getTerrainHeight(ax + .02, az + .02) + .065;
      const by=getTerrainHeight(bx + .02, bz + .02) + .065;
      vertices.push(ax,ay,az,bx,by,bz);
    }
  };
  for (const chunk of terrain.chunks.values()) {
    const x=chunk.cx*CHUNK_SIZE,z=chunk.cz*CHUNK_SIZE,s=CHUNK_SIZE;
    addEdge(x,z,x+s,z); addEdge(x+s,z,x+s,z+s);
    addEdge(x+s,z+s,x,z+s); addEdge(x,z+s,x,z);
  }
  const data = new Float32Array(vertices);
  gl.bindBuffer(gl.ARRAY_BUFFER, worldState.chunkBorderBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  worldState.chunkBorderVertexCount = data.length / 3;
}

function renderWorldInteractionOverlay() {
  if (!worldState.interactionProgram) return;
  updateChunkBorderGeometry();
  const program = worldState.interactionProgram;
  gl.useProgram(program.program);
  gl.uniformMatrix4fv(program.uniforms.uViewProjection, false, viewProjection);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false);
  gl.disable(gl.CULL_FACE);

  if (worldState.showChunkBorders && worldState.chunkBorderVertexCount) {
    gl.bindVertexArray(worldState.chunkBorderVao);
    gl.uniform3f(program.uniforms.uOffset, 0, 0, 0);
    gl.uniform4f(program.uniforms.uColor, 1.0, .76, .16, .88);
    gl.drawArrays(gl.LINES, 0, worldState.chunkBorderVertexCount);
  }

  worldState.preview = targetFromPointer();
  const preview = worldState.preview;
  if (preview) {
    const base = worldState.buildMode === 'delete'
      ? [1.0, .15, .18, .34]
      : (preview.valid ? BLOCK_PREVIEW_COLORS[worldState.selectedBlock] : [1.0, .18, .18, .28]);
    const offsetX=preview.worldX+.5, offsetY=preview.y+.5, offsetZ=preview.worldZ+.5;
    gl.uniform3f(program.uniforms.uOffset, offsetX, offsetY, offsetZ);
    gl.bindVertexArray(worldState.previewVao);
    gl.uniform4f(program.uniforms.uColor, base[0], base[1], base[2], base[3]);
    gl.drawElements(gl.TRIANGLES, terrain.indexCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(worldState.previewLineVao);
    gl.uniform4f(program.uniforms.uColor,
      worldState.buildMode === 'delete' || !preview.valid ? 1.0 : .86,
      worldState.buildMode === 'delete' || !preview.valid ? .18 : 1.0,
      worldState.buildMode === 'delete' || !preview.valid ? .18 : .74,
      .95);
    gl.drawElements(gl.LINES, worldState.previewLineCount, gl.UNSIGNED_SHORT, 0);
  }

  gl.enable(gl.CULL_FACE);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
}

function requestVisibleWorldChunks() {
  if (!network.ready || !terrain?.chunks) return;
  const chunks = Array.from(terrain.chunks.values(), chunk => ({ chunkX: chunk.cx, chunkZ: chunk.cz }));
  const signature = chunks.map(item => worldChunkKey(item.chunkX, item.chunkZ)).sort().join('|');
  if (signature === worldState.lastChunkRequest) return;
  worldState.lastChunkRequest = signature;
  setChunksLoading(true);
  sendWorld({ type: 'world:chunks', chunks });
}

function toggleChunkBorders(force) {
  worldState.showChunkBorders = typeof force === 'boolean' ? force : !worldState.showChunkBorders;
  localStorage.setItem('ridgewood.showChunkBorders', worldState.showChunkBorders ? '1' : '0');
  worldState.chunkBorderSignature = '';
  return worldState.showChunkBorders;
}

function myChunkList() {
  return Array.from(worldState.claims.values()).sort((a,b) => a.chunkX-b.chunkX || a.chunkZ-b.chunkZ);
}

function teleportToChunk(chunkX, chunkZ) {
  const x = Number(chunkX) * CHUNK_SIZE + CHUNK_SIZE / 2;
  const z = Number(chunkZ) * CHUNK_SIZE + CHUNK_SIZE / 2;
  return window.VOXEL_GAME_API?.teleport?.(x, z) || false;
}

function appendWorldCommandMessage(title, text, actions = []) {
  const list = document.querySelector('#chat-message-list');
  const scroller = document.querySelector('#chat-messages');
  if (!list) return;
  const card = document.createElement('article');
  card.className = 'world-chat-command';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const body = document.createElement('span');
  body.textContent = text;
  card.append(heading, body);
  if (actions.length) {
    const actionRow = document.createElement('div');
    actionRow.className = 'world-chat-command-actions';
    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', action.run);
      actionRow.append(button);
    }
    card.append(actionRow);
  }
  list.append(card);
  if (scroller) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
}

function runWorldChatCommand(raw) {
  const parts = raw.trim().split(/\\s+/);
  const command = String(parts[0] || '').toLowerCase();
  if (command === '/showchunks') {
    let visible;
    if (String(parts[1] || '').toLowerCase() === 'on') visible = toggleChunkBorders(true);
    else if (String(parts[1] || '').toLowerCase() === 'off') visible = toggleChunkBorders(false);
    else visible = toggleChunkBorders();
    appendWorldCommandMessage('Chunk borders', visible
      ? 'Chunk boundaries are now visible. Run /showchunks again to hide them.'
      : 'Chunk boundaries are now hidden.');
    return true;
  }
  if (command === '/mychunks') {
    const claims = myChunkList();
    const actions = claims.map(chunk => ({
      label: 'Chunk ' + chunk.chunkX + ', ' + chunk.chunkZ + ' · teleport',
      run: () => {
        teleportToChunk(chunk.chunkX, chunk.chunkZ);
        worldFeedback('Teleported to chunk ' + chunk.chunkX + ', ' + chunk.chunkZ + '.', 'ok');
      }
    }));
    appendWorldCommandMessage('Your chunks', claims.length
      ? 'You own ' + claims.length + ' of ' + worldState.claimLimit + ' available chunks. Choose one to teleport to its center.'
      : 'You have not claimed any chunks yet. Stand in an unclaimed chunk and press C.', actions);
    return true;
  }
  return false;
}

function interceptWorldChatCommands(event) {
  const input = event.target;
  if (!(input instanceof HTMLTextAreaElement) || input.id !== 'chat-input') return;
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  const value = input.value.trim();
  if (!/^\\/(showchunks|mychunks)(?:\\s|$)/i.test(value)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  runWorldChatCommand(value);
}

function handleWorldMessage(message) {
  if (message.type === 'welcome') {
    worldState.userId = String(message.auth?.user_id || '');
    worldState.id = message.world?.id || 'public';
    worldState.persistent = Boolean(message.world?.persistent);
    worldState.claimLimit = Number(message.world?.claimLimit) || 4;
    worldState.claims.clear();
    worldState.lastChunkRequest = '';
    for (const claim of message.world?.claims || []) applyWorldChunk(claim);
    ensureWorldHud();
    ensureWorldLoader();
  }
  if (message.type === 'world:chunks') {
    for (const chunk of message.chunks || []) applyWorldChunk(chunk);
    setChunksLoading(false);
  }
  if (message.type === 'world:chunk-updated' && message.chunk) applyWorldChunk(message.chunk);
  if (message.type === 'world:voxel-updated' && message.chunk) {
    applyWorldChunk(message.chunk);
    worldFeedback('World saved.', 'ok');
  }
  if (message.type === 'world:claim-result') {
    if (message.ok && message.chunk) {
      applyWorldChunk(message.chunk);
      worldFeedback('Chunk claimed. ' + String(message.claimCount || 1) + '/' + String(message.claimLimit || worldState.claimLimit) + ' claims used.', 'ok');
    } else {
      const labels = { already_claimed: 'That chunk is already claimed.', claim_limit: 'You have reached your chunk claim limit.', stand_in_chunk_to_claim: 'Stand inside a chunk to claim it.' };
      worldFeedback(labels[message.error] || message.message || 'Chunk claim failed.', 'error');
    }
  }
  if (message.type === 'world:edit-result' && !message.ok) {
    const labels = { not_owner: 'That chunk belongs to another player.', chunk_not_claimed: 'Claim this chunk before building.', too_far: 'Move closer to the build location.', rate_limited: 'You are building too quickly.' };
    worldFeedback(labels[message.error] || message.message || 'Build action failed.', 'error');
  }
  if (message.type === 'world:error') {
    setChunksLoading(false);
    worldFeedback(message.message || 'World data could not be loaded.', 'error');
  }
}

function addWorldInput() {
  ensureWorldHud();
  ensureWorldLoader();
  setBuildMode(worldState.buildMode);
  document.addEventListener('keydown', interceptWorldChatCommands, true);
  window.addEventListener('keydown', event => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable || window.__voxelChatTyping || window.__ridgewoodMenuOpen) return;
    if (event.code === 'KeyC') { event.preventDefault(); claimCurrentChunk(); }
    if (event.code === 'KeyB') { event.preventDefault(); toggleWorldHud(); }
    if (event.code === 'KeyN') { event.preventDefault(); setBuildMode('delete'); }
    if (event.code === 'Digit1') selectWorldBlock('grass');
    if (event.code === 'Digit2') selectWorldBlock('dirt');
    if (event.code === 'Digit3') selectWorldBlock('stone');
  }, { passive: false });
  canvas.addEventListener('pointerenter', event => {
    worldState.pointerInside = true;
    worldState.pointerX = event.clientX;
    worldState.pointerY = event.clientY;
  });
  canvas.addEventListener('pointermove', event => {
    worldState.pointerInside = true;
    worldState.pointerX = event.clientX;
    worldState.pointerY = event.clientY;
  }, { passive: true });
  canvas.addEventListener('pointerleave', () => {
    worldState.pointerInside = false;
    worldState.preview = null;
  });
  canvas.addEventListener('click', event => {
    if (event.button !== 0 || window.__ridgewoodMenuOpen) return;
    performBuildClick();
  });
}

function chatBridgeState() {
  return {
    id: network.id, name: network.name, color: network.color, online: network.ready,
    x: player.x, y: player.y, z: player.z, angle: player.angle, moving: player.moving,
    chunkX: Math.floor(player.x / CHUNK_SIZE), chunkZ: Math.floor(player.z / CHUNK_SIZE)
  };
}

window.VOXEL_GAME_API = Object.freeze({
  getLocalState: chatBridgeState,
  getPlayers() {
    return Array.from(network.remotes.values(), remote => ({
      id: remote.id, name: remote.name, color: remote.color, x: remote.x, z: remote.z,
      chunkX: Math.floor(remote.x / CHUNK_SIZE), chunkZ: Math.floor(remote.z / CHUNK_SIZE), moving: remote.moving
    }));
  },
  getWorldState() { return { ...worldState, chunks: new Map(worldState.chunks), claims: new Map(worldState.claims) }; },
  getMyChunks: myChunkList,
  send: sendWorld,
  claimCurrentChunk,
  selectBlock: selectWorldBlock,
  setBuildMode,
  toggleBuildHud: toggleWorldHud,
  toggleChunkBorders,
  teleportToChunk,
  runWorldChatCommand,
  isConnected() { return Boolean(network.ready && network.socket && network.socket.readyState === WebSocket.OPEN); },
  setLocalName(name) {
    const next = String(name || '').trim();
    if (!next) return false;
    network.name = next;
    if (networkLabel && network.ready) networkLabel.textContent = 'online · ' + network.name;
    return true;
  },
  teleport(x, z) {
    const nextX = Number(x), nextZ = Number(z);
    if (!Number.isFinite(nextX) || !Number.isFinite(nextZ)) return false;
    player.x = nextX; player.z = nextZ;
    player.groundY = getTerrainHeight(player.x, player.z); player.y = player.groundY;
    player.moving = false; keys.clear(); updateVisibleChunks(true);
    camera.position[0] = player.x + BASE_CAMERA_OFFSET[0] * camera.zoom;
    camera.position[1] = player.y + BASE_CAMERA_OFFSET[1] * camera.zoom;
    camera.position[2] = player.z + BASE_CAMERA_OFFSET[2] * camera.zoom;
    camera.target[0] = player.x; camera.target[1] = player.y + CAMERA_LOOK_HEIGHT; camera.target[2] = player.z;
    network.lastSentAt = 0;
    worldState.lastChunkRequest = '';
    requestVisibleWorldChunks();
    window.dispatchEvent(new CustomEvent('voxel:teleported', { detail: chatBridgeState() }));
    return true;
  },
  highlightPlayer(id, duration = 2500) {
    const remote = network.remotes.get(id); if (!remote) return false;
    remote.chatHighlightUntil = performance.now() + Math.max(300, Number(duration) || 2500); return true;
  },
  highlightPlayerByName(name, duration = 2500) {
    const needle = String(name || '').toLowerCase();
    const remote = Array.from(network.remotes.values()).find(item => item.name.toLowerCase() === needle);
    if (!remote) return false;
    remote.chatHighlightUntil = performance.now() + Math.max(300, Number(duration) || 2500); return true;
  },
  focusCanvas() { canvas.focus(); }
});
queueMicrotask(() => window.dispatchEvent(new CustomEvent('voxel:bridge-ready', { detail: chatBridgeState() })));`,
    'game and world bridge'
  );

  source = replaceRequired(source, '  terrain = createTerrainGeometry();\n  shadowVao = createShadowGeometry();', '  terrain = createTerrainGeometry();\n  shadowVao = createShadowGeometry();\n  initWorldInteractionRendering();', 'world interaction rendering setup');
  source = replaceRequired(source, '  addInput();\n  resize();', '  addInput();\n  addWorldInput();\n  resize();', 'world input');

  source = replaceRequired(
    source,
    `    if (message.type === 'welcome') {`,
    `    handleWorldMessage(message);
    window.dispatchEvent(new CustomEvent('voxel:network-message', { detail: message }));

    if (message.type === 'welcome') {`,
    'network dispatch'
  );

  source = replaceRequired(
    source,
    `    network.ready = false;
    network.remotes.clear();`,
    `    network.ready = false;
    setChunksLoading(false);
    window.dispatchEvent(new CustomEvent('voxel:network-offline'));
    network.remotes.clear();
    updateWorldHud();`,
    'network offline'
  );

  source = replaceRequired(
    source,
    `  regenerateTerrain(terrainSeed, message.spawn ?? { x: 0.5, z: 0.5 });`,
    `  regenerateTerrain(terrainSeed, message.spawn ?? { x: 0.5, z: 0.5 });
  if (Number.isFinite(Number(message.spawn?.angle))) {
    player.angle = player.targetAngle = Number(message.spawn.angle);
  }`,
    'saved facing'
  );

  source = replaceRequired(
    source,
    `  networkLabel.textContent = \`online · \${network.name}\`;
  networkLabel.dataset.state = 'online';
  updatePlayerCount();
}`,
    `  networkLabel.textContent = \`online · \${network.name}\`;
  networkLabel.dataset.state = 'online';
  updatePlayerCount();
  requestVisibleWorldChunks();
  updateWorldHud();
  window.dispatchEvent(new CustomEvent('voxel:network-ready', { detail: chatBridgeState() }));
}`,
    'network ready'
  );

  source = replaceRequired(
    source,
    `  window.addEventListener('keydown', (event) => {
    if (movementKeys.has(event.code)) {`,
    `  window.addEventListener('keydown', (event) => {
    const target = event.target;
    const isTypingTarget = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
    if (isTypingTarget || window.__voxelChatTyping || window.__ridgewoodMenuOpen) return;
    if (movementKeys.has(event.code)) {`,
    'keyboard isolation'
  );

  source = replaceRequired(
    source,
    `        remote.color,
        0.32`,
    `        remote.chatHighlightUntil > performance.now() ? [1.0, 0.95, 0.35] : remote.color,
        remote.chatHighlightUntil > performance.now() ? 0.78 : 0.32`,
    'player highlight'
  );

  source = replaceRequired(
    source,
    `  renderTerrain();
  renderAllShadows();`,
    `  renderTerrain();
  renderWorldInteractionOverlay();
  renderAllShadows();`,
    'world interaction render pass'
  );

  source = replaceRequired(
    source,
    `  chunkLabel.textContent = \`chunk \${chunkX}, \${chunkZ} · \${terrain.chunks.size} loaded\`;`,
    `  chunkLabel.textContent = \`chunk \${chunkX}, \${chunkZ} · \${terrain.chunks.size} loaded\`;
  worldState.chunkBorderSignature = '';
  requestVisibleWorldChunks();
  updateWorldHud();`,
    'chunk synchronization'
  );

  source = replaceRequired(
    source,
    `  const instanceData = new Float32Array(instances);`,
    `  appendWorldOverlay(instances, cx, cz);
  const instanceData = new Float32Array(instances);`,
    'voxel overlay rendering'
  );

  source = replaceRequired(
    source,
    `  return clamp(height, MIN_HEIGHT, MAX_HEIGHT);`,
    `  return overlayColumnHeight(worldCellX, worldCellZ, clamp(height, MIN_HEIGHT, MAX_HEIGHT));`,
    'overlay collision height'
  );

  source = replaceRequired(
    source,
    `    type: 'state',
    x: player.x,
    z: player.z,`,
    `    type: 'state',
    x: player.x,
    y: player.y,
    z: player.z,`,
    'position height persistence'
  );

  source = source.replaceAll('MULTIPLAYER HILLS v4.1.0', 'RIDGEWOOD v0.5.1 ALPHA');
  source = source.replaceAll('multiplayer-hills-4-1-0', 'ridgewood-0-5-1');

  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try { await import(blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
}

loadGame().catch(error => {
  console.error(error);
  document.querySelector('#loading')?.classList.add('hidden');
  const panel = document.querySelector('#error');
  const message = document.querySelector('#error-message');
  if (panel) panel.hidden = false;
  if (message) message.textContent = error instanceof Error ? error.message : String(error);
});