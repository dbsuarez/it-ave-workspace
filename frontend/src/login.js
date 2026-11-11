// IT Avenue Workspace - Login Renderer
// Handles login/register form logic.
//
// Everything lives inside one function scope so nothing here can collide with
// `window.electronAPI`, which the preload defines. (A top-level declaration of
// the same name is a parse error that kills the page before any handler runs.)
(() => {
  'use strict';

  const API_BASE = 'http://127.0.0.1:3001';
  const bridge = window.electronAPI;

  const form = document.getElementById('auth-form');
  const title = document.getElementById('auth-title');
  const subtitle = document.getElementById('auth-subtitle');
  const submitButton = document.getElementById('auth-btn');
  const switchButton = document.getElementById('switch-btn');
  const errorEl = document.getElementById('error-msg');

  const MODES = {
    login: {
      title: 'Sign in',
      subtitle: 'Welcome to IT Avenue Workspace',
      submit: 'Sign in',
      busy: 'Signing in...',
      switchTo: 'Create an account',
      path: '/api/auth/login',
      fallbackError: 'Login failed',
      body: (username, password) => ({ username, password }),
    },
    register: {
      title: 'Create an account',
      subtitle: 'Join IT Avenue Workspace',
      submit: 'Create account',
      busy: 'Creating...',
      switchTo: 'Already have an account?',
      path: '/api/auth/register',
      fallbackError: 'Registration failed',
      body: (username, password) => ({ username, email: `${username}@itavenue.local`, password }),
    },
  };
  let mode = 'login';

  function showError(message) {
    errorEl.textContent = message;
    errorEl.style.display = 'block';
  }

  function applyMode() {
    const current = MODES[mode];
    title.textContent = current.title;
    subtitle.textContent = current.subtitle;
    submitButton.textContent = current.submit;
    switchButton.textContent = current.switchTo;
    errorEl.style.display = 'none';
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const current = MODES[mode];
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;

    errorEl.style.display = 'none';
    submitButton.disabled = true;
    submitButton.textContent = current.busy;

    try {
      let res;
      try {
        res = await fetch(`${API_BASE}${current.path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(current.body(username, password)),
        });
      } catch (err) {
        showError('Cannot connect to server. Is it running?');
        return;
      }

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(data.error || current.fallbackError);
        return;
      }

      await bridge.storeSet('authToken', data.token);
      await bridge.storeSet('user', data.user);
      // Closing this window tells the main process to open the main window.
      window.close();
    } catch (err) {
      console.error('Sign-in error:', err);
      showError('Something went wrong while signing in. Please try again.');
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = MODES[mode].submit;
    }
  }

  // Attach every listener before doing any asynchronous work.
  form.addEventListener('submit', handleSubmit);
  switchButton.addEventListener('click', () => {
    mode = mode === 'login' ? 'register' : 'login';
    applyMode();
  });
  document.getElementById('login-win-min')?.addEventListener('click', () => {
    bridge?.appCommand?.('minimize');
  });
  document.getElementById('login-win-close')?.addEventListener('click', () => {
    bridge?.appCommand?.('close-window');
  });

  if (!bridge) {
    showError('The app did not start correctly (desktop bridge missing). Please restart it.');
    submitButton.disabled = true;
    return;
  }

  // Already signed in: close this window so the main window opens.
  Promise.all([bridge.storeGet('authToken'), bridge.storeGet('user')])
    .then(([token, user]) => {
      if (token && user) window.close();
    })
    .catch((err) => console.error('Read stored session error:', err));
})();
