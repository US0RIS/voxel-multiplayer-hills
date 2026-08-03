/* World Chat loader.
 *
 * The chat module ships as base64 parts so it can be uploaded through hosts
 * that reject large single files. Parts are produced by tools/build-parts.py
 * from docs/chat-source-v4.3.0.js — each part is independently valid base64,
 * so a damaged part fails loudly here instead of silently corrupting the rest
 * of the module (which is exactly what broke chat in v4.2.1).
 */
(() => {
  const VERSION = '4.3.0';
  const PART_COUNT = 16;
  const parts = Array.from(
    { length: PART_COUNT },
    (_, index) => `./chat-parts/part${String(index + 1).padStart(2, '0')}.b64`
  );

  function decodePart(encoded, url) {
    const cleaned = encoded.replace(/\s+/g, '');
    if (!cleaned) throw new Error(`Chat module part is empty: ${url}`);
    if (cleaned.length % 4 !== 0) {
      throw new Error(`Chat module part is corrupt (bad length ${cleaned.length}): ${url}`);
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
      throw new Error(`Chat module part is corrupt (invalid characters): ${url}`);
    }
    const binary = atob(cleaned);
    return new TextDecoder().decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0))
    );
  }

  function reportFailure(error) {
    console.error('World Chat failed to initialize:', error);
    const connection = document.querySelector('#chat-connection');
    if (connection) {
      connection.textContent = `Chat failed to load: ${error.message}`;
      connection.dataset.state = 'offline';
    }
    const input = document.querySelector('#chat-input');
    if (input) {
      input.disabled = true;
      input.placeholder = 'Chat module failed to load — see the console.';
    }
  }

  Promise.all(parts.map(async (url) => {
    let response;
    try {
      response = await fetch(`${url}?v=${VERSION}`, { cache: 'no-store' });
    } catch (error) {
      throw new Error(`Chat module part could not be fetched: ${url} (${error.message})`);
    }
    if (!response.ok) {
      throw new Error(`Chat module part failed to load (${response.status}): ${url}`);
    }
    return decodePart(await response.text(), url);
  }))
    .then((sourceParts) => {
      const source = sourceParts.join('');
      (0, eval)(`${source}\n//# sourceURL=chat-v${VERSION}-runtime.js`);
    })
    .catch(reportFailure);
})();
