// IT Avenue Workspace - Login Renderer
// Handles login/register form logic

// electronAPI is exposed on window by the preload (contextBridge)
// Reference it directly - re-declaring it triggers a global parse error
// ("Identifier 'electronAPI' has already been declared"), which kills the
// whole login script before any handler is attached.

const API_BASE = 'http://127.0.0.1:3001';

async function init() {
  const storedToken = await electronAPI.storeGet('authToken');
  const storedUser = await electronAPI.storeGet('user');

  if (storedToken && storedUser) {
    // Already logged in - close login, open main app
    const mainWindow = window.opener || window.parent;
    if (mainWindow) {
      window.close();
    }
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('error-msg');
  const btn = document.getElementById('auth-btn');

  errorEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Signing in...';

  try {
    const res = await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || 'Login failed';
      errorEl.style.display = 'block';
      return;
    }

    await electronAPI.storeSet('authToken', data.token);
    await electronAPI.storeSet('user', data.user);

    // Signal main process to open main window
    window.close();
  } catch (err) {
    errorEl.textContent = 'Cannot connect to server. Is it running?';
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('error-msg');
  const btn = document.getElementById('auth-btn');

  errorEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Creating...';

  try {
    const res = await fetch(`${API_BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email: `${username}@itavenue.local`, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || 'Registration failed';
      errorEl.style.display = 'block';
      return;
    }

    await electronAPI.storeSet('authToken', data.token);
    await electronAPI.storeSet('user', data.user);
    window.close();
  } catch (err) {
    errorEl.textContent = 'Cannot connect to server. Is it running?';
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create account';
  }
}

function toggleRegister() {
  const form = document.getElementById('auth-form');
  const title = document.getElementById('auth-title');
  const subtitle = document.getElementById('auth-subtitle');
  const btn = document.getElementById('auth-btn');
  const switchBtn = document.getElementById('switch-btn');

  if (btn.textContent === 'Sign in') {
    title.textContent = 'Create an account';
    subtitle.textContent = 'Join IT Avenue Workspace';
    btn.textContent = 'Create account';
    switchBtn.textContent = 'Already have an account?';
    form.onsubmit = handleRegister;
  } else {
    title.textContent = 'Sign in';
    subtitle.textContent = 'Welcome to IT Avenue Workspace';
    btn.textContent = 'Sign in';
    switchBtn.textContent = 'Create an account';
    form.onsubmit = handleLogin;
  }
}

document.getElementById('auth-form').addEventListener('submit', handleLogin);
document.getElementById('switch-btn').addEventListener('click', toggleRegister);

// Frameless window controls
document.getElementById('login-win-min')?.addEventListener('click', () => {
  window.electronAPI?.appCommand?.('minimize');
});
document.getElementById('login-win-close')?.addEventListener('click', () => {
  window.electronAPI?.appCommand?.('close-window');
});

init();
