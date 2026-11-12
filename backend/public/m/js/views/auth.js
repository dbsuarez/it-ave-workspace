// Sign-in, and the "choose your own password" screen new accounts must pass.
import { call, session } from '../api.js';
import { h, clear, toast, busy } from '../ui.js';

function logo() {
  return h('div', { class: 'auth-logo' }, h('img', { src: 'icons/icon-192.png', alt: '', width: 72, height: 72 }), h('h1', {}, 'IT Avenue Workspace'));
}

export function renderLogin(root, done) {
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const username = h('input', { class: 'input', type: 'text', autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', placeholder: 'Username', required: true });
  const password = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Password', required: true });
  const button = h('button', { class: 'btn primary wide', type: 'submit' }, 'Sign in');
  const form = h('form', { class: 'auth-form', onsubmit: async (event) => {
    event.preventDefault();
    error.hidden = true;
    await busy(button, async () => {
      try {
        const data = await call('/api/auth/login', { method: 'POST', body: { username: username.value.trim(), password: password.value } });
        session.token = data.token;
        session.user = data.user;
        done();
      } catch (err) {
        error.textContent = err.status === 429 ? 'Too many tries. Wait a little and try again.' : (err.message || 'Could not sign in.');
        error.hidden = false;
      }
    });
  } }, username, password, error, button);
  clear(root).append(h('div', { class: 'auth' }, logo(), form, h('p', { class: 'hint' }, 'Use the same username and password as the desktop app.')));
  username.focus();
}

export function renderForcedPassword(root, done) {
  const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Your temporary password', required: true });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'New password (at least 8 characters)', required: true, minlength: 8 });
  const again = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Type the new password again', required: true });
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const button = h('button', { class: 'btn primary wide', type: 'submit' }, 'Save my password');
  const form = h('form', { class: 'auth-form', onsubmit: async (event) => {
    event.preventDefault();
    error.hidden = true;
    if (next.value !== again.value) { error.textContent = 'The two new passwords are not the same.'; error.hidden = false; return; }
    await busy(button, async () => {
      try {
        const data = await call('/api/auth/me/account', { method: 'PUT', body: { currentPassword: current.value, newPassword: next.value } });
        session.token = data.token;
        toast('Password saved.', 'success');
        done();
      } catch (err) {
        error.textContent = err.message || 'Could not save the password.';
        error.hidden = false;
      }
    });
  } }, current, next, again, error, button);
  clear(root).append(h('div', { class: 'auth' }, logo(), h('h2', {}, 'Choose your own password'), h('p', { class: 'hint' }, 'Your account started with a temporary password. Pick one only you know.'), form));
}
