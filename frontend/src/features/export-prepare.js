// IT Avenue Workspace - prepares a canvas for export: a mention alone on its line (shown in the app as a
// profile card) becomes a card in the PDF and in the Word file instead of plain "@name".
//
// Pure apart from DOMParser; covered by test/export-prepare.test.js. `lookup(username)` returns the person
// (as the app knows them) or null, and `photos` maps a lower-case username to its picture.

function exportPerson(person, username) {
  const role = person.accountType === 'guest' ? 'Guest' : person.isSuperadmin ? 'Superadmin' : '';
  return {
    username: person.username || username,
    email: person.email || '',
    jobTitle: person.jobTitle || '',
    role,
    status: person.status || '',
    statusText: [person.statusEmoji, person.statusText].filter(Boolean).join(' '),
    color: person.avatarColor || '#6B21A8',
  };
}

// The username when a paragraph holds one mention and nothing else but spaces, otherwise null.
function soloMentionName(node) {
  if (!node || node.type !== 'paragraph') return null;
  let name = null;
  for (const child of node.content || []) {
    if (child.type === 'mention' && name === null) name = child.attrs && child.attrs.username;
    else if (!(child.type === 'text' && !String(child.text || '').trim())) return null;
  }
  return name || null;
}

// Every username that sits alone on a line anywhere in the document (lower case, unique).
function soloMentionNames(doc, found = new Set()) {
  const name = soloMentionName(doc);
  if (name) found.add(String(name).toLowerCase());
  (doc && doc.content ? doc.content : []).forEach((child) => soloMentionNames(child, found));
  return found;
}

// The document with each solo mention of a known person replaced by a profileCard block.
function exportCardsInDoc(doc, lookup, photos = {}) {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return node;
    const name = soloMentionName(node);
    if (name) {
      const person = lookup(name);
      if (person) {
        const attrs = exportPerson(person, name);
        const photo = photos[String(name).toLowerCase()];
        if (photo) attrs.photo = { base64: photo.base64, width: photo.width, height: photo.height };
        return { type: 'profileCard', attrs };
      }
    }
    return node.content ? { ...node, content: node.content.map(walk) } : node;
  };
  return walk(doc);
}

// The editor's HTML with each solo mention of a known person replaced by a card block.
function exportCardsInHtml(html, lookup, photoUrls = {}) {
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  parsed.querySelectorAll('p').forEach((p) => {
    const only = p.children.length === 1 ? p.children[0] : null;
    if (!only || !only.matches('span[data-mention]') || p.textContent.trim() !== only.textContent.trim()) return;
    const username = only.getAttribute('data-mention');
    const person = lookup(username);
    if (!person) return;
    const info = exportPerson(person, username);
    const make = (tag, className, text) => {
      const el = parsed.createElement(tag);
      if (className) el.className = className;
      if (text !== undefined) el.textContent = text;
      return el;
    };
    const card = make('div', 'pcard');
    const avatar = make('div', 'pcard-avatar');
    const photo = photoUrls[String(username).toLowerCase()];
    if (photo) {
      avatar.style.backgroundImage = `url(${photo})`;
    } else {
      avatar.style.background = /^#[0-9a-fA-F]{6}$/.test(info.color) ? info.color : '#6B21A8';
      avatar.textContent = (info.username[0] || '?').toUpperCase();
    }
    const body = make('div', 'pcard-body');
    const name = make('div', 'pcard-name', info.username);
    name.appendChild(make('span', `pcard-dot${info.status === 'online' ? ' online' : ''}`));
    body.appendChild(name);
    const title = [info.jobTitle, info.role].filter(Boolean).join(' · ');
    if (title) body.appendChild(make('div', 'pcard-title', title));
    if (info.statusText) body.appendChild(make('div', 'pcard-status', info.statusText));
    if (info.email) body.appendChild(make('div', 'pcard-email', info.email));
    card.append(avatar, body);
    p.replaceWith(card);
  });
  return parsed.body.innerHTML;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { exportPerson, soloMentionName, soloMentionNames, exportCardsInDoc, exportCardsInHtml };
}
