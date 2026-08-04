/* Ridgewood v0.6.0 game-loader bootstrap. */
const parts = [1, 2, 3, 4, 5].map(number => `game-loader-v0.6.0-parts/part${number}.txt?v=0.6.0`);
const responses = await Promise.all(parts.map(url => fetch(url, { cache: 'no-store' })));
for (const response of responses) {
  if (!response.ok) throw new Error(`Game loader part failed to load (${response.status}).`);
}
const source = (await Promise.all(responses.map(response => response.text()))).join('');
const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
try {
  await import(blobUrl);
} finally {
  URL.revokeObjectURL(blobUrl);
}
