/* Ridgewood — Home screen, v0.5.0
 *
 * Owns the landing experience only:
 *   · the animated isometric voxel backdrop
 *   · the block-built wordmark and slab UI glyphs
 *   · the two server buttons and the modal system
 *   · the "sign in to chat" gate
 *   · handing control over to the existing game module
 *
 * It deliberately does NOT touch the chat module or the multiplayer renderer.
 * The chat gate works by intercepting events on the way down (capture phase)
 * and by parking a fixed strip over the composer, so no chat node is created,
 * moved, restyled, or removed. The only hook into the game is the documented
 * `window.__ridgewoodMenuOpen` flag, which the loader's existing keyboard
 * isolation check honours so the player does not walk around behind the menu.
 */
(() => {
  'use strict';

  const NARROW = 900;

  /* Chat defaults to expanded, which on a phone means it covers the whole
   * landing page on the very first visit. Set the preference before the chat
   * module boots (it reads this key synchronously during its own startup). */
  try {
    if (window.innerWidth <= NARROW && localStorage.getItem('voxel.chat.collapsed') === null) {
      localStorage.setItem('voxel.chat.collapsed', '1');
    }
  } catch { /* private mode — not worth failing the page over */ }

  const $ = (selector) => document.querySelector(selector);

  const home = $('#home');
  const stage = $('#home-scape');
  const wordmarkHost = $('#home-wordmark');
  const publicButton = $('#home-join-public');
  const privateButton = $('#home-join-private');
  const publicMeta = $('#home-public-meta');
  const statusEl = $('#home-status');
  const modal = $('#rw-modal');
  const modalCard = $('#rw-modal-card');
  const modalGlyph = $('#rw-modal-glyph');
  const modalTitle = $('#rw-modal-title');
  const modalBody = $('#rw-modal-body');
  const modalActions = $('#rw-modal-actions');
  const chatLock = $('#rw-chat-lock');
  const menuButton = $('#rw-menu-button');
  const loadingEl = $('#loading');
  const badgeEl = $('#build-badge');
  const helpEl = $('#help');

  let authenticated = false;
  let inGame = false;
  let modalOpen = false;
  let lastFocus = null;

  window.__ridgewoodMenuOpen = true;

  /* =================================================================== art */

  const ICON = {
    /* Isometric cube — the world block. */
    cube(top, left, right, extra = '') {
      return `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <polygon points="24,3 45,15 24,27 3,15" fill="${top}"/>
        <polygon points="3,15 24,27 24,45 3,33" fill="${left}"/>
        <polygon points="45,15 45,33 24,45 24,27" fill="${right}"/>
        ${extra}</svg>`;
    }
  };

  const GLYPH_PUBLIC = `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <polygon points="24,1 46,13.5 24,26 2,13.5" fill="#2a1704" opacity=".22" transform="translate(0,4)"/>
    <polygon points="24,2 45,14 24,26 3,14" fill="#7fc44f"/>
    <polygon points="3,14 24,26 24,45 3,33" fill="#3f7a35"/>
    <polygon points="45,14 45,33 24,45 24,26" fill="#2c5a27"/>
    <polygon points="17,10 24,14 17,18 10,14" fill="#a4dd75"/>
    <polygon points="31,10 38,14 31,18 24,14" fill="#98d268"/>
    <rect x="9" y="21" width="4" height="8" fill="#2f5c29"/>
    <rect x="16" y="25" width="4" height="8" fill="#2f5c29"/>
    <rect x="34" y="21" width="4" height="8" fill="#24491f"/>
  </svg>`;

  const GLYPH_PRIVATE = `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <polygon points="24,2 45,14 24,26 3,14" fill="#647a6d"/>
    <polygon points="3,14 24,26 24,45 3,33" fill="#3a4a43"/>
    <polygon points="45,14 45,33 24,45 24,26" fill="#2a3630"/>
    <path d="M14 27v-4a5 5 0 0 1 10 0v4" fill="none" stroke="#f0a93b" stroke-width="3"/>
    <rect x="11" y="28" width="16" height="12" fill="#f0a93b"/>
    <rect x="17" y="32" width="4" height="5" fill="#2a3630"/>
  </svg>`;

  /* A little blocked-out cabin — "back to the home screen", literally. */
  const GLYPH_HOME = `<svg viewBox="0 0 24 24" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <polygon points="12,2 23,11 19,11 12,5 5,11 1,11" fill="#f0a93b"/>
    <rect x="4" y="10" width="16" height="12" fill="#8fc76a"/>
    <rect x="4" y="10" width="16" height="3" fill="#b0dd8b"/>
    <rect x="10" y="15" width="5" height="7" fill="#2c3d36"/>
    <rect x="6" y="14" width="3" height="3" fill="#2c3d36"/>
  </svg>`;

  const GLYPH_LOCK = `<svg viewBox="0 0 34 34" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M10 15v-4a7 7 0 0 1 14 0v4" fill="none" stroke="#f0a93b" stroke-width="3.2"/>
    <rect x="6" y="15" width="22" height="15" fill="#f0a93b"/>
    <rect x="15" y="20" width="4" height="6" fill="#1e1f22"/>
  </svg>`;

  const GLYPH_MODAL_LOCK = `<svg viewBox="0 0 62 62" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <rect x="9" y="26" width="44" height="30" fill="#0a0f0c"/>
    <path d="M19 26V17a12 12 0 0 1 24 0v9" fill="none" stroke="#f0a93b" stroke-width="6"/>
    <rect x="11" y="28" width="40" height="26" fill="#f0a93b"/>
    <rect x="11" y="28" width="40" height="5" fill="#ffd27a"/>
    <rect x="27" y="36" width="8" height="11" fill="#2a1704"/>
  </svg>`;

  const GLYPH_MODAL_CONE = `<svg viewBox="0 0 62 62" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <polygon points="31,6 52,18 31,30 10,18" fill="#f0a93b"/>
    <polygon points="10,18 31,30 31,52 10,40" fill="#b26d16"/>
    <polygon points="52,18 52,40 31,52 31,30" fill="#8a5210"/>
    <rect x="14" y="22" width="34" height="4" fill="#0a0f0c" opacity=".55" transform="skewY(-30)"/>
    <rect x="14" y="34" width="34" height="4" fill="#0a0f0c" opacity=".55" transform="skewY(-30)"/>
  </svg>`;

  const DISCORD_MARK = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M20.32 4.9A19.4 19.4 0 0 0 15.5 3.4a13.6 13.6 0 0 0-.62 1.27 17.9 17.9 0 0 0-5.37 0A13.3 13.3 0 0 0 8.88 3.4 19.3 19.3 0 0 0 4.06 4.9C1.01 9.46.18 13.9.6 18.29a19.5 19.5 0 0 0 5.92 3 14.5 14.5 0 0 0 1.27-2.06 12.7 12.7 0 0 1-2-.96c.17-.12.33-.25.49-.38a13.9 13.9 0 0 0 11.87 0c.16.14.32.26.49.38-.64.38-1.31.7-2 .96a14.3 14.3 0 0 0 1.27 2.06 19.4 19.4 0 0 0 5.92-3c.5-5.09-.84-9.49-3.5-13.39ZM8.35 15.6c-1.18 0-2.15-1.08-2.15-2.4s.95-2.42 2.15-2.42 2.17 1.09 2.15 2.42c0 1.32-.95 2.4-2.15 2.4Zm7.3 0c-1.18 0-2.15-1.08-2.15-2.4s.95-2.42 2.15-2.42 2.17 1.09 2.15 2.42c0 1.32-.95 2.4-2.15 2.4Z"/>
  </svg>`;

  /* --------------------------------------------------------- block wordmark */

  /* A hand-set 5x7 bitmap face. Drawing the logo out of literal squares is the
   * cheapest honest way to say "this game is made of cubes" — and it needs no
   * webfont, so the wordmark can never render in a fallback face. */
  const FACE = {
    R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
    D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    G: ['01111', '10000', '10000', '10111', '10001', '10001', '01110'],
    E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    W: ['10001', '10001', '10001', '10001', '10101', '11011', '10001'],
    O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110']
  };

  function buildWordmark(word) {
    const gap = 1;
    const glyphs = [...word].map((letter) => FACE[letter]).filter(Boolean);
    const width = glyphs.length * 5 + (glyphs.length - 1) * gap;
    const height = 7;
    const depth = 2;

    const layer = (dx, dy, fill) => {
      let path = '';
      glyphs.forEach((rows, index) => {
        const originX = index * (5 + gap);
        rows.forEach((row, y) => {
          let run = 0;
          for (let x = 0; x <= 5; x += 1) {
            if (row[x] === '1') { run += 1; continue; }
            if (run) path += `M${originX + x - run + dx} ${y + dy}h${run}v1h-${run}z`;
            run = 0;
          }
        });
      });
      return `<path d="${path}" fill="${fill}"/>`;
    };

    return `<svg viewBox="0 0 ${width + depth} ${height + depth}" shape-rendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${word}">
      ${layer(2, 2, '#25401f')}
      ${layer(1, 1, '#c9791b')}
      ${layer(0, 0, '#f6f0e0')}
    </svg>`;
  }

  /* ================================================== isometric voxel scape */

  /* A tiny seeded value-noise terrain, drawn once into offscreen layers and
   * then panned. Same silhouette language as the game: rolling hills, a lake,
   * scattered trees, hard three-tone cube faces, warm haze into the horizon. */

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function random() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeNoise(seed) {
    const random = mulberry32(seed);
    const size = 256;
    const table = new Float32Array(size * size);
    for (let index = 0; index < table.length; index += 1) table[index] = random();
    const at = (x, y) => table[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
    const smooth = (t) => t * t * (3 - 2 * t);

    return function noise(x, y) {
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = smooth(x - x0);
      const fy = smooth(y - y0);
      const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
      const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
      return top * (1 - fy) + bottom * fy;
    };
  }

  const toHex = (r, g, b) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
  const channels = (hex) => {
    const value = parseInt(hex.slice(1), 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  };

  /* Darken toward the shaded side of a cube — slightly blue-shifted, the way
   * a face turned away from a warm sun actually reads. */
  function shade(hex, amount) {
    const [r, g, b] = channels(hex);
    return toHex(r * amount, g * amount, b * (amount + 0.08));
  }

  function mix(hex, targetHex, amount) {
    const a = channels(hex);
    const b = channels(targetHex);
    return toHex(
      a[0] + (b[0] - a[0]) * amount,
      a[1] + (b[1] - a[1]) * amount,
      a[2] + (b[2] - a[2]) * amount
    );
  }

  /* One cube's three visible faces, already hazed for its distance. */
  function faces(base, haze, hazeColor = HAZE) {
    return [
      mix(base, hazeColor, haze),
      mix(shade(base, 0.64), hazeColor, haze * 0.84),
      mix(shade(base, 0.43), hazeColor, haze * 0.72)
    ];
  }

  const SKY_TOP = '#101d29';
  const SKY_MID = '#2b4550';
  const SKY_WARM = '#8d6046';
  const SKY_GLOW = '#e59a52';
  const HAZE = '#c8814f';

  const TERRAIN = [
    { limit: 0.21, color: '#2f6a72', water: true },
    { limit: 0.28, color: '#cdb083' },
    { limit: 0.52, color: '#6fae4b' },
    { limit: 0.74, color: '#508b39' },
    { limit: 0.88, color: '#3c6c30' },
    { limit: 1.01, color: '#83806f' }
  ];

  function makeLayer(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
  }

  const scape = {
    ctx: stage ? stage.getContext('2d') : null,
    sky: null,
    clouds: null,
    land: null,
    width: 0,
    height: 0,
    ratio: 1,
    horizon: 0,
    cloudWidth: 0,
    pointerX: 0,
    pointerY: 0,
    driftX: 0,
    driftY: 0,
    raf: 0
  };

  function paintSky(width, height, horizon) {
    const canvas = makeLayer(width, height);
    const ctx = canvas.getContext('2d');

    const sky = ctx.createLinearGradient(0, 0, 0, horizon + height * 0.1);
    sky.addColorStop(0, SKY_TOP);
    sky.addColorStop(0.44, SKY_MID);
    sky.addColorStop(0.78, SKY_WARM);
    sky.addColorStop(1, SKY_GLOW);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);

    // Sun: a disc quantised onto an 11px grid so even the light is voxelised.
    const sunX = width * 0.72;
    const sunY = horizon - height * 0.13;
    const radius = Math.max(46, height * 0.085);

    const glow = ctx.createRadialGradient(sunX, sunY, radius * 0.4, sunX, sunY, radius * 7);
    glow.addColorStop(0, 'rgba(255, 214, 148, 0.5)');
    glow.addColorStop(0.35, 'rgba(233, 150, 82, 0.22)');
    glow.addColorStop(1, 'rgba(233, 150, 82, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);

    const cell = 11;
    ctx.fillStyle = '#ffe6b4';
    for (let y = -radius; y < radius; y += cell) {
      for (let x = -radius; x < radius; x += cell) {
        const cx = x + cell / 2;
        const cy = y + cell / 2;
        if (cx * cx + cy * cy > radius * radius) continue;
        const fade = 1 - Math.min(1, Math.hypot(cx, cy) / radius);
        ctx.globalAlpha = 0.5 + fade * 0.5;
        ctx.fillRect(Math.round(sunX + x), Math.round(sunY + y), cell - 1, cell - 1);
      }
    }
    ctx.globalAlpha = 1;

    // Far ridge silhouettes, blocked out in steps rather than curves.
    const random = mulberry32(90210);
    for (let pass = 0; pass < 3; pass += 1) {
      const step = 26 + pass * 10;
      const base = horizon - 6 + pass * 9;
      const amplitude = 34 - pass * 9;
      ctx.fillStyle = mix('#1f3a33', HAZE, 0.46 - pass * 0.14);
      ctx.beginPath();
      ctx.moveTo(0, height);
      let previous = base;
      for (let x = 0; x <= width + step; x += step) {
        previous += (random() - 0.5) * amplitude;
        previous = Math.max(base - amplitude * 1.4, Math.min(base + amplitude * 0.5, previous));
        const y = Math.round(previous / 4) * 4;
        ctx.lineTo(x, y);
        ctx.lineTo(x + step, y);
      }
      ctx.lineTo(width + step, height);
      ctx.closePath();
      ctx.fill();
    }

    return canvas;
  }

  function paintClouds(width, height) {
    const canvas = makeLayer(width, height);
    const ctx = canvas.getContext('2d');
    const random = mulberry32(1337);
    const unit = 9;

    for (let index = 0; index < 16; index += 1) {
      const x = random() * width;
      const y = 20 + random() * (height * 0.62);
      const length = 5 + Math.floor(random() * 8);
      const alpha = 0.10 + random() * 0.16;
      ctx.fillStyle = `rgba(255, 232, 205, ${alpha})`;
      let cursor = x;
      for (let block = 0; block < length; block += 1) {
        const blockWidth = unit * (2 + Math.floor(random() * 4));
        const blockHeight = unit * (1 + Math.floor(random() * 2));
        const lift = Math.round((random() - 0.5) * 2) * unit;
        ctx.fillRect(Math.round(cursor), Math.round(y + lift), blockWidth, blockHeight);
        cursor += blockWidth * 0.72;
      }
    }
    return canvas;
  }

  function paintLand(width, height, horizon) {
    const canvas = makeLayer(width, height);
    const ctx = canvas.getContext('2d');

    const tileW = 46;
    const tileH = 23;
    const levelH = 13;
    const levels = 11;
    const count = Math.ceil(width / tileW) + 12;
    const originX = width * 0.5;
    const originY = horizon - 40;

    const noise = makeNoise(2026);
    const random = mulberry32(74015);

    const heights = new Int16Array(count * count);
    for (let i = 0; i < count; i += 1) {
      for (let j = 0; j < count; j += 1) {
        const nx = i * 0.085;
        const ny = j * 0.085;
        let value = noise(nx, ny) * 0.6 + noise(nx * 2.3, ny * 2.3) * 0.27 + noise(nx * 4.7, ny * 4.7) * 0.13;
        value = Math.pow(Math.min(1, Math.max(0, value * 1.28 - 0.1)), 1.25);
        heights[i * count + j] = Math.round(value * levels);
      }
    }

    const heightAt = (i, j) => (i < 0 || j < 0 || i >= count || j >= count ? -2 : heights[i * count + j]);

    const bandFor = (level) => {
      const ratio = level / levels;
      for (const band of TERRAIN) if (ratio <= band.limit) return band;
      return TERRAIN[TERRAIN.length - 1];
    };

    const waterLevel = Math.round(0.21 * levels);

    function facePath(x, y, halfW, halfH) {
      ctx.beginPath();
      ctx.moveTo(x, y - halfH);
      ctx.lineTo(x + halfW, y);
      ctx.lineTo(x, y + halfH);
      ctx.lineTo(x - halfW, y);
      ctx.closePath();
    }

    function drawColumn(x, y, halfW, halfH, depth, top, left, right) {
      facePath(x, y, halfW, halfH);
      ctx.fillStyle = top;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(x - halfW, y);
      ctx.lineTo(x, y + halfH);
      ctx.lineTo(x, y + halfH + depth);
      ctx.lineTo(x - halfW, y + depth);
      ctx.closePath();
      ctx.fillStyle = left;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(x + halfW, y);
      ctx.lineTo(x, y + halfH);
      ctx.lineTo(x, y + halfH + depth);
      ctx.lineTo(x + halfW, y + depth);
      ctx.closePath();
      ctx.fillStyle = right;
      ctx.fill();
    }

    const maxDiagonal = 2 * count - 2;

    for (let diagonal = 0; diagonal <= maxDiagonal; diagonal += 1) {
      const hazeAmount = Math.pow(Math.max(0, 1 - diagonal / (maxDiagonal * 0.82)), 1.9) * 0.94;

      for (let i = Math.max(0, diagonal - count + 1); i <= Math.min(count - 1, diagonal); i += 1) {
        const j = diagonal - i;
        const raw = heights[i * count + j];
        const band = bandFor(raw);
        const level = band.water ? waterLevel : raw;

        const x = originX + (i - j) * (tileW / 2);
        if (x < -tileW || x > width + tileW) continue;
        const y = originY + (i + j) * (tileH / 2) - level * levelH;
        if (y - tileH > height) continue;

        const neighbour = Math.min(heightAt(i + 1, j), heightAt(i, j + 1));
        const drop = Math.max(1, level - Math.max(-1, neighbour) + 1);
        const depth = Math.min(drop * levelH, height);

        const [top, left, right] = faces(band.color, hazeAmount);
        drawColumn(x, y, tileW / 2, tileH / 2, depth, top, left, right);

        if (band.water) {
          ctx.globalAlpha = 0.16 * (1 - hazeAmount);
          facePath(x, y, tileW / 2, tileH / 2);
          ctx.fillStyle = '#cfe9ee';
          ctx.fill();
          ctx.globalAlpha = 1;
          continue;
        }

        // Trees only on the mid-green shelf, and never right at the frame edge.
        const ratio = raw / levels;
        if (ratio > 0.30 && ratio < 0.72 && random() < 0.055) {
          const trunk = faces('#5c4026', hazeAmount);
          const leafLow = faces('#3d7a33', hazeAmount);
          const leafHigh = faces('#63ab4d', hazeAmount);
          drawColumn(x, y - levelH * 0.55, tileW * 0.11, tileH * 0.11, levelH * 0.8, ...trunk);
          drawColumn(x, y - levelH * 1.35, tileW * 0.40, tileH * 0.40, levelH * 1.0, ...leafLow);
          drawColumn(x, y - levelH * 2.30, tileW * 0.24, tileH * 0.24, levelH * 0.75, ...leafHigh);
        }
      }
    }

    return canvas;
  }

  function buildScape() {
    if (!stage || !scape.ctx) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(640, window.innerWidth);
    const height = Math.max(420, window.innerHeight);
    const pad = 70;

    scape.ratio = ratio;
    scape.width = width;
    scape.height = height;
    stage.width = Math.round(width * ratio);
    stage.height = Math.round(height * ratio);
    scape.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    scape.ctx.imageSmoothingEnabled = false;

    const layerWidth = width + pad * 2;
    const layerHeight = height + pad * 2;
    scape.horizon = Math.round(height * 0.44) + pad;
    scape.cloudWidth = layerWidth;

    scape.sky = paintSky(layerWidth, layerHeight, scape.horizon);
    scape.clouds = paintClouds(layerWidth, scape.horizon - pad * 0.5);
    scape.land = paintLand(layerWidth, layerHeight, scape.horizon);
    scape.pad = pad;
  }

  function drawScape(time) {
    const ctx = scape.ctx;
    if (!ctx || !scape.sky) return;
    const pad = scape.pad;

    const targetX = scape.pointerX * 16 + Math.sin(time / 21000) * 22;
    const targetY = scape.pointerY * 9 + Math.cos(time / 27000) * 9;
    scape.driftX += (targetX - scape.driftX) * 0.045;
    scape.driftY += (targetY - scape.driftY) * 0.045;

    ctx.clearRect(0, 0, scape.width, scape.height);
    ctx.drawImage(scape.sky, -pad + scape.driftX * 0.22, -pad + scape.driftY * 0.2);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, scape.width, scape.horizon - pad + 24);
    ctx.clip();
    const cloudShift = (time / 118) % scape.cloudWidth;
    const cloudY = -pad * 0.5 + scape.driftY * 0.3;
    ctx.drawImage(scape.clouds, -cloudShift, cloudY);
    ctx.drawImage(scape.clouds, -cloudShift + scape.cloudWidth, cloudY);
    ctx.restore();

    ctx.drawImage(scape.land, -pad + scape.driftX, -pad + scape.driftY * 0.6);
  }

  function loop(time) {
    drawScape(time);
    scape.raf = requestAnimationFrame(loop);
  }

  function startScape() {
    if (scape.raf) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      drawScape(0);
      return;
    }
    scape.raf = requestAnimationFrame(loop);
  }

  function stopScape() {
    if (!scape.raf) return;
    cancelAnimationFrame(scape.raf);
    scape.raf = 0;
  }

  /* ================================================================== modal */

  function openModal({ glyph, title, body, actions = [] }) {
    if (!modal) return;
    lastFocus = document.activeElement;
    modalGlyph.innerHTML = glyph || '';
    modalGlyph.hidden = !glyph;
    modalTitle.textContent = title;
    modalBody.textContent = body;
    modalActions.replaceChildren();

    for (const action of actions) {
      const node = document.createElement(action.href ? 'a' : 'button');
      node.className = `rw-slab ${action.variant || 'rw-discord'}`;
      if (action.href) {
        node.href = action.href;
      } else {
        node.type = 'button';
        node.addEventListener('click', () => {
          closeModal();
          action.onSelect?.();
        });
      }
      const face = document.createElement('span');
      face.className = 'rw-face';
      face.innerHTML = `${action.icon || ''}<span>${action.label}</span>`;
      node.append(face);
      modalActions.append(node);
    }

    modal.hidden = false;
    modalOpen = true;
    window.__ridgewoodMenuOpen = true;
    requestAnimationFrame(() => modalActions.querySelector('.rw-slab')?.focus());
  }

  function closeModal() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    modalOpen = false;
    window.__ridgewoodMenuOpen = !inGame;
    if (lastFocus instanceof HTMLElement) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }

  function showLoginRequired() {
    openModal({
      glyph: GLYPH_MODAL_LOCK,
      title: 'Sign in required',
      body: 'Log in with Discord in order to use this feature.',
      actions: [
        {
          label: 'Continue with Discord',
          variant: 'rw-discord',
          icon: DISCORD_MARK,
          href: window.RIDGEWOOD_AUTH_API?.loginUrl?.() || '#'
        },
        { label: 'Not now', variant: 'rw-card--private rw-modal-dismiss' }
      ]
    });
  }

  function showUnderConstruction() {
    openModal({
      glyph: GLYPH_MODAL_CONE,
      title: 'Private servers',
      body: 'This feature is under construction.',
      actions: [{ label: 'Back to the valley', variant: 'rw-card--private' }]
    });
  }

  modal?.addEventListener('click', (event) => {
    if (event.target === modal || event.target.classList.contains('rw-modal-backdrop')) closeModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modalOpen) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeModal();
    }
  }, true);

  /* ============================================================== chat gate */

  /* Everything here is passive: capture-phase listeners and one fixed strip
   * parked over the composer. No chat node is touched. */
  function chatGateActive() {
    return !authenticated;
  }

  const COMPOSER_TARGETS = '#chat-input, #chat-send, #chat-emoji-button, #chat-attach, .composer-shell, .chat-composer, #chat-name-save, #chat-status-save, #chat-name-input, #chat-status-input';

  document.addEventListener('pointerdown', (event) => {
    if (!chatGateActive()) return;
    const target = event.target instanceof Element ? event.target.closest(COMPOSER_TARGETS) : null;
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    showLoginRequired();
  }, true);

  document.addEventListener('focusin', (event) => {
    if (!chatGateActive()) return;
    const target = event.target;
    if (!(target instanceof Element) || !target.matches('#chat-input, #chat-name-input, #chat-status-input')) return;
    // The chat module focuses its composer on boot and on stray keypresses.
    // Refuse the focus quietly; the lock strip already explains why.
    target.blur?.();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (!chatGateActive() || modalOpen) return;
    if (document.documentElement.dataset.chatCollapsed === 'true') return;
    if (event.key !== 'Enter' && event.key !== '/') return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (target instanceof HTMLElement && target.closest('#home, .rw-modal')) return;
    event.preventDefault();
    event.stopPropagation();
    showLoginRequired();
  }, true);

  /* ============================================================ navigation */

  /* #game is never hidden — the home screen simply sits on top of it, so the
   * WebGL canvas always has a real size to render into. Entering the world is
   * therefore only ever "get out of the way". */
  function enterGame() {
    if (inGame) return;
    inGame = true;
    window.__ridgewoodMenuOpen = false;
    loadingEl?.removeAttribute('hidden');
    window.RIDGEWOOD_AUTH_API?.startGame?.();

    home?.setAttribute('data-leaving', 'true');
    window.setTimeout(() => {
      home?.setAttribute('hidden', '');
      home?.removeAttribute('data-leaving');
      stopScape();
      badgeEl?.removeAttribute('hidden');
      helpEl?.removeAttribute('hidden');
      menuButton?.removeAttribute('hidden');
      document.documentElement.dataset.ridgewoodView = 'game';
      window.dispatchEvent(new Event('resize'));
      window.VOXEL_GAME_API?.focusCanvas?.();
    }, 320);
  }

  function returnToMenu() {
    if (!inGame) return;
    inGame = false;
    window.__ridgewoodMenuOpen = true;
    badgeEl?.setAttribute('hidden', '');
    helpEl?.setAttribute('hidden', '');
    menuButton?.setAttribute('hidden', '');
    loadingEl?.setAttribute('hidden', '');
    home?.removeAttribute('hidden');
    document.documentElement.dataset.ridgewoodView = 'home';
    buildScape();
    startScape();
  }

  publicButton?.addEventListener('click', enterGame);
  privateButton?.addEventListener('click', showUnderConstruction);
  menuButton?.addEventListener('click', returnToMenu);

  /* ============================================================ live counts */

  function setPlayerCount(count) {
    if (!publicMeta) return;
    const online = Number.isFinite(count) ? count : null;
    publicMeta.textContent = online === null
      ? 'Open world'
      : `${online} ${online === 1 ? 'player' : 'players'} online`;
  }

  window.addEventListener('voxel:network-message', (event) => {
    const message = event.detail || {};
    if (message.type === 'welcome' && Array.isArray(message.players)) {
      setPlayerCount(message.players.length + 1);
    }
    if (message.type === 'chat:users' && Array.isArray(message.users)) {
      setPlayerCount(message.users.filter((user) => user.online).length);
    }
  });

  /* ================================================================= status */

  const statusText = $('#home-status-text');

  function setStatus(state, label) {
    if (!statusEl) return;
    statusEl.dataset.state = state;
    if (statusText) statusText.textContent = label;
  }

  /* ============================================================== bootstrap */

  if (wordmarkHost) wordmarkHost.innerHTML = buildWordmark('RIDGEWOOD');
  $('#home-brand-cube')?.replaceChildren();
  const brandCube = $('#home-brand-cube');
  if (brandCube) brandCube.innerHTML = ICON.cube('#7fc44f', '#3f7a35', '#2c5a27');
  const publicGlyph = $('#home-public-glyph');
  if (publicGlyph) publicGlyph.innerHTML = GLYPH_PUBLIC;
  const privateGlyph = $('#home-private-glyph');
  if (privateGlyph) privateGlyph.innerHTML = GLYPH_PRIVATE;
  const lockGlyph = $('#rw-lock-glyph');
  if (lockGlyph) lockGlyph.innerHTML = GLYPH_LOCK;
  const menuGlyph = $('#rw-menu-glyph');
  if (menuGlyph) menuGlyph.innerHTML = GLYPH_HOME;
  for (const slot of document.querySelectorAll('[data-discord-mark]')) slot.innerHTML = DISCORD_MARK;

  buildScape();
  startScape();

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (home && !home.hasAttribute('hidden')) {
        buildScape();
        if (!scape.raf) drawScape(0);
      }
    }, 180);
  });

  window.addEventListener('pointermove', (event) => {
    if (inGame) return;
    scape.pointerX = (event.clientX / window.innerWidth) * 2 - 1;
    scape.pointerY = (event.clientY / window.innerHeight) * 2 - 1;
  }, { passive: true });

  /* ================================================================== API */

  window.RIDGEWOOD_HOME = Object.freeze({
    setAuthenticated(value) {
      authenticated = Boolean(value);
      home?.setAttribute('data-state', authenticated ? 'member' : 'guest');
      if (chatLock) chatLock.hidden = authenticated;
      if (authenticated) {
        closeModal();
        return;
      }
      // Guests never open a socket, so the chat module will never correct its
      // own placeholder. Say something true instead of "Connecting…" forever.
      const connection = $('#chat-connection');
      if (connection) {
        connection.textContent = 'Sign in to join world chat';
        connection.dataset.state = 'offline';
      }
      const composer = $('#chat-input');
      if (composer) composer.placeholder = 'Log in with Discord to chat';
    },
    setStatus,
    setPlayerCount,
    enterGame,
    returnToMenu,
    showLoginRequired,
    isInGame: () => inGame
  });

  window.RIDGEWOOD_HOME.setAuthenticated(false);
  setStatus('checking', 'Checking server…');
  setPlayerCount(null);
})();
