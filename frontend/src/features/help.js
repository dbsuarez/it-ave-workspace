// IT Avenue Workspace - the Help screen: the user guide with a contents list and a search box.
// The text comes from help-guide.js (generated from docs/USER_GUIDE.md); help-view.js turns it into HTML.
// Opened by the ? button, Help > User guide, or F1. Loaded before renderer.js, which calls setupHelp().

const helpState = { title: 'Help', sections: [], active: null, query: '' };

function loadHelpSections() {
  if (helpState.sections.length) return;
  const guide = helpSections(HELP_GUIDE_MARKDOWN);
  helpState.title = guide.title;
  helpState.sections = guide.sections;
}

function renderHelp() {
  const modal = document.getElementById('help-modal');
  if (!modal) return;
  const shown = helpFilter(helpState.sections, helpState.query);
  if (!shown.some((section) => section.id === helpState.active)) helpState.active = shown[0] ? shown[0].id : null;
  modal.querySelector('#help-toc').innerHTML = helpTocHtml(shown, helpState.active);
  modal.querySelector('#help-body').innerHTML = shown.length
    ? helpBodyHtml(shown)
    : `<p class="help-empty">Nothing in the guide matches "${escapeHtml(helpState.query)}". Try a shorter word.</p>`;
}

function scrollHelpTo(sectionId) {
  helpState.active = sectionId;
  const modal = document.getElementById('help-modal');
  modal.querySelectorAll('.help-toc-item').forEach((item) => {
    const on = item.dataset.helpSection === sectionId;
    item.classList.toggle('active', on);
    if (on) item.setAttribute('aria-current', 'true'); else item.removeAttribute('aria-current');
  });
  document.getElementById(`help-${sectionId}`)?.scrollIntoView({ block: 'start' });
}

// sectionId (optional) opens the guide at that section, for example 'department-forums'.
function openHelp(sectionId) {
  const modal = document.getElementById('help-modal');
  if (!modal) return;
  loadHelpSections();
  helpState.query = '';
  helpState.active = helpState.sections.some((section) => section.id === sectionId) ? sectionId : (helpState.sections[0] || {}).id;
  const search = modal.querySelector('#help-search');
  if (search) search.value = '';
  modal.querySelector('#help-title').textContent = helpState.title;
  renderHelp();
  openSettingsModal(modal);
  if (sectionId && helpState.active === sectionId) scrollHelpTo(sectionId);
  search?.focus();
}

function setupHelp() {
  const modal = document.getElementById('help-modal');
  if (!modal) return;
  modal.querySelector('#help-search').addEventListener('input', (event) => {
    helpState.query = event.target.value;
    renderHelp();
    modal.querySelector('#help-body').scrollTop = 0;
  });
  modal.addEventListener('click', (event) => {
    if (event.target.closest('[data-help-close]')) { closeSettingsModal(); return; }
    const item = event.target.closest('[data-help-section]');
    if (item) scrollHelpTo(item.dataset.helpSection);
  });
}
