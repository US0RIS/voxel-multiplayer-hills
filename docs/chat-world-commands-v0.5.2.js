/* Ridgewood v0.5.2 — expose client-side world commands in chat UI. */
(() => {
  'use strict';

  const WORLD_COMMANDS = [
    {
      command: '/showchunks [on|off]',
      description: 'show, hide, or toggle chunk borders'
    },
    {
      command: '/mychunks',
      description: 'list your claimed chunks and teleport to them'
    }
  ];

  function commandName(item) {
    return String(item?.command || '').trim().split(/\s+/)[0].toLowerCase();
  }

  function mergeWorldCommands(message) {
    const commands = Array.isArray(message.commands) ? message.commands : [];
    const names = new Set(commands.map(commandName));
    for (const item of WORLD_COMMANDS) {
      if (!names.has(commandName(item))) commands.push({ ...item });
    }
    message.commands = commands;
  }

  function augmentHelp(message) {
    if (message?.type !== 'chat:message' || message?.kind !== 'help') return;
    if (typeof message.text !== 'string' || message.text.includes('/showchunks')) return;
    message.text += '\n' + WORLD_COMMANDS
      .map(item => `${item.command} — ${item.description}`)
      .join('\n');
  }

  window.addEventListener('voxel:network-message', event => {
    const message = event.detail;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'chat:history') mergeWorldCommands(message);
    augmentHelp(message);
  }, true);
})();
