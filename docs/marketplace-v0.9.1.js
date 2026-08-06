/* Ridgewood v0.9.1 marketplace client delta: long-street entrance. */
const response = await fetch('./marketplace-v0.9.0.js?v=0.9.1-base', { cache: 'no-store' });
if (!response.ok) throw new Error(`Marketplace client failed to load (${response.status}).`);
let source = await response.text();
const search = "    api.teleport(8.5, -1.5);\n    toast('Teleported to the Ridgewood marketplace. Click a stall to browse it.');";
const replacement = "    api.teleport(8.5, -24.5);\n    toast('Teleported to the south entrance of Ridgewood Market Street. Stalls face the central road.');";
if (!source.includes(search)) throw new Error('Marketplace street teleport patch target is missing.');
source = source.replace(search, replacement);
const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
try { await import(blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
