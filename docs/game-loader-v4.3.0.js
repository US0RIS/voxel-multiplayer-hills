/* Ridgewood v0.5.0 loader: chat bridge + persistent mutable world. */
const GAME_SOURCE_URL = './multiplayer-hills-v4.1.0.js?v=0.5.0';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Ridgewood integration could not patch the game (${label}).`);
  return source.replace(search, replacement);
}

async function loadGame() {
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = 'world-v0.5.0.css?v=0.5.0';
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
  feedbackTimer: 0,
  lastChunkRequest: '',
  hud: null
};

const BLOCK_NAME_TO_TYPE = { grass: BLOCK_GRASS, dirt: BLOCK_DIRT, stone: BLOCK_STONE };

function worldChunkKey(cx, cz) { return \`${'${cx}'},${'${cz}'}\`; }
function worldOwnsChunk(record) { return Boolean(record?.ownerId && record.ownerId === worldState.userId); }

function ensureWorldHud() {
  if (worldState.hud) return worldState.hud;
  const hud = document.createElement('section');
  hud.id = 'world-hud';
  hud.setAttribute('aria-label', 'Building controls');
  hud.innerHTML = \`
    <div class="world-hud-head">
      <div class="world-hud-title"><strong id="world-chunk-title">Chunk 0, 0</strong><span id="world-chunk-owner">Loading ownership…</span></div>
      <button id="world-claim" type="button">Claim</button>
    </div>
    <div class="world-tools" aria-label="Block palette">
      <button class="world-block" data-world-block="grass" aria-pressed="true"><span class="world-swatch world-swatch--grass"></span>Grass <kbd>1</kbd></button>
      <button class="world-block" data-world-block="dirt" aria-pressed="false"><span class="world-swatch world-swatch--dirt"></span>Dirt <kbd>2</kbd></button>
      <button class="world-block" data-world-block="stone" aria-pressed="false"><span class="world-swatch world-swatch--stone"></span>Stone <kbd>3</kbd></button>
    </div>
    <div class="world-actions">
      <button id="world-place" class="world-action" type="button">Place block <kbd>B</kbd></button>
      <button id="world-remove" class="world-action" type="button">Remove block <kbd>N</kbd></button>
    </div>
    <div id="world-feedback">Claim the chunk you are standing in before building.</div>
    <div class="world-shortcuts"><kbd>C</kbd> claim current chunk · blocks are placed one cell in front of your character</div>\`;
  document.body.append(hud);
  hud.querySelector('#world-claim').addEventListener('click', claimCurrentChunk);
  hud.querySelector('#world-place').addEventListener('click', placeSelectedBlock);
  hud.querySelector('#world-remove').addEventListener('click', removeSelectedBlock);
  for (const button of hud.querySelectorAll('[data-world-block]')) {
    button.addEventListener('click', () => selectWorldBlock(button.dataset.worldBlock));
  }
  worldState.hud = hud;
  updateWorldHud();
  return hud;
}

function worldFeedback(text, state = '') {
  const hud = ensureWorldHud();
  const node = hud.querySelector('#world-feedback');
  node.textContent = text;
  node.dataset.state = state;
  clearTimeout(worldState.feedbackTimer);
  worldState.feedbackTimer = setTimeout(() => { node.dataset.state = ''; }, 3500);
}

function selectWorldBlock(type) {
  if (!(type in BLOCK_NAME_TO_TYPE)) return;
  worldState.selectedBlock = type;
  for (const button of ensureWorldHud().querySelectorAll('[data-world-block]')) {
    button.setAttribute('aria-pressed', String(button.dataset.worldBlock === type));
  }
  worldFeedback(\`Selected ${'${type}'} block.\`);
}

function currentWorldChunk() {
  return { chunkX: Math.floor(player.x / CHUNK_SIZE), chunkZ: Math.floor(player.z / CHUNK_SIZE) };
}

function currentChunkRecord() {
  const { chunkX, chunkZ } = currentWorldChunk();
  return worldState.chunks.get(worldChunkKey(chunkX, chunkZ)) || { chunkX, chunkZ, ownerId: null, voxelData: {}, revision: 0 };
}

function updateWorldHud() {
  const hud = ensureWorldHud();
  const { chunkX, chunkZ } = currentWorldChunk();
  const record = currentChunkRecord();
  const owns = worldOwnsChunk(record);
  const claimed = Boolean(record.ownerId);
  hud.querySelector('#world-chunk-title').textContent = \`Chunk ${'${chunkX}'}, ${'${chunkZ}'}\`;
  hud.querySelector('#world-chunk-owner').textContent = owns
    ? \`Your claim · revision ${'${record.revision || 0}'}\`
    : claimed ? 'Claimed by another player' : 'Unclaimed land';
  const claim = hud.querySelector('#world-claim');
  claim.disabled = claimed || !network.ready || !worldState.persistent;
  claim.textContent = owns ? 'Owned' : claimed ? 'Claimed' : 'Claim';
  hud.querySelector('#world-place').disabled = !owns || !network.ready;
  hud.querySelector('#world-remove').disabled = !owns || !network.ready;
}

function sendWorld(payload) {
  const socket = network.socket;
  if (!network.ready || !socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function claimCurrentChunk() {
  const { chunkX, chunkZ } = currentWorldChunk();
  if (!sendWorld({ type: 'world:claim', chunkX, chunkZ })) worldFeedback('World server is not connected.', 'error');
  else worldFeedback('Claim request sent…');
}

function buildTarget() {
  const forwardX = -Math.sin(player.angle);
  const forwardZ = -Math.cos(player.angle);
  const worldX = Math.floor(player.x + forwardX * 1.6);
  const worldZ = Math.floor(player.z + forwardZ * 1.6);
  const chunkX = Math.floor(worldX / CHUNK_SIZE);
  const chunkZ = Math.floor(worldZ / CHUNK_SIZE);
  const localX = ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const localZ = ((worldZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  return { worldX, worldZ, chunkX, chunkZ, localX, localZ };
}

function actionId() {
  return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  });
}

function placeSelectedBlock() {
  const target = buildTarget();
  const record = worldState.chunks.get(worldChunkKey(target.chunkX, target.chunkZ));
  if (!worldOwnsChunk(record)) return worldFeedback('You can only build inside one of your claimed chunks.', 'error');
  const y = getTerrainCellHeight(target.worldX, target.worldZ);
  sendWorld({
    type: 'world:edit', clientActionId: actionId(), action: 'place',
    chunkX: target.chunkX, chunkZ: target.chunkZ, localX: target.localX,
    localZ: target.localZ, y, block: { type: worldState.selectedBlock }
  });
}

function removeSelectedBlock() {
  const target = buildTarget();
  const record = worldState.chunks.get(worldChunkKey(target.chunkX, target.chunkZ));
  if (!worldOwnsChunk(record)) return worldFeedback('You can only edit your own claimed chunks.', 'error');
  let highest = null;
  for (const key of Object.keys(record?.voxelData || {})) {
    const [localX, y, localZ] = key.split(':').map(Number);
    if (localX === target.localX && localZ === target.localZ && (highest === null || y > highest)) highest = y;
  }
  if (highest === null) return worldFeedback('There is no placed block in front of you to remove.', 'error');
  sendWorld({
    type: 'world:edit', clientActionId: actionId(), action: 'remove',
    chunkX: target.chunkX, chunkZ: target.chunkZ, localX: target.localX,
    localZ: target.localZ, y: highest
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
  worldState.chunks.set(worldChunkKey(chunk.chunkX, chunk.chunkZ), chunk);
  if (terrain?.chunks?.has(worldChunkKey(chunk.chunkX, chunk.chunkZ))) rebuildWorldChunk(chunk.chunkX, chunk.chunkZ);
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
    const [localX, y, localZ] = key.split(':').map(Number);
    if (![localX, y, localZ].every(Number.isFinite) || value?.action !== 'place') continue;
    const type = BLOCK_NAME_TO_TYPE[value?.block?.type] ?? BLOCK_STONE;
    instances.push(cx * CHUNK_SIZE + localX + 0.5, y + 0.5, cz * CHUNK_SIZE + localZ + 0.5, type);
  }
}

function overlayColumnHeight(worldCellX, worldCellZ, baseHeight) {
  const cx = Math.floor(worldCellX / CHUNK_SIZE);
  const cz = Math.floor(worldCellZ / CHUNK_SIZE);
  const localX = ((worldCellX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const localZ = ((worldCellZ % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const record = worldState.chunks.get(worldChunkKey(cx, cz));
  let height = baseHeight;
  for (const [key, value] of Object.entries(record?.voxelData || {})) {
    const [x, y, z] = key.split(':').map(Number);
    if (x === localX && z === localZ && value?.action === 'place') height = Math.max(height, y + 1);
  }
  return height;
}

function requestVisibleWorldChunks() {
  if (!network.ready || !terrain?.chunks) return;
  const chunks = Array.from(terrain.chunks.values(), chunk => ({ chunkX: chunk.cx, chunkZ: chunk.cz }));
  const signature = chunks.map(item => worldChunkKey(item.chunkX, item.chunkZ)).sort().join('|');
  if (signature === worldState.lastChunkRequest) return;
  worldState.lastChunkRequest = signature;
  sendWorld({ type: 'world:chunks', chunks });
}

function handleWorldMessage(message) {
  if (message.type === 'welcome') {
    worldState.userId = String(message.auth?.user_id || '');
    worldState.id = message.world?.id || 'public';
    worldState.persistent = Boolean(message.world?.persistent);
    worldState.claimLimit = Number(message.world?.claimLimit) || 4;
    worldState.claims.clear();
    for (const claim of message.world?.claims || []) {
      const normalized = normalizeChunk(claim);
      worldState.claims.set(worldChunkKey(normalized.chunkX, normalized.chunkZ), normalized);
      worldState.chunks.set(worldChunkKey(normalized.chunkX, normalized.chunkZ), normalized);
    }
    ensureWorldHud();
  }
  if (message.type === 'world:chunks') for (const chunk of message.chunks || []) applyWorldChunk(chunk);
  if (message.type === 'world:chunk-updated' && message.chunk) applyWorldChunk(message.chunk);
  if (message.type === 'world:voxel-updated' && message.chunk) {
    applyWorldChunk(message.chunk);
    worldFeedback('World saved.', 'ok');
  }
  if (message.type === 'world:claim-result') {
    if (message.ok && message.chunk) {
      applyWorldChunk(message.chunk);
      worldFeedback(\`Chunk claimed. ${'${message.claimCount || 1}'}/${'${message.claimLimit || worldState.claimLimit}'} claims used.\`, 'ok');
    } else {
      const labels = { already_claimed: 'That chunk is already claimed.', claim_limit: 'You have reached your chunk claim limit.', stand_in_chunk_to_claim: 'Stand inside a chunk to claim it.' };
      worldFeedback(labels[message.error] || message.message || 'Chunk claim failed.', 'error');
    }
  }
  if (message.type === 'world:edit-result' && !message.ok) {
    const labels = { not_owner: 'That chunk belongs to another player.', chunk_not_claimed: 'Claim this chunk before building.', too_far: 'Move closer to the build location.', rate_limited: 'You are building too quickly.' };
    worldFeedback(labels[message.error] || message.message || 'Build action failed.', 'error');
  }
  if (message.type === 'world:error') worldFeedback(message.message || 'World data could not be loaded.', 'error');
}

function addWorldInput() {
  ensureWorldHud();
  window.addEventListener('keydown', event => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable || window.__voxelChatTyping || window.__ridgewoodMenuOpen) return;
    if (event.code === 'KeyC') { event.preventDefault(); claimCurrentChunk(); }
    if (event.code === 'KeyB') { event.preventDefault(); placeSelectedBlock(); }
    if (event.code === 'KeyN') { event.preventDefault(); removeSelectedBlock(); }
    if (event.code === 'Digit1') selectWorldBlock('grass');
    if (event.code === 'Digit2') selectWorldBlock('dirt');
    if (event.code === 'Digit3') selectWorldBlock('stone');
  }, { passive: false });
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
  send: sendWorld,
  claimCurrentChunk,
  placeBlock: placeSelectedBlock,
  removeBlock: removeSelectedBlock,
  selectBlock: selectWorldBlock,
  isConnected() { return Boolean(network.ready && network.socket && network.socket.readyState === WebSocket.OPEN); },
  setLocalName(name) {
    const next = String(name || '').trim();
    if (!next) return false;
    network.name = next;
    if (networkLabel && network.ready) networkLabel.textContent = \`online · ${'${network.name}'}\`;
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
    `  chunkLabel.textContent = \`chunk \${chunkX}, \${chunkZ} · \${terrain.chunks.size} loaded\`;`,
    `  chunkLabel.textContent = \`chunk \${chunkX}, \${chunkZ} · \${terrain.chunks.size} loaded\`;
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

  source = source.replaceAll('MULTIPLAYER HILLS v4.1.0', 'RIDGEWOOD v0.5.0 ALPHA');
  source = source.replaceAll('multiplayer-hills-4-1-0', 'ridgewood-0-5-0');

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
