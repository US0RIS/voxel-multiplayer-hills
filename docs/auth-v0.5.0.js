/* Ridgewood unified authentication, v0.7.0. */
(() => {
  'use strict';

  const TOKEN_KEY = 'ridgewood.session_token';
  const USER_KEY = 'ridgewood.auth_user';
  const AUTH_SERVER = String(window.VOXEL_CONFIG?.AUTH_SERVER_URL || 'https://voxel-multiplayer-hills-410-server.onrender.com').replace(/\/$/, '');
  const loginButton = document.querySelector('#home-login');
  const identity = document.querySelector('#home-identity');
  const identityName = document.querySelector('#home-username');
  const avatar = document.querySelector('#home-avatar');
  const logoutButton = document.querySelector('#home-logout');
  let gameStarted = false;
  let authModal = null;

  const discordLoginUrl = () => `${AUTH_SERVER}/auth/discord`;
  const DISCORD_MARK = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.32 4.9A19.4 19.4 0 0 0 15.5 3.4a13.6 13.6 0 0 0-.62 1.27 17.9 17.9 0 0 0-5.37 0A13.3 13.3 0 0 0 8.88 3.4 19.3 19.3 0 0 0 4.06 4.9C1.01 9.46.18 13.9.6 18.29a19.5 19.5 0 0 0 5.92 3 14.5 14.5 0 0 0 1.27-2.06 12.7 12.7 0 0 1-2-.96c.17-.12.33-.25.49-.38a13.9 13.9 0 0 0 11.87 0c.16.14.32.26.49.38-.64.38-1.31.7-2 .96a14.3 14.3 0 0 0 1.27 2.06 19.4 19.4 0 0 0 5.92-3c.5-5.09-.84-9.49-3.5-13.39ZM8.35 15.6c-1.18 0-2.15-1.08-2.15-2.4s.95-2.42 2.15-2.42 2.17 1.09 2.15 2.42c0 1.32-.95 2.4-2.15 2.4Zm7.3 0c-1.18 0-2.15-1.08-2.15-2.4s.95-2.42 2.15-2.42 2.17 1.09 2.15 2.42c0 1.32-.95 2.4-2.15 2.4Z"/></svg>`;
  const USER_MARK = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="8" y="3" width="8" height="8"/><rect x="5" y="13" width="14" height="8"/><rect x="3" y="16" width="3" height="5"/><rect x="18" y="16" width="3" height="5"/></svg>`;

  function ensureStyles() {
    if (document.querySelector('link[data-ridgewood-login]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'login-v0.7.0.css?v=0.7.0';
    link.dataset.ridgewoodLogin = 'true';
    document.head.append(link);
  }

  function slab(label, className, icon = '', type = 'button') {
    return `<button type="${type}" class="rw-slab ${className}"><span class="rw-face">${icon ? `<span class="rw-auth-icon">${icon}</span>` : ''}<span>${label}</span></span></button>`;
  }

  function errorMessage(code, status) {
    const messages = {
      invalid_username: 'Use 3–24 letters, numbers, periods, underscores, or hyphens.',
      password_too_short: 'Password must be at least 10 characters.',
      password_too_long: 'Password is too long.',
      username_taken: 'That username is already taken.',
      invalid_credentials: 'Incorrect username or password.',
      account_temporarily_locked: 'This account is temporarily locked after repeated failed attempts.',
      too_many_attempts: 'Too many login attempts. Try again later.',
      account_banned: 'This account is banned.',
      registration_unavailable: 'Account creation is temporarily unavailable.',
      login_unavailable: 'Username login is temporarily unavailable.'
    };
    return messages[code] || (status >= 500 ? 'The login server is temporarily unavailable.' : 'Login failed.');
  }

  function createModal() {
    if (authModal) return authModal;
    const modal = document.createElement('section');
    modal.id = 'rw-auth-modal';
    modal.hidden = true;
    modal.setAttribute('aria-label', 'Log in');
    modal.innerHTML = `<div class="rw-auth-backdrop" data-close></div><div class="rw-auth-card" role="dialog" aria-modal="true" aria-labelledby="rw-auth-title"><div class="rw-auth-head"><div><h2 id="rw-auth-title">Log in</h2><p id="rw-auth-subtitle">Choose how you want to enter Ridgewood.</p></div><button class="rw-auth-close" type="button" aria-label="Close" data-close>×</button></div><div class="rw-auth-options">${slab('Continue with Discord','rw-auth-option rw-auth-option--discord',DISCORD_MARK)}${slab('Username & password','rw-auth-option rw-auth-option--password',USER_MARK)}</div><form class="rw-auth-form" hidden autocomplete="on"><div class="rw-auth-field"><label for="rw-auth-username">Username</label><input id="rw-auth-username" name="username" type="text" minlength="3" maxlength="24" pattern="[A-Za-z0-9_.-]+" autocomplete="username" required /></div><div class="rw-auth-field"><label for="rw-auth-password">Password</label><input id="rw-auth-password" name="password" type="password" minlength="10" maxlength="256" autocomplete="current-password" required /></div><div class="rw-auth-field rw-auth-confirm" hidden><label for="rw-auth-password-confirm">Confirm password</label><input id="rw-auth-password-confirm" name="passwordConfirm" type="password" minlength="10" maxlength="256" autocomplete="new-password" /></div><p class="rw-auth-error" role="alert" aria-live="polite"></p>${slab('Log in','rw-auth-submit','', 'submit')}<div class="rw-auth-row"><button type="button" class="rw-auth-link rw-auth-back">← Other login methods</button><button type="button" class="rw-auth-link rw-auth-switch">Create an account</button></div><p class="rw-auth-note">Usernames may contain letters, numbers, periods, underscores, and hyphens. Passwords must be at least 10 characters.</p></form></div>`;
    document.body.append(modal);

    const options = modal.querySelector('.rw-auth-options');
    const form = modal.querySelector('.rw-auth-form');
    const title = modal.querySelector('#rw-auth-title');
    const subtitle = modal.querySelector('#rw-auth-subtitle');
    const confirmField = modal.querySelector('.rw-auth-confirm');
    const confirmInput = modal.querySelector('#rw-auth-password-confirm');
    const passwordInput = modal.querySelector('#rw-auth-password');
    const submit = modal.querySelector('.rw-auth-submit');
    const submitLabel = submit.querySelector('.rw-face span:last-child');
    const switchButton = modal.querySelector('.rw-auth-switch');
    const error = modal.querySelector('.rw-auth-error');
    let mode = 'login';

    const setMode = next => {
      mode = next;
      const register = mode === 'register';
      title.textContent = register ? 'Create account' : 'Log in';
      subtitle.textContent = register ? 'Choose a username and password for Ridgewood.' : 'Enter your Ridgewood username and password.';
      confirmField.hidden = !register;
      confirmInput.required = register;
      passwordInput.autocomplete = register ? 'new-password' : 'current-password';
      submitLabel.textContent = register ? 'Create account' : 'Log in';
      switchButton.textContent = register ? 'I already have an account' : 'Create an account';
      error.textContent = '';
    };
    const showOptions = () => {
      form.hidden = true;
      options.hidden = false;
      title.textContent = 'Log in';
      subtitle.textContent = 'Choose how you want to enter Ridgewood.';
      error.textContent = '';
    };
    const showPassword = () => {
      options.hidden = true;
      form.hidden = false;
      setMode('login');
      requestAnimationFrame(() => modal.querySelector('#rw-auth-username').focus());
    };

    modal.querySelector('.rw-auth-option--discord').addEventListener('click', () => { location.href = discordLoginUrl(); });
    modal.querySelector('.rw-auth-option--password').addEventListener('click', showPassword);
    modal.querySelector('.rw-auth-back').addEventListener('click', showOptions);
    switchButton.addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));
    for (const close of modal.querySelectorAll('[data-close]')) close.addEventListener('click', closeLogin);
    modal.addEventListener('keydown', event => { if (event.key === 'Escape') closeLogin(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      error.textContent = '';
      const username = String(form.elements.username.value || '').trim();
      const password = String(form.elements.password.value || '');
      if (mode === 'register' && password !== String(form.elements.passwordConfirm.value || '')) {
        error.textContent = 'Passwords do not match.';
        return;
      }
      submit.disabled = true;
      try {
        const response = await fetch(`${AUTH_SERVER}/auth/password/${mode}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
          cache: 'no-store', credentials: 'omit'
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.token || !payload.user) throw new Error(errorMessage(payload.error, response.status));
        localStorage.setItem(TOKEN_KEY, payload.token);
        localStorage.setItem(USER_KEY, JSON.stringify(payload.user));
        location.reload();
      } catch (failure) {
        error.textContent = failure instanceof Error ? failure.message : 'Login failed.';
      } finally {
        submit.disabled = false;
      }
    });
    modal._showOptions = showOptions;
    authModal = modal;
    return modal;
  }

  function openLogin() {
    ensureStyles();
    const modal = createModal();
    modal._showOptions();
    modal.hidden = false;
    document.documentElement.dataset.authModal = 'open';
    setTimeout(() => modal.querySelector('.rw-auth-option--discord')?.focus(), 0);
  }
  function closeLogin() {
    if (!authModal) return;
    authModal.hidden = true;
    delete document.documentElement.dataset.authModal;
  }
  function relabelLoginControls() {
    for (const trigger of document.querySelectorAll('a[href$="/auth/discord"], #home-login, [data-login-chooser]')) {
      trigger.setAttribute('href', '#login');
      trigger.dataset.loginChooser = 'true';
      const text = trigger.querySelector('.rw-face span:last-child') || trigger.querySelector('span:last-child');
      if (text) text.textContent = 'Log in';
    }
    const sub = document.querySelector('.rw-lock-sub');
    if (sub) sub.textContent = 'Log in to use world chat.';
  }

  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-login-chooser], a[href="#login"], #home-login');
    if (!trigger) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openLogin();
  }, true);

  function readFragment() {
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
    const token = fragment.get('auth_token');
    const username = fragment.get('username');
    const provider = fragment.get('provider') || 'discord';
    const error = fragment.get('auth_error');
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
      if (username) localStorage.setItem(USER_KEY, JSON.stringify({ username, provider }));
    }
    if (token || error) history.replaceState(null, '', location.pathname + location.search);
    return { token, error };
  }
  async function validateSession(token) {
    const response = await fetch(`${AUTH_SERVER}/auth/me?token=${encodeURIComponent(token)}`, { cache: 'no-store', credentials: 'omit' });
    if (response.status === 403) {
      // The account is banned. Say so plainly instead of bouncing the player
      // back to a login screen that will keep refusing them.
      const payload = await response.json().catch(() => ({}));
      const until = payload?.ban?.permanent
        ? 'This ban does not expire.'
        : payload?.ban?.until
          ? `The ban lifts on ${new Date(payload.ban.until).toLocaleString()}.`
          : '';
      const reason = payload?.ban?.reason ? `Reason: ${payload.ban.reason}. ` : '';
      const detail = `This account is banned. ${reason}${until}`.trim();
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      showSignedOut();
      window.RIDGEWOOD_HOME?.setStatus('offline', detail);
      return { banned: true, detail };
    }
    if (!response.ok) return null;
    const payload = await response.json();
    return payload?.authenticated ? payload.user : null;
  }
  // Installed immediately at load, not after /auth/me resolves.
  //
  // The home screen's "Public Server" button calls RIDGEWOOD_AUTH_API.startGame()
  // directly. If it was clicked before the /auth/me round trip finished — very
  // easy on a cold server — the game opened its socket before this wrapper
  // existed, so no token was ever sent and the player connected as an anonymous
  // guest with no role. The token is also read per connection rather than
  // captured once, so a socket opened before login, or reconnected after it,
  // always carries the current token.
  function installAuthenticatedWebSocket() {
    if (window.__RIDGEWOOD_AUTH_SOCKET_INSTALLED__) return;
    const Native = window.WebSocket;
    function Wrapped(url, protocols) {
      const token = localStorage.getItem(TOKEN_KEY) || '';
      const next = new URL(String(url), location.href);
      if (token && next.host === new URL(AUTH_SERVER).host && !next.searchParams.has('token')) {
        next.searchParams.set('token', token);
      }
      return protocols === undefined ? new Native(next.toString()) : new Native(next.toString(), protocols);
    }
    Wrapped.prototype = Native.prototype;
    Object.defineProperties(Wrapped, { CONNECTING:{value:Native.CONNECTING}, OPEN:{value:Native.OPEN}, CLOSING:{value:Native.CLOSING}, CLOSED:{value:Native.CLOSED} });
    window.WebSocket = Wrapped;
    window.__RIDGEWOOD_AUTH_SOCKET_INSTALLED__ = true;
  }
  function startGameModule() {
    if (gameStarted) return;
    gameStarted = true;
    const script = document.createElement('script');
    script.type = 'module';
    script.src = 'game-loader-v0.8.0.js?v=0.8.1';
    script.onerror = () => { gameStarted = false; window.RIDGEWOOD_HOME?.setStatus('offline', 'Game module failed to load'); };
    document.body.append(script);
  }
  function showSignedIn(user) {
    const name = user?.username || user?.displayName || user?.name || 'Adventurer';
    if (identityName) identityName.textContent = name;
    const url = user?.avatar_url || user?.avatarUrl || '';
    if (avatar) {
      if (url) { avatar.src = url; avatar.alt = `${name}'s avatar`; }
      else { avatar.removeAttribute('src'); avatar.alt = ''; }
    }
    loginButton?.setAttribute('hidden','');
    identity?.removeAttribute('hidden');
    document.documentElement.dataset.authenticated = 'true';
    window.RIDGEWOOD_HOME?.setAuthenticated(true);
  }
  function showSignedOut() {
    loginButton?.removeAttribute('hidden');
    identity?.setAttribute('hidden','');
    document.documentElement.dataset.authenticated = 'false';
    window.RIDGEWOOD_HOME?.setAuthenticated(false);
    relabelLoginControls();
  }
  function activate(user) {
    const token = localStorage.getItem(TOKEN_KEY) || '';
    installAuthenticatedWebSocket();
    window.RIDGEWOOD_AUTH = Object.freeze({ token, user, serverUrl: AUTH_SERVER });
    window.dispatchEvent(new CustomEvent('ridgewood:auth-ready', { detail: window.RIDGEWOOD_AUTH }));
    showSignedIn(user);
    startGameModule();
  }
  async function checkServer() {
    try {
      const response = await fetch(`${AUTH_SERVER}/health`, { cache:'no-store' });
      if (!response.ok) throw new Error();
      const payload = await response.json().catch(() => ({}));
      window.RIDGEWOOD_HOME?.setStatus('online', `Ridgewood Main online${payload.version ? ` · v${payload.version}` : ''}`);
    } catch { window.RIDGEWOOD_HOME?.setStatus('offline','Server unreachable'); }
  }
  async function initialize() {
    ensureStyles();
    relabelLoginControls();
    const callback = readFragment();
    if (callback.error) {
      localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY);
      showSignedOut();
      window.RIDGEWOOD_HOME?.setStatus('offline', `Sign-in failed: ${callback.error.replaceAll('_',' ')}`);
      return;
    }
    const token = callback.token || localStorage.getItem(TOKEN_KEY) || '';
    if (!token) { showSignedOut(); checkServer(); return; }
    try {
      const user = await validateSession(token);
      if (user?.banned) return;
      if (!user) {
        localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY);
        showSignedOut(); checkServer(); return;
      }
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      activate(user);
      checkServer();
    } catch {
      showSignedOut();
      window.RIDGEWOOD_HOME?.setStatus('offline','Could not reach the login server');
    }
  }

  // Before initialize(), before any click handler, before the game module can
  // exist. This is the whole point: nothing may open a socket first.
  installAuthenticatedWebSocket();

  logoutButton?.addEventListener('click', () => window.RIDGEWOOD_AUTH_API.logout());
  window.RIDGEWOOD_AUTH_API = Object.freeze({
    loginUrl: discordLoginUrl, openLogin, startGame: startGameModule,
    isAuthenticated: () => document.documentElement.dataset.authenticated === 'true',
    getToken: () => localStorage.getItem(TOKEN_KEY) || '',
    getUser() { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; } },
    async logout() {
      const token = localStorage.getItem(TOKEN_KEY) || '';
      try { if (token) await fetch(`${AUTH_SERVER}/auth/logout?token=${encodeURIComponent(token)}`, { method:'POST', cache:'no-store' }); }
      finally { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(USER_KEY); location.reload(); }
    }
  });
  initialize();
})();
