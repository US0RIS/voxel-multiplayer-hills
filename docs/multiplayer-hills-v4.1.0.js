const canvas = document.querySelector('#canvas');
const loading = document.querySelector('#loading');
const loadingText = document.querySelector('#loading-text');
const help = document.querySelector('#help');
const errorPanel = document.querySelector('#error');
const errorMessage = document.querySelector('#error-message');
const seedLabel = document.querySelector('#seed-label');
const chunkLabel = document.querySelector('#chunk-label');
const networkLabel = document.querySelector('#network-label');
const playerLabel = document.querySelector('#player-label');

const gl = canvas.getContext('webgl2', {
  antialias: true,
  alpha: false,
  depth: true,
  powerPreference: 'high-performance'
});

if (!gl) {
  showError(new Error('This browser or device does not provide WebGL 2.'));
  throw new Error('WebGL 2 unavailable');
}

const CHUNK_SIZE = 16;
const CHUNK_LOAD_RADIUS = 4;
const CHUNK_UNLOAD_RADIUS = 5;
const MIN_HEIGHT = 2;
const MAX_HEIGHT = 14;
const WALK_SPEED = 4.0;
const MAX_STEP_HEIGHT = 1.05;
const JOINT_COUNT = 19;
const BASE_CAMERA_OFFSET = [7.6, 8.8, 10.4];
const CAMERA_LOOK_HEIGHT = 0.9;
const MIN_ZOOM = 0.62;
const MAX_ZOOM = 1.85;
const NETWORK_SEND_INTERVAL = 1000 / 15;
const REMOTE_RENDER_DISTANCE = CHUNK_SIZE * (CHUNK_LOAD_RADIUS + 1.5);
const FOG_COLOR = [0.045, 0.060, 0.052];

const BLOCK_GRASS = 0;
const BLOCK_DIRT = 1;
const BLOCK_STONE = 2;

const keys = new Set();
const player = {
  x: 0,
  y: 0,
  groundY: 0,
  z: 0,
  angle: 0,
  targetAngle: 0,
  moving: false,
  walkBlend: 0,
  walkTime: 0,
  idleTime: 0
};

let model;
let characterProgram;
let terrainProgram;
let shadowProgram;
let terrain;
let shadowVao;
let lastTime = performance.now();
let startedMoving = false;
let terrainSeed = 0;

const network = {
  socket: null,
  id: null,
  name: 'Connecting…',
  color: [1, 1, 1],
  maxPlayers: 8,
  ready: false,
  lastSentAt: 0,
  reconnectTimer: null,
  reconnectAttempt: 0,
  connectionGeneration: 0,
  remotes: new Map()
};

const camera = {
  position: [...BASE_CAMERA_OFFSET],
  target: [0, CAMERA_LOOK_HEIGHT, 0],
  zoom: 1,
  targetZoom: 1
};

const view = mat4Create();
const projection = mat4Create();
const viewProjection = mat4Create();
const modelMatrix = mat4Create();
const jointPalette = new Float32Array(JOINT_COUNT * 16);

async function start() {
  console.info('MULTIPLAYER HILLS v4.1.0: deployment multiplayer active');
  characterProgram = createProgram(characterVertexShader, characterFragmentShader);
  terrainProgram = createProgram(terrainVertexShader, terrainFragmentShader);
  shadowProgram = createProgram(shadowVertexShader, shadowFragmentShader);

  terrain = createTerrainGeometry();
  shadowVao = createShadowGeometry();

  loadingText.textContent = 'Loading character…';
  model = await loadGlb('./assets/voxel_adventurer.glb');

  loadingText.textContent = 'Connecting to multiplayer room…';
  await connectMultiplayer();
  document.documentElement.dataset.build = 'multiplayer-hills-4-1-0';

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.clearColor(...FOG_COLOR, 1);

  addInput();
  resize();
  loading.classList.add('hidden');
  requestAnimationFrame(frame);
}

function frame(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  updatePlayer(dt);
  updateEntityAnimation(player, dt);
  updateRemotePlayers(dt);
  sendNetworkState(now);
  updateCamera(dt);
  render();

  requestAnimationFrame(frame);
}

function updatePlayer(dt) {
  const horizontal = Number(keys.has('KeyD') || keys.has('ArrowRight'))
    - Number(keys.has('KeyA') || keys.has('ArrowLeft'));
  const vertical = Number(keys.has('KeyW') || keys.has('ArrowUp'))
    - Number(keys.has('KeyS') || keys.has('ArrowDown'));

  const length = Math.hypot(horizontal, vertical);
  player.moving = length > 0;

  if (player.moving) {
    // Camera-relative movement on the XZ plane.
    const fx = -BASE_CAMERA_OFFSET[0];
    const fz = -BASE_CAMERA_OFFSET[2];
    const fl = Math.hypot(fx, fz);
    const forwardX = fx / fl;
    const forwardZ = fz / fl;
    const rightX = -forwardZ;
    const rightZ = forwardX;

    let dx = forwardX * vertical + rightX * horizontal;
    let dz = forwardZ * vertical + rightZ * horizontal;
    const dl = Math.hypot(dx, dz);
    dx /= dl;
    dz /= dl;

    const distance = WALK_SPEED * dt;
    movePlayer(dx * distance, dz * distance);

    // The model's face points down local -Z in its bind pose.
    player.targetAngle = Math.atan2(-dx, -dz);
    player.angle = dampAngle(player.angle, player.targetAngle, 15, dt);
  }

  player.groundY = getTerrainHeight(player.x, player.z);
  player.y = damp(player.y, player.groundY, 20, dt);
  updateVisibleChunks();
}

function movePlayer(dx, dz) {
  const currentHeight = getTerrainHeight(player.x, player.z);
  const targetX = player.x + dx;
  const targetZ = player.z + dz;
  const targetHeight = getTerrainHeight(targetX, targetZ);

  if (Math.abs(targetHeight - currentHeight) <= MAX_STEP_HEIGHT) {
    player.x = targetX;
    player.z = targetZ;
    return;
  }

  // Slide along a blocked ledge rather than stopping completely.
  const xHeight = getTerrainHeight(targetX, player.z);
  if (Math.abs(xHeight - currentHeight) <= MAX_STEP_HEIGHT) player.x = targetX;
  const zHeight = getTerrainHeight(player.x, targetZ);
  if (Math.abs(zHeight - getTerrainHeight(player.x, player.z)) <= MAX_STEP_HEIGHT) player.z = targetZ;
}

function updateEntityAnimation(entity, dt) {
  entity.idleTime += dt;
  if (entity.moving) entity.walkTime += dt;
  entity.walkBlend = damp(entity.walkBlend, entity.moving ? 1 : 0, 12, dt);
}

function computePosePalette(entity, palette) {
  const nodes = model.nodes;
  for (let i = 0; i < nodes.length; i++) {
    copyQuat(nodes[i].rotation, nodes[i].baseRotation);
  }

  const idle = model.animationsByName.get('Idle');
  if (idle) applyRotationClip(idle, entity.idleTime, 1);

  const walk = model.animationsByName.get('Walk');
  if (walk && entity.walkBlend > 0.001) {
    applyRotationClip(walk, entity.walkTime, entity.walkBlend);
  }

  updateNodeMatrices(palette);
}

function applyRotationClip(clip, time, blend) {
  const localTime = clip.duration > 0 ? time % clip.duration : 0;
  const sampled = [0, 0, 0, 1];

  for (const channel of clip.channels) {
    if (channel.path !== 'rotation') continue;
    sampleQuaternion(channel.times, channel.values, localTime, sampled);
    const node = model.nodes[channel.node];
    quatSlerp(node.rotation, node.rotation, sampled, blend);
  }
}

function updateNodeMatrices(palette = jointPalette) {
  for (let i = 0; i < model.nodes.length; i++) {
    const node = model.nodes[i];
    mat4FromRotationTranslationScale(node.localMatrix, node.rotation, node.translation, node.scale);
    if (node.parent >= 0) {
      mat4Multiply(node.globalMatrix, model.nodes[node.parent].globalMatrix, node.localMatrix);
    } else {
      node.globalMatrix.set(node.localMatrix);
    }
  }

  for (let j = 0; j < model.joints.length; j++) {
    const nodeIndex = model.joints[j];
    const out = palette.subarray(j * 16, j * 16 + 16);
    mat4Multiply(out, model.nodes[nodeIndex].globalMatrix, model.inverseBindMatrices[j]);
  }
}

function updateCamera(dt) {
  camera.zoom = damp(camera.zoom, camera.targetZoom, 9.0, dt);
  const desiredX = player.x + BASE_CAMERA_OFFSET[0] * camera.zoom;
  const desiredY = player.y + BASE_CAMERA_OFFSET[1] * camera.zoom;
  const desiredZ = player.z + BASE_CAMERA_OFFSET[2] * camera.zoom;
  const t = 1 - Math.exp(-5.5 * dt);

  camera.position[0] += (desiredX - camera.position[0]) * t;
  camera.position[1] += (desiredY - camera.position[1]) * t;
  camera.position[2] += (desiredZ - camera.position[2]) * t;
  camera.target[0] = player.x;
  camera.target[1] = player.y + CAMERA_LOOK_HEIGHT;
  camera.target[2] = player.z;
}

function render() {
  resize();

  mat4LookAt(view, camera.position, camera.target, [0, 1, 0]);
  mat4Perspective(projection, Math.PI * 35 / 180, canvas.width / canvas.height, 0.1, 220);
  mat4Multiply(viewProjection, projection, view);
  mat4FromYRotationTranslation(modelMatrix, player.angle, player.x, player.y, player.z);

  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  renderTerrain();
  renderAllShadows();
  renderAllCharacters();
}

function renderTerrain() {
  gl.useProgram(terrainProgram.program);
  gl.uniformMatrix4fv(terrainProgram.uniforms.uViewProjection, false, viewProjection);
  gl.uniform3f(terrainProgram.uniforms.uLightDirection, -0.48, 0.82, 0.34);
  gl.uniform3f(terrainProgram.uniforms.uCameraPosition, camera.position[0], camera.position[1], camera.position[2]);
  gl.uniform3f(terrainProgram.uniforms.uFogColor, FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2]);

  for (const chunk of terrain.chunks.values()) {
    gl.bindVertexArray(chunk.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, terrain.indexCount, gl.UNSIGNED_SHORT, 0, chunk.instanceCount);
  }
}

function renderAllShadows() {
  renderShadowAt(player.x, player.groundY, player.z);
  for (const remote of network.remotes.values()) {
    if (distance2D(player.x, player.z, remote.renderX, remote.renderZ) <= REMOTE_RENDER_DISTANCE) {
      renderShadowAt(remote.renderX, remote.y, remote.renderZ);
    }
  }
}

function renderShadowAt(x, y, z) {
  gl.useProgram(shadowProgram.program);
  gl.bindVertexArray(shadowVao);
  gl.uniformMatrix4fv(shadowProgram.uniforms.uViewProjection, false, viewProjection);
  gl.uniform3f(shadowProgram.uniforms.uPlayerPosition, x, y + 0.012, z);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false);
  gl.disable(gl.CULL_FACE);
  gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  gl.enable(gl.CULL_FACE);
  gl.depthMask(true);
  gl.disable(gl.BLEND);
}

function renderAllCharacters() {
  renderCharacterAt(player, player.x, player.y, player.z, player.angle, [1, 1, 1], 0);
  for (const remote of network.remotes.values()) {
    if (distance2D(player.x, player.z, remote.renderX, remote.renderZ) <= REMOTE_RENDER_DISTANCE) {
      renderCharacterAt(
        remote,
        remote.renderX,
        remote.y,
        remote.renderZ,
        remote.renderAngle,
        remote.color,
        0.32
      );
    }
  }
}

function renderCharacterAt(entity, x, y, z, angle, tint, tintAmount) {
  computePosePalette(entity, entity.jointPalette ?? jointPalette);
  mat4FromYRotationTranslation(modelMatrix, angle, x, y, z);

  gl.useProgram(characterProgram.program);
  gl.uniformMatrix4fv(characterProgram.uniforms.uViewProjection, false, viewProjection);
  gl.uniformMatrix4fv(characterProgram.uniforms.uModel, false, modelMatrix);
  gl.uniformMatrix4fv(characterProgram.uniforms.uJoints, false, entity.jointPalette ?? jointPalette);
  gl.uniform3f(characterProgram.uniforms.uLightDirection, -0.45, 0.82, 0.35);
  gl.uniform3f(characterProgram.uniforms.uCameraPosition, camera.position[0], camera.position[1], camera.position[2]);
  gl.uniform3f(characterProgram.uniforms.uFogColor, FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2]);
  gl.uniform3f(characterProgram.uniforms.uPlayerTint, tint[0], tint[1], tint[2]);
  gl.uniform1f(characterProgram.uniforms.uTintAmount, tintAmount);

  for (const primitive of model.primitives) {
    gl.bindVertexArray(primitive.vao);
    gl.uniform4fv(characterProgram.uniforms.uBaseColor, primitive.color);
    gl.drawElements(gl.TRIANGLES, primitive.indexCount, primitive.indexType, 0);
  }
}

async function loadGlb(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Character file failed to load (${response.status}).`);
  const arrayBuffer = await response.arrayBuffer();
  const { json, binary } = parseGlb(arrayBuffer);

  const accessors = json.accessors.map((_, index) => readAccessor(json, binary, index));
  const nodes = json.nodes.map((node) => ({
    name: node.name ?? '',
    parent: -1,
    children: node.children ?? [],
    translation: new Float32Array(node.translation ?? [0, 0, 0]),
    scale: new Float32Array(node.scale ?? [1, 1, 1]),
    baseRotation: new Float32Array(node.rotation ?? [0, 0, 0, 1]),
    rotation: new Float32Array(node.rotation ?? [0, 0, 0, 1]),
    localMatrix: mat4Create(),
    globalMatrix: mat4Create()
  }));

  for (let i = 0; i < nodes.length; i++) {
    for (const child of nodes[i].children) nodes[child].parent = i;
  }

  const mesh = json.meshes[0];
  const primitives = mesh.primitives.map((primitive) => createCharacterPrimitive(
    primitive,
    accessors,
    json.materials
  ));

  const skin = json.skins[0];
  const ibmAccessor = accessors[skin.inverseBindMatrices];
  const inverseBindMatrices = [];
  for (let i = 0; i < skin.joints.length; i++) {
    inverseBindMatrices.push(ibmAccessor.array.slice(i * 16, i * 16 + 16));
  }

  const animationsByName = new Map();
  for (const animation of json.animations ?? []) {
    const channels = animation.channels.map((channel) => {
      const sampler = animation.samplers[channel.sampler];
      const input = accessors[sampler.input];
      const output = accessors[sampler.output];
      return {
        node: channel.target.node,
        path: channel.target.path,
        times: input.array,
        values: output.array
      };
    });
    const duration = Math.max(0, ...channels.map((c) => c.times[c.times.length - 1] ?? 0));
    animationsByName.set(animation.name ?? '', { name: animation.name ?? '', duration, channels });
  }

  const result = {
    json,
    accessors,
    nodes,
    primitives,
    joints: skin.joints,
    inverseBindMatrices,
    animationsByName
  };

  model = result;
  updateNodeMatrices();
  return result;
}

function parseGlb(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('The character file is not a valid GLB.');
  if (view.getUint32(4, true) !== 2) throw new Error('Only GLB version 2 is supported.');

  const decoder = new TextDecoder();
  let offset = 12;
  let json;
  let binary;

  while (offset < arrayBuffer.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const chunk = arrayBuffer.slice(start, start + length);

    if (type === 0x4e4f534a) {
      json = JSON.parse(decoder.decode(chunk).replace(/[\u0000\s]+$/g, ''));
    } else if (type === 0x004e4942) {
      binary = chunk;
    }
    offset = start + length;
  }

  if (!json || !binary) throw new Error('The GLB is missing its JSON or binary data.');
  return { json, binary };
}

function readAccessor(json, binary, accessorIndex) {
  const accessor = json.accessors[accessorIndex];
  const view = json.bufferViews[accessor.bufferView];
  const components = componentCount(accessor.type);
  const TypedArray = typedArrayFor(accessor.componentType);
  const componentBytes = TypedArray.BYTES_PER_ELEMENT;
  const packedStride = components * componentBytes;
  const stride = view.byteStride ?? packedStride;
  const byteOffset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const count = accessor.count;

  if (stride === packedStride) {
    const source = new TypedArray(binary, byteOffset, count * components);
    return {
      array: source.slice(),
      count,
      components,
      componentType: accessor.componentType,
      normalized: Boolean(accessor.normalized)
    };
  }

  const output = new TypedArray(count * components);
  const sourceView = new DataView(binary);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < components; c++) {
      output[i * components + c] = readComponent(
        sourceView,
        byteOffset + i * stride + c * componentBytes,
        accessor.componentType
      );
    }
  }
  return {
    array: output,
    count,
    components,
    componentType: accessor.componentType,
    normalized: Boolean(accessor.normalized)
  };
}

function createCharacterPrimitive(primitive, accessors, materials) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const bindings = [
    ['POSITION', 0, false],
    ['NORMAL', 1, false],
    ['JOINTS_0', 2, true],
    ['WEIGHTS_0', 3, false]
  ];

  const buffers = [];
  for (const [semantic, location, integer] of bindings) {
    const accessorIndex = primitive.attributes[semantic];
    if (accessorIndex === undefined) throw new Error(`Character is missing ${semantic}.`);
    const accessor = accessors[accessorIndex];
    const buffer = gl.createBuffer();
    buffers.push(buffer);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, accessor.array, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(location);
    if (integer) {
      gl.vertexAttribIPointer(location, accessor.components, accessor.componentType, 0, 0);
    } else {
      gl.vertexAttribPointer(location, accessor.components, accessor.componentType, accessor.normalized, 0, 0);
    }
  }

  const indexAccessor = accessors[primitive.indices];
  const indexBuffer = gl.createBuffer();
  buffers.push(indexBuffer);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indexAccessor.array, gl.STATIC_DRAW);

  const pbr = materials[primitive.material]?.pbrMetallicRoughness;
  const color = new Float32Array(pbr?.baseColorFactor ?? [1, 1, 1, 1]);

  return {
    vao,
    buffers,
    indexCount: indexAccessor.count,
    indexType: indexAccessor.componentType,
    color
  };
}


function createTerrainGeometry() {
  const half = 0.497;
  const positions = [];
  const normals = [];
  const indices = [];

  const faces = [
    [[ 0, 0, 1], [[-half,-half, half],[ half,-half, half],[ half, half, half],[-half, half, half]]],
    [[ 0, 0,-1], [[ half,-half,-half],[-half,-half,-half],[-half, half,-half],[ half, half,-half]]],
    [[ 1, 0, 0], [[ half,-half, half],[ half,-half,-half],[ half, half,-half],[ half, half, half]]],
    [[-1, 0, 0], [[-half,-half,-half],[-half,-half, half],[-half, half, half],[-half, half,-half]]],
    [[ 0, 1, 0], [[-half, half, half],[ half, half, half],[ half, half,-half],[-half, half,-half]]],
    [[ 0,-1, 0], [[-half,-half,-half],[ half,-half,-half],[ half,-half, half],[-half,-half, half]]]
  ];

  for (const [normal, corners] of faces) {
    const base = positions.length / 3;
    for (const corner of corners) {
      positions.push(...corner);
      normals.push(...normal);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

  const normalBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);

  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

  return {
    positionBuffer,
    normalBuffer,
    indexBuffer,
    indexCount: indices.length,
    chunks: new Map(),
    seed: 0,
    playerChunkX: Number.NaN,
    playerChunkZ: Number.NaN
  };
}

function regenerateTerrain(seed, spawn = { x: 0.5, z: 0.5 }) {
  clearTerrainChunks();
  terrain.seed = seed >>> 0;
  seedLabel.textContent = `seed ${terrain.seed}`;

  player.x = spawn.x;
  player.z = spawn.z;
  player.groundY = getTerrainHeight(player.x, player.z);
  player.y = player.groundY;
  player.walkTime = 0;
  player.idleTime = 0;
  player.moving = false;

  camera.zoom = 1;
  camera.targetZoom = 1;
  camera.position[0] = player.x + BASE_CAMERA_OFFSET[0];
  camera.position[1] = player.y + BASE_CAMERA_OFFSET[1];
  camera.position[2] = player.z + BASE_CAMERA_OFFSET[2];

  terrain.playerChunkX = Number.NaN;
  terrain.playerChunkZ = Number.NaN;
  updateVisibleChunks(true);
}

function clearTerrainChunks() {
  for (const chunk of terrain.chunks.values()) {
    gl.deleteBuffer(chunk.instanceBuffer);
    gl.deleteVertexArray(chunk.vao);
  }
  terrain.chunks.clear();
}

function updateVisibleChunks(force = false) {
  const chunkX = Math.floor(player.x / CHUNK_SIZE);
  const chunkZ = Math.floor(player.z / CHUNK_SIZE);
  if (!force && chunkX === terrain.playerChunkX && chunkZ === terrain.playerChunkZ) return;

  terrain.playerChunkX = chunkX;
  terrain.playerChunkZ = chunkZ;

  const missing = [];
  for (let dz = -CHUNK_LOAD_RADIUS; dz <= CHUNK_LOAD_RADIUS; dz++) {
    for (let dx = -CHUNK_LOAD_RADIUS; dx <= CHUNK_LOAD_RADIUS; dx++) {
      const cx = chunkX + dx;
      const cz = chunkZ + dz;
      const key = chunkKey(cx, cz);
      if (!terrain.chunks.has(key)) missing.push({ cx, cz, distance: dx * dx + dz * dz });
    }
  }
  missing.sort((a, b) => a.distance - b.distance);
  for (const item of missing) {
    const key = chunkKey(item.cx, item.cz);
    terrain.chunks.set(key, createTerrainChunk(item.cx, item.cz));
  }

  for (const [key, chunk] of terrain.chunks) {
    if (
      Math.abs(chunk.cx - chunkX) > CHUNK_UNLOAD_RADIUS ||
      Math.abs(chunk.cz - chunkZ) > CHUNK_UNLOAD_RADIUS
    ) {
      gl.deleteBuffer(chunk.instanceBuffer);
      gl.deleteVertexArray(chunk.vao);
      terrain.chunks.delete(key);
    }
  }

  chunkLabel.textContent = `chunk ${chunkX}, ${chunkZ} · ${terrain.chunks.size} loaded`;
}

function createTerrainChunk(cx, cz) {
  const instances = [];
  const startX = cx * CHUNK_SIZE;
  const startZ = cz * CHUNK_SIZE;

  for (let localZ = 0; localZ < CHUNK_SIZE; localZ++) {
    for (let localX = 0; localX < CHUNK_SIZE; localX++) {
      const worldCellX = startX + localX;
      const worldCellZ = startZ + localZ;
      const height = getTerrainCellHeight(worldCellX, worldCellZ);
      const surfaceType = getSurfaceType(worldCellX, worldCellZ, height);
      const worldX = worldCellX + 0.5;
      const worldZ = worldCellZ + 0.5;

      // The top cube is always present.
      instances.push(worldX, height - 0.5, worldZ, surfaceType);

      // Add only the column depth that can be exposed by a lower neighbor.
      const lowestNeighbor = Math.min(
        getTerrainCellHeight(worldCellX - 1, worldCellZ),
        getTerrainCellHeight(worldCellX + 1, worldCellZ),
        getTerrainCellHeight(worldCellX, worldCellZ - 1),
        getTerrainCellHeight(worldCellX, worldCellZ + 1)
      );

      for (let y = lowestNeighbor; y < height - 1; y++) {
        const depth = height - 1 - y;
        const type = depth <= 2 ? BLOCK_DIRT : BLOCK_STONE;
        instances.push(worldX, y + 0.5, worldZ, type);
      }
    }
  }

  const instanceData = new Float32Array(instances);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  gl.bindBuffer(gl.ARRAY_BUFFER, terrain.positionBuffer);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, terrain.normalBuffer);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

  const instanceBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, instanceData, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(2, 1);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, terrain.indexBuffer);
  gl.bindVertexArray(null);

  return {
    cx,
    cz,
    vao,
    instanceBuffer,
    instanceCount: instanceData.length / 4
  };
}

function chunkKey(cx, cz) {
  return `${cx},${cz}`;
}

function getTerrainHeight(x, z) {
  return getTerrainCellHeight(Math.floor(x), Math.floor(z));
}

function getTerrainCellHeight(worldCellX, worldCellZ) {
  let height = getBaseTerrainHeight(worldCellX, worldCellZ);

  // Keep a small, gently blended clearing around the initial spawn.
  const distance = Math.hypot(worldCellX, worldCellZ);
  if (distance < 7) {
    const centerHeight = getBaseTerrainHeight(0, 0);
    const blend = smoothstep(2.0, 7.0, distance);
    height = Math.round(mix(centerHeight, height, blend));
  }

  return clamp(height, MIN_HEIGHT, MAX_HEIGHT);
}

function getBaseTerrainHeight(worldCellX, worldCellZ) {
  const warpX = (fbm(worldCellX * 0.006, worldCellZ * 0.006, terrain.seed ^ 0x51f15e5d) - 0.5) * 18.0;
  const warpZ = (fbm(worldCellX * 0.006 + 83.0, worldCellZ * 0.006 - 41.0, terrain.seed ^ 0x9e3779b9) - 0.5) * 18.0;
  const x = worldCellX + warpX;
  const z = worldCellZ + warpZ;

  const broad = fbm(x * 0.0105, z * 0.0105, terrain.seed);
  const rolling = fbm(x * 0.021 + 37.0, z * 0.021 - 19.0, terrain.seed ^ 0x7f4a7c15);
  const detail = fbm(x * 0.044 - 11.0, z * 0.044 + 53.0, terrain.seed ^ 0xa341316c);
  const raw = 7.0 + (broad - 0.5) * 9.0 + (rolling - 0.5) * 2.5 + (detail - 0.5) * 0.65;
  return Math.round(raw);
}

function getSurfaceType(worldCellX, worldCellZ, height) {
  if (Math.hypot(worldCellX, worldCellZ) < 5) return BLOCK_GRASS;

  const soil = fbm(worldCellX * 0.028 + 73.1, worldCellZ * 0.028 - 31.4, terrain.seed ^ 0xc8013ea4);
  const rock = fbm(worldCellX * 0.020 - 12.4, worldCellZ * 0.020 + 86.0, terrain.seed ^ 0xad90777d);

  if (height >= 12 || (height >= 10 && rock > 0.57) || rock > 0.75) return BLOCK_STONE;
  if (soil > 0.67 || soil < 0.28) return BLOCK_DIRT;
  return BLOCK_GRASS;
}

function fbm(x, z, seed) {
  let value = 0;
  let amplitude = 0.55;
  let frequency = 1;
  let total = 0;
  for (let octave = 0; octave < 4; octave++) {
    value += valueNoise(x * frequency, z * frequency, seed + octave * 1013) * amplitude;
    total += amplitude;
    frequency *= 2.03;
    amplitude *= 0.5;
  }
  return value / total;
}

function valueNoise(x, z, seed) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = smoothCurve(x - x0);
  const tz = smoothCurve(z - z0);
  const a = hashGrid(x0, z0, seed);
  const b = hashGrid(x0 + 1, z0, seed);
  const c = hashGrid(x0, z0 + 1, seed);
  const d = hashGrid(x0 + 1, z0 + 1, seed);
  return mix(mix(a, b, tx), mix(c, d, tx), tz);
}

function hashGrid(x, z, seed) {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function smoothCurve(t) {
  return t * t * (3 - 2 * t);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

function createShadowGeometry() {
  const positions = new Float32Array([
    -1, -1,
     1, -1,
     1,  1,
    -1,  1
  ]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  return createSimpleVao(positions, indices, 2);
}

function createSimpleVao(positions, indices, components) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vertexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, components, gl.FLOAT, false, 0, 0);
  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  return vao;
}

function createProgram(vertexSource, fragmentSource) {
  const vertex = compileShader(gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`Shader link failed: ${gl.getProgramInfoLog(program)}`);
  }
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  const uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(program, info.name);
  }
  return { program, uniforms };
}

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`Shader compilation failed: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}



function connectMultiplayer() {
  let websocketUrl;
  try {
    websocketUrl = resolveWebSocketUrl();
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve) => {
    openMultiplayerSocket(websocketUrl, resolve, true);
  });
}

function resolveWebSocketUrl() {
  const config = window.VOXEL_CONFIG ?? {};
  const params = new URLSearchParams(window.location.search);
  const queryValue = params.get('server');
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname);
  const configured = queryValue || (isLocal ? config.LOCAL_WEBSOCKET_URL : config.PUBLIC_WEBSOCKET_URL);

  if (!configured || /YOUR-RENDER-SERVICE/i.test(configured)) {
    throw new Error(
      'The public multiplayer server is not configured. Deploy /server, then set PUBLIC_WEBSOCKET_URL in docs/config.js.'
    );
  }

  let normalized = String(configured).trim();
  if (/^https:\/\//i.test(normalized)) normalized = normalized.replace(/^https:/i, 'wss:');
  if (/^http:\/\//i.test(normalized)) normalized = normalized.replace(/^http:/i, 'ws:');
  if (!/^wss?:\/\//i.test(normalized)) {
    throw new Error('The multiplayer server URL must begin with ws:// or wss://.');
  }
  return normalized;
}

function openMultiplayerSocket(websocketUrl, resolve = null, initial = false) {
  const generation = ++network.connectionGeneration;
  if (network.reconnectTimer) {
    clearTimeout(network.reconnectTimer);
    network.reconnectTimer = null;
  }

  networkLabel.textContent = initial ? 'connecting…' : `reconnecting… attempt ${network.reconnectAttempt + 1}`;
  networkLabel.dataset.state = 'connecting';
  const socket = new WebSocket(websocketUrl);
  network.socket = socket;
  let welcomed = false;

  socket.addEventListener('open', () => {
    if (generation !== network.connectionGeneration) socket.close();
  });

  socket.addEventListener('message', (event) => {
    if (generation !== network.connectionGeneration) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'welcome') {
      welcomed = true;
      network.reconnectAttempt = 0;
      handleWelcome(message);
      if (resolve) {
        resolve();
        resolve = null;
      }
      return;
    }
    if (message.type === 'error') {
      showTransientNetworkError(message.message || 'The multiplayer server rejected the connection.');
      return;
    }
    if (message.type === 'joined' && message.player) {
      upsertRemotePlayer(message.player, true);
      updatePlayerCount();
      return;
    }
    if (message.type === 'state') {
      const remote = network.remotes.get(message.id);
      if (remote) updateRemoteTarget(remote, message);
      return;
    }
    if (message.type === 'left') {
      network.remotes.delete(message.id);
      updatePlayerCount();
    }
  });

  socket.addEventListener('error', () => {
    // The close event schedules the retry. Browsers intentionally expose
    // little detail for failed WebSocket handshakes.
  });

  socket.addEventListener('close', () => {
    if (generation !== network.connectionGeneration) return;
    network.ready = false;
    network.remotes.clear();
    updatePlayerCount();

    const delay = Math.min(15000, 1200 * (2 ** network.reconnectAttempt));
    const jitter = Math.floor(Math.random() * 350);
    network.reconnectAttempt += 1;
    networkLabel.textContent = `offline · retrying in ${Math.ceil((delay + jitter) / 1000)}s`;
    networkLabel.dataset.state = 'offline';
    network.reconnectTimer = setTimeout(
      () => openMultiplayerSocket(websocketUrl, resolve, false),
      delay + jitter
    );
  });
}

function handleWelcome(message) {
  network.id = message.id;
  network.name = message.name;
  network.color = message.color ?? [1, 1, 1];
  network.maxPlayers = message.maxPlayers ?? 8;
  network.ready = true;
  network.lastSentAt = 0;
  network.remotes.clear();

  terrainSeed = Number(message.seed) >>> 0;
  regenerateTerrain(terrainSeed, message.spawn ?? { x: 0.5, z: 0.5 });
  for (const remote of message.players ?? []) upsertRemotePlayer(remote, true);

  networkLabel.textContent = `online · ${network.name}`;
  networkLabel.dataset.state = 'online';
  updatePlayerCount();
}

function upsertRemotePlayer(data, snap = false) {
  if (!data || data.id === network.id) return;
  let remote = network.remotes.get(data.id);
  if (!remote) {
    const x = Number(data.x) || 0.5;
    const z = Number(data.z) || 0.5;
    remote = {
      id: data.id,
      name: data.name ?? 'Player',
      color: Array.isArray(data.color) ? data.color : [0.7, 0.8, 1],
      x,
      z,
      renderX: x,
      renderZ: z,
      y: getTerrainHeight(x, z),
      angle: Number(data.angle) || 0,
      renderAngle: Number(data.angle) || 0,
      moving: Boolean(data.moving),
      idleTime: Math.random() * 2,
      walkTime: Math.random(),
      walkBlend: 0,
      jointPalette: new Float32Array(JOINT_COUNT * 16),
      lastUpdate: performance.now()
    };
    network.remotes.set(data.id, remote);
  }
  updateRemoteTarget(remote, data, snap);
}

function updateRemoteTarget(remote, data, snap = false) {
  const x = Number(data.x);
  const z = Number(data.z);
  const angle = Number(data.angle);
  if (Number.isFinite(x)) remote.x = x;
  if (Number.isFinite(z)) remote.z = z;
  if (Number.isFinite(angle)) remote.angle = angle;
  remote.moving = Boolean(data.moving);
  remote.lastUpdate = performance.now();
  if (snap) {
    remote.renderX = remote.x;
    remote.renderZ = remote.z;
    remote.renderAngle = remote.angle;
    remote.y = getTerrainHeight(remote.renderX, remote.renderZ);
  }
}

function updateRemotePlayers(dt) {
  const now = performance.now();
  for (const [id, remote] of network.remotes) {
    remote.renderX = damp(remote.renderX, remote.x, 11, dt);
    remote.renderZ = damp(remote.renderZ, remote.z, 11, dt);
    remote.renderAngle = dampAngle(remote.renderAngle, remote.angle, 14, dt);
    remote.y = damp(remote.y, getTerrainHeight(remote.renderX, remote.renderZ), 18, dt);
    updateEntityAnimation(remote, dt);
    if (now - remote.lastUpdate > 12000) network.remotes.delete(id);
  }
  updatePlayerCount();
}

function sendNetworkState(now) {
  const socket = network.socket;
  if (!network.ready || !socket || socket.readyState !== WebSocket.OPEN) return;
  if (now - network.lastSentAt < NETWORK_SEND_INTERVAL) return;
  network.lastSentAt = now;
  socket.send(JSON.stringify({
    type: 'state',
    x: player.x,
    z: player.z,
    angle: player.angle,
    moving: player.moving
  }));
}

function updatePlayerCount() {
  const count = network.ready ? network.remotes.size + 1 : 0;
  playerLabel.textContent = `${count}/${network.maxPlayers} players`;
}

function showTransientNetworkError(message) {
  networkLabel.textContent = message;
  networkLabel.dataset.state = 'offline';
}

function distance2D(ax, az, bx, bz) {
  return Math.hypot(ax - bx, az - bz);
}

function addInput() {
  const movementKeys = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'
  ]);

  window.addEventListener('keydown', (event) => {
    if (movementKeys.has(event.code)) {
      event.preventDefault();
      keys.add(event.code);
      if (!startedMoving) {
        startedMoving = true;
        help.style.opacity = '0.72';
      }
      return;
    }

  }, { passive: false });

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    camera.targetZoom = clamp(
      camera.targetZoom * Math.exp(event.deltaY * 0.00125),
      MIN_ZOOM,
      MAX_ZOOM
    );
  }, { passive: false });

  window.addEventListener('keyup', (event) => keys.delete(event.code));
  window.addEventListener('blur', () => keys.clear());
  window.addEventListener('resize', resize);
  canvas.focus();
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
  }
}

function showError(error) {
  console.error(error);
  loading.classList.add('hidden');
  errorPanel.hidden = false;
  errorMessage.textContent = error instanceof Error ? error.message : String(error);
}

function componentCount(type) {
  return { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }[type];
}

function typedArrayFor(componentType) {
  const map = {
    5120: Int8Array,
    5121: Uint8Array,
    5122: Int16Array,
    5123: Uint16Array,
    5125: Uint32Array,
    5126: Float32Array
  };
  const result = map[componentType];
  if (!result) throw new Error(`Unsupported GLB component type ${componentType}.`);
  return result;
}

function readComponent(view, offset, componentType) {
  switch (componentType) {
    case 5120: return view.getInt8(offset);
    case 5121: return view.getUint8(offset);
    case 5122: return view.getInt16(offset, true);
    case 5123: return view.getUint16(offset, true);
    case 5125: return view.getUint32(offset, true);
    case 5126: return view.getFloat32(offset, true);
    default: throw new Error(`Unsupported component type ${componentType}.`);
  }
}

function sampleQuaternion(times, values, time, out) {
  if (times.length === 1 || time <= times[0]) {
    out[0] = values[0]; out[1] = values[1]; out[2] = values[2]; out[3] = values[3];
    return out;
  }

  const last = times.length - 1;
  if (time >= times[last]) {
    const i = last * 4;
    out[0] = values[i]; out[1] = values[i + 1]; out[2] = values[i + 2]; out[3] = values[i + 3];
    return out;
  }

  let index = 0;
  while (index + 1 < times.length && time > times[index + 1]) index++;
  const next = index + 1;
  const t = (time - times[index]) / Math.max(times[next] - times[index], 1e-6);
  const a = values.subarray(index * 4, index * 4 + 4);
  const b = values.subarray(next * 4, next * 4 + 4);
  return quatSlerp(out, a, b, t);
}

function quatSlerp(out, a, b, t) {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }

  let scale0;
  let scale1;
  if (1 - cos > 1e-6) {
    const omega = Math.acos(clamp(cos, -1, 1));
    const sinOmega = Math.sin(omega);
    scale0 = Math.sin((1 - t) * omega) / sinOmega;
    scale1 = Math.sin(t * omega) / sinOmega;
  } else {
    scale0 = 1 - t;
    scale1 = t;
  }

  out[0] = scale0 * a[0] + scale1 * bx;
  out[1] = scale0 * a[1] + scale1 * by;
  out[2] = scale0 * a[2] + scale1 * bz;
  out[3] = scale0 * a[3] + scale1 * bw;
  return quatNormalize(out);
}

function quatNormalize(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  q[0] /= l; q[1] /= l; q[2] /= l; q[3] /= l;
  return q;
}

function copyQuat(out, source) {
  out[0] = source[0]; out[1] = source[1]; out[2] = source[2]; out[3] = source[3];
}

function mat4Create() {
  const out = new Float32Array(16);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

function mat4Multiply(out, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
  out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
  out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
  out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
  out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
  out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
  out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
  out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  return out;
}

function mat4FromRotationTranslationScale(out, q, v, s) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = s[0], sy = s[1], sz = s[2];

  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;
  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;
  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;
  out[12] = v[0];
  out[13] = v[1];
  out[14] = v[2];
  out[15] = 1;
  return out;
}

function mat4FromYRotationTranslation(out, angle, x, y, z) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  out[0] = c; out[1] = 0; out[2] = -s; out[3] = 0;
  out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0;
  out[8] = s; out[9] = 0; out[10] = c; out[11] = 0;
  out[12] = x; out[13] = y; out[14] = z; out[15] = 1;
  return out;
}

function mat4Perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[11] = -1;
  out[10] = (far + near) / (near - far);
  out[14] = (2 * far * near) / (near - far);
  return out;
}

function mat4LookAt(out, eye, center, up) {
  let zx = eye[0] - center[0];
  let zy = eye[1] - center[1];
  let zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

function damp(current, target, lambda, dt) {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

function dampAngle(current, target, lambda, dt) {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * (1 - Math.exp(-lambda * dt));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const characterVertexShader = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in uvec4 aJoints;
layout(location = 3) in vec4 aWeights;

uniform mat4 uViewProjection;
uniform mat4 uModel;
uniform mat4 uJoints[${JOINT_COUNT}];

out vec3 vWorldPosition;
out vec3 vWorldNormal;

void main() {
  mat4 skin =
      aWeights.x * uJoints[int(aJoints.x)]
    + aWeights.y * uJoints[int(aJoints.y)]
    + aWeights.z * uJoints[int(aJoints.z)]
    + aWeights.w * uJoints[int(aJoints.w)];

  vec4 localPosition = skin * vec4(aPosition, 1.0);
  vec4 worldPosition = uModel * localPosition;
  vWorldPosition = worldPosition.xyz;
  vWorldNormal = normalize(mat3(uModel) * mat3(skin) * aNormal);
  gl_Position = uViewProjection * worldPosition;
}`;

const characterFragmentShader = `#version 300 es
precision highp float;

in vec3 vWorldPosition;
in vec3 vWorldNormal;

uniform vec4 uBaseColor;
uniform vec3 uLightDirection;
uniform vec3 uCameraPosition;
uniform vec3 uFogColor;
uniform vec3 uPlayerTint;
uniform float uTintAmount;

out vec4 outColor;

void main() {
  vec3 normal = normalize(vWorldNormal);
  vec3 lightDirection = normalize(uLightDirection);
  vec3 viewDirection = normalize(uCameraPosition - vWorldPosition);

  float diffuse = max(dot(normal, lightDirection), 0.0);
  float hemisphere = normal.y * 0.5 + 0.5;
  float rim = pow(1.0 - max(dot(normal, viewDirection), 0.0), 3.0);

  float light = 0.38 + diffuse * 0.64 + hemisphere * 0.10;
  vec3 tintedBase = mix(uBaseColor.rgb, uBaseColor.rgb * uPlayerTint, uTintAmount);
  vec3 color = tintedBase * light + rim * 0.035;

  float fog = smoothstep(48.0, 88.0, distance(uCameraPosition, vWorldPosition));
  color = mix(color, uFogColor, fog);
  outColor = vec4(color, uBaseColor.a);
}`;

const terrainVertexShader = `#version 300 es
precision highp float;
precision highp int;

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aOffsetAndType;

uniform mat4 uViewProjection;

out vec3 vWorldPosition;
out vec3 vNormal;
out vec3 vLocalPosition;
flat out int vBlockType;

void main() {
  vLocalPosition = aPosition;
  vWorldPosition = aPosition + aOffsetAndType.xyz;
  vNormal = aNormal;
  vBlockType = int(aOffsetAndType.w + 0.5);
  gl_Position = uViewProjection * vec4(vWorldPosition, 1.0);
}`;

const terrainFragmentShader = `#version 300 es
precision highp float;
precision highp int;

in vec3 vWorldPosition;
in vec3 vNormal;
in vec3 vLocalPosition;
flat in int vBlockType;

uniform vec3 uLightDirection;
uniform vec3 uCameraPosition;
uniform vec3 uFogColor;
uniform vec3 uPlayerTint;
uniform float uTintAmount;

out vec4 outColor;

float hash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 normal = normalize(vNormal);
  vec2 facePosition;
  if (abs(normal.y) > 0.5) facePosition = vWorldPosition.xz;
  else if (abs(normal.x) > 0.5) facePosition = vWorldPosition.zy;
  else facePosition = vWorldPosition.xy;

  // Four small square tiles across each block face, reflecting the supplied block art.
  vec2 tiled = facePosition * 4.0;
  vec2 localTile = fract(tiled);
  vec2 tileId = floor(tiled);
  float tileVariation = hash(vec3(tileId, float(vBlockType) * 17.0));
  float edgeDistance = min(min(localTile.x, 1.0 - localTile.x), min(localTile.y, 1.0 - localTile.y));
  float tileSeam = 1.0 - smoothstep(0.035, 0.085, edgeDistance);

  vec3 darkColor;
  vec3 lightColor;

  if (vBlockType == ${BLOCK_STONE}) {
    darkColor = vec3(0.095, 0.098, 0.112);
    lightColor = vec3(0.285, 0.292, 0.325);
  } else if (vBlockType == ${BLOCK_DIRT}) {
    darkColor = vec3(0.125, 0.055, 0.020);
    lightColor = vec3(0.405, 0.205, 0.075);
  } else {
    bool grassFace = normal.y > 0.5 || (abs(normal.y) < 0.5 && vLocalPosition.y > 0.27);
    if (grassFace) {
      darkColor = vec3(0.220, 0.485, 0.045);
      lightColor = vec3(0.500, 0.800, 0.115);
    } else {
      darkColor = vec3(0.125, 0.055, 0.020);
      lightColor = vec3(0.405, 0.205, 0.075);
    }
  }

  vec3 base = mix(darkColor, lightColor, 0.25 + tileVariation * 0.62);
  base *= 1.0 - tileSeam * 0.16;

  vec3 lightDirection = normalize(uLightDirection);
  float diffuse = max(dot(normal, lightDirection), 0.0);
  float hemisphere = normal.y * 0.5 + 0.5;
  float light = 0.43 + diffuse * 0.56 + hemisphere * 0.10;
  vec3 color = base * light;

  // Slightly darken vertical faces so terraces read clearly.
  color *= mix(0.82, 1.0, max(normal.y, 0.0));

  float fog = smoothstep(45.0, 78.0, distance(uCameraPosition, vWorldPosition));
  color = mix(color, uFogColor, fog);
  outColor = vec4(color, 1.0);
}`;

const shadowVertexShader = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
uniform mat4 uViewProjection;
uniform vec3 uPlayerPosition;
out vec2 vLocal;
void main() {
  vLocal = aPosition;
  vec3 world = vec3(
    uPlayerPosition.x + aPosition.x * 0.52,
    uPlayerPosition.y,
    uPlayerPosition.z + aPosition.y * 0.34
  );
  gl_Position = uViewProjection * vec4(world, 1.0);
}`;

const shadowFragmentShader = `#version 300 es
precision highp float;
in vec2 vLocal;
out vec4 outColor;
void main() {
  float radius = length(vLocal);
  float alpha = (1.0 - smoothstep(0.35, 1.0, radius)) * 0.32;
  outColor = vec4(0.0, 0.0, 0.0, alpha);
}`;

start().catch(showError);
