// IT Avenue Workspace - the left rail as an Owner arranged it for everyone (docs: GET /api/settings/sidebar `rail`, PUT /api/settings/sidebar/rail).
// A layout is { order: [section keys on the rail], more: [keys in the More menu] }. Pure helpers (tested) first, then the code that
// reorders the real buttons and fills the More menu, and the Owner's "Customize the rail" dialog.

const railEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Moves one section up or down inside the list it is in. Home is fixed first, so nothing moves above it. Returns a new layout.
function railMoveWithin(layout, key, direction) {
  if (key === 'home') return layout;
  for (const list of ['order', 'more']) {
    const items = layout[list];
    const at = items.indexOf(key);
    if (at < 0) continue;
    const to = direction === 'up' ? at - 1 : at + 1;
    const floor = list === 'order' ? 1 : 0; // Home holds the first place on the rail
    if (to < floor || to >= items.length) return layout;
    const next = items.slice();
    [next[at], next[to]] = [next[to], next[at]];
    return { ...layout, [list]: next };
  }
  return layout;
}

// Moves a section from the rail into More (at the end), or from More back onto the rail (at the end). Home cannot move.
function railTogglePlacement(layout, key) {
  if (key === 'home') return layout;
  if (layout.order.includes(key)) return { order: layout.order.filter((k) => k !== key), more: [...layout.more, key] };
  if (layout.more.includes(key)) return { order: [...layout.order, key], more: layout.more.filter((k) => k !== key) };
  return layout;
}

// labels: { key: text }
function railCustomizeHtml({ layout, labels }) {
  const row = (key, list, index, count) => {
    const label = railEscape(labels[key] || key);
    if (key === 'home') return `<li class="rail-edit-row" data-rail-row="home"><span class="rail-edit-label">${label}</span><span class="rail-edit-note">Always first</span></li>`;
    const floor = list === 'order' ? 1 : 0;
    return `<li class="rail-edit-row" data-rail-row="${railEscape(key)}"><span class="rail-edit-label">${label}</span><span class="rail-edit-tools"><button type="button" class="btn small" data-rail-move="up" data-rail-key="${railEscape(key)}" aria-label="Move ${label} up"${index <= floor ? ' disabled' : ''}>&uarr;</button><button type="button" class="btn small" data-rail-move="down" data-rail-key="${railEscape(key)}" aria-label="Move ${label} down"${index >= count - 1 ? ' disabled' : ''}>&darr;</button><button type="button" class="btn small" data-rail-toggle data-rail-key="${railEscape(key)}">${list === 'order' ? 'Move to More' : 'Move to the rail'}</button></span></li>`;
  };
  const rail = layout.order.map((key, i) => row(key, 'order', i, layout.order.length)).join('');
  const more = layout.more.length ? layout.more.map((key, i) => row(key, 'more', i, layout.more.length)).join('') : '<li class="rail-edit-empty">Nothing in More: the More button is hidden.</li>';
  return `<div class="modal-header"><h3>Customize the rail</h3><button class="modal-close" type="button" data-rail-close aria-label="Close">&times;</button></div><div class="modal-body"><p class="drawing-share-note">Everyone in the workspace sees the rail the way you arrange it here. Move sections up and down, or into the More menu.</p><h4 class="rail-edit-title">On the rail</h4><ol class="rail-edit-list">${rail}</ol><h4 class="rail-edit-title">In the More menu</h4><ol class="rail-edit-list">${more}</ol></div><div class="modal-footer"><button type="button" class="btn" data-rail-reset>Reset to default</button><button type="button" class="btn" data-rail-close>Cancel</button><button type="button" class="btn primary" data-rail-save>Save for everyone</button></div>`;
}

// ---------------------------------------------------------------------------------------------------------------- in the app

const railState = { layout: null, draft: null };

const railMoreKeys = () => (railState.layout ? railState.layout.more : ['lists']);

const railLabelOf = (button) => {
  const label = button.querySelector('span');
  return label ? label.textContent.trim() : button.dataset.rail;
};

// Reorders the real buttons, hides the ones that live in More, and fills the More menu with them. Safe to call again at any time.
function applyRailLayout(layout) {
  const scroller = document.querySelector('.rail-scroll');
  if (!scroller || !layout || !Array.isArray(layout.order) || !Array.isArray(layout.more)) return;
  railState.layout = { order: layout.order.slice(), more: layout.more.slice() };
  const button = (key) => scroller.querySelector(`.rail-item[data-rail="${key}"]`);
  for (const key of layout.order) {
    const el = button(key);
    if (!el) continue;
    el.removeAttribute('data-in-more');
    scroller.appendChild(el); // appending in order puts them in order
  }
  for (const key of layout.more) button(key)?.setAttribute('data-in-more', '1');
  refreshMoreMenu();
  if (typeof updateRail === 'function' && typeof state !== 'undefined') updateRail(state.section);
}

// The More menu: one entry per section in More (a section only people with permission see, such as Moderation, shows only for them).
function refreshMoreMenu() {
  const menu = document.getElementById('more-menu');
  const wrap = document.querySelector('.rail-more');
  if (!menu || !railState.layout) return;
  const entries = railState.layout.more.map((key) => {
    const source = document.querySelector(`.rail-scroll .rail-item[data-rail="${key}"]`);
    if (!source || source.hidden) return '';
    const icon = source.querySelector('svg');
    const small = icon ? icon.outerHTML.replace(/width="\d+"/, 'width="16"').replace(/height="\d+"/, 'height="16"') : '';
    return `<button class="menu-item menu-item-icon" type="button" data-more-section="${railEscape(key)}" role="menuitem">${small}<span>${railEscape(railLabelOf(source))}</span></button>`;
  }).filter(Boolean);
  menu.innerHTML = entries.join('');
  if (wrap) wrap.hidden = entries.length === 0;
  if (typeof state !== 'undefined') menu.querySelectorAll('[data-more-section]').forEach((item) => item.classList.toggle('active', item.dataset.moreSection === state.section));
}

// ---- the Owner's dialog ----

const railModal = () => document.getElementById('rail-customize-modal');

function railLabels() {
  const labels = {};
  document.querySelectorAll('.rail-scroll .rail-item[data-rail]').forEach((el) => { labels[el.dataset.rail] = railLabelOf(el); });
  return labels;
}

function renderRailCustomizer() {
  railModal().innerHTML = railCustomizeHtml({ layout: railState.draft, labels: railLabels() });
}

function openRailCustomizer() {
  if (!railState.layout) return;
  railState.draft = { order: railState.layout.order.slice(), more: railState.layout.more.slice() };
  renderRailCustomizer();
  openSettingsModal(railModal());
}

async function saveRailLayout() {
  try {
    const res = await api('/api/settings/sidebar/rail', { method: 'PUT', body: JSON.stringify(railState.draft) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save the rail');
    applyRailLayout(data.rail);
    closeSettingsModal();
    showToast('The rail is saved for everyone.', 'success');
  } catch (err) { showToast(err.message || 'Could not save the rail.', 'error'); }
}

async function resetRailLayout() {
  try {
    const res = await api('/api/settings/sidebar/rail', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not reset the rail');
    applyRailLayout(data.rail);
    closeSettingsModal();
    showToast('The rail is back to the default for everyone.', 'success');
  } catch (err) { showToast(err.message || 'Could not reset the rail.', 'error'); }
}

function setupRailLayout() {
  const modal = railModal();
  if (!modal) return;
  modal.addEventListener('click', (event) => {
    const t = event.target;
    if (t.closest('[data-rail-close]')) { closeSettingsModal(); return; }
    if (t.closest('[data-rail-save]')) { saveRailLayout(); return; }
    if (t.closest('[data-rail-reset]')) { resetRailLayout(); return; }
    const move = t.closest('[data-rail-move]');
    if (move) { railState.draft = railMoveWithin(railState.draft, move.dataset.railKey, move.dataset.railMove); renderRailCustomizer(); return; }
    const toggle = t.closest('[data-rail-toggle]');
    if (toggle) { railState.draft = railTogglePlacement(railState.draft, toggle.dataset.railKey); renderRailCustomizer(); }
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { railMoveWithin, railTogglePlacement, railCustomizeHtml };
}
