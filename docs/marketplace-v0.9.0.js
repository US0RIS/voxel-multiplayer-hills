/* Ridgewood v0.9.0 — coin HUD and marketplace client. */
(() => {
  'use strict';

  const state = {
    coins: 0,
    userId: '',
    stalls: [],
    inventory: [],
    activeStallNumber: null,
    connected: false,
    requests: new Map()
  };

  const $ = selector => document.querySelector(selector);
  const formatCoins = value => new Intl.NumberFormat().format(Number(value) || 0);
  const requestId = () => crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  function installStyles() {
    if (document.querySelector('link[data-ridgewood-marketplace]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'marketplace-v0.9.0.css?v=0.9.0';
    link.dataset.ridgewoodMarketplace = 'true';
    document.head.append(link);
  }

  function send(type, payload = {}) {
    const id = requestId();
    const ok = window.VOXEL_GAME_API?.send?.({ type, requestId: id, ...payload });
    if (ok) state.requests.set(id, { type, at: Date.now() });
    return ok;
  }

  function ensureHud() {
    let hud = $('#rw-economy-hud');
    if (hud) return hud;
    hud = document.createElement('section');
    hud.id = 'rw-economy-hud';
    hud.hidden = true;
    hud.setAttribute('aria-label', 'Coin balance and marketplace');
    hud.innerHTML = '<span class="rw-coin-mark" aria-hidden="true">◆</span>' +
      '<span><span id="rw-coin-balance">0</span> coins</span>' +
      '<button id="rw-market-button" type="button" title="Teleport to marketplace (M)">Marketplace <kbd>M</kbd></button>';
    document.body.append(hud);
    hud.querySelector('#rw-market-button').addEventListener('click', teleportToMarketplace);
    return hud;
  }

  function ensureToasts() {
    let host = $('#rw-market-toasts');
    if (!host) {
      host = document.createElement('section');
      host.id = 'rw-market-toasts';
      host.setAttribute('aria-live', 'polite');
      document.body.append(host);
    }
    return host;
  }

  function toast(message, stateName = '') {
    const item = document.createElement('div');
    item.className = 'rw-market-toast';
    if (stateName) item.dataset.state = stateName;
    item.textContent = message;
    ensureToasts().append(item);
    setTimeout(() => item.remove(), 4200);
  }

  function setBalance(coins) {
    state.coins = Math.max(0, Number(coins) || 0);
    const node = $('#rw-coin-balance');
    if (node) node.textContent = formatCoins(state.coins);
    const balance = $('#rw-market-panel-balance');
    if (balance) balance.textContent = `${formatCoins(state.coins)} coins available`;
  }

  function stallNumber(stall) {
    return Number(stall?.stall_number ?? stall?.stallNumber);
  }

  function stallByNumber(number) {
    return state.stalls.find(stall => stallNumber(stall) === Number(number)) || null;
  }

  function normalizeStalls(stalls) {
    return Array.isArray(stalls) ? stalls.map(stall => ({
      ...stall,
      stall_number: stallNumber(stall),
      listings: Array.isArray(stall.listings) ? stall.listings : []
    })).sort((a, b) => a.stall_number - b.stall_number) : [];
  }

  function receiveStalls(stalls) {
    state.stalls = normalizeStalls(stalls);
    window.VOXEL_GAME_API?.refreshMarketplaceHub?.();
    if (state.activeStallNumber !== null && !$('#rw-marketplace-panel')?.hidden) {
      openStall(state.activeStallNumber);
    }
  }

  function teleportToMarketplace() {
    const api = window.VOXEL_GAME_API;
    if (!api?.teleport) {
      toast('The game is still loading.', 'error');
      return false;
    }
    api.teleport(8.5, -1.5);
    toast('Teleported to the Ridgewood marketplace. Click a stall to browse it.');
    return true;
  }

  function closePanel() {
    const panel = $('#rw-marketplace-panel');
    if (panel) panel.hidden = true;
    state.activeStallNumber = null;
    delete document.documentElement.dataset.marketplaceOpen;
    window.VOXEL_GAME_API?.focusCanvas?.();
  }

  function button(label, className = 'rw-market-button') {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = className;
    node.textContent = label;
    return node;
  }

  function ensurePanel() {
    let panel = $('#rw-marketplace-panel');
    if (panel) return panel;
    panel = document.createElement('section');
    panel.id = 'rw-marketplace-panel';
    panel.hidden = true;
    panel.innerHTML = '<div class="rw-market-card" role="dialog" aria-modal="true" aria-labelledby="rw-market-title">' +
      '<header class="rw-market-head"><div><h2 id="rw-market-title">Marketplace Stall</h2><p id="rw-market-subtitle"></p></div><button class="rw-market-close" type="button" aria-label="Close">×</button></header>' +
      '<div class="rw-market-balance" id="rw-market-panel-balance"></div>' +
      '<div class="rw-market-list" id="rw-market-list"></div>' +
      '<div class="rw-market-actions" id="rw-market-actions"></div>' +
      '</div>';
    document.body.append(panel);
    panel.addEventListener('pointerdown', event => {
      if (event.target === panel) closePanel();
    });
    panel.querySelector('.rw-market-close').addEventListener('click', closePanel);
    return panel;
  }

  function ownerName(stall) {
    return stall?.owner?.name || (stall?.claimed ? 'Another player' : 'Unclaimed');
  }

  function ownStall(stall) {
    return Boolean(stall?.owner_id && String(stall.owner_id) === String(state.userId));
  }

  function itemRow(stall, listing) {
    const row = document.createElement('article');
    row.className = 'rw-market-item';
    const copy = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = listing.item_name || 'Unnamed item';
    const meta = document.createElement('span');
    meta.className = 'rw-market-meta';
    meta.textContent = `${listing.item_type || 'item'} · ${listing.quantity || 1} available`;
    copy.append(name, meta);
    const controls = document.createElement('div');
    const price = document.createElement('div');
    price.className = 'rw-market-price';
    price.textContent = `${formatCoins(listing.price)} coins`;
    controls.append(price);
    if (ownStall(stall)) {
      const remove = button('Delist', 'rw-market-danger');
      remove.addEventListener('click', () => send('marketplace:delist', { listing_id: listing.id }));
      controls.append(remove);
    } else {
      const buy = button('Buy');
      buy.disabled = state.coins < Number(listing.price || 0);
      buy.addEventListener('click', () => {
        const confirmed = confirm(`Pay ${formatCoins(listing.price)} coins for ${listing.item_name}?`);
        if (confirmed) send('marketplace:buy', { listing_id: listing.id });
      });
      controls.append(buy);
    }
    row.append(copy, controls);
    return row;
  }

  function openStall(number) {
    const stall = stallByNumber(number);
    if (!stall) {
      send('marketplace:stalls');
      toast('Loading marketplace stall…');
      return;
    }
    state.activeStallNumber = Number(number);
    const panel = ensurePanel();
    panel.hidden = false;
    document.documentElement.dataset.marketplaceOpen = 'true';
    panel.querySelector('#rw-market-title').textContent = stall.name || `Stall ${number}`;
    panel.querySelector('#rw-market-subtitle').textContent = stall.claimed
      ? `Stall ${number} · owned by ${ownerName(stall)}`
      : `Stall ${number} · available to claim`;
    setBalance(state.coins);

    const list = panel.querySelector('#rw-market-list');
    list.replaceChildren();
    if (!stall.listings.length) {
      const empty = document.createElement('div');
      empty.className = 'rw-market-empty';
      empty.textContent = stall.claimed ? 'This stall has no listings yet.' : 'Claim this stall to start selling items.';
      list.append(empty);
    } else {
      for (const listing of stall.listings) list.append(itemRow(stall, listing));
    }

    const actions = panel.querySelector('#rw-market-actions');
    actions.replaceChildren();
    if (!stall.claimed) {
      const claim = button('Claim this stall');
      claim.addEventListener('click', () => {
        const name = prompt('Name your stall:', `Stall ${number}`);
        if (name !== null) send('marketplace:claim', { stall_number: number, name: name.trim() || `Stall ${number}` });
      });
      actions.append(claim);
    } else if (ownStall(stall)) {
      const add = button('List New Item');
      add.addEventListener('click', () => openListDialog(stall));
      const rename = button('Rename Stall');
      rename.addEventListener('click', () => {
        const name = prompt('New stall name:', stall.name || '');
        if (name?.trim()) send('marketplace:rename', { name: name.trim() });
      });
      const release = button('Unclaim Stall', 'rw-market-danger');
      release.addEventListener('click', () => {
        if (confirm('Unclaim this stall? All current listings will be removed.')) send('marketplace:unclaim');
      });
      actions.append(add, rename, release);
    }
  }

  function ensureDialog() {
    let dialog = $('#rw-marketplace-dialog');
    if (dialog) return dialog;
    dialog = document.createElement('section');
    dialog.id = 'rw-marketplace-dialog';
    dialog.hidden = true;
    dialog.innerHTML = '<div class="rw-market-card" role="dialog" aria-modal="true" aria-labelledby="rw-list-title">' +
      '<header class="rw-market-head"><div><h2 id="rw-list-title">List New Item</h2><p>Create a marketplace listing.</p></div><button class="rw-market-close" type="button" aria-label="Close">×</button></header>' +
      '<form class="rw-market-form">' +
      '<label>Item type<select name="itemType"><option value="cosmetic">Cosmetic</option><option value="house">House</option><option value="resource">Resource</option><option value="service">Service</option><option value="other">Other</option></select></label>' +
      '<label>Item name<input name="itemName" maxlength="80" required /></label>' +
      '<label>Price in coins<input name="price" type="number" min="1" max="1000000000" required /></label>' +
      '<label>Quantity<input name="quantity" type="number" min="1" max="999" value="1" required /></label>' +
      '<p class="rw-market-error" role="alert"></p>' +
      '<button class="rw-market-button" type="submit">Create Listing</button>' +
      '</form></div>';
    document.body.append(dialog);
    dialog.querySelector('.rw-market-close').addEventListener('click', () => { dialog.hidden = true; });
    dialog.addEventListener('pointerdown', event => { if (event.target === dialog) dialog.hidden = true; });
    dialog.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      const stall = stallByNumber(state.activeStallNumber);
      if (!stall) return;
      const form = event.currentTarget;
      const payload = {
        stall_id: stall.id,
        item_type: form.elements.itemType.value,
        item_name: form.elements.itemName.value.trim(),
        price: Number(form.elements.price.value),
        quantity: Number(form.elements.quantity.value)
      };
      if (!payload.item_name || payload.price < 1 || payload.quantity < 1) {
        form.querySelector('.rw-market-error').textContent = 'Enter a valid name, price, and quantity.';
        return;
      }
      send('marketplace:list-item', payload);
      dialog.hidden = true;
      form.reset();
      form.elements.quantity.value = '1';
    });
    return dialog;
  }

  function openListDialog() {
    const dialog = ensureDialog();
    dialog.hidden = false;
    requestAnimationFrame(() => dialog.querySelector('input[name="itemName"]')?.focus());
  }

  const errors = {
    insufficient_coins: 'You do not have enough coins.',
    stall_claimed: 'That stall has already been claimed.',
    already_has_stall: 'You already own a marketplace stall.',
    not_stall_owner: 'Only the stall owner can do that.',
    not_listing_owner: 'Only the listing owner can do that.',
    cannot_buy_own_listing: 'You cannot buy your own listing.',
    listing_unavailable: 'That listing is no longer available.',
    listing_limit: 'This stall has reached its listing limit.',
    economy_unavailable: 'The marketplace is temporarily unavailable.'
  };

  function handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'welcome') {
      state.userId = String(message.auth?.user_id || '');
      state.connected = true;
      if (message.economy) setBalance(message.economy.coins);
      ensureHud().hidden = false;
      send('marketplace:stalls');
      send('marketplace:inventory');
    }
    if (message.type === 'coins:balance') setBalance(message.coins);
    if (message.type === 'marketplace:stalls') receiveStalls(message.stalls);
    if (message.type === 'marketplace:inventory') state.inventory = Array.isArray(message.inventory) ? message.inventory : [];
    if (message.type === 'marketplace:updated') send('marketplace:stalls');
    if (message.type === 'marketplace:purchased') {
      toast(`Purchased ${message.item?.name || 'item'} from ${message.stallName || 'the marketplace'}.`);
      send('marketplace:inventory');
    }
    if (message.type === 'marketplace:sold') toast(`Sold ${message.item?.name || 'an item'}.`);
    if (message.type === 'economy:result') {
      state.requests.delete(message.requestId);
      if (!message.ok) {
        toast(errors[message.error] || message.message || 'Marketplace action failed.', 'error');
        return;
      }
      if (message.action === 'marketplace:claim') toast('Stall claimed.');
      if (message.action === 'marketplace:unclaim') toast('Stall released.');
      if (message.action === 'marketplace:list-item') toast('Item listed for sale.');
      if (message.action === 'marketplace:delist') toast('Listing removed.');
      if (message.action === 'marketplace:rename') toast('Stall renamed.');
      send('marketplace:stalls');
      send('coins:balance');
    }
  }

  function interceptMarketplaceCommand(event) {
    const input = event.target;
    if (!(input instanceof HTMLTextAreaElement) || input.id !== 'chat-input') return;
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    if (!/^\/marketplace(?:\s|$)/i.test(input.value.trim())) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    teleportToMarketplace();
  }

  function installInput() {
    document.addEventListener('keydown', interceptMarketplaceCommand, true);
    window.addEventListener('keydown', event => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable || window.__voxelChatTyping || window.__ridgewoodMenuOpen) return;
      if (event.code === 'KeyM') {
        event.preventDefault();
        teleportToMarketplace();
      }
      if (event.key === 'Escape' && document.documentElement.dataset.marketplaceOpen === 'true') closePanel();
    }, { passive: false });

    const attachCanvasHandler = () => {
      const canvas = $('#canvas');
      if (!canvas || canvas.dataset.marketplaceClick === 'true') return;
      canvas.dataset.marketplaceClick = 'true';
      canvas.addEventListener('click', event => {
        const hover = window.VOXEL_GAME_API?.getMarketplaceHover?.();
        if (!hover?.stallNumber || window.__ridgewoodMenuOpen) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openStall(hover.stallNumber);
      }, true);
    };
    attachCanvasHandler();
    window.addEventListener('voxel:bridge-ready', attachCanvasHandler);
  }

  function addCommandToHistory(message) {
    if (message.type !== 'chat:history' || !Array.isArray(message.commands)) return;
    if (!message.commands.some(item => String(item.command || '').startsWith('/marketplace'))) {
      message.commands.push({ command: '/marketplace', description: 'teleport to the public marketplace' });
    }
  }

  installStyles();
  ensureHud();
  ensureToasts();
  installInput();
  window.addEventListener('voxel:network-message', event => {
    addCommandToHistory(event.detail || {});
    handleMessage(event.detail || {});
  }, true);
  window.addEventListener('voxel:network-offline', () => { state.connected = false; });

  window.RIDGEWOOD_MARKETPLACE = Object.freeze({
    getStalls: () => state.stalls.map(stall => ({ ...stall, listings: [...stall.listings] })),
    getCoins: () => state.coins,
    getInventory: () => [...state.inventory],
    openStall,
    teleport: teleportToMarketplace,
    refresh() { send('marketplace:stalls'); send('coins:balance'); }
  });
})();
