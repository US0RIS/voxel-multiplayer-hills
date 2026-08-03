/* Loads the untouched v4.1.0 renderer and injects the chat bridge into it.
 *
 * The renderer source is patched in memory (never on disk) so the game module
 * stays a single, reviewable file. Every patch target is asserted, so a
 * renderer change fails loudly instead of silently disabling chat features.
 */
const GAME_SOURCE_URL = './multiplayer-hills-v4.1.0.js?v=4.1.0';

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error(`Chat integration could not patch the game (${label}).`);
  }
  return source.replace(search, replacement);
}

async function loadGameWithChatBridge() {
  const response = await fetch(GAME_SOURCE_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Game source failed to load (${response.status}).`);
  let source = await response.text();

  source = replaceRequired(
    source,
    'const jointPalette = new Float32Array(JOINT_COUNT * 16);',
    `const jointPalette = new Float32Array(JOINT_COUNT * 16);

function chatBridgeState() {
  return {
    id: network.id,
    name: network.name,
    color: network.color,
    online: network.ready,
    x: player.x,
    y: player.y,
    z: player.z,
    angle: player.angle,
    moving: player.moving,
    chunkX: Math.floor(player.x / CHUNK_SIZE),
    chunkZ: Math.floor(player.z / CHUNK_SIZE)
  };
}

window.VOXEL_GAME_API = Object.freeze({
  getLocalState: chatBridgeState,
  getPlayers() {
    return Array.from(network.remotes.values(), (remote) => ({
      id: remote.id,
      name: remote.name,
      color: remote.color,
      x: remote.x,
      z: remote.z,
      chunkX: Math.floor(remote.x / CHUNK_SIZE),
      chunkZ: Math.floor(remote.z / CHUNK_SIZE),
      moving: remote.moving
    }));
  },
  send(payload) {
    const socket = network.socket;
    if (!network.ready || !socket || socket.readyState !== WebSocket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      console.warn('Chat packet could not be sent:', error);
      return false;
    }
  },
  isConnected() {
    return Boolean(network.ready && network.socket && network.socket.readyState === WebSocket.OPEN);
  },
  setLocalName(name) {
    const next = String(name || '').trim();
    if (!next) return false;
    network.name = next;
    if (typeof networkLabel !== 'undefined' && networkLabel && network.ready) {
      networkLabel.textContent = \`online · \${network.name}\`;
    }
    return true;
  },
  teleport(x, z) {
    const nextX = Number(x);
    const nextZ = Number(z);
    if (!Number.isFinite(nextX) || !Number.isFinite(nextZ)) return false;
    player.x = nextX;
    player.z = nextZ;
    player.groundY = getTerrainHeight(player.x, player.z);
    player.y = player.groundY;
    player.moving = false;
    keys.clear();
    updateVisibleChunks(true);
    camera.position[0] = player.x + BASE_CAMERA_OFFSET[0] * camera.zoom;
    camera.position[1] = player.y + BASE_CAMERA_OFFSET[1] * camera.zoom;
    camera.position[2] = player.z + BASE_CAMERA_OFFSET[2] * camera.zoom;
    camera.target[0] = player.x;
    camera.target[1] = player.y + CAMERA_LOOK_HEIGHT;
    camera.target[2] = player.z;
    network.lastSentAt = 0;
    window.dispatchEvent(new CustomEvent('voxel:teleported', { detail: chatBridgeState() }));
    return true;
  },
  highlightPlayer(id, duration = 2500) {
    const remote = network.remotes.get(id);
    if (!remote) return false;
    remote.chatHighlightUntil = performance.now() + Math.max(300, Number(duration) || 2500);
    return true;
  },
  highlightPlayerByName(name, duration = 2500) {
    const needle = String(name || '').toLowerCase();
    const remote = Array.from(network.remotes.values()).find((item) => item.name.toLowerCase() === needle);
    if (!remote) return false;
    remote.chatHighlightUntil = performance.now() + Math.max(300, Number(duration) || 2500);
    return true;
  },
  focusCanvas() {
    canvas.focus();
  }
});
queueMicrotask(() => window.dispatchEvent(new CustomEvent('voxel:bridge-ready', { detail: chatBridgeState() })));`,
    'game bridge'
  );

  source = replaceRequired(
    source,
    `    if (message.type === 'welcome') {`,
    `    window.dispatchEvent(new CustomEvent('voxel:network-message', { detail: message }));

    if (message.type === 'welcome') {`,
    'network event dispatch'
  );

  source = replaceRequired(
    source,
    `    network.ready = false;
    network.remotes.clear();`,
    `    network.ready = false;
    window.dispatchEvent(new CustomEvent('voxel:network-offline'));
    network.remotes.clear();`,
    'network offline event'
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
  window.dispatchEvent(new CustomEvent('voxel:network-ready', { detail: chatBridgeState() }));
}`,
    'network ready event'
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
    'chat keyboard isolation'
  );

  source = replaceRequired(
    source,
    `        remote.color,
        0.32`,
    `        remote.chatHighlightUntil > performance.now() ? [1.0, 0.95, 0.35] : remote.color,
        remote.chatHighlightUntil > performance.now() ? 0.78 : 0.32`,
    'in-world player highlight'
  );

  source = source.replaceAll('MULTIPLAYER HILLS v4.1.0', 'MULTIPLAYER HILLS v4.3.0');
  source = source.replaceAll('multiplayer-hills-4-1-0', 'multiplayer-hills-4-3-0');

  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    await import(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

loadGameWithChatBridge().catch((error) => {
  console.error(error);
  const loading = document.querySelector('#loading');
  const panel = document.querySelector('#error');
  const message = document.querySelector('#error-message');
  loading?.classList.add('hidden');
  if (panel) panel.hidden = false;
  if (message) message.textContent = error instanceof Error ? error.message : String(error);
});
