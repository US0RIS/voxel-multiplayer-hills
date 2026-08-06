/* Ridgewood v0.9.1 final loader delta: stabilize rendering and palette upload. */
const response = await fetch('./game-loader-v0.9.0.js?v=0.9.1-street', { cache: 'no-store' });
if (!response.ok) throw new Error(`Market street loader failed to load (${response.status}).`);
let source = await response.text();

const renderSearch = "  [`  renderTerrain();\n  renderAllShadows();`, `  renderTerrain();\n  renderMarketStalls();\n  renderAllShadows();`, 'marketplace rendering'],";
const renderReplacement = "  ['function renderAllShadows() {', 'function renderAllShadows() {\\n  renderMarketStalls();', 'marketplace rendering'],";
if (!source.includes(renderSearch)) throw new Error('Market street rendering patch target is missing.');
source = source.replace(renderSearch, renderReplacement);

const paletteSearch = "  const colors = window.RIDGEWOOD_MARKET_STALL_ASSET.colors;\n  for (let index = 0; index < colors.length; index += 1) gl.uniform4fv(marketStallProgram.uniforms['uColors[' + index + ']'], colors[index]);";
const paletteReplacement = "  const colors = window.RIDGEWOOD_MARKET_STALL_ASSET.colors;\n  gl.uniform4fv(marketStallProgram.uniforms.uColors, new Float32Array(colors.flat()));";
if (!source.includes(paletteSearch)) throw new Error('Market stall palette patch target is missing.');
source = source.replace(paletteSearch, paletteReplacement);

const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
try { await import(blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
