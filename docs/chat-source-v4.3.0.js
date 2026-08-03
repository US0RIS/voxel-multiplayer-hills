/* Voxel Multiplayer Hills — World Chat v4.3.0
 *
 * Readable source of truth for the chat client. `chat-v4.3.0.js` loads a
 * base64 copy of this file from `chat-parts/`. After editing, run:
 *
 *     python3 tools/build-parts.py
 */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ setup */

  const MAX_MESSAGES = 300;
  const GROUP_WINDOW_MS = 5 * 60 * 1000;
  const BOTTOM_THRESHOLD_PX = 90;
  const MAX_TOASTS = 4;
  const TOAST_LIFETIME_MS = 4200;
  const KEY = {
    cache: 'voxel.chat.history.v4.3',
    collapsed: 'voxel.chat.collapsed',
    sound: 'voxel.chat.sound',
    desktop: 'voxel.chat.desktop',
    members: 'voxel.chat.members',
    draft: 'voxel.chat.draft',
    lastRead: 'voxel.chat.lastread',
    nick: 'voxel.chat.nick'
  };
  const MOVEMENT_CODES = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'
  ]);
  const DEFAULT_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🔥', '✅', '❓'];

  const EMOJI_GROUPS = [
    ['Reactions', [
      ['👍', 'thumbs up yes ok'], ['👎', 'thumbs down no'], ['❤️', 'heart love'],
      ['🔥', 'fire lit hot'], ['🎉', 'party tada celebrate'], ['✅', 'check done yes'],
      ['❌', 'cross no wrong'], ['❓', 'question what'], ['❗', 'exclamation important'],
      ['👀', 'eyes look watching'], ['🙏', 'pray thanks please'], ['👋', 'wave hello bye'],
      ['🤝', 'handshake deal trade'], ['💯', 'hundred perfect'], ['🚀', 'rocket launch ship']
    ]],
    ['Faces', [
      ['😀', 'grin happy smile'], ['😂', 'joy laugh cry'], ['🙂', 'slight smile'],
      ['😉', 'wink'], ['😍', 'heart eyes love'], ['😎', 'cool sunglasses'],
      ['🤔', 'thinking hmm'], ['😅', 'sweat nervous laugh'], ['😭', 'sob crying'],
      ['😡', 'angry rage mad'], ['😴', 'sleeping tired afk'], ['🤯', 'mind blown'],
      ['🥳', 'partying celebrate'], ['😱', 'scream shock'], ['💀', 'skull dead rip'],
      ['🫠', 'melting'], ['😬', 'grimace awkward'], ['🤖', 'robot bot']
    ]],
    ['World', [
      ['🧱', 'brick block build'], ['⛏️', 'pickaxe mine mining'], ['🪓', 'axe chop wood'],
      ['🌲', 'tree pine forest'], ['🌳', 'tree forest'], ['🏔️', 'mountain hills'],
      ['🏠', 'house home base'], ['🏰', 'castle build'], ['🗺️', 'map explore'],
      ['⌖', 'location marker here'], ['💎', 'diamond gem ore'], ['🪙', 'coin money gold'],
      ['🌊', 'water ocean wave'], ['🌙', 'moon night'], ['☀️', 'sun day sunny'],
      ['⚡', 'lightning fast power'], ['🔨', 'hammer craft build'], ['🧭', 'compass direction']
    ]],
    ['Objects', [
      ['💬', 'chat speech message'], ['📌', 'pin pinned'], ['🔔', 'bell notification'],
      ['🔕', 'mute silent'], ['📣', 'announce megaphone'], ['🎮', 'game controller play'],
      ['🎲', 'dice roll random'], ['🛒', 'cart shop market'], ['🎁', 'gift present'],
      ['⏰', 'clock time alarm'], ['🧠', 'brain smart idea'], ['💡', 'idea bulb'],
      ['🔒', 'lock claim private'], ['🔑', 'key access'], ['📦', 'box package chest']
    ]]
  ];

  const SHORTCODES = {
    ':)': '🙂', ':-)': '🙂', ':(': '🙁', ':-(': '🙁', ':d': '😀', ':p': '😛',
    ';)': '😉', ':o': '😮', '<3': '❤️', ':thumbsup:': '👍', ':fire:': '🔥',
    ':tada:': '🎉', ':eyes:': '👀', ':skull:': '💀', ':heart:': '❤️',
    ':wave:': '👋', ':rocket:': '🚀', ':check:': '✅', ':shrug:': '¯\\_(ツ)_/¯'
  };

  const $ = (selector) => document.querySelector(selector);

  const ui = {
    panel: $('#chat-panel'),
    collapse: $('#chat-collapse'),
    collapsedTab: $('#chat-collapsed-tab'),
    unread: $('#chat-unread'),
    scroller: $('#chat-messages'),
    list: $('#chat-message-list'),
    intro: $('#chat-intro'),
    input: $('#chat-input'),
    send: $('#chat-send'),
    charCount: $('#chat-char-count'),
    playerList: $('#chat-player-list'),
    onlineCount: $('#chat-online-count'),
    memberSearch: $('#chat-member-search'),
    typing: $('#chat-typing'),
    connection: $('#chat-connection'),
    searchToggle: $('#chat-search-toggle'),
    searchBar: $('#chat-search-bar'),
    searchInput: $('#chat-search-input'),
    searchCount: $('#chat-search-count'),
    searchPrev: $('#chat-search-prev'),
    searchNext: $('#chat-search-next'),
    searchClose: $('#chat-search-close'),
    sound: $('#chat-sound-toggle'),
    desktop: $('#chat-desktop-toggle'),
    membersToggle: $('#chat-members-toggle'),
    pinsToggle: $('#chat-pins-toggle'),
    pinsPanel: $('#chat-pins-panel'),
    pinsList: $('#chat-pins-list'),
    pinsClose: $('#chat-pins-close'),
    pinsCount: $('#chat-pins-count'),
    toastRegion: $('#chat-toasts'),
    mentionMenu: $('#chat-mention-menu'),
    commandHint: $('#chat-command-hint'),
    emojiButton: $('#chat-emoji-button'),
    emojiPicker: $('#chat-emoji-picker'),
    emojiSearch: $('#chat-emoji-search'),
    emojiResults: $('#chat-emoji-results'),
    contextMenu: $('#chat-context-menu'),
    replyBar: $('#chat-reply-bar'),
    replyLabel: $('#chat-reply-label'),
    replyCancel: $('#chat-reply-cancel'),
    jumpButton: $('#chat-jump'),
    statusInput: $('#chat-status-input'),
    statusSave: $('#chat-status-save'),
    nameInput: $('#chat-name-input'),
    nameSave: $('#chat-name-save'),
    composerShell: $('#chat-composer-shell'),
    uploadHint: $('#chat-attach')
  };

  if (!ui.panel || !ui.input || !ui.scroller || !ui.list) return;

  const state = {
    collapsed: localStorage.getItem(KEY.collapsed) === '1',
    sound: localStorage.getItem(KEY.sound) !== '0',
    desktop: localStorage.getItem(KEY.desktop) === '1',
    membersVisible: localStorage.getItem(KEY.members) !== '0',
    messages: loadCache(),
    users: [],
    pinned: [],
    commands: [],
    reactions: DEFAULT_REACTIONS.slice(),
    limits: { messageLength: 2000, rateLimit: 5, rateWindowSeconds: 5 },
    local: null,
    pending: new Map(),
    outbox: [],
    sendTimes: [],
    typingUsers: new Map(),
    unread: 0,
    mentionUnread: 0,
    lastRead: Number(localStorage.getItem(KEY.lastRead)) || 0,
    unreadAnchor: null,
    search: '',
    searchMatches: [],
    searchCursor: 0,
    memberFilter: '',
    replyTo: null,
    editingId: null,
    connected: false,
    bridgeReady: Boolean(window.VOXEL_GAME_API),
    typingTimer: null,
    lastTypingSent: false,
    lastLocationSent: 0,
    audioContext: null,
    pinnedToBottom: true,
    newWhileScrolled: 0,
    activeMenuCleanup: null,
    mentionIndex: 0,
    commandIndex: 0,
    menuNavigated: false,
    nodeCache: new Map(),
    baseTitle: document.title,
    flushTimer: null,
    reconnectNotified: false
  };

  /* ------------------------------------------------------------------- boot */

  applyCollapsedState(false);
  applyMembersVisibility();
  updateSoundButton();
  updateDesktopButton();
  restoreDraft();
  bindEvents();
  render();
  renderPlayers();
  renderPins();
  updateTypingIndicator();
  updateComposerState();
  updateCharCount();

  if (!state.collapsed) requestAnimationFrame(() => ui.input.focus({ preventScroll: true }));

  window.addEventListener('voxel:bridge-ready', (event) => {
    state.bridgeReady = true;
    mergeLocal(event.detail);
    updateComposerState();
  });

  window.addEventListener('voxel:network-ready', (event) => {
    state.connected = true;
    mergeLocal(event.detail);
    setConnectionState('online', `Connected as ${localName()}`);
    updateComposerState();
    sendPacket({ type: 'chat:history' });
    flushOutbox();
    if (state.reconnectNotified) {
      showSystemToast('Reconnected', 'Chat is live again.');
      state.reconnectNotified = false;
    }
  });

  window.addEventListener('voxel:network-offline', () => {
    state.connected = false;
    state.reconnectNotified = true;
    setConnectionState('offline', 'Reconnecting…');
    state.typingUsers.clear();
    updateTypingIndicator();
    updateComposerState();
  });

  window.addEventListener('voxel:network-message', (event) => handleNetworkMessage(event.detail || {}));

  window.addEventListener('beforeunload', () => {
    saveDraft();
    markRead();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !state.collapsed && isPinnedToBottom()) markRead();
  });

  setInterval(() => {
    renderPlayers();
    refreshRelativeTimes();
    updateTypingIndicator();
    const now = performance.now();
    if (state.connected && now - state.lastLocationSent > 5000) {
      const local = window.VOXEL_GAME_API?.getLocalState?.();
      if (local) {
        mergeLocal(local);
        sendPacket({ type: 'chat:location-update', x: local.x, z: local.z });
        state.lastLocationSent = now;
      }
    }
  }, 5000);

  /* ----------------------------------------------------------------- events */

  function bindEvents() {
    ui.collapse.addEventListener('click', () => setCollapsed(true));
    ui.collapsedTab.addEventListener('click', () => setCollapsed(false));
    ui.send.addEventListener('click', () => sendCurrentMessage());

    ui.sound.addEventListener('click', () => {
      state.sound = !state.sound;
      localStorage.setItem(KEY.sound, state.sound ? '1' : '0');
      updateSoundButton();
      if (state.sound) playPing(0.35);
    });

    ui.desktop.addEventListener('click', async () => {
      if (!('Notification' in window)) {
        showSystemToast('Not supported', 'This browser has no desktop notification support.');
        return;
      }
      if (state.desktop) {
        state.desktop = false;
      } else {
        const permission = Notification.permission === 'granted'
          ? 'granted'
          : await Notification.requestPermission();
        if (permission !== 'granted') {
          showSystemToast('Notifications blocked', 'Allow notifications in your browser settings to enable this.');
          return;
        }
        state.desktop = true;
      }
      localStorage.setItem(KEY.desktop, state.desktop ? '1' : '0');
      updateDesktopButton();
    });

    ui.membersToggle.addEventListener('click', () => {
      state.membersVisible = !state.membersVisible;
      localStorage.setItem(KEY.members, state.membersVisible ? '1' : '0');
      applyMembersVisibility();
    });

    ui.pinsToggle.addEventListener('click', () => togglePins());
    ui.pinsClose.addEventListener('click', () => togglePins(false));

    ui.input.addEventListener('focus', () => {
      window.__voxelChatTyping = true;
      if (isPinnedToBottom()) markRead();
    });
    ui.input.addEventListener('blur', () => {
      window.__voxelChatTyping = false;
      scheduleTyping(false, true);
      saveDraft();
    });
    ui.input.addEventListener('input', () => {
      autoGrow();
      updateCharCount();
      scheduleTyping(Boolean(ui.input.value.trim()));
      updateMentionMenu();
      updateCommandHint();
      saveDraft();
    });
    ui.input.addEventListener('keydown', onComposerKeydown);
    ui.input.addEventListener('paste', () => requestAnimationFrame(() => { autoGrow(); updateCharCount(); }));

    ui.emojiButton.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleEmojiPicker();
    });
    ui.emojiSearch.addEventListener('input', () => renderEmojiResults(ui.emojiSearch.value));
    ui.emojiSearch.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeEmojiPicker();
        ui.input.focus();
      }
    });

    ui.replyCancel.addEventListener('click', () => setReplyTarget(null));

    ui.searchToggle.addEventListener('click', () => openSearch());
    ui.searchClose.addEventListener('click', () => closeSearch());
    ui.searchInput.addEventListener('input', () => {
      state.search = ui.searchInput.value.trim().toLowerCase();
      state.searchCursor = 0;
      render();
      focusSearchMatch(0);
    });
    ui.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeSearch(); }
      if (event.key === 'Enter') {
        event.preventDefault();
        stepSearch(event.shiftKey ? -1 : 1);
      }
    });
    ui.searchPrev.addEventListener('click', () => stepSearch(-1));
    ui.searchNext.addEventListener('click', () => stepSearch(1));

    ui.statusSave.addEventListener('click', saveStatus);
    ui.statusInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') saveStatus();
    });
    ui.nameSave.addEventListener('click', saveName);
    ui.nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') saveName();
    });
    ui.memberSearch.addEventListener('input', () => {
      state.memberFilter = ui.memberSearch.value.trim().toLowerCase();
      renderPlayers();
    });

    ui.scroller.addEventListener('scroll', () => {
      const atBottom = isPinnedToBottom();
      state.pinnedToBottom = atBottom;
      ui.jumpButton.hidden = atBottom;
      if (atBottom) {
        state.newWhileScrolled = 0;
        updateJumpButton();
        if (!document.hidden && !state.collapsed) markRead();
      }
    }, { passive: true });

    ui.jumpButton.addEventListener('click', () => {
      scrollToBottom(true);
      markRead();
    });

    ui.list.addEventListener('contextmenu', (event) => {
      const article = event.target.closest('.chat-message');
      if (!article) return;
      const message = findMessage(article.dataset.messageId);
      if (!message) return;
      event.preventDefault();
      openContextMenu(message, event.clientX, event.clientY);
    });

    document.querySelector('#canvas')?.addEventListener('pointerdown', () => {
      window.__voxelChatTyping = false;
      ui.input.blur();
      closeAllMenus();
    });

    document.addEventListener('click', (event) => {
      if (!ui.emojiPicker.hidden && !ui.emojiPicker.contains(event.target) && event.target !== ui.emojiButton) {
        closeEmojiPicker();
      }
      if (!ui.contextMenu.hidden && !ui.contextMenu.contains(event.target)) closeContextMenu();
      if (!ui.pinsPanel.hidden && !ui.pinsPanel.contains(event.target) && event.target !== ui.pinsToggle) {
        togglePins(false);
      }
    });

    window.addEventListener('keydown', onGlobalKeydown, { capture: true });
    window.addEventListener('resize', () => { if (state.pinnedToBottom) scrollToBottom(false); });
  }

  function onComposerKeydown(event) {
    if (!ui.mentionMenu.hidden && handleMenuKeys(event, ui.mentionMenu, 'mentionIndex')) return;
    if (!ui.commandHint.hidden && handleMenuKeys(event, ui.commandHint, 'commandIndex')) return;

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendCurrentMessage();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!ui.emojiPicker.hidden) { closeEmojiPicker(); return; }
      if (state.editingId) { cancelEdit(); return; }
      if (state.replyTo) { setReplyTarget(null); return; }
      if (ui.input.value) {
        ui.input.value = '';
        ui.input.dispatchEvent(new Event('input'));
        return;
      }
      if (!ui.searchBar.hidden) { closeSearch(); return; }
      setCollapsed(true);
      window.VOXEL_GAME_API?.focusCanvas?.();
      return;
    }
    if (event.key === 'ArrowUp' && !ui.input.value && !state.editingId) {
      const own = [...state.messages].reverse().find(
        (item) => item.sender?.id === localId() && !item.system && !item.deleted && !item.optimistic
      );
      if (own) {
        event.preventDefault();
        beginEdit(own.id);
      }
    }
  }

  function handleMenuKeys(event, menu, indexKey) {
    const buttons = Array.from(menu.querySelectorAll('button'));
    if (!buttons.length) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      state[indexKey] = (state[indexKey] + delta + buttons.length) % buttons.length;
      state.menuNavigated = true;
      highlightMenuOption(menu, state[indexKey]);
      return true;
    }
    if (event.key === 'Enter' && !event.shiftKey && menu === ui.commandHint && !state.menuNavigated) {
      // A fully typed command should send, not re-complete itself.
      const typed = ui.input.value.trim().split(' ')[0].toLowerCase();
      const highlighted = buttons[Math.min(state[indexKey], buttons.length - 1)]
        .querySelector('strong').textContent.split(' ')[0].toLowerCase();
      if (typed === highlighted) {
        menu.hidden = true;
        return false;
      }
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault();
      buttons[Math.min(state[indexKey], buttons.length - 1)].click();
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      menu.hidden = true;
      return true;
    }
    return false;
  }

  function highlightMenuOption(menu, index) {
    Array.from(menu.querySelectorAll('button')).forEach((button, position) => {
      button.classList.toggle('is-active', position === index);
      if (position === index) button.scrollIntoView({ block: 'nearest' });
    });
  }

  function onGlobalKeydown(event) {
    const target = event.target;
    const inField = target instanceof HTMLInputElement
      || target instanceof HTMLTextAreaElement
      || target?.isContentEditable;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      if (state.collapsed) setCollapsed(false);
      openSearch();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'p' && event.shiftKey) {
      event.preventDefault();
      if (state.collapsed) setCollapsed(false);
      togglePins(true);
      return;
    }
    if (event.key === 'Escape' && !inField) {
      if (!ui.contextMenu.hidden) { closeContextMenu(); return; }
      if (!ui.emojiPicker.hidden) { closeEmojiPicker(); return; }
      if (!ui.pinsPanel.hidden) { togglePins(false); return; }
    }
    if (inField) return;

    if (event.key === 'Enter' || event.key === '/') {
      event.preventDefault();
      if (state.collapsed) setCollapsed(false);
      ui.input.focus({ preventScroll: true });
      if (event.key === '/' && !ui.input.value) {
        ui.input.value = '/';
        ui.input.dispatchEvent(new Event('input'));
      }
      return;
    }
    if (!state.collapsed
      && event.key.length === 1
      && !MOVEMENT_CODES.has(event.code)
      && !event.metaKey && !event.ctrlKey && !event.altKey) {
      ui.input.focus({ preventScroll: true });
    }
  }

  /* ---------------------------------------------------------------- network */

  function handleNetworkMessage(message) {
    switch (message.type) {
      case 'welcome':
        state.connected = true;
        state.local = {
          ...(state.local || {}),
          id: message.id,
          name: message.name,
          color: message.color,
          ...(window.VOXEL_GAME_API?.getLocalState?.() || {})
        };
        state.local.id = message.id;
        state.local.name = message.name;
        if (Array.isArray(message.reactions) && message.reactions.length) state.reactions = message.reactions;
        if (message.limits) state.limits = { ...state.limits, ...message.limits };
        ui.input.maxLength = state.limits.messageLength;
        ui.nameInput.value = message.name;
        setConnectionState('online', `Connected as ${message.name}`);
        updateCharCount();
        updateComposerState();
        applyStoredNickname();
        break;
      case 'chat:history':
        if (Array.isArray(message.messages)) {
          state.messages = mergeHistories(state.messages, message.messages);
          cacheMessages();
          render();
          scrollToBottom(false);
        }
        if (Array.isArray(message.users)) { state.users = message.users; renderPlayers(); }
        if (Array.isArray(message.pinned)) { state.pinned = message.pinned; renderPins(); }
        if (Array.isArray(message.commands)) state.commands = message.commands;
        break;
      case 'chat:message':
        receiveMessage(message);
        break;
      case 'chat:update':
        if (message.message) {
          upsertMessage(message.message);
          cacheMessages();
          render();
        }
        break;
      case 'chat:ack':
        updateDelivery(message);
        break;
      case 'chat:error':
        handleServerError(message);
        break;
      case 'chat:users':
        state.users = Array.isArray(message.users) ? message.users : state.users;
        renderPlayers();
        break;
      case 'chat:pins':
        state.pinned = Array.isArray(message.pinned) ? message.pinned : [];
        renderPins();
        render();
        break;
      case 'chat:presence':
        if (message.user) {
          const index = state.users.findIndex((user) => user.name === message.user.name);
          if (index >= 0) state.users[index] = message.user;
          else state.users.push(message.user);
          renderPlayers();
        }
        break;
      case 'chat:renamed':
        handleRename(message);
        break;
      case 'chat:user-status':
        updateUserStatus(message);
        break;
      case 'chat:typing':
        updateTypingUser(message);
        break;
      case 'chat:reaction':
        updateReaction(message);
        break;
      case 'chat:clear-local':
        state.messages = [];
        state.nodeCache.clear();
        cacheMessages();
        render();
        showSystemToast('Chat cleared', 'Your local message view was cleared.');
        break;
      case 'chat:teleport':
        if (message.location) {
          window.VOXEL_GAME_API?.teleport?.(message.location.x, message.location.z);
          showSystemToast('Location jump', `Moved to chunk ${message.location.chunkX}, ${message.location.chunkZ}.`);
        }
        break;
      default:
        break;
    }
  }

  function handleServerError(message) {
    if (message.code === 'rate-limit' && message.clientId) {
      const queued = state.pending.get(message.clientId);
      const original = queued && findMessage(queued);
      if (original) {
        original.delivery = 'queued';
        // Guard against double-queueing: the message may already be waiting in
        // the outbox, and re-adding it would send the same text twice.
        if (!state.outbox.some((item) => item.clientId === message.clientId)) {
          state.outbox.push({
            clientId: message.clientId,
            text: original.text,
            replyTo: original.replyTo?.id || null,
            localId: original.id
          });
        }
        render();
        scheduleFlush((Number(message.retryAfter) || 1) * 1000 + 120);
        return;
      }
    }
    failPending(message.clientId, message.message || 'Message was rejected.');
  }

  function handleRename(message) {
    if (message.id === localId()) {
      state.local = { ...state.local, name: message.name };
      ui.nameInput.value = message.name;
      localStorage.setItem(KEY.nick, message.name);
      setConnectionState('online', `Connected as ${message.name}`);
      window.VOXEL_GAME_API?.setLocalName?.(message.name);
    }
    const user = state.users.find((item) => item.id === message.id || item.name === message.previous);
    if (user) user.name = message.name;
    renderPlayers();
    render();
  }

  function applyStoredNickname() {
    const stored = localStorage.getItem(KEY.nick);
    if (stored && stored !== localName()) sendPacket({ type: 'chat:nick', name: stored });
  }

  /* --------------------------------------------------------------- outgoing */

  function sendCurrentMessage() {
    if (state.editingId) { commitEdit(); return; }
    const raw = ui.input.value;
    const text = raw.replace(/\s+$/, '');
    if (!text.trim()) return;
    if (text.length > state.limits.messageLength) {
      showSystemToast('Too long', `Messages are limited to ${state.limits.messageLength} characters.`);
      return;
    }

    const clientId = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const isCommand = text.startsWith('/') && !text.startsWith('//');
    const replyId = state.replyTo?.id || null;

    if (!isCommand) {
      const local = currentLocation();
      const optimistic = {
        type: 'chat:message',
        id: `pending-${clientId}`,
        clientId,
        index: null,
        sender: { id: localId(), name: localName(), color: localColor() },
        text: text.startsWith('//') ? text.slice(1) : text,
        timestamp: Date.now(),
        location: local,
        reactions: {},
        replyTo: state.replyTo
          ? { id: state.replyTo.id, name: state.replyTo.name, text: state.replyTo.text, color: state.replyTo.color }
          : null,
        mentions: [],
        delivery: state.connected ? 'sending' : 'queued',
        optimistic: true
      };
      state.messages.push(optimistic);
      state.pending.set(clientId, optimistic.id);
      trimMessages();
      render();
      scrollToBottom(true);
    }

    const packet = { type: 'chat:send', clientId, text, replyTo: replyId };
    if (state.connected && withinRateBudget()) {
      const sent = sendPacket(packet);
      if (!sent) queueOutbound(packet, `pending-${clientId}`);
    } else {
      queueOutbound(packet, `pending-${clientId}`);
    }

    ui.input.value = '';
    setReplyTarget(null);
    ui.input.dispatchEvent(new Event('input'));
    scheduleTyping(false, true);
    ui.input.focus({ preventScroll: true });
    markRead();
  }

  function queueOutbound(packet, localId) {
    if (!state.outbox.some((item) => item.clientId === packet.clientId)) {
      state.outbox.push({ clientId: packet.clientId, text: packet.text, replyTo: packet.replyTo, localId });
    }
    const message = findMessage(localId);
    if (message) message.delivery = 'queued';
    render();
    scheduleFlush(state.connected ? 400 : 1500);
  }

  function scheduleFlush(delay) {
    clearTimeout(state.flushTimer);
    state.flushTimer = setTimeout(flushOutbox, Math.max(120, delay));
  }

  function flushOutbox() {
    if (!state.connected || !state.outbox.length) return;
    if (!withinRateBudget()) { scheduleFlush(700); return; }
    const item = state.outbox.shift();
    const sent = sendPacket({ type: 'chat:send', clientId: item.clientId, text: item.text, replyTo: item.replyTo });
    if (!sent) {
      state.outbox.unshift(item);
      scheduleFlush(1500);
      return;
    }
    const message = findMessage(item.localId);
    if (message) message.delivery = 'sending';
    render();
    if (state.outbox.length) scheduleFlush(400);
  }

  function withinRateBudget() {
    const window_ = (state.limits.rateWindowSeconds || 5) * 1000;
    const now = Date.now();
    state.sendTimes = state.sendTimes.filter((time) => now - time < window_);
    if (state.sendTimes.length >= (state.limits.rateLimit || 5)) return false;
    state.sendTimes.push(now);
    return true;
  }

  function retryMessage(messageId) {
    const message = findMessage(messageId);
    if (!message) return;
    message.delivery = 'queued';
    message.error = null;
    const clientId = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    state.pending.set(clientId, message.id);
    state.outbox.push({ clientId, text: message.text, replyTo: message.replyTo?.id || null, localId: message.id });
    render();
    scheduleFlush(200);
  }

  function receiveMessage(message) {
    const own = message.sender?.id && message.sender.id === localId();
    if (own) {
      const entry = Array.from(state.pending.entries()).find(([, pendingId]) => {
        const pending = findMessage(pendingId);
        return pending && pending.optimistic && pending.text === message.text;
      });
      if (entry) {
        const [clientId, pendingId] = entry;
        const index = state.messages.findIndex((item) => item.id === pendingId);
        if (index >= 0) state.messages[index] = { ...message, delivery: 'delivered' };
        state.pending.delete(clientId);
        state.nodeCache.delete(`msg:${pendingId}`);
      } else {
        upsertMessage({ ...message, delivery: 'delivered' });
      }
    } else {
      upsertMessage(message);
    }

    trimMessages();
    cacheMessages();

    const mentionsMe = isMention(message);
    const wasAtBottom = state.pinnedToBottom;
    render();
    if (wasAtBottom && !state.search) scrollToBottom(true);
    else if (!own) {
      state.newWhileScrolled += 1;
      updateJumpButton();
    }

    if (own) { markRead(); return; }

    const focused = !document.hidden && !state.collapsed && document.activeElement === ui.input;
    const activelyTyping = focused && Boolean(ui.input.value.trim());

    if (state.collapsed || document.hidden || !wasAtBottom) {
      state.unread += 1;
      if (mentionsMe) state.mentionUnread += 1;
      updateUnreadBadge();
    } else {
      markRead();
    }

    if ((state.collapsed || document.hidden) && !activelyTyping && !message.system) {
      if (!document.hidden) showMessageToast(message);
      notifyDesktop(message, mentionsMe);
      if (state.sound) playPing(mentionsMe ? 0.95 : 0.5);
    } else if (mentionsMe && state.sound && !focused) {
      playPing(0.95);
    }
  }

  function updateDelivery(ack) {
    const pendingId = state.pending.get(ack.clientId);
    if (!pendingId) return;
    const message = findMessage(pendingId);
    if (!message) return;
    message.delivery = ack.status === 'delivered' ? 'delivered' : 'sent';
    if (ack.messageId) message.serverId = ack.messageId;
    if (ack.index != null) message.index = ack.index;
    render();
  }

  function failPending(clientId, reason) {
    const pendingId = state.pending.get(clientId);
    const message = findMessage(pendingId);
    if (message) {
      message.delivery = 'failed';
      message.error = reason;
    }
    state.pending.delete(clientId);
    render();
    showSystemToast('Message not sent', reason);
  }

  /* ------------------------------------------------------- message rendering */

  function buildRows() {
    const filtered = state.search
      ? state.messages.filter((message) => matchesSearch(message))
      : state.messages;
    const visible = filtered.slice(-MAX_MESSAGES);
    const rows = [];
    let previous = null;
    let unreadPlaced = false;

    for (const message of visible) {
      const dayKey = dayStamp(message.timestamp);
      if (!previous || dayStamp(previous.timestamp) !== dayKey) {
        rows.push({ kind: 'divider', key: `divider:${dayKey}`, label: dayLabel(message.timestamp) });
        previous = null;
      }
      if (!unreadPlaced
        && state.unread > 0
        && state.lastRead
        && Number(message.timestamp) > state.lastRead
        && message.sender?.id !== localId()) {
        rows.push({ kind: 'unread', key: 'unread-divider' });
        unreadPlaced = true;
        previous = null;
      }
      const grouped = Boolean(previous)
        && !message.system
        && !previous.system
        && !message.replyTo
        && previous.sender?.id === message.sender?.id
        && previous.sender?.name === message.sender?.name
        && Number(message.timestamp) - Number(previous.timestamp) < GROUP_WINDOW_MS
        && !message.deleted
        && !previous.deleted;
      rows.push({ kind: 'message', key: `msg:${message.id}`, message, grouped });
      previous = message;
    }
    return rows;
  }

  function render() {
    const previousHeight = ui.scroller.scrollHeight;
    const previousTop = ui.scroller.scrollTop;
    const wasAtBottom = state.pinnedToBottom;

    const rows = buildRows();
    const nodes = [];
    const seen = new Set();

    for (const row of rows) {
      const signature = rowSignature(row);
      const cached = state.nodeCache.get(row.key);
      let node;
      if (cached && cached.signature === signature) {
        node = cached.node;
      } else {
        node = createRowNode(row);
        state.nodeCache.set(row.key, { signature, node });
      }
      seen.add(row.key);
      nodes.push(node);
    }
    for (const key of Array.from(state.nodeCache.keys())) {
      if (!seen.has(key)) state.nodeCache.delete(key);
    }

    ui.list.replaceChildren(...nodes);
    ui.intro.hidden = rows.length > 12;
    updateEmptyState(rows.length === 0);
    updateSearchMatches();

    if (wasAtBottom && !state.search) {
      scrollToBottom(false);
    } else {
      const delta = ui.scroller.scrollHeight - previousHeight;
      if (delta !== 0) ui.scroller.scrollTop = previousTop + delta;
    }
  }

  function rowSignature(row) {
    if (row.kind !== 'message') return `${row.kind}:${row.label || ''}:${state.unread}`;
    const message = row.message;
    const reactions = Object.entries(message.reactions || {})
      .map(([emoji, data]) => `${emoji}${data?.count || 0}${(data?.playerIds || []).includes(localId()) ? 'm' : ''}`)
      .join(',');
    return [
      message.id, message.text, message.editedAt, message.deleted, message.delivery, message.error,
      message.index, message.pinned, reactions, row.grouped, state.search,
      state.editingId === message.id, isMention(message), message.sender?.name
    ].join('|');
  }

  function createRowNode(row) {
    if (row.kind === 'divider') {
      const divider = document.createElement('div');
      divider.className = 'chat-divider';
      divider.innerHTML = '<span></span>';
      divider.querySelector('span').textContent = row.label;
      return divider;
    }
    if (row.kind === 'unread') {
      const divider = document.createElement('div');
      divider.className = 'chat-divider is-unread';
      divider.innerHTML = '<span>New messages</span>';
      return divider;
    }
    return createMessageElement(row.message, row.grouped);
  }

  function createMessageElement(message, grouped) {
    const article = document.createElement('article');
    article.className = 'chat-message';
    article.dataset.messageId = message.id;
    if (message.index != null) article.dataset.messageIndex = String(message.index);
    article.classList.toggle('is-grouped', Boolean(grouped));
    article.classList.toggle('is-system', Boolean(message.system));
    article.classList.toggle('is-private', Boolean(message.private));
    article.classList.toggle('is-dm', message.kind === 'dm');
    article.classList.toggle('is-emote', message.kind === 'emote');
    article.classList.toggle('is-deleted', Boolean(message.deleted));
    article.classList.toggle('is-failed', message.delivery === 'failed');
    article.classList.toggle('is-pending', message.delivery === 'sending' || message.delivery === 'queued');
    article.classList.toggle('is-mentioned', isMention(message));
    article.classList.toggle('is-pinned', Boolean(message.pinned));

    if (message.replyTo) article.append(createReplyPreview(message.replyTo));

    const gutter = document.createElement('div');
    gutter.className = 'chat-gutter';
    if (grouped) {
      const stamp = document.createElement('time');
      stamp.className = 'chat-hover-time';
      stamp.dateTime = safeIso(message.timestamp);
      stamp.title = fullTimestamp(message.timestamp);
      stamp.textContent = shortClock(message.timestamp);
      gutter.append(stamp);
    } else {
      const avatar = document.createElement('button');
      avatar.type = 'button';
      avatar.className = 'chat-avatar';
      avatar.style.setProperty('--avatar-color', rgbColor(message.sender?.color));
      avatar.textContent = initials(message.sender?.name || 'W');
      avatar.title = message.sender?.name || 'World';
      avatar.addEventListener('click', (event) => {
        event.stopPropagation();
        const user = findUser(message.sender);
        if (user) openMemberMenu(user, event.clientX, event.clientY);
      });
      gutter.append(avatar);
    }

    const body = document.createElement('div');
    body.className = 'chat-message-body';

    if (!grouped) {
      const meta = document.createElement('div');
      meta.className = 'chat-message-meta';

      const author = document.createElement('button');
      author.type = 'button';
      author.className = 'chat-author';
      author.style.color = rgbColor(message.sender?.color, true);
      author.textContent = message.sender?.name || 'World';
      author.addEventListener('mouseenter', () => highlightSender(message.sender));
      author.addEventListener('click', (event) => {
        event.stopPropagation();
        insertMention(message.sender?.name);
      });
      meta.append(author);

      if (message.kind === 'dm') {
        const badge = document.createElement('span');
        badge.className = 'chat-badge is-dm';
        badge.textContent = message.dm?.fromId === localId()
          ? `to ${message.dm?.toName || '?'}`
          : 'whisper';
        meta.append(badge);
      }
      if (message.system) {
        const badge = document.createElement('span');
        badge.className = 'chat-badge';
        badge.textContent = 'system';
        meta.append(badge);
      }

      const time = document.createElement('time');
      time.className = 'chat-time';
      time.dateTime = safeIso(message.timestamp);
      time.dataset.timestamp = String(message.timestamp);
      time.title = fullTimestamp(message.timestamp);
      time.textContent = formatMessageTime(message.timestamp);
      meta.append(time);

      if (message.pinned) {
        const pin = document.createElement('span');
        pin.className = 'chat-badge is-pin';
        pin.textContent = '📌 pinned';
        meta.append(pin);
      }
      if (message.index != null) {
        const index = document.createElement('span');
        index.className = 'chat-index';
        index.textContent = `#${message.index}`;
        index.title = `Use /goto ${message.index} to jump to this location`;
        meta.append(index);
      }
      body.append(meta);
    }

    const text = document.createElement('div');
    text.className = 'chat-text';
    if (message.deleted) {
      text.classList.add('is-tombstone');
      text.textContent = 'This message was deleted.';
    } else if (state.editingId === message.id) {
      body.append(text);
      text.append(createEditor(message));
    } else {
      renderMarkdown(text, message.text || '');
      if (message.editedAt) {
        const edited = document.createElement('span');
        edited.className = 'chat-edited';
        edited.title = `Edited ${fullTimestamp(message.editedAt)}`;
        edited.textContent = '(edited)';
        text.append(' ', edited);
      }
    }
    if (state.editingId !== message.id) body.append(text);

    const actions = document.createElement('div');
    actions.className = 'chat-message-actions';

    if (message.location && !message.deleted) {
      actions.append(chip(`⌖ ${message.location.chunkX}, ${message.location.chunkZ}`, 'Jump to this location', () => {
        jumpToLocation(message.location);
      }, 'chat-location-chip'));
    }

    for (const [emoji, data] of Object.entries(message.reactions || {})) {
      if (!data?.count) continue;
      const mine = (data.playerIds || []).includes(localId());
      const button = chip(`${emoji} ${data.count}`, reactionTooltip(emoji, data), () => {
        reactToMessage(message.id, emoji);
      }, 'chat-reaction');
      button.classList.toggle('is-mine', mine);
      actions.append(button);
    }

    if (!message.deleted && !message.optimistic && !message.private && message.id?.startsWith('m-')) {
      const add = chip('＋', 'Add reaction', (event) => {
        openReactionPicker(message.id, event.currentTarget);
      }, 'chat-reaction is-add');
      actions.append(add);
    }

    if (message.delivery === 'failed') {
      actions.append(chip('Retry', message.error || 'Send failed', () => retryMessage(message.id), 'chat-retry'));
      actions.append(chip('Discard', 'Remove this message', () => {
        state.messages = state.messages.filter((item) => item.id !== message.id);
        render();
      }, 'chat-retry is-ghost'));
    }

    if (message.sender?.id === localId() || message.optimistic) {
      const delivery = document.createElement('span');
      delivery.className = 'chat-delivery';
      delivery.title = message.error || deliveryLabel(message.delivery);
      delivery.textContent = deliveryIcon(message.delivery);
      actions.append(delivery);
    }

    if (actions.childElementCount) body.append(actions);

    article.append(gutter, body);
    if (!message.deleted) article.append(createHoverToolbar(message));
    return article;
  }

  function createReplyPreview(reply) {
    const wrapper = document.createElement('button');
    wrapper.type = 'button';
    wrapper.className = 'chat-reply-preview';
    wrapper.title = 'Jump to the replied message';
    const spine = document.createElement('span');
    spine.className = 'reply-spine';
    const name = document.createElement('strong');
    name.textContent = reply.name || 'Unknown';
    name.style.color = rgbColor(reply.color, true);
    const preview = document.createElement('span');
    preview.className = 'reply-text';
    preview.textContent = reply.text || 'Original message unavailable';
    wrapper.append(spine, name, preview);
    wrapper.addEventListener('click', (event) => {
      event.stopPropagation();
      scrollToMessage(reply.id);
    });
    return wrapper;
  }

  function createHoverToolbar(message) {
    const bar = document.createElement('div');
    bar.className = 'chat-hover-actions';
    const own = message.sender?.id === localId();
    const persisted = Boolean(message.id?.startsWith('m-'));

    if (persisted) {
      bar.append(toolButton('😊', 'Add reaction', (event) => openReactionPicker(message.id, event.currentTarget)));
      bar.append(toolButton('↩︎', 'Reply', () => setReplyTarget(message)));
    }
    if (own && persisted && !message.system) {
      bar.append(toolButton('✎', 'Edit', () => beginEdit(message.id)));
    }
    if (persisted) {
      bar.append(toolButton(message.pinned ? '📌' : '📍', message.pinned ? 'Unpin' : 'Pin', () => {
        sendPacket({ type: 'chat:pin', messageId: message.id, pinned: !message.pinned });
      }));
    }
    if (own && persisted) {
      bar.append(toolButton('🗑', 'Delete', () => confirmDelete(message)));
    }
    bar.append(toolButton('⋯', 'More actions', (event) => {
      const rect = event.currentTarget.getBoundingClientRect();
      openContextMenu(message, rect.left, rect.bottom + 4);
    }));
    return bar;
  }

  function toolButton(label, title, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hover-action';
    button.title = title;
    button.setAttribute('aria-label', title);
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      handler(event);
    });
    return button;
  }

  function chip(label, title, handler, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.title = title;
    button.textContent = label;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      handler(event);
    });
    return button;
  }

  function updateEmptyState(empty) {
    ui.list.dataset.empty = empty ? 'true' : 'false';
    if (empty && state.search) {
      const notice = document.createElement('p');
      notice.className = 'chat-empty';
      notice.textContent = `No messages match “${ui.searchInput.value}”.`;
      ui.list.replaceChildren(notice);
    }
  }

  /* ------------------------------------------------------------ edit/delete */

  function beginEdit(messageId) {
    state.editingId = messageId;
    render();
    requestAnimationFrame(() => {
      const editor = ui.list.querySelector('.chat-inline-editor');
      if (editor) {
        editor.focus();
        editor.selectionStart = editor.value.length;
        editor.style.height = `${editor.scrollHeight}px`;
      }
    });
  }

  function createEditor(message) {
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-editor-wrap';
    const editor = document.createElement('textarea');
    editor.className = 'chat-inline-editor';
    editor.value = message.text || '';
    editor.rows = 1;
    editor.addEventListener('input', () => {
      editor.style.height = 'auto';
      editor.style.height = `${Math.min(editor.scrollHeight, 220)}px`;
    });
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        commitEdit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelEdit();
      }
    });
    const help = document.createElement('div');
    help.className = 'chat-editor-help';
    help.innerHTML = 'escape to <button type="button" data-action="cancel">cancel</button> · enter to <button type="button" data-action="save">save</button>';
    help.querySelector('[data-action="cancel"]').addEventListener('click', cancelEdit);
    help.querySelector('[data-action="save"]').addEventListener('click', commitEdit);
    wrapper.append(editor, help);
    return wrapper;
  }

  function commitEdit() {
    const editor = ui.list.querySelector('.chat-inline-editor');
    if (!editor || !state.editingId) return;
    const text = editor.value.trim();
    const messageId = state.editingId;
    const original = findMessage(messageId);
    state.editingId = null;
    if (!text) {
      confirmDelete(original);
      render();
      return;
    }
    if (original && original.text !== text) {
      sendPacket({ type: 'chat:edit', messageId, text });
      original.text = text;
      original.editedAt = Date.now();
    }
    render();
    ui.input.focus({ preventScroll: true });
  }

  function cancelEdit() {
    state.editingId = null;
    render();
    ui.input.focus({ preventScroll: true });
  }

  function confirmDelete(message) {
    if (!message) return;
    openConfirm('Delete message?', message.text ? truncate(message.text, 90) : '', () => {
      sendPacket({ type: 'chat:delete', messageId: message.id });
    });
  }

  function openConfirm(title, detail, onConfirm) {
    closeContextMenu();
    const menu = ui.contextMenu;
    menu.replaceChildren();
    menu.classList.add('is-confirm');
    const heading = document.createElement('strong');
    heading.textContent = title;
    const body = document.createElement('p');
    body.textContent = detail;
    const row = document.createElement('div');
    row.className = 'confirm-row';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closeContextMenu);
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'is-danger';
    confirm.textContent = 'Delete';
    confirm.addEventListener('click', () => {
      onConfirm();
      closeContextMenu();
    });
    row.append(cancel, confirm);
    menu.append(heading, body, row);
    menu.hidden = false;
    positionFloating(menu, window.innerWidth / 2, window.innerHeight / 2, true);
    confirm.focus();
  }

  /* --------------------------------------------------------------- reply/UI */

  function setReplyTarget(message) {
    if (!message) {
      state.replyTo = null;
      ui.replyBar.hidden = true;
      return;
    }
    state.replyTo = {
      id: message.id,
      name: message.sender?.name || 'Unknown',
      color: message.sender?.color,
      text: truncate(message.text || '', 120)
    };
    ui.replyLabel.textContent = `Replying to ${state.replyTo.name}`;
    ui.replyBar.hidden = false;
    ui.input.focus({ preventScroll: true });
  }

  function insertMention(name) {
    if (!name || name === 'World') return;
    const current = ui.input.value;
    const spacer = current && !current.endsWith(' ') ? ' ' : '';
    ui.input.value = `${current}${spacer}@${name} `;
    ui.input.dispatchEvent(new Event('input'));
    ui.input.focus({ preventScroll: true });
  }

  function reactToMessage(messageId, emoji) {
    sendPacket({ type: 'chat:reaction', messageId, emoji });
  }

  function updateReaction(message) {
    const target = state.messages.find(
      (item) => item.id === message.messageId || item.serverId === message.messageId
    );
    if (target) {
      target.reactions = message.reactions || {};
      cacheMessages();
      render();
    }
    const pinned = state.pinned.find((item) => item.id === message.messageId);
    if (pinned) pinned.reactions = message.reactions || {};
  }

  function reactionTooltip(emoji, data) {
    const names = data.names || [];
    if (!names.length) return `React with ${emoji}`;
    if (names.length <= 4) return `${names.join(', ')} reacted with ${emoji}`;
    return `${names.slice(0, 4).join(', ')} and ${names.length - 4} more reacted with ${emoji}`;
  }

  /* ------------------------------------------------------------- pins panel */

  function togglePins(force) {
    const next = force === undefined ? ui.pinsPanel.hidden : force;
    ui.pinsPanel.hidden = !next;
    if (next) renderPins();
  }

  function renderPins() {
    ui.pinsCount.textContent = state.pinned.length ? String(state.pinned.length) : '';
    ui.pinsCount.hidden = state.pinned.length === 0;
    if (!state.pinned.length) {
      const empty = document.createElement('p');
      empty.className = 'chat-empty';
      empty.textContent = 'Nothing pinned yet. Hover a message and choose the pin action.';
      ui.pinsList.replaceChildren(empty);
      return;
    }
    ui.pinsList.replaceChildren(...state.pinned.map((message) => {
      const item = document.createElement('div');
      item.className = 'pin-item';
      const head = document.createElement('div');
      head.className = 'pin-head';
      const name = document.createElement('strong');
      name.textContent = message.sender?.name || 'World';
      name.style.color = rgbColor(message.sender?.color, true);
      const time = document.createElement('time');
      time.textContent = fullTimestamp(message.timestamp);
      head.append(name, time);
      const text = document.createElement('p');
      renderMarkdown(text, message.text || '');
      const actions = document.createElement('div');
      actions.className = 'pin-actions';
      actions.append(chip('Jump', 'Scroll to this message', () => {
        togglePins(false);
        scrollToMessage(message.id);
      }, 'chat-retry is-ghost'));
      actions.append(chip('Unpin', 'Remove from pinned', () => {
        sendPacket({ type: 'chat:pin', messageId: message.id, pinned: false });
      }, 'chat-retry is-ghost'));
      item.append(head, text, actions);
      return item;
    }));
  }

  /* ---------------------------------------------------------- context menus */

  function openContextMenu(message, x, y) {
    const menu = ui.contextMenu;
    menu.classList.remove('is-confirm');
    menu.replaceChildren();
    const own = message.sender?.id === localId();
    const persisted = Boolean(message.id?.startsWith('m-'));
    const items = [];

    if (persisted) items.push(['↩︎  Reply', () => setReplyTarget(message)]);
    if (message.sender?.name && message.sender.name !== 'World') {
      items.push([`@  Mention ${message.sender.name}`, () => insertMention(message.sender.name)]);
      if (!own) items.push([`💬  Whisper ${message.sender.name}`, () => {
        ui.input.value = `/w ${message.sender.name} `;
        ui.input.dispatchEvent(new Event('input'));
        ui.input.focus();
      }]);
    }
    if (message.text) items.push(['⧉  Copy text', () => copyText(message.text)]);
    if (message.index != null) items.push([`#  Copy /goto ${message.index}`, () => copyText(`/goto ${message.index}`)]);
    if (message.location) items.push(['⌖  Teleport here', () => jumpToLocation(message.location)]);
    if (persisted) items.push([message.pinned ? '📌  Unpin message' : '📍  Pin message', () => {
      sendPacket({ type: 'chat:pin', messageId: message.id, pinned: !message.pinned });
    }]);
    if (own && persisted && !message.system) items.push(['✎  Edit message', () => beginEdit(message.id)]);
    if (own && persisted) items.push(['🗑  Delete message', () => confirmDelete(message), true]);

    for (const [label, handler, danger] of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      if (danger) button.classList.add('is-danger');
      button.addEventListener('click', () => {
        closeContextMenu();
        handler();
      });
      menu.append(button);
    }
    menu.hidden = false;
    positionFloating(menu, x, y);
  }

  function openMemberMenu(user, x, y) {
    const menu = ui.contextMenu;
    menu.classList.remove('is-confirm');
    menu.replaceChildren();
    const own = user.id === localId();
    const items = [
      [`@  Mention ${user.name}`, () => insertMention(user.name)]
    ];
    if (!own) {
      items.push([`💬  Whisper ${user.name}`, () => {
        ui.input.value = `/w ${user.name} `;
        ui.input.dispatchEvent(new Event('input'));
        ui.input.focus();
      }]);
      if (user.online) items.push([`⌖  Teleport to ${user.name}`, () => {
        sendPacket({ type: 'chat:send', clientId: `c-${Date.now()}`, text: `/tp ${user.name}` });
      }]);
      items.push(['👁  Highlight in world', () => highlightSender(user)]);
    } else {
      items.push(['✎  Change display name', () => ui.nameInput.focus()]);
      items.push(['✎  Set status', () => ui.statusInput.focus()]);
    }
    for (const [label, handler] of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => {
        closeContextMenu();
        handler();
      });
      menu.append(button);
    }
    menu.hidden = false;
    positionFloating(menu, x, y);
  }

  function closeContextMenu() {
    ui.contextMenu.hidden = true;
    ui.contextMenu.classList.remove('is-confirm');
  }

  function closeAllMenus() {
    closeContextMenu();
    closeEmojiPicker();
    ui.mentionMenu.hidden = true;
    ui.commandHint.hidden = true;
    togglePins(false);
  }

  function positionFloating(element, x, y, centered = false) {
    element.style.visibility = 'hidden';
    element.hidden = false;
    const rect = element.getBoundingClientRect();
    let left = centered ? x - rect.width / 2 : x;
    let top = centered ? y - rect.height / 2 : y;
    left = Math.max(8, Math.min(left, window.innerWidth - rect.width - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - rect.height - 8));
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
    element.style.visibility = 'visible';
  }

  /* ----------------------------------------------------------- emoji picker */

  function toggleEmojiPicker() {
    if (!ui.emojiPicker.hidden) { closeEmojiPicker(); return; }
    ui.emojiPicker.dataset.mode = 'compose';
    delete ui.emojiPicker.dataset.messageId;
    ui.emojiSearch.value = '';
    renderEmojiResults('');
    const rect = ui.emojiButton.getBoundingClientRect();
    ui.emojiPicker.hidden = false;
    positionFloating(ui.emojiPicker, rect.right - 320, rect.top - 372);
    ui.emojiSearch.focus();
  }

  function openReactionPicker(messageId, anchor) {
    ui.emojiPicker.dataset.mode = 'react';
    ui.emojiPicker.dataset.messageId = messageId;
    ui.emojiSearch.value = '';
    renderEmojiResults('');
    const rect = anchor.getBoundingClientRect();
    ui.emojiPicker.hidden = false;
    positionFloating(ui.emojiPicker, rect.left - 150, rect.bottom + 6);
    ui.emojiSearch.focus();
  }

  function closeEmojiPicker() {
    ui.emojiPicker.hidden = true;
  }

  function renderEmojiResults(query) {
    const needle = String(query || '').trim().toLowerCase();
    const reactMode = ui.emojiPicker.dataset.mode === 'react';
    const fragment = document.createDocumentFragment();

    const groups = reactMode
      ? [['Quick reactions', state.reactions.map((emoji) => [emoji, ''])], ...EMOJI_GROUPS]
      : EMOJI_GROUPS;

    let matches = 0;
    for (const [title, entries] of groups) {
      const filtered = needle
        ? entries.filter(([emoji, keywords]) => emoji.includes(needle) || keywords.includes(needle))
        : entries;
      if (!filtered.length) continue;
      matches += filtered.length;
      const heading = document.createElement('div');
      heading.className = 'emoji-group';
      heading.textContent = title;
      fragment.append(heading);
      const grid = document.createElement('div');
      grid.className = 'emoji-grid';
      for (const [emoji, keywords] of filtered) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = emoji;
        button.title = keywords || emoji;
        button.addEventListener('click', () => {
          if (reactMode) {
            const target = ui.emojiPicker.dataset.messageId;
            if (state.reactions.includes(emoji)) reactToMessage(target, emoji);
            else showSystemToast('Unsupported reaction', `${emoji} is not enabled on this server.`);
          } else {
            const value = ui.input.value;
            const needsSpace = value && !value.endsWith(' ');
            ui.input.value = `${value}${needsSpace ? ' ' : ''}${emoji} `;
            ui.input.dispatchEvent(new Event('input'));
            ui.input.focus();
          }
          closeEmojiPicker();
        });
        grid.append(button);
      }
      fragment.append(grid);
    }
    if (!matches) {
      const empty = document.createElement('p');
      empty.className = 'chat-empty';
      empty.textContent = 'No emoji found.';
      fragment.append(empty);
    }
    ui.emojiResults.replaceChildren(fragment);
  }

  /* ------------------------------------------------------------- suggestions */

  function updateMentionMenu() {
    const value = ui.input.value.slice(0, ui.input.selectionStart ?? ui.input.value.length);
    // Names can contain spaces, so the query runs to the end of the line and is
    // matched loosely; the menu closes on its own when nothing matches.
    const match = value.match(/(^|\s)@([^@\n]{0,24})$/);
    if (!match) { ui.mentionMenu.hidden = true; return; }
    const query = match[2].toLowerCase();
    const candidates = [
      { name: 'everyone', status: 'Notify everyone online', color: [0.55, 0.6, 0.95], special: true },
      ...mergedUsers().filter((user) => user.id !== localId())
    ].filter((user) => user.name.toLowerCase().includes(query)).slice(0, 8);

    if (!candidates.length) { ui.mentionMenu.hidden = true; return; }
    state.mentionIndex = 0;
    state.menuNavigated = false;
    ui.mentionMenu.replaceChildren(...candidates.map((user) => {
      const button = document.createElement('button');
      button.type = 'button';
      const avatar = document.createElement('span');
      avatar.className = 'suggestion-avatar';
      avatar.style.setProperty('--avatar-color', rgbColor(user.color));
      avatar.textContent = user.special ? '@' : initials(user.name);
      const name = document.createElement('strong');
      name.textContent = user.name;
      const detail = document.createElement('span');
      detail.textContent = user.special
        ? user.status
        : (user.status || (user.online ? 'online' : `last seen ${relativeTime(user.lastSeen)}`));
      button.append(avatar, name, detail);
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        const before = ui.input.value.slice(0, ui.input.selectionStart ?? ui.input.value.length);
        const after = ui.input.value.slice(ui.input.selectionStart ?? ui.input.value.length);
        ui.input.value = `${before.replace(/@[^@\n]*$/, `@${user.name} `)}${after}`;
        ui.input.dispatchEvent(new Event('input'));
        ui.input.focus();
      });
      return button;
    }));
    ui.mentionMenu.hidden = false;
    highlightMenuOption(ui.mentionMenu, 0);
  }

  function updateCommandHint() {
    const value = ui.input.value;
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('\n')) {
      ui.commandHint.hidden = true;
      return;
    }
    const typed = value.split(' ')[0].toLowerCase();
    const commands = state.commands.length ? state.commands : [
      { command: '/help', description: 'show the command list' },
      { command: '/nick [name]', description: 'change your display name' },
      { command: '/me [action]', description: 'post an action message' },
      { command: '/status [text]', description: 'set your status' },
      { command: '/here', description: 'announce your chunk' },
      { command: '/location', description: 'post your current location' },
      { command: '/list', description: 'list everyone online' },
      { command: '/tp [player]', description: 'teleport to a player' },
      { command: '/goto [index]', description: 'jump to a message location' },
      { command: '/w [player] [text]', description: 'send a private message' },
      { command: '/roll [sides]', description: 'roll a die' },
      { command: '/pins', description: 'list pinned messages' },
      { command: '/clear', description: 'clear your local view' }
    ];
    const matches = commands
      .filter((item) => item.command.split(' ')[0].startsWith(typed))
      .slice(0, 6);
    if (!matches.length || value.includes(' ')) { ui.commandHint.hidden = true; return; }
    state.commandIndex = 0;
    state.menuNavigated = false;
    ui.commandHint.replaceChildren(...matches.map((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      const name = document.createElement('strong');
      name.textContent = item.command;
      const detail = document.createElement('span');
      detail.textContent = item.description;
      button.append(name, detail);
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => {
        ui.input.value = `${item.command.split(' ')[0]} `;
        ui.input.dispatchEvent(new Event('input'));
        ui.input.focus();
      });
      return button;
    }));
    ui.commandHint.hidden = false;
    highlightMenuOption(ui.commandHint, 0);
  }

  /* ----------------------------------------------------------- member panel */

  function renderPlayers() {
    const users = mergedUsers();
    const filtered = state.memberFilter
      ? users.filter((user) => user.name.toLowerCase().includes(state.memberFilter))
      : users;
    const online = users.filter((user) => user.online);
    ui.onlineCount.textContent = `${online.length} online`;

    const fragment = document.createDocumentFragment();
    const groups = [
      ['Online', filtered.filter((user) => user.online)],
      ['Offline', filtered.filter((user) => !user.online)]
    ];
    for (const [label, list] of groups) {
      if (!list.length) continue;
      const heading = document.createElement('div');
      heading.className = 'player-section-label';
      heading.textContent = `${label} — ${list.length}`;
      fragment.append(heading);
      for (const user of list) fragment.append(createPlayerRow(user));
    }
    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'chat-empty';
      empty.textContent = 'No members match that search.';
      fragment.append(empty);
    }
    ui.playerList.replaceChildren(fragment);
  }

  function createPlayerRow(user) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'chat-player';
    item.dataset.online = user.online ? 'true' : 'false';
    item.addEventListener('mouseenter', () => highlightSender(user));
    item.addEventListener('click', (event) => openMemberMenu(user, event.clientX, event.clientY));
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openMemberMenu(user, event.clientX, event.clientY);
    });

    const dot = document.createElement('span');
    dot.className = 'presence-dot';
    const avatar = document.createElement('span');
    avatar.className = 'player-avatar';
    avatar.style.setProperty('--avatar-color', rgbColor(user.color));
    avatar.textContent = initials(user.name);
    if (state.typingUsers.has(user.id)) avatar.classList.add('is-typing');

    const details = document.createElement('span');
    details.className = 'player-details';
    const name = document.createElement('strong');
    name.textContent = user.name + (user.id === localId() ? ' (you)' : '');
    const status = document.createElement('span');
    status.textContent = user.status || (user.online
      ? `Chunk ${user.chunkX ?? '?'}, ${user.chunkZ ?? '?'}`
      : `Last seen ${relativeTime(user.lastSeen)}`);
    details.append(name, status);
    item.append(dot, avatar, details);
    return item;
  }

  function mergedUsers() {
    const map = new Map();
    for (const user of state.users || []) map.set(user.id || user.name, { ...user });
    const local = window.VOXEL_GAME_API?.getLocalState?.();
    if (local?.id) {
      map.set(local.id, {
        ...map.get(local.id),
        ...local,
        name: localName(),
        online: true,
        lastSeen: Date.now()
      });
    }
    for (const remote of window.VOXEL_GAME_API?.getPlayers?.() || []) {
      const existing = map.get(remote.id) || {};
      map.set(remote.id, { ...existing, ...remote, name: existing.name || remote.name, online: true, lastSeen: Date.now() });
    }
    return Array.from(map.values()).sort(
      (a, b) => Number(b.online) - Number(a.online) || String(a.name).localeCompare(String(b.name))
    );
  }

  function findUser(sender) {
    if (!sender) return null;
    return mergedUsers().find((user) => user.id === sender.id || user.name === sender.name) || sender;
  }

  function saveStatus() {
    const status = ui.statusInput.value.trim().slice(0, 80);
    sendPacket({ type: 'chat:user-status', status });
    ui.statusInput.blur();
  }

  function saveName() {
    const name = ui.nameInput.value.trim();
    if (!name || name === localName()) { ui.nameInput.blur(); return; }
    localStorage.setItem(KEY.nick, name);
    sendPacket({ type: 'chat:nick', name });
    ui.nameInput.blur();
  }

  function updateUserStatus(message) {
    const user = state.users.find((item) => item.id === message.id || item.name === message.name);
    if (user) user.status = message.status || '';
    if (message.id === localId()) ui.statusInput.value = message.status || '';
    renderPlayers();
  }

  /* ------------------------------------------------------------ typing state */

  function updateTypingUser(message) {
    if (message.id === localId()) return;
    if (message.typing) {
      state.typingUsers.set(message.id, { name: message.name || 'Someone', expires: Date.now() + 4200 });
    } else {
      state.typingUsers.delete(message.id);
    }
    updateTypingIndicator();
  }

  function updateTypingIndicator() {
    const now = Date.now();
    let changed = false;
    for (const [id, item] of state.typingUsers) {
      if (item.expires < now) { state.typingUsers.delete(id); changed = true; }
    }
    const names = Array.from(state.typingUsers.values(), (item) => item.name);
    ui.typing.dataset.active = names.length ? 'true' : 'false';
    const label = names.length === 0 ? ''
      : names.length === 1 ? `${names[0]} is typing`
        : names.length === 2 ? `${names[0]} and ${names[1]} are typing`
          : names.length === 3 ? `${names[0]}, ${names[1]} and ${names[2]} are typing`
            : 'Several people are typing';
    ui.typing.textContent = label ? `${label}…` : '';
    if (changed) renderPlayers();
  }

  function scheduleTyping(typing, immediate = false) {
    clearTimeout(state.typingTimer);
    const send = () => {
      if (typing !== state.lastTypingSent) {
        sendPacket({ type: 'chat:typing', typing });
        state.lastTypingSent = typing;
      }
      if (typing) state.typingTimer = setTimeout(() => scheduleTyping(false, true), 2600);
    };
    if (immediate) send();
    else state.typingTimer = setTimeout(send, 180);
  }

  /* -------------------------------------------------------------- panel state */

  function setCollapsed(collapsed) {
    if (state.collapsed === collapsed) return;
    state.collapsed = collapsed;
    localStorage.setItem(KEY.collapsed, collapsed ? '1' : '0');
    applyCollapsedState(true);
  }

  function applyCollapsedState(animate) {
    ui.panel.dataset.collapsed = state.collapsed ? 'true' : 'false';
    document.documentElement.dataset.chatCollapsed = state.collapsed ? 'true' : 'false';
    ui.collapsedTab.hidden = !state.collapsed;
    ui.panel.setAttribute('aria-hidden', state.collapsed ? 'true' : 'false');
    if (animate) {
      ui.panel.classList.add('is-animating');
      setTimeout(() => ui.panel.classList.remove('is-animating'), 280);
    }
    if (state.collapsed) {
      closeAllMenus();
      ui.input.blur();
      window.__voxelChatTyping = false;
      window.VOXEL_GAME_API?.focusCanvas?.();
    } else {
      markRead();
      setTimeout(() => {
        ui.input.focus({ preventScroll: true });
        scrollToBottom(false);
      }, animate ? 210 : 0);
    }
  }

  function applyMembersVisibility() {
    ui.panel.dataset.members = state.membersVisible ? 'true' : 'false';
    ui.membersToggle.setAttribute('aria-pressed', state.membersVisible ? 'true' : 'false');
    ui.membersToggle.title = state.membersVisible ? 'Hide member list' : 'Show member list';
  }

  function setConnectionState(mode, label) {
    ui.connection.textContent = label;
    ui.connection.dataset.state = mode;
  }

  function updateComposerState() {
    const enabled = state.bridgeReady;
    ui.input.disabled = false;
    ui.send.disabled = !ui.input.value.trim();
    ui.composerShell.dataset.offline = state.connected ? 'false' : 'true';
    ui.input.placeholder = state.connected
      ? 'Message #world-chat'
      : (enabled ? 'Offline — messages will send when you reconnect' : 'Connecting chat…');
  }

  function updateCharCount() {
    const length = ui.input.value.length;
    const limit = state.limits.messageLength || 2000;
    ui.charCount.textContent = length > limit - 300 ? `${limit - length}` : '';
    ui.charCount.dataset.limit = length > limit ? 'over' : (length > limit - 100 ? 'near' : 'normal');
    ui.send.disabled = !ui.input.value.trim() || length > limit;
  }

  function autoGrow() {
    ui.input.style.height = 'auto';
    ui.input.style.height = `${Math.min(ui.input.scrollHeight, 208)}px`;
  }

  function updateSoundButton() {
    ui.sound.dataset.enabled = state.sound ? 'true' : 'false';
    ui.sound.setAttribute('aria-pressed', state.sound ? 'true' : 'false');
    ui.sound.title = state.sound ? 'Notification sound on' : 'Notification sound off';
    ui.sound.textContent = state.sound ? '🔔' : '🔕';
  }

  function updateDesktopButton() {
    ui.desktop.dataset.enabled = state.desktop ? 'true' : 'false';
    ui.desktop.setAttribute('aria-pressed', state.desktop ? 'true' : 'false');
    ui.desktop.title = state.desktop ? 'Desktop notifications on' : 'Desktop notifications off';
  }

  /* ------------------------------------------------------------ unread state */

  function markRead() {
    state.unread = 0;
    state.mentionUnread = 0;
    state.newWhileScrolled = 0;
    state.lastRead = Date.now();
    localStorage.setItem(KEY.lastRead, String(state.lastRead));
    updateUnreadBadge();
  }

  function updateUnreadBadge() {
    const count = state.unread;
    ui.unread.textContent = count > 99 ? '99+' : String(count);
    ui.unread.hidden = count === 0;
    ui.unread.dataset.mention = state.mentionUnread > 0 ? 'true' : 'false';
    ui.collapsedTab.dataset.unread = count > 0 ? 'true' : 'false';
    document.title = count > 0 ? `(${count > 99 ? '99+' : count}) ${state.baseTitle}` : state.baseTitle;
  }

  /* ------------------------------------------------------------------ search */

  function openSearch() {
    if (state.collapsed) setCollapsed(false);
    ui.searchBar.hidden = false;
    setTimeout(() => ui.searchInput.focus({ preventScroll: true }), 0);
  }

  function closeSearch() {
    ui.searchBar.hidden = true;
    ui.searchInput.value = '';
    state.search = '';
    state.searchMatches = [];
    render();
    scrollToBottom(false);
    ui.input.focus({ preventScroll: true });
  }

  function matchesSearch(message) {
    const haystack = `${message.sender?.name || ''} ${message.text || ''}`.toLowerCase();
    return haystack.includes(state.search);
  }

  function updateSearchMatches() {
    if (!state.search) {
      ui.searchCount.textContent = '';
      state.searchMatches = [];
      return;
    }
    state.searchMatches = Array.from(ui.list.querySelectorAll('.chat-message'));
    const total = state.searchMatches.length;
    ui.searchCount.textContent = total ? `${Math.min(state.searchCursor + 1, total)} / ${total}` : '0 results';
  }

  function stepSearch(delta) {
    if (!state.searchMatches.length) return;
    state.searchCursor = (state.searchCursor + delta + state.searchMatches.length) % state.searchMatches.length;
    focusSearchMatch(state.searchCursor);
    updateSearchMatches();
  }

  function focusSearchMatch(index) {
    const node = state.searchMatches[index];
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.add('is-jump-target');
    setTimeout(() => node.classList.remove('is-jump-target'), 1400);
  }

  /* ---------------------------------------------------------------- markdown */

  function renderMarkdown(container, source) {
    const text = applyShortcodes(String(source || ''));
    const blocks = text.split(/```/);
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (index % 2 === 1) {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        const firstBreak = block.indexOf('\n');
        code.textContent = firstBreak >= 0 && !block.slice(0, firstBreak).includes(' ')
          ? block.slice(firstBreak + 1).replace(/\n$/, '')
          : block;
        pre.append(code);
        container.append(pre);
      } else if (block) {
        renderTextBlock(container, block);
      }
    }
  }

  function renderTextBlock(container, source) {
    const lines = source.split('\n');
    let quote = null;
    let list = null;

    const flush = () => { quote = null; list = null; };

    for (const line of lines) {
      const quoteMatch = line.match(/^>\s?(.*)$/);
      const listMatch = line.match(/^\s*[-*]\s+(.*)$/);
      if (quoteMatch) {
        list = null;
        if (!quote) {
          quote = document.createElement('blockquote');
          container.append(quote);
        } else {
          quote.append(document.createElement('br'));
        }
        renderInline(quote, quoteMatch[1]);
        continue;
      }
      if (listMatch) {
        quote = null;
        if (!list) {
          list = document.createElement('ul');
          container.append(list);
        }
        const item = document.createElement('li');
        renderInline(item, listMatch[1]);
        list.append(item);
        continue;
      }
      flush();
      renderInline(container, line);
      container.append(document.createTextNode('\n'));
    }
    if (container.lastChild?.nodeType === Node.TEXT_NODE && container.lastChild.textContent === '\n') {
      container.lastChild.remove();
    }
  }

  const INLINE_PREFIX = [
    '(`[^`\\n]+`)',
    '(\\*\\*[^*\\n]+\\*\\*)',
    '(__[^_\\n]+__)',
    '(~~[^~\\n]+~~)',
    '(\\|\\|[^|\\n]+\\|\\|)',
    '(\\*[^*\\n]+\\*)',
    '(_[^_\\n]+_)',
    '(https?://[^\\s<>"]+)'
  ].join('|');
  const GENERIC_MENTION = '@[A-Za-z0-9_.\\-]{1,24}';
  let inlineCache = { key: '', pattern: null };

  /* Display names may contain spaces ("Player 1"), so the mention token cannot
   * be a simple \S+ run. Known names are matched first, longest to shortest,
   * with a generic single-word token as the fallback for unknown users. */
  function inlinePattern() {
    const names = Array.from(new Set([
      ...mergedUsers().map((user) => user.name),
      ...state.messages.map((message) => message.sender?.name),
      localName(), 'everyone', 'here'
    ].filter((name) => typeof name === 'string' && name.trim())))
      .sort((a, b) => b.length - a.length);
    const key = names.join(' ');
    if (inlineCache.key === key && inlineCache.pattern) return inlineCache.pattern;
    const mention = `(@(?:${[...names.map(escapeRegExp), GENERIC_MENTION.slice(1)].join('|')}))`;
    inlineCache = { key, pattern: new RegExp(`${INLINE_PREFIX}|${mention}`, 'g') };
    return inlineCache.pattern;
  }

  function renderInline(container, source) {
    const text = String(source || '');
    let cursor = 0;
    for (const match of text.matchAll(inlinePattern())) {
      if (match.index > cursor) appendHighlighted(container, text.slice(cursor, match.index));
      const token = match[0];
      container.append(inlineNode(token));
      cursor = match.index + token.length;
    }
    if (cursor < text.length) appendHighlighted(container, text.slice(cursor));
  }

  function inlineNode(token) {
    if (token.startsWith('`') && token.endsWith('`')) {
      const code = document.createElement('code');
      code.className = 'inline-code';
      code.textContent = token.slice(1, -1);
      return code;
    }
    if (token.startsWith('**')) return wrapInline('strong', token.slice(2, -2));
    if (token.startsWith('__')) return wrapInline('u', token.slice(2, -2));
    if (token.startsWith('~~')) return wrapInline('s', token.slice(2, -2));
    if (token.startsWith('||')) {
      const spoiler = document.createElement('span');
      spoiler.className = 'chat-spoiler';
      spoiler.title = 'Click to reveal';
      spoiler.textContent = token.slice(2, -2);
      spoiler.addEventListener('click', (event) => {
        event.stopPropagation();
        spoiler.classList.add('is-revealed');
      });
      return spoiler;
    }
    if (token.startsWith('*')) return wrapInline('em', token.slice(1, -1));
    if (token.startsWith('_')) return wrapInline('em', token.slice(1, -1));
    if (/^https?:\/\//.test(token)) {
      const link = document.createElement('a');
      link.href = token;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = truncate(token, 72);
      link.title = token;
      link.addEventListener('click', (event) => event.stopPropagation());
      return link;
    }
    const mention = document.createElement('span');
    mention.className = 'chat-mention';
    const name = token.slice(1);
    if (name.toLowerCase() === localName().toLowerCase()
      || name.toLowerCase() === 'everyone'
      || name.toLowerCase() === 'here') {
      mention.classList.add('is-me');
    }
    mention.textContent = token;
    return mention;
  }

  function wrapInline(tag, inner) {
    const element = document.createElement(tag);
    renderInline(element, inner);
    return element;
  }

  function appendHighlighted(container, text) {
    if (!state.search) { container.append(document.createTextNode(text)); return; }
    const lower = text.toLowerCase();
    let cursor = 0;
    let position = lower.indexOf(state.search);
    while (position >= 0) {
      if (position > cursor) container.append(document.createTextNode(text.slice(cursor, position)));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(position, position + state.search.length);
      container.append(mark);
      cursor = position + state.search.length;
      position = lower.indexOf(state.search, cursor);
    }
    if (cursor < text.length) container.append(document.createTextNode(text.slice(cursor)));
  }

  function applyShortcodes(text) {
    return text.replace(/(^|\s)(:[a-z0-9_+-]+:|<3|:-?[)(dpo])(?=\s|$)/gi, (match, lead, token) => {
      const replacement = SHORTCODES[token.toLowerCase()];
      return replacement ? `${lead}${replacement}` : match;
    });
  }

  /* ------------------------------------------------------- toasts + notices */

  function showMessageToast(message) {
    while (ui.toastRegion.childElementCount >= MAX_TOASTS) ui.toastRegion.lastElementChild?.remove();
    const toast = document.createElement('article');
    toast.className = 'chat-toast';
    toast.dataset.messageId = message.id;
    if (isMention(message)) toast.classList.add('is-mention');

    const header = document.createElement('div');
    header.className = 'chat-toast-header';
    const avatar = document.createElement('span');
    avatar.className = 'chat-toast-avatar';
    avatar.style.setProperty('--avatar-color', rgbColor(message.sender?.color));
    avatar.textContent = initials(message.sender?.name || 'W');
    const author = document.createElement('strong');
    author.textContent = message.sender?.name || 'World';
    const time = document.createElement('time');
    time.textContent = shortClock(message.timestamp);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'chat-toast-close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = '×';
    header.append(avatar, author, time, close);

    const preview = document.createElement('p');
    preview.textContent = truncate(message.text || '', 96);
    toast.append(header, preview);

    const dismiss = () => dismissToast(toast);
    const timer = setTimeout(dismiss, TOAST_LIFETIME_MS);
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      clearTimeout(timer);
      dismiss();
    });
    toast.addEventListener('click', () => {
      clearTimeout(timer);
      setCollapsed(false);
      setTimeout(() => scrollToMessage(message.id), 250);
      dismiss();
    });
    ui.toastRegion.prepend(toast);
    requestAnimationFrame(() => toast.classList.add('is-visible'));
  }

  function showSystemToast(title, text) {
    showMessageToast({
      id: `toast-${Date.now()}`,
      sender: { name: title, color: [0.58, 0.68, 0.62] },
      text,
      timestamp: Date.now()
    });
  }

  function dismissToast(toast) {
    toast.classList.remove('is-visible');
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 220);
  }

  function notifyDesktop(message, mentionsMe) {
    if (!state.desktop || !('Notification' in window) || Notification.permission !== 'granted') return;
    if (!document.hidden && !state.collapsed) return;
    try {
      const notification = new Notification(
        mentionsMe ? `${message.sender?.name} mentioned you` : `${message.sender?.name} · #world-chat`,
        { body: truncate(message.text || '', 140), tag: 'voxel-world-chat', renotify: false }
      );
      notification.onclick = () => {
        window.focus();
        setCollapsed(false);
        setTimeout(() => scrollToMessage(message.id), 200);
        notification.close();
      };
    } catch {
      /* Notification constructor can throw on some platforms; chat still works. */
    }
  }

  /* ---------------------------------------------------------------- helpers */

  function jumpToLocation(location) {
    if (!location) return;
    const ok = window.VOXEL_GAME_API?.teleport?.(location.x, location.z);
    if (ok) {
      window.VOXEL_GAME_API?.focusCanvas?.();
      showSystemToast('Location jump', `Moved to chunk ${location.chunkX}, ${location.chunkZ}.`);
    } else {
      showSystemToast('Cannot teleport', 'The world is still loading.');
    }
  }

  function highlightSender(sender) {
    if (!sender || sender.id === localId()) return;
    const byId = window.VOXEL_GAME_API?.highlightPlayer?.(sender.id, 2200);
    if (!byId) window.VOXEL_GAME_API?.highlightPlayerByName?.(sender.name, 2200);
  }

  function scrollToMessage(messageId) {
    if (!messageId) return;
    const target = ui.list.querySelector(`[data-message-id="${cssEscape(messageId)}"]`);
    if (!target) {
      showSystemToast('Not loaded', 'That message is not in your local history.');
      return;
    }
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('is-jump-target');
    setTimeout(() => target.classList.remove('is-jump-target'), 1500);
  }

  function cssEscape(value) {
    return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
  }

  function isPinnedToBottom() {
    return ui.scroller.scrollHeight - ui.scroller.scrollTop - ui.scroller.clientHeight < BOTTOM_THRESHOLD_PX;
  }

  function updateJumpButton() {
    const count = state.newWhileScrolled;
    ui.jumpButton.dataset.count = String(count);
    ui.jumpButton.firstElementChild.textContent = count > 0
      ? `${count} new message${count === 1 ? '' : 's'}`
      : 'Jump to present';
    ui.jumpButton.hidden = count === 0 && isPinnedToBottom();
  }

  function scrollToBottom(smooth) {
    state.pinnedToBottom = true;
    state.newWhileScrolled = 0;
    ui.jumpButton.dataset.count = '0';
    ui.jumpButton.hidden = true;
    const run = () => {
      ui.scroller.scrollTo({ top: ui.scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    };
    requestAnimationFrame(run);
  }

  function sendPacket(payload) {
    return Boolean(window.VOXEL_GAME_API?.send?.(payload));
  }

  function copyText(text) {
    const done = () => showSystemToast('Copied', truncate(text, 60));
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.append(helper);
    helper.select();
    try { document.execCommand('copy'); done(); } catch { /* ignore */ }
    helper.remove();
  }

  function mergeLocal(detail) {
    if (!detail) return;
    const name = state.local?.name && detail.name === undefined ? state.local.name : (detail.name || state.local?.name);
    state.local = { ...(state.local || {}), ...detail, name };
  }

  function localId() { return state.local?.id; }
  function localName() { return state.local?.name || 'You'; }
  function localColor() { return state.local?.color || [0.42, 0.72, 1]; }

  function currentLocation() {
    const local = window.VOXEL_GAME_API?.getLocalState?.() || state.local || {};
    const x = Number(local.x) || 0;
    const z = Number(local.z) || 0;
    return {
      x,
      z,
      chunkX: Number.isFinite(local.chunkX) ? local.chunkX : Math.floor(x / 16),
      chunkZ: Number.isFinite(local.chunkZ) ? local.chunkZ : Math.floor(z / 16)
    };
  }

  function isMention(message) {
    if (!message?.text || message.sender?.id === localId()) return false;
    if (message.kind === 'dm') return message.dm?.toId === localId();
    const name = localName();
    const pattern = new RegExp(`(^|\\s)@(${escapeRegExp(name)}|everyone|here)\\b`, 'i');
    return pattern.test(message.text);
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function findMessage(id) {
    return id ? state.messages.find((item) => item.id === id) : undefined;
  }

  function upsertMessage(message) {
    const index = state.messages.findIndex(
      (item) => item.id === message.id || (item.serverId && item.serverId === message.id)
    );
    if (index >= 0) state.messages[index] = { ...state.messages[index], ...message };
    else state.messages.push(message);
    state.messages.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  }

  function mergeHistories(local, remote) {
    const map = new Map();
    for (const message of local) {
      if (message?.id && !message.optimistic) map.set(message.id, message);
    }
    for (const message of remote) if (message?.id) map.set(message.id, message);
    const pendingLocal = local.filter((message) => message.optimistic && message.delivery !== 'delivered');
    return [...map.values(), ...pendingLocal]
      .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
      .slice(-MAX_MESSAGES);
  }

  function trimMessages() {
    if (state.messages.length > MAX_MESSAGES) {
      state.messages.splice(0, state.messages.length - MAX_MESSAGES);
    }
  }

  function loadCache() {
    try {
      const value = JSON.parse(localStorage.getItem(KEY.cache) || '[]');
      return Array.isArray(value) ? value.slice(-MAX_MESSAGES) : [];
    } catch {
      return [];
    }
  }

  function cacheMessages() {
    try {
      const safe = state.messages
        .filter((message) => !message.optimistic && !message.private)
        .slice(-MAX_MESSAGES);
      localStorage.setItem(KEY.cache, JSON.stringify(safe));
    } catch {
      /* Storage can be unavailable in private browsing; server history still works. */
    }
  }

  function saveDraft() {
    try {
      localStorage.setItem(KEY.draft, ui.input.value);
    } catch { /* ignore */ }
  }

  function restoreDraft() {
    try {
      const draft = localStorage.getItem(KEY.draft);
      if (draft) {
        ui.input.value = draft;
        autoGrow();
      }
    } catch { /* ignore */ }
  }

  function refreshRelativeTimes() {
    for (const element of ui.list.querySelectorAll('time[data-timestamp]')) {
      element.textContent = formatMessageTime(Number(element.dataset.timestamp));
    }
  }

  function deliveryIcon(delivery) {
    if (delivery === 'delivered') return '✓✓';
    if (delivery === 'failed') return '!';
    if (delivery === 'queued') return '◷';
    return '✓';
  }

  function deliveryLabel(delivery) {
    if (delivery === 'delivered') return 'Delivered to the server';
    if (delivery === 'sent') return 'Sent';
    if (delivery === 'failed') return 'Failed';
    if (delivery === 'queued') return 'Queued — will send when connected';
    return 'Sending';
  }

  function dayStamp(timestamp) {
    const date = new Date(Number(timestamp) || Date.now());
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }

  function dayLabel(timestamp) {
    const date = new Date(Number(timestamp) || Date.now());
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86_400_000);
    if (dayStamp(date.getTime()) === dayStamp(today.getTime())) return 'Today';
    if (dayStamp(date.getTime()) === dayStamp(yesterday.getTime())) return 'Yesterday';
    return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function formatMessageTime(timestamp) {
    const date = new Date(Number(timestamp) || Date.now());
    const age = Date.now() - date.getTime();
    if (age >= 0 && age < 60_000) return 'now';
    if (age >= 0 && age < 60 * 60_000) return `${Math.max(1, Math.floor(age / 60_000))}m ago`;
    return shortClock(timestamp);
  }

  function shortClock(timestamp) {
    return new Date(Number(timestamp) || Date.now())
      .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function fullTimestamp(timestamp) {
    return new Date(Number(timestamp) || Date.now()).toLocaleString([], {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
    });
  }

  function safeIso(timestamp) {
    const date = new Date(Number(timestamp) || Date.now());
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }

  function relativeTime(timestamp) {
    const age = Math.max(0, Date.now() - Number(timestamp || 0));
    if (age < 60_000) return 'just now';
    if (age < 60 * 60_000) return `${Math.floor(age / 60_000)}m ago`;
    if (age < 24 * 60 * 60_000) return `${Math.floor(age / 3_600_000)}h ago`;
    return `${Math.floor(age / 86_400_000)}d ago`;
  }

  function rgbColor(color, bright = false) {
    const values = Array.isArray(color) ? color : [0.45, 0.65, 0.95];
    const channels = values.slice(0, 3).map((value) => {
      const scaled = Number(value) * 255;
      return Math.max(0, Math.min(255, Math.round(bright ? Math.min(255, scaled * 1.15 + 26) : scaled)));
    });
    return `rgb(${channels.join(' ')})`;
  }

  function initials(name) {
    return String(name || '?')
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  function truncate(value, limit) {
    const text = String(value || '');
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
  }

  function playPing(intensity = 0.5) {
    try {
      state.audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      const context = state.audioContext;
      if (context.state === 'suspended') context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(650 + intensity * 180, context.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(880 + intensity * 220, context.currentTime + 0.08);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.045 * intensity, context.currentTime + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.18);
    } catch {
      /* Audio can be blocked until the first user gesture; chat remains functional. */
    }
  }
})();
