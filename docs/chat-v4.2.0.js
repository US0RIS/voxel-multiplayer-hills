(() => {
  const parts = [
    './chat-parts/part01.b64',
    './chat-parts/part02.b64',
    './chat-parts/part03.b64',
    './chat-parts/part04.b64',
    './chat-parts/part05.b64',
    './chat-parts/part06.b64',
    './chat-parts/part07.b64'
  ];

  function decodePart(encoded) {
    const binary = atob(encoded.replace(/\s+/g, ''));
    return new TextDecoder().decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0))
    );
  }

  Promise.all(parts.map(async (url) => {
    const response = await fetch(`${url}?v=4.2.1`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Chat module part failed to load (${response.status}): ${url}`);
    }
    return decodePart(await response.text());
  }))
    .then((sourceParts) => {
      const source = sourceParts.join('');
      (0, eval)(`${source}\n//# sourceURL=chat-v4.2.1-runtime.js`);
    })
    .catch((error) => {
      console.error('World Chat failed to initialize:', error);
      const connection = document.querySelector('#chat-connection');
      if (connection) {
        connection.textContent = `Chat failed: ${error.message}`;
        connection.dataset.state = 'offline';
      }
    });
})();
