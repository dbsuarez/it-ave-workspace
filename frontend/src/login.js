// IT Avenue Workspace - Login Renderer
// Handles login/register form logic.
//
// Everything lives inside one function scope so nothing here can collide with
// `window.electronAPI`, which the preload defines. (A top-level declaration of
// the same name is a parse error that kills the page before any handler runs.)
(() => {
  'use strict';

  const bridge = window.electronAPI;
  // The server comes from the app's settings (see server-config.js), never a constant.
  const API_BASE = (bridge && bridge.apiBase) || 'http://127.0.0.1:3001';

  const form = document.getElementById('auth-form');
  const title = document.getElementById('auth-title');
  const subtitle = document.getElementById('auth-subtitle');
  const submitButton = document.getElementById('auth-btn');
  const switchButton = document.getElementById('switch-btn');
  const errorEl = document.getElementById('error-msg');
  const inviteRow = document.getElementById('invite-row');
  const inviteInput = document.getElementById('invite-code');
  const inviteLabel = document.getElementById('invite-label');
  let inviteRequired = false;

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
      body: (username, password) => {
        const inviteCode = inviteInput.value.trim();
        return {
          username, email: `${username}@itavenue.local`, password,
          ...(inviteCode ? { inviteCode } : {}),
        };
      },
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
    inviteRow.hidden = mode !== 'register';
    inviteInput.required = mode === 'register' && inviteRequired;
    document.getElementById('password').minLength = mode === 'register' ? 8 : 0;
    inviteLabel.textContent = inviteRequired ? 'Invitation code' : 'Invitation code (optional)';
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

  // ---- Server address ----
  const serverUrlEl = document.getElementById('server-url');
  const serverChange = document.getElementById('server-change');
  const serverForm = document.getElementById('server-form');
  const serverInput = document.getElementById('server-input');
  const serverNote = document.getElementById('server-note');
  const serverFixedNote = document.getElementById('server-fixed-note');

  function setServerNote(message, isError = false) {
    serverNote.textContent = message;
    serverNote.classList.toggle('error', isError);
  }

  serverUrlEl.textContent = API_BASE;
  if (bridge && bridge.serverSource === 'environment') {
    serverChange.hidden = true;
    serverFixedNote.textContent = 'Set by the API_BASE environment variable on this computer.';
  }

  serverChange.addEventListener('click', () => {
    serverForm.hidden = false;
    serverInput.value = API_BASE;
    setServerNote('');
    serverInput.focus();
    serverInput.select();
  });
  document.getElementById('server-cancel').addEventListener('click', () => {
    serverForm.hidden = true;
  });
  document.getElementById('server-reset').addEventListener('click', async () => {
    await bridge.resetServerUrl();
    window.location.reload();
  });
  serverForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const saveButton = document.getElementById('server-save');
    saveButton.disabled = true;
    setServerNote('Checking the server…');
    try {
      const checked = await bridge.checkServerUrl(serverInput.value);
      if (!checked.ok) {
        setServerNote(checked.error, true);
        return;
      }
      if (!checked.reachable
        && !window.confirm(`Could not reach a server at ${checked.url}.\n\nSave this address anyway?`)) {
        setServerNote('Not saved.', true);
        return;
      }
      const saved = await bridge.setServerUrl(checked.url);
      if (!saved.ok) {
        setServerNote(saved.error, true);
        return;
      }
      window.location.reload();
    } catch (err) {
      console.error('Change server error:', err);
      setServerNote('Could not change the server address.', true);
    } finally {
      saveButton.disabled = false;
    }
  });

  if (!bridge) {
    showError('The app did not start correctly (desktop bridge missing). Please restart it.');
    submitButton.disabled = true;
    return;
  }

  // Ask whether sign-up needs an invitation code. Failure just leaves it optional.
  fetch(`${API_BASE}/api/admin/registration`)
    .then((res) => res.json())
    .then((data) => {
      inviteRequired = data.mode === 'invite';
      applyMode();
    })
    .catch(() => {});

  // Already signed in: close this window so the main window opens.
  Promise.all([bridge.storeGet('authToken'), bridge.storeGet('user')])
    .then(([token, user]) => {
      if (token && user) window.close();
    })
    .catch((err) => console.error('Read stored session error:', err));
})();
