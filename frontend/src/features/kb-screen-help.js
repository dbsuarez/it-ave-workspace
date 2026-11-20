// IT Avenue Workspace - Help links from other screens: when HR has linked Knowledge Base articles to a screen (Leave, Sheets, ...),
// a small "Help" chip at the top right of that screen opens them. Loaded after knowledge-base.js; renderer.js calls
// refreshScreenHelp(section) whenever the section changes, and the People screen calls it when its tab changes.

const KB_HELP_SECTIONS = new Set(['home', 'activity', 'later', 'files', 'notes', 'canvas2', 'drawings', 'sheets', 'people', 'huddle', 'lists']);
const KB_HELP_TTL_MS = 60 * 1000;
const kbHelpCache = new Map(); // screen key -> { at, articles }
let kbHelpArticles = [];
let kbHelpRequest = 0;

// The Knowledge Base key of what is on screen: People opens on tabs, and Leave and Attendance have help of their own.
function kbHelpKeyFor(section) {
  if (section === 'people') {
    const tab = typeof peopleState !== 'undefined' ? peopleState.tab : '';
    return tab === 'leave' || tab === 'attendance' ? tab : 'people';
  }
  return KB_HELP_SECTIONS.has(section) ? section : null;
}

async function kbHelpFor(key) {
  const cached = kbHelpCache.get(key);
  if (cached && Date.now() - cached.at < KB_HELP_TTL_MS) return cached.articles;
  const response = await api(`/api/kb/screens/${key}`);
  if (!response.ok) return []; // a guest, or the Knowledge Base is not available: no chip
  const articles = (await response.json()).articles || [];
  kbHelpCache.set(key, { at: Date.now(), articles });
  return articles;
}

function kbHideHelp() {
  const chip = document.getElementById('kb-help-chip');
  if (chip) chip.hidden = true;
  document.getElementById('kb-help-menu')?.remove();
}

async function refreshScreenHelp(section) {
  const chip = document.getElementById('kb-help-chip');
  if (!chip) return;
  kbHideHelp();
  const key = kbHelpKeyFor(section || state.section);
  if (!key) return;
  const request = ++kbHelpRequest;
  try {
    const articles = await kbHelpFor(key);
    if (request !== kbHelpRequest || !articles.length) return; // the person has moved on, or there is nothing to show
    kbHelpArticles = articles;
    chip.textContent = articles.length === 1 ? `Help: ${articles[0].title}` : `Help (${articles.length})`;
    chip.title = 'Open the Knowledge Base article for this screen';
    chip.hidden = false;
  } catch (err) { console.error('Screen help error:', err); }
}

async function kbOpenHelpArticle(id) {
  kbHideHelp();
  await setSection('knowledgebase');
  await openKbArticle(id);
}

if (typeof document !== 'undefined') {
  setupKbHelpWindow();
  document.addEventListener('click', (event) => {
    const chip = event.target.closest && event.target.closest('#kb-help-chip');
    const item = event.target.closest && event.target.closest('[data-kb-help-article]');
    // an article opens in a floating window over this screen, not in the Knowledge Base screen
    if (item) { document.getElementById('kb-help-menu')?.remove(); kbOpenHelpWindow(Number(item.dataset.kbHelpArticle)); return; }
    if (chip) {
      if (kbHelpArticles.length === 1) { kbOpenHelpWindow(kbHelpArticles[0].id); return; }
      const existing = document.getElementById('kb-help-menu');
      if (existing) { existing.remove(); return; }
      const menu = document.createElement('div');
      menu.id = 'kb-help-menu';
      menu.className = 'kb-help-menu';
      menu.innerHTML = kbHelpArticles.map((a) => `<button type="button" data-kb-help-article="${Number(a.id)}">${String(a.title).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))}</button>`).join('');
      chip.insertAdjacentElement('afterend', menu);
      return;
    }
    document.getElementById('kb-help-menu')?.remove();
  });
}
