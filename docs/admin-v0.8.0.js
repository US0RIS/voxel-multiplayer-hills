/* Ridgewood v0.8.0 — staff control panel.
 *
 * This file is pure UI and input. It holds no authority: every power it exposes
 * is granted by the server in the `admin` block of the welcome packet, and
 * every action it takes is a request the server re-checks against the account's
 * role in Supabase. Editing this file in devtools gets you a nicer-looking
 * panel and nothing else.
 *
 * The one piece of shared state is `window.__RIDGEWOOD_ADMIN`, which the
 * patched game loop reads for fly and speed. The server independently clamps
 * both, so a forged value cannot outrun or out-reach what staff are allowed.
 */
(() => {
  'use strict';

  if (window.__RIDGEWOOD_ADMIN_PANEL__) return;
  window.__RIDGEWOOD_ADMIN_PANEL__ = true;

  const SPEED_STEPS = [1, 2, 4];
  const STORAGE_KEY = 'ridgewood.admin.prefs';

  // Read by the patched game loop. Defaults are "behave like a normal player".
  const powers = window.__RIDGEWOOD_ADMIN = {
    staff: false,
    flying: false,
    flySpeed: 9,
    speed: 1,
    reach: 8,
    buildOverride: false,
    verticalInput: 0
  };

  const state = {
    role: 'player',
    caps: null,
    players: [],
    panelOpen: false,
    tab: 'powers',
    pending: new Map(),
    requestSeq: 0
  };

  let ui = null;

  // ------------------------------------------------------------ utilities

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; }
    catch { return {}; }
  }

  function savePrefs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        speed: powers.speed,
        buildOverride: powers.buildOverride,
        tab: state.tab
      }));
    } catch { /* private browsing; preferences are not important enough to fail on */ }
  }

  function isTyping() {
    const node = document.activeElement;
    return Boolean(
      window.__voxelChatTyping ||
      (node && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node.isContentEditable))
    );
  }

  function send(payload) {
    return Boolean(window.VOXEL_GAME_API?.send?.(payload));
  }

  function request(action, fields = {}) {
    const requestId = `a${++state.requestSeq}`;
    if (!send({ type: 'admin:action', action, requestId, ...fields })) {
      setStatus('Not connected to the world server.', 'error');
      return null;
    }
    setStatus('Working…', 'busy');
    return requestId;
  }

  function setStatus(text, tone = '') {
    if (!ui) return;
    ui.status.textContent = text || '';
    ui.status.dataset.state = tone;
  }

  function ensureStyles() {
    if (document.querySelector('link[data-ridgewood-admin]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'admin-v0.8.0.css?v=0.8.0';
    link.dataset.ridgewoodAdmin = 'true';
    document.head.append(link);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // --------------------------------------------------------------- panel

  function buildPanel() {
    if (ui) return ui;
    ensureStyles();

    const panel = el('section', null);
    panel.id = 'rw-admin-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Admin control panel');

    const head = el('div', 'rw-admin-head');
    const title = el('span', 'rw-admin-title', 'Control Panel');
    const roleTag = el('span', 'rw-admin-role', 'ADMIN');
    const close = el('button', 'rw-admin-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close the control panel');
    close.addEventListener('click', () => togglePanel(false));
    head.append(title, roleTag, close);

    const tabs = el('div', 'rw-admin-tabs');
    const body = el('div', 'rw-admin-body');
    const status = el('p', 'rw-admin-status');

    const sections = {};
    for (const [key, label] of [
      ['powers', 'Powers'], ['players', 'Players'], ['moderate', 'Moderate'], ['log', 'Log']
    ]) {
      const tab = el('button', 'rw-admin-tab', label);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.dataset.tab = key;
      tab.addEventListener('click', () => selectTab(key));
      tabs.append(tab);

      const section = el('div', 'rw-admin-section');
      section.dataset.section = key;
      section.hidden = true;
      sections[key] = section;
      body.append(section);
    }

    body.append(status);
    panel.append(head, tabs, body);
    document.body.append(panel);

    const launch = el('button', null, '⚙ Admin');
    launch.id = 'rw-admin-launch';
    launch.type = 'button';
    launch.hidden = true;
    launch.title = 'Open the admin control panel (F1)';
    launch.addEventListener('click', () => togglePanel());
    document.body.append(launch);

    const flight = el('div', null);
    flight.id = 'rw-admin-flight';
    flight.hidden = true;
    document.body.append(flight);

    ui = { panel, roleTag, tabs, body, status, sections, launch, flight };
    makeDraggable(panel, head);
    renderPowers();
    renderModerate();
    selectTab(loadPrefs().tab || 'powers');
    return ui;
  }

  function makeDraggable(panel, handle) {
    let startX = 0, startY = 0, originLeft = 0, originTop = 0, dragging = false;
    handle.addEventListener('pointerdown', event => {
      if (event.target.closest('button') && event.target !== handle) return;
      dragging = true;
      const box = panel.getBoundingClientRect();
      startX = event.clientX; startY = event.clientY;
      originLeft = box.left; originTop = box.top;
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
      if (!dragging) return;
      const width = panel.offsetWidth, height = panel.offsetHeight;
      panel.style.left = `${Math.max(4, Math.min(window.innerWidth - width - 4, originLeft + event.clientX - startX))}px`;
      panel.style.top = `${Math.max(4, Math.min(window.innerHeight - height - 4, originTop + event.clientY - startY))}px`;
      panel.style.right = 'auto';
    });
    const stop = event => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  function selectTab(key) {
    if (!ui || !ui.sections[key]) return;
    state.tab = key;
    for (const tab of ui.tabs.querySelectorAll('.rw-admin-tab')) {
      tab.setAttribute('aria-selected', String(tab.dataset.tab === key));
    }
    for (const [name, section] of Object.entries(ui.sections)) section.hidden = name !== key;
    if (key === 'players') refreshPlayers();
    if (key === 'log') refreshLog();
    savePrefs();
  }

  function togglePanel(force) {
    if (!powers.staff) return;
    buildPanel();
    state.panelOpen = typeof force === 'boolean' ? force : !state.panelOpen;
    ui.panel.hidden = !state.panelOpen;
    // The game ignores movement keys while a menu is open; reuse that flag so
    // typing a player name never walks the character around.
    window.__ridgewoodMenuOpen = state.panelOpen;
    if (state.panelOpen && state.tab === 'players') refreshPlayers();
  }

  // -------------------------------------------------------- powers panel

  function toggleRow(label, hint, keyHint, getter, onToggle) {
    const button = el('button', 'rw-admin-toggle');
    button.type = 'button';
    const text = el('span', 'rw-admin-toggle-text');
    text.append(el('strong', null, label), el('span', null, hint));
    button.append(text);
    if (keyHint) button.append(el('span', 'rw-admin-key', keyHint));
    button.addEventListener('click', () => { onToggle(); sync(); });
    button._sync = () => button.setAttribute('aria-pressed', String(Boolean(getter())));
    return button;
  }

  function renderPowers() {
    const section = ui.sections.powers;
    section.replaceChildren();
    section.append(el('div', 'rw-admin-label', 'Movement'));

    const fly = toggleRow(
      'Flight', 'Space rises, Shift descends', 'F',
      () => powers.flying, () => setFlying(!powers.flying)
    );
    section.append(fly);

    const speed = el('div', 'rw-admin-slider');
    const header = el('header');
    const speedLabel = el('span', null, 'Movement speed');
    const speedValue = el('span', null, `${powers.speed}×`);
    header.append(speedLabel, speedValue);
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '1';
    range.max = String(SPEED_STEPS.length);
    range.step = '1';
    range.value = String(Math.max(1, SPEED_STEPS.indexOf(powers.speed) + 1));
    range.addEventListener('input', () => {
      setSpeed(SPEED_STEPS[Number(range.value) - 1] || 1);
      speedValue.textContent = `${powers.speed}×`;
    });
    speed.append(header, range);
    section.append(speed);
    section.append(el('p', 'rw-admin-note', 'Press R to cycle speed without opening the panel.'));

    section.append(el('div', 'rw-admin-label', 'Building'));
    const override = toggleRow(
      'Build anywhere', 'Edit blocks inside any claim, including unclaimed land', 'G',
      () => powers.buildOverride, () => setOverride(!powers.buildOverride)
    );
    section.append(override);
    section.append(el('p', 'rw-admin-note',
      'While this is off you build exactly like an ordinary player, so you cannot damage '
      + "someone else's plot by accident. Every override edit is written to the audit log."));

    section._syncers = [fly._sync, override._sync, () => {
      speedValue.textContent = `${powers.speed}×`;
      range.value = String(Math.max(1, SPEED_STEPS.indexOf(powers.speed) + 1));
    }];
  }

  // ------------------------------------------------------- players panel

  function refreshPlayers() {
    request('players');
  }

  function renderPlayers() {
    const section = ui.sections.players;
    section.replaceChildren();

    const refresh = el('button', 'rw-admin-mini', 'Refresh');
    refresh.type = 'button';
    refresh.addEventListener('click', refreshPlayers);
    const head = el('div', 'rw-admin-label', `Online — ${state.players.length}`);
    section.append(head, refresh);

    if (!state.players.length) {
      section.append(el('p', 'rw-admin-empty', 'Nobody else is online.'));
      return;
    }

    const list = el('div', 'rw-admin-players');
    const myRank = rankOf(state.role);
    for (const player of state.players) {
      const row = el('div', 'rw-admin-player');
      row.dataset.role = player.role || 'player';

      const name = el('span', 'rw-admin-player-name');
      name.append(
        el('strong', null, player.name),
        el('span', null, `chunk ${player.chunkX ?? '?'}, ${player.chunkZ ?? '?'}`
          + (player.role && player.role !== 'player' ? ` · ${player.role}` : ''))
      );

      const tp = el('button', 'rw-admin-mini', 'Go to');
      tp.type = 'button';
      tp.title = `Teleport to ${player.name}`;
      tp.addEventListener('click', () => {
        window.VOXEL_GAME_API?.teleport?.(player.x, player.z);
        setStatus(`Teleported to ${player.name}.`, 'ok');
      });

      const kick = el('button', 'rw-admin-mini is-danger', 'Kick');
      kick.type = 'button';
      const outranked = rankOf(player.role) >= myRank;
      kick.disabled = outranked;
      kick.title = outranked
        ? `${player.name} has an equal or higher role than you`
        : `Disconnect ${player.name}`;
      kick.addEventListener('click', () => {
        const reason = prompt(`Kick ${player.name}. Reason (optional):`, '');
        if (reason === null) return;
        request('kick', { player: player.name, reason });
      });

      row.append(name, tp, kick);
      list.append(row);
    }
    section.append(list);
  }

  function rankOf(role) {
    return ({ player: 0, moderator: 1, admin: 2 })[String(role || 'player').toLowerCase()] ?? 0;
  }

  // ------------------------------------------------------ moderate panel

  function renderModerate() {
    const section = ui.sections.moderate;
    section.replaceChildren();

    // --- ban ---
    section.append(el('div', 'rw-admin-label', 'Ban an account'));
    const banForm = el('form', 'rw-admin-form');
    const banName = document.createElement('input');
    banName.type = 'text';
    banName.placeholder = 'Username';
    banName.autocomplete = 'off';
    banName.required = true;

    const row = el('div', 'rw-admin-form-row');
    const duration = document.createElement('select');
    for (const [value, label] of [
      ['1h', '1 hour'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days'], ['forever', 'Permanent']
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      duration.append(option);
    }
    duration.value = '24h';
    const banReason = document.createElement('input');
    banReason.type = 'text';
    banReason.placeholder = 'Reason (optional)';
    banReason.autocomplete = 'off';
    row.append(duration, banReason);

    const banSubmit = el('button', 'rw-admin-submit', 'Ban account');
    banSubmit.type = 'submit';
    banForm.append(banName, row, banSubmit);
    banForm.addEventListener('submit', event => {
      event.preventDefault();
      const name = banName.value.trim();
      if (!name) return;
      const label = duration.options[duration.selectedIndex].textContent.toLowerCase();
      if (!confirm(`Ban ${name} (${label})?\n\nThis revokes their sessions and disconnects them now.`)) return;
      request('ban', { player: name, duration: duration.value, reason: banReason.value.trim() });
      banName.value = '';
      banReason.value = '';
    });
    section.append(banForm);

    // --- unban ---
    section.append(el('div', 'rw-admin-label', 'Lift a ban'));
    const unbanForm = el('form', 'rw-admin-form');
    const unbanName = document.createElement('input');
    unbanName.type = 'text';
    unbanName.placeholder = 'Username';
    unbanName.autocomplete = 'off';
    unbanName.required = true;
    const unbanSubmit = el('button', 'rw-admin-submit', 'Unban');
    unbanSubmit.type = 'submit';
    unbanForm.append(unbanName, unbanSubmit);
    unbanForm.addEventListener('submit', event => {
      event.preventDefault();
      if (!unbanName.value.trim()) return;
      request('unban', { player: unbanName.value.trim() });
      unbanName.value = '';
    });
    section.append(unbanForm);

    // --- roles (admin only) ---
    const roleWrap = el('div', 'rw-admin-section');
    roleWrap.append(el('div', 'rw-admin-label', 'Set a role'));
    const roleForm = el('form', 'rw-admin-form');
    const roleName = document.createElement('input');
    roleName.type = 'text';
    roleName.placeholder = 'Username';
    roleName.autocomplete = 'off';
    roleName.required = true;
    const roleSelect = document.createElement('select');
    for (const value of ['player', 'moderator', 'admin']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value[0].toUpperCase() + value.slice(1);
      roleSelect.append(option);
    }
    roleSelect.value = 'moderator';
    const roleSubmit = el('button', 'rw-admin-submit', 'Apply role');
    roleSubmit.type = 'submit';
    roleForm.append(roleName, roleSelect, roleSubmit);
    roleForm.addEventListener('submit', event => {
      event.preventDefault();
      const name = roleName.value.trim();
      if (!name) return;
      if (!confirm(`Make ${name} a ${roleSelect.value}?`)) return;
      request('set-role', { player: name, role: roleSelect.value });
      roleName.value = '';
    });
    roleWrap.append(roleForm);
    roleWrap.append(el('p', 'rw-admin-note', 'Only an admin can change roles, and never their own.'));
    section.append(roleWrap);

    section._syncers = [() => { roleWrap.hidden = state.role !== 'admin'; }];
  }

  // ----------------------------------------------------------- log panel

  function refreshLog() { request('modlog', { limit: 20 }); }

  function renderLog(entries) {
    const section = ui.sections.log;
    section.replaceChildren();
    const refresh = el('button', 'rw-admin-mini', 'Refresh');
    refresh.type = 'button';
    refresh.addEventListener('click', refreshLog);
    section.append(el('div', 'rw-admin-label', 'Recent moderation'), refresh);

    if (!entries?.length) {
      section.append(el('p', 'rw-admin-empty', 'Nothing recorded yet.'));
      return;
    }
    const list = el('div', 'rw-admin-log');
    for (const entry of entries) {
      const when = String(entry.created_at || '').slice(0, 16).replace('T', ' ');
      const line = el('div', 'rw-admin-log-entry');
      line.append(
        document.createTextNode(`${when} · `),
        el('b', null, entry.actor_name || 'system'),
        document.createTextNode(` ${String(entry.action || '').replace(/_/g, ' ')} `),
        el('b', null, entry.target_name || '')
      );
      list.append(line);
    }
    section.append(list);
  }

  // -------------------------------------------------------- power setters

  function setFlying(next) {
    if (!powers.staff) return;
    powers.flying = Boolean(next);
    powers.verticalInput = 0;
    sync();
  }

  function setSpeed(multiplier) {
    if (!powers.staff) return;
    const max = Number(state.caps?.maxSpeedMultiplier) || 1;
    powers.speed = Math.max(1, Math.min(max, Number(multiplier) || 1));
    savePrefs();
    sync();
  }

  function setOverride(next) {
    if (!powers.staff) return;
    powers.buildOverride = Boolean(next);
    powers.reach = powers.buildOverride ? (Number(state.caps?.buildDistance) || 8) : 8;
    savePrefs();
    sync();
  }

  function sync() {
    if (!ui) return;
    for (const section of Object.values(ui.sections)) {
      for (const syncer of section._syncers || []) syncer();
    }
    ui.roleTag.textContent = state.role === 'admin' ? 'ADMIN' : 'MOD';
    ui.flight.hidden = !powers.flying && powers.speed === 1 && !powers.buildOverride;
    ui.flight.replaceChildren();
    if (powers.flying) ui.flight.append(el('span', null, '✈ Flight'));
    if (powers.speed !== 1) ui.flight.append(el('span', null, `${powers.speed}× speed`));
    if (powers.buildOverride) ui.flight.append(el('span', null, '⛏ Build anywhere'));
  }

  // ------------------------------------------------------- staff enabling

  function enableStaff(role, caps) {
    state.role = String(role || 'player').toLowerCase();
    state.caps = caps || null;
    powers.staff = Boolean(caps?.staff);

    if (!powers.staff) {
      powers.flying = false;
      powers.speed = 1;
      powers.buildOverride = false;
      powers.reach = 8;
      if (ui) { ui.launch.hidden = true; ui.panel.hidden = true; ui.flight.hidden = true; }
      return;
    }

    buildPanel();
    ui.launch.hidden = false;
    powers.flySpeed = Math.max(4, Math.min(40, Number(caps.maxFlyHeight) ? 9 : 9));

    const prefs = loadPrefs();
    setSpeed(prefs.speed ?? 1);
    setOverride(Boolean(prefs.buildOverride));
    renderModerate();
    sync();
    setStatus(`Signed in as ${state.role}. Press F1 to toggle this panel.`, 'ok');
  }

  function showBanned(reason, detail) {
    let overlay = document.querySelector('#rw-admin-banned');
    if (!overlay) {
      ensureStyles();
      overlay = el('div', null);
      overlay.id = 'rw-admin-banned';
      const card = el('div', 'rw-banned-card');
      card.append(el('h2', null, 'You have been removed'), el('p', null, ''));
      overlay.append(card);
      document.body.append(overlay);
    }
    overlay.querySelector('h2').textContent = detail || 'You have been removed';
    overlay.querySelector('p').textContent = reason || 'A moderator disconnected you from Ridgewood.';
    overlay.hidden = false;
  }

  // ------------------------------------------------------------- results

  function handleResult(message) {
    if (!message.ok) {
      setStatus(message.message || `Action failed (${message.error || 'unknown'}).`, 'error');
      return;
    }
    if (message.action === 'players') {
      state.players = Array.isArray(message.players) ? message.players : [];
      renderPlayers();
      setStatus('', '');
      return;
    }
    if (message.action === 'modlog') {
      renderLog(message.entries);
      setStatus('', '');
      return;
    }
    setStatus(message.message || 'Done.', 'ok');
    if (['kick', 'ban', 'set-role'].includes(message.action)) refreshPlayers();
  }

  window.addEventListener('voxel:network-message', event => {
    const message = event.detail;
    if (!message || typeof message !== 'object') return;

    if (message.type === 'welcome') {
      enableStaff(message.role, message.admin);
    } else if (message.type === 'admin:role') {
      enableStaff(message.role, message.admin);
    } else if (message.type === 'admin:result') {
      handleResult(message);
    } else if (message.type === 'admin:open-panel') {
      togglePanel(true);
    } else if (message.type === 'admin:kicked') {
      showBanned(message.reason, 'Disconnected by a moderator');
    }
  });

  // -------------------------------------------------------------- input

  const VERTICAL_KEYS = new Set(['Space', 'ShiftLeft', 'ShiftRight']);

  function updateVertical(event, pressed) {
    if (!powers.flying) return false;
    if (event.code === 'Space') {
      powers.verticalInput = pressed ? 1 : (powers.verticalInput === 1 ? 0 : powers.verticalInput);
      return true;
    }
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      powers.verticalInput = pressed ? -1 : (powers.verticalInput === -1 ? 0 : powers.verticalInput);
      return true;
    }
    return false;
  }

  window.addEventListener('keydown', event => {
    // F1 works even while the panel has focus, so staff can always close it.
    if (event.code === 'F1' && powers.staff) {
      event.preventDefault();
      togglePanel();
      return;
    }
    if (!powers.staff || isTyping() || event.metaKey || event.ctrlKey || event.altKey) return;

    if (VERTICAL_KEYS.has(event.code) && updateVertical(event, true)) {
      event.preventDefault();
      return;
    }
    if (event.repeat) return;
    if (event.code === 'KeyF') { event.preventDefault(); setFlying(!powers.flying); }
    else if (event.code === 'KeyG') { event.preventDefault(); setOverride(!powers.buildOverride); }
    else if (event.code === 'KeyR') {
      event.preventDefault();
      const max = Number(state.caps?.maxSpeedMultiplier) || 1;
      const allowed = SPEED_STEPS.filter(step => step <= max);
      setSpeed(allowed[(allowed.indexOf(powers.speed) + 1) % allowed.length] || 1);
    }
  }, { capture: true });

  window.addEventListener('keyup', event => {
    if (!powers.staff) return;
    if (VERTICAL_KEYS.has(event.code)) updateVertical(event, false);
  }, { capture: true });

  // Losing focus mid-flight would otherwise leave the player climbing forever.
  window.addEventListener('blur', () => { powers.verticalInput = 0; });

  // ------------------------------------------------------ chat prominence
  //
  // Staff badges are applied here rather than inside the chat module, so the
  // chat client and its generated base64 parts stay untouched. Roles arrive on
  // the wire (`sender.role` on every message, `role` on every member) and are
  // decorated onto the DOM as messages render.

  const ROLE_LABELS = { admin: 'ADMIN', moderator: 'MOD' };
  const rolesByName = new Map();

  function normalizeRole(value) {
    const role = String(value || '').toLowerCase();
    return ROLE_LABELS[role] ? role : '';
  }

  function rememberRole(source) {
    if (!source) return;
    const role = normalizeRole(source.role);
    // 'player' must be recorded too, so a demotion clears an old badge.
    const known = String(source.role || '').toLowerCase();
    if (!known) return;
    if (source.name) rolesByName.set(String(source.name).toLowerCase(), role);
  }

  function roleForMessage(article) {
    // Consecutive messages from one sender are grouped and drop the author
    // line, so walk back to the message that still carries the name.
    let source = article;
    while (source && !source.querySelector('.chat-author')) {
      source = source.classList.contains('is-grouped') ? source.previousElementSibling : null;
      if (source && !source.classList.contains('chat-message')) source = null;
    }
    const name = source?.querySelector('.chat-author')?.textContent?.trim().toLowerCase();
    return name ? (rolesByName.get(name) || '') : '';
  }

  function badgeFor(role) {
    const badge = document.createElement('span');
    badge.className = `chat-badge chat-role-badge is-${role}`;
    badge.textContent = ROLE_LABELS[role];
    badge.title = role === 'admin' ? 'Server administrator' : 'Moderator';
    badge.dataset.ridgewoodRoleBadge = 'true';
    return badge;
  }

  function decorateMessage(article) {
    if (article.classList.contains('is-system')) return;
    const role = roleForMessage(article);
    if (article.dataset.senderRole === role || (!role && !article.dataset.senderRole)) return;

    for (const stale of article.querySelectorAll('[data-ridgewood-role-badge]')) stale.remove();
    if (!role) {
      delete article.dataset.senderRole;
      return;
    }
    article.dataset.senderRole = role;
    // Grouped messages have no author line; the rail alone marks those.
    article.querySelector('.chat-message-meta')?.append(badgeFor(role));
  }

  function decorateMember(row) {
    const name = row.querySelector('.player-details strong');
    if (!name) return;
    // Read the original text node rather than textContent: the badge is
    // appended into this same element, so textContent would include the badge
    // on the next pass, the name would stop matching, and the badge would
    // delete itself. The chat client writes the name as a single text node.
    const raw = name.firstChild?.textContent ?? name.textContent ?? '';
    const key = raw.replace(/\s*\(you\)\s*$/, '').trim().toLowerCase();
    const role = key ? (rolesByName.get(key) || '') : '';
    if (row.dataset.memberRole === role) return;

    for (const stale of row.querySelectorAll('[data-ridgewood-role-badge]')) stale.remove();
    if (!role) {
      delete row.dataset.memberRole;
      return;
    }
    row.dataset.memberRole = role;
    name.append(badgeFor(role)); // spacing comes from the stylesheet
  }

  let decorateQueued = false;

  function decorateAll() {
    decorateQueued = false;
    for (const article of document.querySelectorAll('.chat-message')) decorateMessage(article);
    for (const row of document.querySelectorAll('.chat-player')) decorateMember(row);
  }

  function queueDecorate() {
    if (decorateQueued) return;
    decorateQueued = true;
    requestAnimationFrame(decorateAll);
  }

  function watchChat() {
    const list = document.querySelector('#chat-message-list');
    const members = document.querySelector('#chat-player-list');
    if (!list && !members) return false;
    const observer = new MutationObserver(queueDecorate);
    if (list) observer.observe(list, { childList: true, subtree: true });
    if (members) observer.observe(members, { childList: true, subtree: true });
    queueDecorate();
    return true;
  }

  if (!watchChat()) {
    document.addEventListener('DOMContentLoaded', watchChat, { once: true });
  }

  window.addEventListener('voxel:network-message', event => {
    const message = event.detail;
    if (!message || typeof message !== 'object') return;

    if (message.type === 'chat:message') rememberRole(message.sender);
    else if (message.type === 'chat:history') {
      for (const item of message.messages || []) rememberRole(item.sender);
      for (const user of message.users || []) rememberRole(user);
    } else if (message.type === 'chat:users') {
      for (const user of message.users || []) rememberRole(user);
    } else if (message.type === 'welcome') {
      rememberRole({ id: message.id, name: message.name, role: message.role });
      for (const player of message.players || []) rememberRole(player);
    } else if (message.type === 'joined') rememberRole(message.player);
    else if (message.type === 'admin:role') {
      rememberRole({ id: message.id, role: message.role });
    } else return;

    queueDecorate();
  });

  window.addEventListener('voxel:network-offline', () => {
    powers.verticalInput = 0;
    setStatus('Disconnected from the world server.', 'error');
  });
})();
