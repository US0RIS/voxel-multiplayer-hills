/* Ridgewood v0.9.1 final loader delta: upload the supplied asset palette as one uniform array. */
const response = await fetch('./game-loader-v0.9.0.js?v=0.9.1-street', { cache: 'no-store' });
if (!response.ok) throw new Error(`Market street loader failed to load (${response.status}).`);
let source = await response.text();
const search = "  const colors = window.RIDGEWOOD_MARKET_STALL_ASSET.colors;\n  for (let index = 0; index < colors.length; index += 1) gl.uniform4fv(marketStallProgram.uniforms['uColors[' + index + ']'], colors[index]);";
const replacement = "  const colors = window.RIDGEWOOD_MARKET_STALL_ASSET.colors;\n  gl.uniform4fv(marketStallProgram.uniforms.uColors, new Float32Array(colors.flat()));";
if (!source.includes(search)) throw new Error('Market stall palette patch target is missing.');
source = source.replace(search, replacement);
const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
try { await import(blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
