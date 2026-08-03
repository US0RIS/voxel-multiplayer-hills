/* World Chat loader.
 *
 * The chat module ships as base64 parts so it can be uploaded through hosts
 * that reject large single files. Parts are produced by tools/build-parts.py
 * from docs/chat-source-v4.3.0.js — each part is independently valid base64,
 * so a damaged part fails loudly here instead of silently corrupting the rest
 * of the module (which is exactly what broke chat in v4.2.1).
 *
 * BUILD_ID / SOURCE_BYTES / SOURCE_SHA256 below are rewritten automatically by
 * tools/build-parts.py. Do not edit them by hand.
 *
 * Why the content hash matters: the part URLs used to be busted with a static
 * version string. When the module changed but the version did not, browsers and
 * CDNs happily served a mix of freshly-deployed and cached parts. Part
 * boundaries shift whenever the source changes, so the concatenation became
 * gibberish and the module died with a meaningless syntax error at whatever
 * identifier happened to land on the seam. Hashing the content means a changed
 * module always has changed URLs, and the integrity check below turns any
 * remaining mismatch into a message that actually says what to do.
 */
(() => {
  const BUILD_ID = '064815090df91964';
  const PART_COUNT = 16;
  const SOURCE_BYTES = 95808;
  const SOURCE_SHA256 = '064815090df91964b3fd8cc71256eb7fb5a2a08b4f1266603d75287282f385a6';

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
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function concatBytes(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }

  async function sha256Hex(bytes) {
    if (!globalThis.crypto?.subtle) return null;
    try {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return null;
    }
  }

  const STALE_HINT = 'The chat files on the server do not match each other, which normally '
    + 'means a stale cache. Hard-refresh the page (Cmd/Ctrl+Shift+R). If it persists, '
    + 'clear site data for this domain.';

  async function verify(bytes) {
    if (SOURCE_BYTES && bytes.length !== SOURCE_BYTES) {
      throw new Error(`Chat module is incomplete (${bytes.length} of ${SOURCE_BYTES} bytes). ${STALE_HINT}`);
    }
    if (SOURCE_SHA256) {
      const actual = await sha256Hex(bytes);
      if (actual && actual !== SOURCE_SHA256) {
        throw new Error(`Chat module failed its integrity check. ${STALE_HINT}`);
      }
    }
  }

  function reportFailure(error) {
    console.error('World Chat failed to initialize:', error);
    const connection = document.querySelector('#chat-connection');
    if (connection) {
      connection.textContent = `Chat failed to load: ${error.message}`;
      connection.dataset.state = 'offline';
      connection.title = error.message;
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
      response = await fetch(`${url}?v=${BUILD_ID}`, { cache: 'no-store' });
    } catch (error) {
      throw new Error(`Chat module part could not be fetched: ${url} (${error.message})`);
    }
    if (!response.ok) {
      throw new Error(`Chat module part failed to load (${response.status}): ${url}`);
    }
    return decodePart(await response.text(), url);
  }))
    .then(async (chunks) => {
      const bytes = concatBytes(chunks);
      await verify(bytes);
      const source = new TextDecoder().decode(bytes);
      (0, eval)(`${source}\n//# sourceURL=chat-${BUILD_ID}-runtime.js`);
    })
    .catch(reportFailure);
})();
