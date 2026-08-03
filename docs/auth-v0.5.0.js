/* Ridgewood — Discord authentication, v0.5.0
 *
 * Replaces the v0.4.2 full-screen sign-in gate. Same session handling, same
 * token storage, same authenticated-WebSocket wrapper — the difference is
 * purely where it surfaces: sign-in is now a control on the home screen, and
 * signing in is no longer a hard gate on loading the game module.
 *
 * Auth state drives two things:
 *   · the identity chip in the home header
 *   · whether world chat is unlocked (see home-v0.5.0.js)
 *
 * The game module is started by the home screen when the player picks a
 * server, or eagerly for signed-in players so that world chat is already live
 * on the home screen — chat has no socket of its own, it rides the renderer's.
 */
(() => {
  'use strict';

  const TOKEN_KEY = 'ridgewood.session_token';
  const USER_KEY = 'ridgewood.auth_user';
  const AUTH_SERVER = String(
    window.VOXEL_CONFIG?.AUTH_SERVER_URL ||
    'https://voxel-multiplayer-hills-410-server.onrender.com'
  ).replace(/\/$/, '');

  const loginButton = document.querySelector('#home-login');
  const identity = document.querySelector('#home-identity');
  const identityName = document.querySelector('#home-username');
  const avatar = document.querySelector('#home-avatar');
  const logoutButton = document.querySelector('#home-logout');

  let gameStarted = false;

  const loginUrl = () => `${AUTH_SERVER}/auth/discord`;

  for (const anchor of document.querySelectorAll('a[href$="/auth/discord"]')) {
    anchor.href = loginUrl();
  }

  /* --------------------------------------------------------------- session */

  function readCallbackFragment() {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const token = fragment.get('auth_token');
    const username = fragment.get('username');
    const error = fragment.get('auth_error');

    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
      if (username) {
        localStorage.setItem(USER_KEY, JSON.stringify({ username, provider: 'discord' }));
      }
    }

    if (token || error) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    return { token, username, error };
  }

  async function validateSession(token) {
    if (!token) return null;
    const response = await fetch(`${AUTH_SERVER}/auth/me?token=${encodeURIComponent(token)}`, {
      cache: 'no-store',
      credentials: 'omit'
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload?.authenticated ? payload.user : null;
  }

  /* Unchanged from v0.4.2: the renderer opens its own socket, so the session
   * is carried by wrapping WebSocket before the game module ever loads. */
  function installAuthenticatedWebSocket(token) {
    if (window.__RIDGEWOOD_AUTH_SOCKET_INSTALLED__ || !token) return;
    const NativeWebSocket = window.WebSocket;

    function AuthenticatedWebSocket(url, protocols) {
      const next = new URL(String(url), window.location.href);
      const serverHost = new URL(AUTH_SERVER).host;
      if (next.host === serverHost && !next.searchParams.has('token')) {
        next.searchParams.set('token', token);
      }
      return protocols === undefined
        ? new NativeWebSocket(next.toString())
        : new NativeWebSocket(next.toString(), protocols);
    }

    AuthenticatedWebSocket.prototype = NativeWebSocket.prototype;
    Object.defineProperties(AuthenticatedWebSocket, {
      CONNECTING: { value: NativeWebSocket.CONNECTING },
      OPEN: { value: NativeWebSocket.OPEN },
      CLOSING: { value: NativeWebSocket.CLOSING },
      CLOSED: { value: NativeWebSocket.CLOSED }
    });

    window.WebSocket = AuthenticatedWebSocket;
    window.__RIDGEWOOD_AUTH_SOCKET_INSTALLED__ = true;
  }

  function startGameModule() {
    if (gameStarted) return;
    gameStarted = true;
    const script = document.createElement('script');
    script.type = 'module';
    script.src = 'game-loader-v4.3.0.js?v=0.5.0';
    script.onerror = () => {
      gameStarted = false;
      window.RIDGEWOOD_HOME?.setStatus('offline', 'Game module failed to load');
    };
    document.body.append(script);
  }

  /* ------------------------------------------------------------------- ui */

  function avatarUrl(user) {
    if (!user) return '';
    if (user.avatarUrl || user.avatar_url) return user.avatarUrl || user.avatar_url;
    if (user.id && user.avatar) {
      return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
    }
    return '';
  }

  function displayName(user) {
    return user?.globalName || user?.global_name || user?.displayName
      || user?.username || user?.name || 'Adventurer';
  }

  function showSignedIn(user) {
    const name = displayName(user);
    if (identityName) identityName.textContent = name;

    const url = avatarUrl(user);
    if (avatar) {
      if (url) {
        avatar.src = url;
        avatar.alt = `${name}'s Discord avatar`;
      } else {
        avatar.removeAttribute('src');
        avatar.alt = '';
      }
    }

    loginButton?.setAttribute('hidden', '');
    identity?.removeAttribute('hidden');
    document.documentElement.dataset.authenticated = 'true';
    window.RIDGEWOOD_HOME?.setAuthenticated(true);
  }

  function showSignedOut() {
    loginButton?.removeAttribute('hidden');
    identity?.setAttribute('hidden', '');
    document.documentElement.dataset.authenticated = 'false';
    window.RIDGEWOOD_HOME?.setAuthenticated(false);
  }

  /* ------------------------------------------------------------- lifecycle */

  function activate(user) {
    const token = localStorage.getItem(TOKEN_KEY) || '';
    installAuthenticatedWebSocket(token);
    window.RIDGEWOOD_AUTH = Object.freeze({ token, user: user || null, serverUrl: AUTH_SERVER });
    window.dispatchEvent(new CustomEvent('ridgewood:auth-ready', { detail: window.RIDGEWOOD_AUTH }));
    showSignedIn(user);
    // Signed in? Bring the world up straight away so world chat is live while
    // the player is still choosing a server.
    startGameModule();
  }

  async function checkServer() {
    window.RIDGEWOOD_HOME?.setStatus('checking', 'Checking server…');
    try {
      const response = await fetch(`${AUTH_SERVER}/health`, { cache: 'no-store' });
      if (!response.ok) throw new Error(String(response.status));
      const payload = await response.json().catch(() => ({}));
      const version = payload?.version ? ` · v${payload.version}` : '';
      window.RIDGEWOOD_HOME?.setStatus('online', `Ridgewood Main online${version}`);
    } catch {
      window.RIDGEWOOD_HOME?.setStatus('offline', 'Server unreachable');
    }
  }

  async function initialize() {
    const callback = readCallbackFragment();
    if (callback.error) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      showSignedOut();
      window.RIDGEWOOD_HOME?.setStatus(
        'offline',
        `Discord sign-in failed: ${callback.error.replaceAll('_', ' ')}`
      );
      return;
    }

    const token = callback.token || localStorage.getItem(TOKEN_KEY) || '';
    if (!token) {
      showSignedOut();
      checkServer();
      return;
    }

    try {
      const user = await validateSession(token);
      if (!user) {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        showSignedOut();
        checkServer();
        return;
      }
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      activate(user);
      checkServer();
    } catch (error) {
      console.error('Authentication check failed:', error);
      showSignedOut();
      window.RIDGEWOOD_HOME?.setStatus('offline', 'Could not reach the login server');
    }
  }

  logoutButton?.addEventListener('click', () => window.RIDGEWOOD_AUTH_API.logout());

  window.RIDGEWOOD_AUTH_API = Object.freeze({
    loginUrl,
    startGame: startGameModule,
    isAuthenticated: () => document.documentElement.dataset.authenticated === 'true',
    getToken: () => localStorage.getItem(TOKEN_KEY) || '',
    getUser() {
      try {
        return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
      } catch {
        return null;
      }
    },
    async logout() {
      const token = localStorage.getItem(TOKEN_KEY) || '';
      try {
        if (token) {
          await fetch(`${AUTH_SERVER}/auth/logout?token=${encodeURIComponent(token)}`, {
            method: 'POST',
            cache: 'no-store'
          });
        }
      } finally {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        window.location.reload();
      }
    }
  });

  initialize();
})();
