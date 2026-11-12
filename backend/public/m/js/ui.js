// Small UI toolkit for the phone app. Everything is built with createElement and textContent, never from markup
// strings, so a message or a name can never run as script.
import { blobUrl, session } from './api.js';
import { initialOf } from './format.js';

// h('div', { class: 'card', onclick: fn, dataset: { id: 1 } }, 'text', childEl, ...)
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'text') el.textContent = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// Append children, skipping null, undefined and false (a bare append() would print the word "null").
export function put(el, ...kids) {
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function toast(text, kind = 'info') {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = h('div', { class: `toast toast-${kind}`, role: 'status' }, text);
  host.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 5500 : 3200);
}

// A round avatar: the person's photo when they have one, otherwise their initial on their color.
export function avatar(person, size = 40) {
  const el = h('span', { class: 'avatar' }, initialOf(person));
  // set through the style object: the page policy blocks inline style attributes
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.fontSize = `${Math.round(size * 0.42)}px`;
  el.style.backgroundColor = /^#[0-9a-fA-F]{6}$/.test(person.avatarColor || '') ? person.avatarColor : '#6B21A8';
  const id = person.id ?? person.userId;
  if (person.photoVersion && id !== undefined && session.token) {
    blobUrl(`/api/users/${id}/photo?v=${person.photoVersion}`).then((url) => {
      if (url) { el.style.backgroundImage = `url("${url}")`; el.textContent = ''; el.classList.add('has-photo'); }
    });
  }
  return el;
}

// A sheet that slides up from the bottom. Returns { close, body }.
export function sheet(title, build) {
  const body = h('div', { class: 'sheet-body' });
  const close = () => { overlay.remove(); document.body.classList.remove('sheet-open'); };
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(); } },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': title },
      h('div', { class: 'sheet-head' }, h('strong', {}, title), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, '×')),
      body));
  build(body, close);
  document.body.append(overlay);
  document.body.classList.add('sheet-open');
  return { close, body };
}

export function confirmBox(message, okLabel = 'OK') {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value, close) => { if (!done) { done = true; resolve(value); } close(); };
    const { close } = sheet('Are you sure?', (body, closeSheet) => {
      body.append(h('p', {}, message), h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => finish(false, closeSheet) }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => finish(true, closeSheet) }, okLabel)));
    });
    void close;
  });
}

// Ask for a line of text; resolves null when cancelled.
export function askText(message, { placeholder = '', maxLength = 300, required = false } = {}) {
  return new Promise((resolve) => {
    sheet(message, (body, close) => {
      const input = h('input', { type: 'text', class: 'input', maxlength: maxLength, placeholder });
      const submit = () => {
        const value = input.value.trim();
        if (required && !value) return;
        close();
        resolve(value);
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      body.append(input, h('div', { class: 'row-actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => { close(); resolve(null); } }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', onclick: submit }, 'OK')));
      setTimeout(() => input.focus(), 50);
    });
  });
}

export const emptyState = (title, hint) => h('div', { class: 'empty' }, h('strong', {}, title), hint ? h('p', {}, hint) : null);

export function chip(text, kind = '') {
  return h('span', { class: `chip ${kind}` }, text);
}

// Disable a button while a task runs, and say so if it fails.
export async function busy(button, task) {
  if (button) button.disabled = true;
  try {
    return await task();
  } catch (err) {
    toast(err.message || 'Something went wrong.', 'error');
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

// Small stroke icons (24x24), drawn as SVG.
const ICONS = {
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  back: 'M15 18l-6-6 6-6',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  plus: 'M12 5v14M5 12h14',
};

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name] || '');
  svg.append(path);
  return svg;
}
