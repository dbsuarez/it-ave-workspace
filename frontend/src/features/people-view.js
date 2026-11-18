// IT Avenue Workspace - the card and list views of People > Directory and My team, and the toggles above them.
//
// Pure functions: people in, HTML out. The helpers (escape, name, avatar, presence) come from people.js so this file
// needs nothing else and can be tested on its own. Inactive people (former employees, visible to HR and Owners only)
// are shown but are not buttons: their employee pages are not available. Loaded before renderer.js.

function peopleToggleGroup(label, attribute, options, current) {
  return `<div class="pp-toggle" role="group" aria-label="${label}">${options.map(([value, text]) =>
    `<button type="button" class="pp-toggle-btn${value === current ? ' active' : ''}" data-${attribute}="${value}" aria-pressed="${value === current}">${text}</button>`).join('')}</div>`;
}

// prefs: { view: 'card' | 'list', status: 'active' | 'inactive', canSeeInactive }
function peopleTogglesHtml(prefs) {
  return peopleToggleGroup('View', 'people-view', [['card', 'Cards'], ['list', 'List']], prefs.view)
    + (prefs.canSeeInactive ? peopleToggleGroup('Employees', 'people-status', [['active', 'Active'], ['inactive', 'Inactive']], prefs.status) : '');
}

const NO_TITLE = '<span class="pp-muted">No title yet</span>';
const INACTIVE_BADGE = '<span class="pp-badge pp-badge-inactive">Inactive</span>';

function peopleCardsHtml(people, h) {
  return `<div class="pp-grid">${people.map((p) => {
    const body = `
      ${h.avatar(p, 'lg')}
      <span class="pp-card-body">
        <span class="pp-card-name">${h.escape(h.name(p))} ${p.inactive ? INACTIVE_BADGE : h.presence(p)}</span>
        <span class="pp-card-title">${h.escape(p.jobTitle || '') || NO_TITLE}</span>
        ${p.department ? `<span class="pp-card-meta">${h.escape(p.department)}</span>` : ''}
        ${p.location ? `<span class="pp-card-meta">${h.escape(p.location)}</span>` : ''}
      </span>`;
    return p.inactive
      ? `<div class="pp-card pp-card-inactive">${body}</div>`
      : `<button type="button" class="pp-card" data-person="${Number(p.id)}">${body}</button>`;
  }).join('')}</div>`;
}

function peopleListHtml(people, h) {
  const cell = (value) => (value ? h.escape(value) : '<span class="pp-muted">—</span>');
  const rows = people.map((p) => {
    const cells = `
      <span class="pp-prow-name" role="cell">${h.avatar(p, 'sm')}<span>${h.escape(h.name(p))}</span> ${p.inactive ? INACTIVE_BADGE : h.presence(p)}</span>
      <span role="cell">${h.escape(p.jobTitle || '') || NO_TITLE}</span>
      <span role="cell">${cell(p.department)}</span>
      <span role="cell">${cell(p.location)}</span>`;
    return p.inactive
      ? `<div class="pp-prow pp-prow-inactive" role="row">${cells}</div>`
      : `<button type="button" class="pp-prow" data-person="${Number(p.id)}" role="row">${cells}</button>`;
  }).join('');
  return `<div class="pp-list" role="table">
    <div class="pp-list-head" role="row"><span role="columnheader">Name</span><span role="columnheader">Title</span><span role="columnheader">Department</span><span role="columnheader">Location</span></div>
    ${rows}</div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { peopleTogglesHtml, peopleCardsHtml, peopleListHtml };
}
