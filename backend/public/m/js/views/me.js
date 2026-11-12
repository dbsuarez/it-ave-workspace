// Me: who I am, change my password, sign out, and how to put the app on the home screen.
import { call, session, deviceId } from '../api.js';
import { h, toast, avatar, busy } from '../ui.js';
import { personName } from '../format.js';

export async function render(root, parts, ctx) {
  const data = await call('/api/auth/me');
  const user = { ...data.user };
  session.user = { ...session.user, ...user };

  const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Current password' });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'New password (at least 8 characters)' });
  const again = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'New password again' });
  const save = h('button', { class: 'btn primary', type: 'button', onclick: () => busy(save, async () => {
    if (!current.value || !next.value) { toast('Fill in your current and new password.', 'error'); return; }
    if (next.value !== again.value) { toast('The two new passwords are not the same.', 'error'); return; }
    const result = await call('/api/auth/me/account', { method: 'PUT', body: { currentPassword: current.value, newPassword: next.value } });
    session.token = result.token;
    current.value = ''; next.value = ''; again.value = '';
    toast('Password changed. Other devices are signed out.', 'success');
  }) }, 'Change password');

  root.append(h('div', { class: 'page' },
    h('div', { class: 'card profile-head' }, avatar({ ...user, id: user.id }, 64),
      h('div', {}, h('strong', {}, personName(user)), h('div', { class: 'muted' }, `@${user.username}`), h('div', { class: 'muted' }, user.email || ''), user.jobTitle ? h('div', { class: 'muted' }, user.jobTitle) : null)),
    h('div', { class: 'card' }, h('h3', {}, 'Change password'), current, next, again, save),
    h('div', { class: 'card' }, h('h3', {}, 'This phone'),
      h('p', { class: 'muted' }, `Device id ${deviceId().slice(0, 8)}…  The first device you clock in from is trusted. If you use another, HR approves it.`),
      h('p', { class: 'muted' }, 'To keep the app on your home screen, open the browser menu and choose "Add to Home screen".')),
    h('button', { class: 'btn danger wide', type: 'button', onclick: () => ctx.signOut() }, 'Sign out')));
}
