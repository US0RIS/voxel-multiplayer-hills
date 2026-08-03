(() => {
  'use strict';

  const TOKEN_KEY = 'ridgewood.session_token';
  const USER_KEY = 'ridgewood.auth_user';
  const AUTH_SERVER = String(
    window.VOXEL_CONFIG?.AUTH_SERVER_URL ||
    'https://voxel-multiplayer-hills-410-server.onrender.com'
  ).replace(/\/$/, '');

  const screen = document.querySelector('#auth-screen');
  const login = document.querySelector('#auth-discord-login');
  const status = document.querySelector('#auth-status');

  function setStatus(message, state = '') {
    if (!status) return;
    status.textContent = message;
    status.dataset.state = state;
  }

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

  function revealApplication(user) {
    screen?.setAttribute('hidden', '');
    document.documentElement.dataset.authenticated = 'true';
    window.RIDGEWOOD_AUTH = Object.freeze({
      token: localStorage.getItem(TOKEN_KEY) || '',
      user: user || null,
      serverUrl: AUTH_SERVER
    });
    window.dispatchEvent(new CustomEvent('ridgewood:auth-ready', { detail: window.RIDGEWOOD_AUTH }));
  }

  function showLogin(message = 'Sign in to enter Ridgewood.') {
    document.documentElement.dataset.authenticated = 'false';
    screen?.removeAttribute('hidden');
    setStatus(message, message.toLowerCase().includes('failed') ? 'error' : '');
  }

  async function initialize() {
    const callback = readCallbackFragment();
    if (callback.error) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      showLogin(`Discord sign-in failed: ${callback.error.replaceAll('_', ' ')}.`);
      return;
    }

    const token = callback.token || localStorage.getItem(TOKEN_KEY) || '';
    if (!token) {
      showLogin();
      return;
    }

    setStatus('Verifying your Discord session…', 'checking');
    try {
      const user = await validateSession(token);
      if (!user) {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        showLogin('Your session expired. Sign in again.');
        return;
      }
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      revealApplication(user);
    } catch (error) {
      console.error('Authentication check failed:', error);
      showLogin('Could not verify the session. Try again when the server is available.');
    }
  }

  if (login) login.href = `${AUTH_SERVER}/auth/discord`;

  window.RIDGEWOOD_AUTH_API = Object.freeze({
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
