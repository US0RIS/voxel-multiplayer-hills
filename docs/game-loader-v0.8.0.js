/* Compatibility entry point: existing auth code still requests v0.8.0. */
await import('./assets/market-stall-v0.9.1.js?v=0.9.1');
await import('./marketplace-v0.9.1.js?v=0.9.1');
const ridgewoodNativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const value = typeof input === 'string' ? input : String(input?.url || input);
  if (value.includes('game-loader-v0.8.0.js?v=0.9.1-base')) {
    return ridgewoodNativeFetch('./game-loader-v0.8.0-base.js?v=0.8.1', init);
  }
  return ridgewoodNativeFetch(input, init);
};
try {
  await import('./game-loader-v0.9.1.js?v=0.9.1');
} finally {
  window.fetch = ridgewoodNativeFetch;
}
