// IT Avenue Workspace - the changelog (CHANGELOG.md at the repository root): reading it, choosing what to show after an update, and the notes
// that go into the update file. Pure and tested (frontend/test/changelog.test.js). Used by the app and by scripts/release.js.
//
// CHANGELOG.md looks like:
//   ## 1.2.0 - 2026-12-01
//   ### New
//   - one short, plain-language line per change
//   ### Fixed
//   - ...

const CL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// -> [{ version, date, groups: [{ title, items: [text] }] }], in file order (newest first)
function parseChangelog(markdown) {
  const entries = [];
  let entry = null;
  let group = null;
  for (const raw of String(markdown || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const head = /^##\s+v?(\d+(?:\.\d+){1,3})(?:\s*[-–—]\s*(\d{4}-\d{2}-\d{2}))?\s*$/.exec(line);
    if (head) { entry = { version: head[1], date: head[2] || '', groups: [] }; entries.push(entry); group = null; continue; }
    if (!entry) continue;
    const title = /^###\s+(.+)$/.exec(line);
    if (title) { group = { title: title[1].trim(), items: [] }; entry.groups.push(group); continue; }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const text = bullet ? bullet[1].trim() : line.trim();
    if (!text) continue;
    if (!group) { group = { title: '', items: [] }; entry.groups.push(group); }
    group.items.push(text);
  }
  return entries;
}

function compareVersions(a, b) {
  const part = (version) => String(version || '').replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const x = part(a);
  const y = part(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// What to show after an update: the entries newer than `lastSeen` and no newer than the running version. A first run (no lastSeen) shows only
// the running version.
function entriesSince(entries, lastSeen, current) {
  if (!lastSeen) return entries.filter((entry) => compareVersions(entry.version, current) === 0);
  return entries.filter((entry) => compareVersions(entry.version, lastSeen) > 0 && compareVersions(entry.version, current) <= 0);
}

// The notes of one version as plain text (they go into the update file). null when the version has no entry.
function notesFor(entries, version) {
  const entry = entries.find((e) => compareVersions(e.version, version) === 0);
  if (!entry) return null;
  return entry.groups.map((g) => `${g.title ? `${g.title}\n` : ''}${g.items.map((item) => `- ${item}`).join('\n')}`).join('\n\n');
}

const clEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clInline = (text) => clEscape(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');

function clDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return match ? `${Number(match[3])} ${CL_MONTHS[Number(match[2]) - 1] || ''} ${match[1]}` : '';
}

function whatsNewHtml(entries) {
  return (entries || []).map((entry) => `<section class="cl-entry"><h3>Version ${clEscape(entry.version)}${entry.date ? ` <small>${clEscape(clDate(entry.date))}</small>` : ''}</h3>${entry.groups.map((group) => `${group.title ? `<h4>${clEscape(group.title)}</h4>` : ''}<ul>${group.items.map((item) => `<li>${clInline(item)}</li>`).join('')}</ul>`).join('')}</section>`).join('');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseChangelog, compareVersions, entriesSince, notesFor, whatsNewHtml };
}
