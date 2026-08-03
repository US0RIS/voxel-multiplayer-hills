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

  Promise.all(parts.map(async (url) => {
    const response = await fetch(`${url}?v=4.2.0`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Chat module part failed to load (${response.status}): ${url}`);
    return (await response.text()).trim();
  }))
    .then((encodedParts) => {
      const binary = atob(encodedParts.join(''));
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const source = new TextDecoder().decode(bytes);
      (0, eval)(`${source}\n//# sourceURL=chat-v4.2.0-runtime.js`);
    })
    .catch((error) => {
      console.error(error);
      const connection = document.querySelector('#chat-connection');
      if (connection) {
        connection.textContent = 'Chat failed to load';
        connection.dataset.state = 'offline';
      }
    });
})();
