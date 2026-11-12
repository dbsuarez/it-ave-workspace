// IT Avenue Workspace - People: the directory, the org chart, and each employee's own page.
//
// An employee page shows what that person chose to share (about, their own titled sections, links, and
// whichever of email / phone / location they left visible), who they report to and who reports to them.
// People edit their own page; the Superadmin sets reporting lines (on a page, or in the chart's edit mode).
// Needs org-chart.js. Loaded before renderer.js; renderer.js calls loadPeople() when the section opens.

const peopleState = {
  list: [], loaded: false, error: '', tab: 'directory', query: '', department: '',
  pageId: null, page: null, editLines: false, collapsed: new Set(),
  view: null, // the org chart's pan and zoom: { x, y, k }; null until the first fit
};

const escapeText = (value) => escapeHtml(String(value === undefined || value === null ? '' : value));

function peopleAvatar(person, size = 'md') {
  const initial = escapeText((personName(person) || '?').charAt(0).toUpperCase());
  const color = /^#[0-9a-fA-F]{6}$/.test(person.avatarColor || '') ? person.avatarColor : '#6B21A8';
  return `<span class="pp-avatar pp-avatar-${size}" style="background:${color}" data-photo-id="${Number(person.id)}" data-photo-version="${Number(person.photoVersion) || ''}">${initial}</span>`;
}

// Fetch and show photos on every avatar placeholder in a container.
function paintPeoplePhotos(container) {
  container.querySelectorAll('.pp-avatar[data-photo-version]').forEach((el) => {
    const version = Number(el.dataset.photoVersion);
    if (!version) return;
    paintAvatar(el, { id: Number(el.dataset.photoId), photoVersion: version });
  });
}

function presenceDot(person) {
  return `<span class="pp-dot${person.status === 'online' ? ' online' : ''}" title="${escapeText(person.status || '')}"></span>`;
}

function personLine(person) {
  return [person.jobTitle, person.department].filter(Boolean).join(' · ');
}

async function loadPeople(force = false) {
  if (peopleState.loaded && !force) { renderPeople(); return; }
  try {
    const res = await api('/api/people');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load people');
    peopleState.list = data.people;
    peopleState.error = '';
  } catch (err) {
    peopleState.list = [];
    peopleState.error = err.message || 'Could not load people';
  }
  peopleState.loaded = true;
  renderPeople();
}

// ---- header and body ---------------------------------------------------------------------------

function renderPeople() {
  const title = document.getElementById('people-title');
  const sub = document.getElementById('people-sub');
  const actions = document.getElementById('people-actions');
  if (!title || !actions) return;
  if (peopleState.pageId !== null) {
    title.textContent = peopleState.page ? personName(peopleState.page.person) : 'Person';
    sub.textContent = 'Employee page';
    actions.innerHTML = '<button type="button" class="btn" data-people-back>← People</button>';
    renderPersonPage();
    return;
  }
  title.textContent = 'People';
  sub.textContent = peopleState.tab === 'chart' ? 'Who reports to whom.' : peopleState.tab === 'manage' ? 'Employee records, departments and accounts.' : peopleState.tab === 'leave' ? 'Time off: balances, requests, approvals and who is away.' : peopleState.tab === 'attendance' ? 'Clock in and out, timesheets, and the payroll export.' : 'Everyone in the workspace.';
  const departments = Array.from(new Set(peopleState.list.map((p) => p.department).filter(Boolean))).sort();
  actions.innerHTML = `
    <div class="pp-tabs" role="tablist">
      <button type="button" class="pp-tab${peopleState.tab === 'directory' ? ' active' : ''}" data-people-tab="directory" role="tab">Directory</button>
      <button type="button" class="pp-tab${peopleState.tab === 'chart' ? ' active' : ''}" data-people-tab="chart" role="tab">Org chart</button>
      <button type="button" class="pp-tab${peopleState.tab === 'leave' ? ' active' : ''}" data-people-tab="leave" role="tab">Leave${typeof leaveState !== 'undefined' && leaveState.waiting ? ` (${leaveState.waiting})` : ''}</button>
      <button type="button" class="pp-tab${peopleState.tab === 'attendance' ? ' active' : ''}" data-people-tab="attendance" role="tab">Attendance</button>
      ${canManageEmployees() ? `<button type="button" class="pp-tab${peopleState.tab === 'manage' ? ' active' : ''}" data-people-tab="manage" role="tab">Manage</button>` : ''}
    </div>
    <input type="search" id="people-search" class="pp-search" placeholder="Search name, title, department…" value="${escapeText(peopleState.query)}" aria-label="Search people">
    ${peopleState.tab === 'directory' && departments.length ? `<select id="people-department" class="pp-select" aria-label="Department">
      <option value="">All departments</option>${departments.map((d) => `<option value="${escapeText(d)}"${d === peopleState.department ? ' selected' : ''}>${escapeText(d)}</option>`).join('')}</select>` : ''}
    ${peopleState.tab === 'chart' && canManageEmployees()
      ? `<button type="button" class="btn${peopleState.editLines ? ' primary' : ''}" data-people-edit-lines>${peopleState.editLines ? 'Done editing' : 'Edit reporting lines'}</button>` : ''}`;
  renderPeopleBody();
}

function renderPeopleBody() {
  const body = document.getElementById('people-body');
  if (!body) return;
  if (peopleState.error) {
    body.innerHTML = emptyRecordMarkup('People are not available', peopleState.error);
    return;
  }
  if (peopleState.tab === 'manage' && !canManageEmployees()) peopleState.tab = 'directory';
  body.className = `people-body ${peopleState.tab === 'chart' ? 'people-chart-body' : peopleState.tab === 'manage' || peopleState.tab === 'leave' || peopleState.tab === 'attendance' ? 'people-manage-body' : 'people-directory-body'}`;
  if (peopleState.tab === 'chart') renderOrgChart(body); else if (peopleState.tab === 'manage') renderEmployeeManagement(body); else if (peopleState.tab === 'leave') renderLeave(body); else if (peopleState.tab === 'attendance') renderAttendance(body); else renderDirectory(body);
  paintPeoplePhotos(body);
}

function matchesPeopleQuery(person, query) {
  const q = query.trim().toLowerCase();
  return !q || [person.username, personFullName(person), person.jobTitle, person.department, person.location].some((v) => String(v || '').toLowerCase().includes(q));
}

function renderDirectory(body) {
  const people = peopleState.list.slice()
    .sort((a, b) => personName(a).localeCompare(personName(b), undefined, { sensitivity: 'base' })) // name order
    .filter((p) => matchesPeopleQuery(p, peopleState.query))
    .filter((p) => !peopleState.department || p.department === peopleState.department);
  if (!people.length) {
    body.innerHTML = emptyRecordMarkup(peopleState.list.length ? 'No one matches' : 'No people yet', peopleState.list.length ? 'Try a different search.' : 'Workspace members will appear here.');
    return;
  }
  body.innerHTML = `<div class="pp-grid">${people.map((p) => `
    <button type="button" class="pp-card" data-person="${p.id}">
      ${peopleAvatar(p, 'lg')}
      <span class="pp-card-body">
        <span class="pp-card-name">${escapeText(personName(p))} ${presenceDot(p)}</span>
        <span class="pp-card-title">${escapeText(p.jobTitle) || '<span class="pp-muted">No title yet</span>'}</span>
        ${p.department ? `<span class="pp-card-meta">${escapeText(p.department)}</span>` : ''}
        ${p.location ? `<span class="pp-card-meta">${escapeText(p.location)}</span>` : ''}
      </span>
    </button>`).join('')}</div>`;
}

// ---- org chart ---------------------------------------------------------------------------------

// The extra (dotted-line) managers of a person, as people, in order.
function secondaryManagersOf(person, everyone) {
  return (person.secondaryManagerIds || []).map((id) => everyone.find((o) => o.id === id)).filter(Boolean);
}

function orgNodeHtml(node, editable, everyone) {
  const p = node.person;
  const also = secondaryManagersOf(p, everyone);
  const size = orgTeamSize(node);
  const collapsed = peopleState.collapsed.has(p.id);
  const card = `
    <div class="org-card${node.matched ? ' matched' : ''}${node.children.length ? ' has-team' : ''}" data-org-card="${p.id}"${also.length ? ` title="Also reports to ${escapeText(also.map((o) => personName(o)).join(', '))} (dotted line)"` : ''}>
      <button type="button" class="org-card-main" data-person="${p.id}">
        ${peopleAvatar(p, 'md')}
        <span class="org-card-text">
          <strong>${escapeText(personName(p))}</strong>
          <span>${escapeText(p.jobTitle) || ''}</span>
          ${p.department ? `<em>${escapeText(p.department)}</em>` : ''}
        </span>
      </button>
      ${editable ? `<select class="org-manager-select" data-org-manager="${p.id}" aria-label="Reports to">
        <option value="">No manager</option>${everyone.filter((o) => o.id !== p.id).map((o) => `<option value="${o.id}"${o.id === p.managerId ? ' selected' : ''}>${escapeText(personName(o))}</option>`).join('')}</select>
        <div class="org-also-edit">
          ${also.map((o) => `<span class="org-chip">${escapeText(personName(o))}<button type="button" data-secondary-remove="${p.id}:${o.id}" aria-label="Remove ${escapeText(personName(o))} as an extra manager">×</button></span>`).join('')}
          ${(p.secondaryManagerIds || []).length < 5 ? `<select class="org-manager-select" data-org-secondary-add="${p.id}" aria-label="Add an extra manager"><option value="">+ Also reports to…</option>${everyone.filter((o) => o.id !== p.id && o.id !== p.managerId && !(p.secondaryManagerIds || []).includes(o.id)).map((o) => `<option value="${o.id}">${escapeText(personName(o))}</option>`).join('')}</select>` : ''}
        </div>` : ''}
      ${node.children.length ? `<span class="org-team-count">${size} ${size === 1 ? 'member' : 'members'}</span>
      <button type="button" class="org-toggle" data-org-toggle="${p.id}" title="${collapsed ? 'Show' : 'Hide'} the team (${size} ${size === 1 ? 'member' : 'members'})" aria-label="${collapsed ? 'Show' : 'Hide'} the team" aria-expanded="${!collapsed}">${collapsed ? '+' : '−'}</button>` : ''}
    </div>`;
  const kids = node.children.length && !collapsed
    ? `<ul class="org-children">${node.children.map((child) => orgNodeHtml(child, editable, everyone)).join('')}</ul>` : '';
  return `<li class="org-node">${card}${kids}</li>`;
}

function renderOrgChart(body) {
  if (!peopleState.list.length) {
    body.innerHTML = emptyRecordMarkup('No people yet', 'Workspace members will appear here.');
    return;
  }
  const editable = Boolean(peopleState.editLines && canManageEmployees());
  const tree = filterOrgTree(buildOrgTree(peopleState.list), peopleState.query);
  if (!tree.length) {
    body.innerHTML = emptyRecordMarkup('No one matches', 'Try a different search.');
    return;
  }
  const hint = editable ? '<p class="pp-hint">Choose who each person reports to: the first is the main manager and sets where they sit in the chart. Add extra managers below it; they show as "Also reports to". Changes save immediately.</p>'
    : (peopleState.list.every((p) => !p.managerId) ? '<p class="pp-hint">No reporting lines are set yet.' + (canManageEmployees() ? ' Use "Edit reporting lines" to set them.' : ' The Superadmin or HR sets them.') + '</p>' : '');
  const hasDotted = peopleState.list.some((p) => (p.secondaryManagerIds || []).length);
  body.innerHTML = `${hint}
    <div class="org-viewport" id="org-viewport" tabindex="0" aria-label="Org chart. Drag to move, scroll to zoom.">
      <div class="org-tools">
        <button type="button" data-org-zoom="out" aria-label="Zoom out" title="Zoom out">−</button>
        <button type="button" data-org-zoom="reset" id="org-zoom-label" title="Back to 100%">100%</button>
        <button type="button" data-org-zoom="in" aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" data-org-zoom="fit" title="Fit the whole chart">Fit</button>
        ${hasDotted ? '<span class="org-legend"><i></i> also reports to</span>' : ''}
      </div>
      <div class="org-canvas" id="org-canvas">
        <ul class="org-roots">${tree.map((node) => orgNodeHtml(node, editable, peopleState.list)).join('')}</ul>
        <svg class="org-dotted" id="org-dotted" aria-hidden="true"></svg>
      </div>
    </div>`;
  requestAnimationFrame(() => { orgApplyView(true); });
}

// ---- pan, zoom and the dotted lines ----------------------------------------------------------------

const ORG_MIN_ZOOM = 0.25;
const ORG_MAX_ZOOM = 2.5;

function orgClampZoom(k) { return Math.min(ORG_MAX_ZOOM, Math.max(ORG_MIN_ZOOM, k)); }

// Fit the whole chart in the viewport (never larger than 100%), centered at the top.
function orgFitView() {
  const viewport = document.getElementById('org-viewport');
  const canvas = document.getElementById('org-canvas');
  if (!viewport || !canvas) return;
  const pad = 24;
  const k = orgClampZoom(Math.min(1, (viewport.clientWidth - pad) / canvas.offsetWidth, (viewport.clientHeight - pad) / canvas.offsetHeight));
  peopleState.view = { k, x: Math.max(pad / 2, (viewport.clientWidth - canvas.offsetWidth * k) / 2), y: pad / 2 };
}

function orgApplyView(initial) {
  const canvas = document.getElementById('org-canvas');
  if (!canvas) return;
  if (!peopleState.view) orgFitView();
  const view = peopleState.view;
  if (!view) return;
  canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  const label = document.getElementById('org-zoom-label');
  if (label) label.textContent = `${Math.round(view.k * 100)}%`;
  if (initial) orgDrawDotted();
}

// Zoom by a factor around a point of the viewport (its center when none is given).
function orgZoomBy(factor, clientX, clientY) {
  const viewport = document.getElementById('org-viewport');
  if (!viewport || !peopleState.view) return;
  const rect = viewport.getBoundingClientRect();
  const mx = (clientX === undefined ? rect.left + rect.width / 2 : clientX) - rect.left;
  const my = (clientY === undefined ? rect.top + rect.height / 2 : clientY) - rect.top;
  const view = peopleState.view;
  const k = orgClampZoom(view.k * factor);
  peopleState.view = { k, x: mx - (mx - view.x) * (k / view.k), y: my - (my - view.y) * (k / view.k) };
  orgApplyView(false);
}

// A line through these points with rounded corners, like the connectors in the chart.
function orgRoundedPath(points, radius) {
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const [px, py] = points[i - 1];
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    const r = Math.min(radius, Math.hypot(cx - px, cy - py) / 2, Math.hypot(nx - cx, ny - cy) / 2);
    const inX = cx - Math.sign(cx - px) * r; const inY = cy - Math.sign(cy - py) * r;
    const outX = cx + Math.sign(nx - cx) * r; const outY = cy + Math.sign(ny - cy) * r;
    d += ` L${inX},${inY} Q${cx},${cy} ${outX},${outY}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last[0]},${last[1]}`;
}

// A dashed line from each extra manager's card to the person's card, drawn like the chart's own connectors. Positions are measured on screen and
// divided by the zoom, so the lines sit in the same unscaled space as the cards.
function orgDrawDotted() {
  const svg = document.getElementById('org-dotted');
  const canvas = document.getElementById('org-canvas');
  if (!svg || !canvas) return;
  const k = (peopleState.view && peopleState.view.k) || 1;
  const origin = canvas.getBoundingClientRect();
  const box = (id) => {
    const card = canvas.querySelector(`[data-org-card="${id}"]`);
    if (!card) return null;
    const r = card.getBoundingClientRect();
    return { left: (r.left - origin.left) / k, right: (r.right - origin.left) / k, top: (r.top - origin.top) / k, bottom: (r.bottom - origin.top) / k };
  };
  const parts = [];
  let lane = 0;
  for (const person of peopleState.list) {
    const to = (person.secondaryManagerIds || []).length ? box(person.id) : null;
    if (!to) continue;
    for (const managerId of person.secondaryManagerIds) {
      const from = box(managerId);
      if (!from) continue; // that manager's card is hidden (a collapsed team)
      const x1 = (from.left + from.right) / 2;
      const x2 = (to.left + to.right) / 2;
      let points;
      if (to.top > from.bottom + 8) {
        // the person is below: down from the manager, across, down into the person (like the chart's own lines)
        const midY = to.top - 14 - (lane % 3) * 6;
        points = [[x1, from.bottom], [x1, midY], [x2, midY], [x2, to.top]];
      } else {
        // same level or above: down under both cards, across, and up into the person
        const lowY = Math.max(from.bottom, to.bottom) + 18 + (lane % 3) * 6;
        points = [[x1, from.bottom], [x1, lowY], [x2, lowY], [x2, to.bottom]];
      }
      parts.push(`<path d="${orgRoundedPath(points, 8)}"/>`);
      lane += 1;
    }
  }
  svg.setAttribute('width', canvas.offsetWidth);
  svg.setAttribute('height', canvas.offsetHeight);
  svg.innerHTML = parts.join('');
}

async function setPersonManager(personId, managerId) {
  try {
    const res = await api(`/api/people/${personId}/manager`, { method: 'PUT', body: JSON.stringify({ managerId }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not change the reporting line');
    const person = peopleState.list.find((p) => p.id === personId);
    if (person) {
      person.managerId = data.managerId;
      person.secondaryManagerIds = (person.secondaryManagerIds || []).filter((id) => id !== data.managerId);
    }
    return true;
  } catch (err) {
    showToast(err.message || 'Could not change the reporting line.', 'error');
    return false;
  }
}

// Replace the extra managers of someone. Resolves true on success.
async function setSecondaryManagers(personId, managerIds) {
  try {
    const res = await api(`/api/people/${personId}/secondary-managers`, { method: 'PUT', body: JSON.stringify({ managerIds }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not change the reporting line');
    const person = peopleState.list.find((p) => p.id === personId);
    if (person) person.secondaryManagerIds = data.secondaryManagerIds;
    return true;
  } catch (err) {
    showToast(err.message || 'Could not change the reporting line.', 'error');
    return false;
  }
}

// ---- an employee's page ------------------------------------------------------------------------

async function openPersonPage(id) {
  if (state.section !== 'people') await setSection('people');
  peopleState.pageId = Number(id);
  peopleState.page = null;
  renderPeople();
  try {
    const res = await api(`/api/people/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not open that page');
    if (peopleState.pageId !== Number(id)) return;
    peopleState.page = data;
    renderPeople();
  } catch (err) {
    showToast(err.message || 'Could not open that page.', 'error');
    peopleState.pageId = null;
    renderPeople();
  }
}

function contactRow(label, value, href) {
  if (!value) return '';
  return `<div class="pp-row"><span>${label}</span>${href ? `<a href="${escapeText(href)}">${escapeText(value)}</a>` : `<strong>${escapeText(value)}</strong>`}</div>`;
}

function renderPersonPage() {
  const body = document.getElementById('people-body');
  if (!body) return;
  body.className = 'people-body people-page-body';
  if (!peopleState.page) { body.innerHTML = '<p class="pp-muted">Loading…</p>'; return; }
  const { person, manager, reports, canSetManager } = peopleState.page;
  const secondaryManagers = peopleState.page.secondaryManagers || [];
  const secondaryReports = peopleState.page.secondaryReports || [];
  const mine = Number(person.id) === Number(state.user.id);
  const color = /^#[0-9a-fA-F]{6}$/.test(person.avatarColor || '') ? person.avatarColor : '#6B21A8';
  const empty = !person.about && !person.sections.length && !person.links.length;
  const personCard = (p) => `<button type="button" class="pp-mini" data-person="${p.id}">${peopleAvatar(p, 'sm')}<span><strong>${escapeText(personName(p))}</strong><em>${escapeText(personLine(p))}</em></span></button>`;
  body.innerHTML = `
    <div class="pp-cover" style="background:${color}"></div>
    <div class="pp-hero">
      ${peopleAvatar(person, 'xl')}
      <div class="pp-hero-text">
        <h2>${escapeText(personName(person))} ${presenceDot(person)}</h2>
        <p>${escapeText(personLine(person)) || '<span class="pp-muted">No title yet</span>'}</p>
        <p class="pp-muted">${[personFullName(person) ? '@' + person.username : '', person.location, [person.statusEmoji, person.statusText].filter(Boolean).join(' ')].filter(Boolean).map(escapeText).join(' · ')}</p>
      </div>
      <div class="pp-hero-actions">
        ${mine ? '<button type="button" class="btn primary" data-edit-page>Edit my page</button>'
    : `<button type="button" class="btn" data-page-message="${person.id}">+ Message</button><button type="button" class="btn" data-page-huddle="${person.id}">+ Huddle</button>`}
      </div>
    </div>
    <div class="pp-columns">
      <div class="pp-main">
        ${person.about ? `<section class="pp-section"><h3>About</h3><p class="pp-text">${escapeText(person.about)}</p></section>` : ''}
        ${person.sections.map((s) => `<section class="pp-section"><h3>${escapeText(s.title)}</h3><p class="pp-text">${escapeText(s.body)}</p></section>`).join('')}
        ${empty ? emptyRecordMarkup(mine ? 'Your page is empty' : `${personName(person)} has not added anything yet`, mine ? 'Use "Edit my page" to add an about text, sections and links.' : 'Their title and contact details show on the right.', 'compact') : ''}
      </div>
      <aside class="pp-side">
        <section class="pp-section">
          <h3>Contact</h3>
          ${contactRow('Email', person.email, person.email ? `mailto:${person.email}` : '')}
          ${contactRow('Phone', person.phone)}
          ${contactRow('Location', person.location)}
          ${contactRow('Department', person.department)}
          ${contactRow('Member since', person.memberSince ? new Date(person.memberSince).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '')}
        </section>
        ${person.links.length ? `<section class="pp-section"><h3>Links</h3>${person.links.map((l) => `<a class="pp-link" href="${escapeText(l.url)}" target="_blank" rel="noopener noreferrer">${escapeText(l.label)}</a>`).join('')}</section>` : ''}
        <section class="pp-section">
          <h3>Reports to</h3>
          ${manager ? personCard(manager) : '<p class="pp-muted">No manager set</p>'}
          ${secondaryManagers.length || canSetManager ? '<h4 class="pp-subhead">Also reports to</h4>' : ''}
          ${secondaryManagers.map((m) => `<div class="pp-secondary-row">${personCard(m)}${canSetManager ? `<button type="button" class="btn" data-page-remove-secondary="${m.id}" aria-label="Remove ${escapeText(personName(m))} as an extra manager">Remove</button>` : ''}</div>`).join('')}
          ${canSetManager ? `<div class="pp-manager-edit"><select id="page-manager" aria-label="Reports to"><option value="">No manager</option>${peopleState.list.filter((p) => p.id !== person.id).map((p) => `<option value="${p.id}"${manager && manager.id === p.id ? ' selected' : ''}>${escapeText(personName(p))}</option>`).join('')}</select><button type="button" class="btn" data-page-set-manager="${person.id}">Save</button></div>
          ${secondaryManagers.length < 5 ? `<div class="pp-manager-edit"><select id="page-secondary" aria-label="Add an extra manager"><option value="">Add an extra manager…</option>${peopleState.list.filter((p) => p.id !== person.id && !(manager && manager.id === p.id) && !secondaryManagers.some((m) => m.id === p.id)).map((p) => `<option value="${p.id}">${escapeText(personName(p))}</option>`).join('')}</select><button type="button" class="btn" data-page-add-secondary="${person.id}">Add</button></div>` : ''}` : ''}
        </section>
        <section class="pp-section">
          <h3>Direct reports${reports.length ? ` (${reports.length})` : ''}</h3>
          ${reports.length ? reports.map(personCard).join('') : '<p class="pp-muted">No direct reports</p>'}
          ${secondaryReports.length ? `<h4 class="pp-subhead">Dotted-line reports (${secondaryReports.length})</h4>${secondaryReports.map(personCard).join('')}` : ''}
        </section>
      </aside>
    </div>`;
  paintPeoplePhotos(body);
}

// ---- editing my own page ----------------------------------------------------------------------

function sectionEditorRow(section = { title: '', body: '' }) {
  return `<div class="pp-edit-section">
    <input type="text" maxlength="60" placeholder="Section title (for example Ask me about)" value="${escapeText(section.title)}" data-edit-section-title>
    <textarea maxlength="1500" rows="3" placeholder="Write something" data-edit-section-body>${escapeText(section.body)}</textarea>
    <button type="button" class="btn" data-edit-remove>Remove section</button>
  </div>`;
}

function linkEditorRow(link = { label: '', url: '' }) {
  return `<div class="pp-edit-link">
    <input type="text" maxlength="40" placeholder="Label" value="${escapeText(link.label)}" data-edit-link-label>
    <input type="text" maxlength="300" placeholder="https://…" value="${escapeText(link.url)}" data-edit-link-url>
    <button type="button" class="btn" data-edit-remove>Remove</button>
  </div>`;
}

function openPageEditor() {
  const modal = document.getElementById('people-editor-modal');
  const page = peopleState.page;
  if (!modal || !page) return;
  const p = page.person;
  const hide = p.hide || {};
  modal.innerHTML = `
    <div class="modal-header"><h3>Edit my page</h3>
      <button class="modal-close" id="btn-close-people-editor" type="button" aria-label="Close"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
    <form id="people-editor-form">
      <div class="modal-body pp-editor-body">
        <p class="form-note">Your photo and avatar color are in Profile. Everything here is shown to other employees on your page.</p>
        <div class="pp-edit-triple">
          <div class="form-group"><label for="pe-last">Last name</label><input id="pe-last" type="text" maxlength="100" value="${escapeText(p.lastName)}"></div>
          <div class="form-group"><label for="pe-first">First name</label><input id="pe-first" type="text" maxlength="100" value="${escapeText(p.firstName)}"></div>
          <div class="form-group"><label for="pe-middle">Middle name</label><input id="pe-middle" type="text" maxlength="100" value="${escapeText(p.middleName)}"></div>
        </div>
        <div class="form-group"><label for="pe-title">Job title</label><input id="pe-title" type="text" maxlength="100" value="${escapeText(p.jobTitle)}"></div>
        <div class="form-group"><label for="pe-location">Location</label><input id="pe-location" type="text" maxlength="100" value="${escapeText(p.location)}"></div>
        <p class="form-note">${p.department ? `Your department is ${escapeText(p.department)}. ` : ''}HR sets your department, employee number and reporting line.</p>
        <div class="form-group"><label for="pe-phone">Phone</label><input id="pe-phone" type="text" maxlength="40" value="${escapeText(p.phone)}"></div>
        <div class="form-group"><label for="pe-about">About me</label><textarea id="pe-about" rows="4" maxlength="1500">${escapeText(p.about)}</textarea></div>
        <h4 class="modal-section-title">My sections</h4>
        <div id="pe-sections">${p.sections.map((s) => sectionEditorRow(s)).join('')}</div>
        <button type="button" class="btn" id="btn-pe-add-section">+ Add a section</button>
        <h4 class="modal-section-title">My links</h4>
        <div id="pe-links">${p.links.map((l) => linkEditorRow(l)).join('')}</div>
        <button type="button" class="btn" id="btn-pe-add-link">+ Add a link</button>
        <h4 class="modal-section-title">Hide from others</h4>
        <label class="preference-toggle"><input type="checkbox" id="pe-hide-email"${hide.email ? ' checked' : ''}><span>Hide my email</span></label>
        <label class="preference-toggle"><input type="checkbox" id="pe-hide-phone"${hide.phone ? ' checked' : ''}><span>Hide my phone</span></label>
        <label class="preference-toggle"><input type="checkbox" id="pe-hide-location"${hide.location ? ' checked' : ''}><span>Hide my location</span></label>
      </div>
      <div class="modal-footer"><button class="btn" type="button" id="btn-cancel-people-editor">Cancel</button><button class="btn primary" type="submit">Save my page</button></div>
    </form>`;
  openSettingsModal(modal);
}

async function savePageEditor(event) {
  event.preventDefault();
  const modal = document.getElementById('people-editor-modal');
  const value = (id) => modal.querySelector(`#${id}`).value;
  const sections = Array.from(modal.querySelectorAll('.pp-edit-section')).map((row) => ({
    title: row.querySelector('[data-edit-section-title]').value, body: row.querySelector('[data-edit-section-body]').value,
  })).filter((s) => s.title.trim() || s.body.trim());
  const links = Array.from(modal.querySelectorAll('.pp-edit-link')).map((row) => ({
    label: row.querySelector('[data-edit-link-label]').value, url: row.querySelector('[data-edit-link-url]').value,
  })).filter((l) => l.label.trim() || l.url.trim());
  const body = {
    lastName: value('pe-last'), firstName: value('pe-first'), middleName: value('pe-middle'),
    jobTitle: value('pe-title'), location: value('pe-location'), phone: value('pe-phone'),
    about: value('pe-about'), sections, links,
    hide: { email: modal.querySelector('#pe-hide-email').checked, phone: modal.querySelector('#pe-hide-phone').checked, location: modal.querySelector('#pe-hide-location').checked },
  };
  try {
    const res = await api('/api/people/me', { method: 'PUT', body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not save your page');
    state.user = { ...state.user, jobTitle: data.person.jobTitle };
    await electronAPI.storeSet('user', state.user);
    closeSettingsModal();
    showToast('Your page was saved.', 'success');
    peopleState.loaded = false;
    await loadPeople(true);
    await openPersonPage(state.user.id);
  } catch (err) {
    showToast(err.message || 'Could not save your page.', 'error');
  }
}

// ---- events ------------------------------------------------------------------------------------

if (typeof document !== 'undefined') {
  document.addEventListener('click', async (event) => {
    const t = event.target;
    if (!t.closest) return;
    const tab = t.closest('[data-people-tab]');
    if (tab) { peopleState.tab = tab.dataset.peopleTab; renderPeople(); return; }
    const toggle = t.closest('[data-org-toggle]');
    if (toggle) {
      const id = Number(toggle.dataset.orgToggle);
      if (peopleState.collapsed.has(id)) peopleState.collapsed.delete(id); else peopleState.collapsed.add(id);
      renderPeopleBody();
      return;
    }
    if (t.closest('[data-people-edit-lines]')) { peopleState.editLines = !peopleState.editLines; renderPeople(); return; }
    if (t.closest('.org-manager-select, .org-also-edit')) return;
    const person = t.closest('[data-person]');
    if (person) { openPersonPage(Number(person.dataset.person)); return; }
    const profile = t.closest('[data-profile-user]');
    if (profile) { openPersonPage(Number(profile.dataset.profileUser)); return; }
    if (t.closest('[data-people-back]')) { peopleState.pageId = null; peopleState.page = null; renderPeople(); return; }
    if (t.closest('[data-edit-page]')) { openPageEditor(); return; }
    const message = t.closest('[data-page-message]');
    if (message) { openDM(Number(message.dataset.pageMessage)); return; }
    const huddle = t.closest('[data-page-huddle]');
    if (huddle) { startDirectHuddle(Number(huddle.dataset.pageHuddle)); return; }
    const setManager = t.closest('[data-page-set-manager]');
    if (setManager) {
      const value = document.getElementById('page-manager').value;
      const ok = await setPersonManager(Number(setManager.dataset.pageSetManager), value === '' ? null : Number(value));
      if (ok) { showToast('Reporting line saved.', 'success'); openPersonPage(Number(setManager.dataset.pageSetManager)); }
      return;
    }
    const addSecondary = t.closest('[data-page-add-secondary]');
    if (addSecondary) {
      const personId = Number(addSecondary.dataset.pageAddSecondary);
      const value = document.getElementById('page-secondary').value;
      if (!value) return;
      const current = (peopleState.page.secondaryManagers || []).map((m) => m.id);
      if (await setSecondaryManagers(personId, [...current, Number(value)])) openPersonPage(personId);
      return;
    }
    const removeSecondary = t.closest('[data-page-remove-secondary]');
    if (removeSecondary) {
      const personId = peopleState.pageId;
      const current = (peopleState.page.secondaryManagers || []).map((m) => m.id).filter((id) => id !== Number(removeSecondary.dataset.pageRemoveSecondary));
      if (await setSecondaryManagers(personId, current)) openPersonPage(personId);
      return;
    }
    const chipRemove = t.closest('[data-secondary-remove]');
    if (chipRemove) {
      const [personId, managerId] = chipRemove.dataset.secondaryRemove.split(':').map(Number);
      const person = peopleState.list.find((p) => p.id === personId);
      const next = ((person && person.secondaryManagerIds) || []).filter((id) => id !== managerId);
      if (await setSecondaryManagers(personId, next)) renderPeopleBody();
      return;
    }
    // the page editor
    if (t.closest('#btn-close-people-editor, #btn-cancel-people-editor')) { closeSettingsModal(); return; }
    if (t.closest('#btn-pe-add-section')) {
      if (document.querySelectorAll('#pe-sections .pp-edit-section').length >= 8) { showToast('A page can have at most 8 sections.', 'error'); return; }
      document.getElementById('pe-sections').insertAdjacentHTML('beforeend', sectionEditorRow());
      return;
    }
    if (t.closest('#btn-pe-add-link')) {
      if (document.querySelectorAll('#pe-links .pp-edit-link').length >= 8) { showToast('A page can have at most 8 links.', 'error'); return; }
      document.getElementById('pe-links').insertAdjacentHTML('beforeend', linkEditorRow());
      return;
    }
    const remove = t.closest('[data-edit-remove]');
    if (remove) remove.parentElement.remove();
  });

  document.addEventListener('input', (event) => {
    if (event.target.id === 'people-search') { peopleState.query = event.target.value; renderPeopleBody(); }
  });

  document.addEventListener('change', async (event) => {
    if (event.target.id === 'people-department') { peopleState.department = event.target.value; renderPeopleBody(); return; }
    const addSelect = event.target.closest ? event.target.closest('[data-org-secondary-add]') : null;
    if (addSelect) {
      const id = Number(addSelect.dataset.orgSecondaryAdd);
      if (!addSelect.value) return;
      const person = peopleState.list.find((p) => p.id === id);
      const ok = await setSecondaryManagers(id, [...((person && person.secondaryManagerIds) || []), Number(addSelect.value)]);
      if (ok) renderPeopleBody(); else addSelect.value = '';
      return;
    }
    const select = event.target.closest ? event.target.closest('[data-org-manager]') : null;
    if (select) {
      const id = Number(select.dataset.orgManager);
      const ok = await setPersonManager(id, select.value === '' ? null : Number(select.value));
      if (!ok) { const person = peopleState.list.find((p) => p.id === id); select.value = person && person.managerId ? String(person.managerId) : ''; }
      else renderPeopleBody();
    }
  });

  document.addEventListener('submit', (event) => {
    if (event.target.id === 'people-editor-form') savePageEditor(event);
  });
}

// Org chart navigation: drag to pan, scroll to zoom, buttons for the rest.
if (typeof document !== 'undefined') {
  let pan = null;
  let justPanned = false;

  document.addEventListener('pointerdown', (event) => {
    const viewport = event.target.closest && event.target.closest('#org-viewport');
    if (!viewport || event.button !== 0 || event.target.closest('select, input, textarea, .org-tools, .org-chip')) return;
    pan = { x: event.clientX, y: event.clientY, vx: peopleState.view.x, vy: peopleState.view.y, moved: false };
  });

  window.addEventListener('pointermove', (event) => {
    if (!pan || !peopleState.view) return;
    const dx = event.clientX - pan.x;
    const dy = event.clientY - pan.y;
    if (!pan.moved && Math.hypot(dx, dy) < 5) return;
    pan.moved = true;
    peopleState.view.x = pan.vx + dx;
    peopleState.view.y = pan.vy + dy;
    document.getElementById('org-viewport')?.classList.add('panning');
    orgApplyView(false);
  });

  const endPan = () => {
    if (!pan) return;
    if (pan.moved) { justPanned = true; setTimeout(() => { justPanned = false; }, 0); }
    pan = null;
    document.getElementById('org-viewport')?.classList.remove('panning');
  };
  window.addEventListener('pointerup', endPan);
  window.addEventListener('pointercancel', endPan);

  // a drag that ends on a card must not also open that person's page
  document.addEventListener('click', (event) => {
    if (justPanned) { event.stopPropagation(); event.preventDefault(); }
  }, true);

  document.addEventListener('wheel', (event) => {
    if (!event.target.closest || !event.target.closest('#org-viewport')) return;
    event.preventDefault();
    orgZoomBy(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)), event.clientX, event.clientY);
  }, { passive: false });

  document.addEventListener('click', (event) => {
    const button = event.target.closest && event.target.closest('[data-org-zoom]');
    if (!button) return;
    const action = button.dataset.orgZoom;
    if (action === 'in') orgZoomBy(1.25);
    else if (action === 'out') orgZoomBy(1 / 1.25);
    else if (action === 'reset') { orgZoomBy(1 / peopleState.view.k); }
    else if (action === 'fit') { orgFitView(); orgApplyView(false); }
    orgDrawDotted();
  });

  document.addEventListener('keydown', (event) => {
    if (!event.target.closest || !event.target.closest('#org-viewport') || event.target.closest('select, input')) return;
    const step = 60;
    if (event.key === '+' || event.key === '=') orgZoomBy(1.25);
    else if (event.key === '-') orgZoomBy(1 / 1.25);
    else if (event.key === '0') { orgFitView(); orgApplyView(false); }
    else if (event.key === 'ArrowLeft') { peopleState.view.x += step; orgApplyView(false); }
    else if (event.key === 'ArrowRight') { peopleState.view.x -= step; orgApplyView(false); }
    else if (event.key === 'ArrowUp') { peopleState.view.y += step; orgApplyView(false); }
    else if (event.key === 'ArrowDown') { peopleState.view.y -= step; orgApplyView(false); }
    else return;
    event.preventDefault();
  });
}
