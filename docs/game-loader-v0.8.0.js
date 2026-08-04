/* Ridgewood v0.8.0 delta loader: staff flight, movement speed, and build reach.
 *
 * The loaders are a chain of text deltas, each asserting on its anchors:
 *
 *   game-loader-v0.8.0.js  (this file)
 *     └ patches game-loader-v0.6.0.js
 *         └ patches game-loader-v4.3.0.js
 *             └ patches multiplayer-hills-v4.1.0.js   ← the actual game
 *
 * The game lives two levels down, so the patches below are emitted as source
 * text that the v0.6.0 loader hands to the v4.3.0 loader. JSON.stringify does
 * all the quoting, so the game snippets can be written as ordinary strings.
 *
 * Nothing here grants a power. `window.__RIDGEWOOD_ADMIN` is populated by
 * admin-v0.8.0.js only after the server says the account is staff, and the
 * server re-validates every resulting edit, so forcing the flag client-side
 * gets you a local animation and a rejected packet.
 */

const LOADER_URL = './game-loader-v0.6.0.js?v=0.8.0-base';

/* Anchor marking the end of each loader, just before it imports the blob. */
const OUTER_ANCHOR = 'const blobUrl = URL.createObjectURL(new Blob([source], { type: \'text/javascript\' }));';
const INNER_ANCHOR = '  const blobUrl = URL.createObjectURL(new Blob([source], { type: \'text/javascript\' }));';

/* Game-level patches, applied to multiplayer-hills-v4.1.0.js after the v0.6.0
 * loader has already rewritten movement and collision. Anchors below therefore
 * match the post-v0.6.0 text, not the file on disk. */
const GAME_PATCHES = [
  [
    '    const distance = WALK_SPEED * dt;',
    '    const distance = WALK_SPEED * (Number(window.__RIDGEWOOD_ADMIN?.speed) || 1) * dt;',
    'admin movement speed'
  ],
  [
    `function movePlayer(dx, dz) {
  const currentGround = resolvePlayerGround(player.x, player.z, player.groundY || player.y);`,
    `function movePlayer(dx, dz) {
  const rwAdmin = window.__RIDGEWOOD_ADMIN;
  if (rwAdmin && rwAdmin.staff && rwAdmin.flying) {
    // Flight ignores terrain collision entirely; the server clamps the
    // resulting height when the position is persisted.
    player.x += dx;
    player.z += dz;
    return;
  }
  const currentGround = resolvePlayerGround(player.x, player.z, player.groundY || player.y);`,
    'admin flight collision bypass'
  ],
  [
    `  player.groundY = resolvePlayerGround(player.x, player.z, player.groundY || player.y);
  player.y = damp(player.y, player.groundY, 20, dt);`,
    `  const rwFlight = window.__RIDGEWOOD_ADMIN;
  if (rwFlight && rwFlight.staff && rwFlight.flying) {
    const lift = Number(rwFlight.verticalInput) || 0;
    const climb = Number(rwFlight.flySpeed) || 9;
    player.y = clamp(player.y + lift * climb * dt, 0.5, 180);
    player.groundY = player.y;
  } else {
    player.groundY = resolvePlayerGround(player.x, player.z, player.groundY || player.y);
    player.y = damp(player.y, player.groundY, 20, dt);
  }`,
    'admin vertical flight'
  ],
  [
    `  const owns = worldOwnsChunk(record);
  const isDelete = worldState.buildMode === 'delete';`,
    `  const rwAdmin = window.__RIDGEWOOD_ADMIN;
  const rwOverride = Boolean(rwAdmin && rwAdmin.staff && rwAdmin.buildOverride);
  const rwMaxReach = rwOverride ? (Number(rwAdmin.reach) || 8.0) : 8.0;
  const owns = worldOwnsChunk(record) || rwOverride;
  const isDelete = worldState.buildMode === 'delete';`,
    'admin build override target'
  ],
  [
    `  const intersectsPlayer = !isDelete && voxelIntersectsPlayer(cell.worldX, cell.y, cell.worldZ);`,
    `  const intersectsPlayer = !isDelete && !rwOverride && voxelIntersectsPlayer(cell.worldX, cell.y, cell.worldZ);`,
    'admin self-intersection allowance'
  ],
  [
    `  const valid = owns && distance <= 8.0 && cell.y >= WORLD_FLOOR && cell.y <= 96 && !bedrock && !intersectsPlayer;`,
    `  const valid = owns && distance <= rwMaxReach && cell.y >= WORLD_FLOOR && cell.y <= 96 && !bedrock && !intersectsPlayer;`,
    'admin build reach validity'
  ],
  [
    `      : distance > 8.0 ? 'Move closer to that block.'`,
    `      : distance > rwMaxReach ? 'Move closer to that block.'`,
    'admin build reach message'
  ],
  [
    `    sendWorld({
      type: 'world:edit', clientActionId: actionId(), action: 'remove',
      chunkX: target.chunkX, chunkZ: target.chunkZ, localX: target.localX,
      localZ: target.localZ, y: target.y
    });`,
    `    sendWorld({
      type: 'world:edit', clientActionId: actionId(), action: 'remove',
      chunkX: target.chunkX, chunkZ: target.chunkZ, localX: target.localX,
      localZ: target.localZ, y: target.y,
      adminOverride: Boolean(window.__RIDGEWOOD_ADMIN?.buildOverride)
    });`,
    'admin override on remove'
  ],
  [
    `  sendWorld({
    type: 'world:edit', clientActionId: actionId(), action: 'place',
    chunkX: target.chunkX, chunkZ: target.chunkZ, localX: target.localX,
    localZ: target.localZ, y: target.y, block: { type: worldState.selectedBlock }
  });`,
    `  sendWorld({
    type: 'world:edit', clientActionId: actionId(), action: 'place',
    chunkX: target.chunkX, chunkZ: target.chunkZ, localX: target.localX,
    localZ: target.localZ, y: target.y, block: { type: worldState.selectedBlock },
    adminOverride: Boolean(window.__RIDGEWOOD_ADMIN?.buildOverride)
  });`,
    'admin override on place'
  ],
  [
    `      const labels = { already_claimed: 'That chunk is already claimed.', claim_limit: 'You have reached your chunk claim limit.', stand_in_chunk_to_claim: 'Stand inside a chunk to claim it.' };`,
    `      const labels = { already_claimed: 'That chunk is already claimed.', claim_limit: 'You have reached your chunk claim limit.', stand_in_chunk_to_claim: 'Stand inside a chunk to claim it.', forbidden: 'You do not have permission to do that.' };`,
    'admin claim labels'
  ]
];

const response = await fetch(LOADER_URL, { cache: 'no-store' });
if (!response.ok) throw new Error(`Ridgewood v0.6.0 loader failed to load (${response.status}).`);
let loader = await response.text();

function replaceRequired(search, replacement, label) {
  if (!loader.includes(search)) throw new Error(`Ridgewood v0.8.0 upgrade failed (${label}).`);
  loader = loader.replace(search, replacement);
}

/* Build the statements the v4.3.0 loader will execute against the game text. */
const innerStatements = GAME_PATCHES
  .map(([search, replacement, label]) =>
    `  source = replaceRequired(source, ${JSON.stringify(search)}, ${JSON.stringify(replacement)}, ${JSON.stringify(label)});\n`)
  .join('');

/* Wrap those in the single statement the v0.6.0 loader will execute against
 * the v4.3.0 loader text. */
replaceRequired(
  OUTER_ANCHOR,
  `replaceRequired(${JSON.stringify(INNER_ANCHOR)}, ${JSON.stringify(innerStatements + INNER_ANCHOR)}, 'admin game patches');\n`
  + OUTER_ANCHOR,
  'admin patch injection'
);

replaceRequired("'RIDGEWOOD v0.6.0 ALPHA'", "'RIDGEWOOD v0.8.0 ALPHA'", 'build label');
replaceRequired("'ridgewood-0-6-0'", "'ridgewood-0-8-0'", 'source label');

const blobUrl = URL.createObjectURL(new Blob([loader], { type: 'text/javascript' }));
try { await import(blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
