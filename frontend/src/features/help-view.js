// IT Avenue Workspace - the Help screen's content: the user guide (docs/USER_GUIDE.md) as sections.
//
// Pure functions: markdown in, escaped HTML out. The guide uses a small subset of Markdown (# title, ## sections,
// ### questions, paragraphs, - and 1. lists, **bold**, *italic*, `code`); HTML comments are skipped. Loaded before
// help.js, which draws the screen.

function helpEscape(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function helpInline(value) {
  return helpEscape(value)
    .split(/(`[^`]+`|\*\*.+?\*\*|\*[^*]+\*)/g)
    .map((token) => {
      if (token.length > 2 && token.startsWith('`') && token.endsWith('`')) return `<code>${token.slice(1, -1)}</code>`;
      if (token.length > 4 && token.startsWith('**') && token.endsWith('**')) return `<strong>${token.slice(2, -2)}</strong>`;
      if (token.length > 2 && token.startsWith('*') && token.endsWith('*')) return `<em>${token.slice(1, -1)}</em>`;
      return token;
    }).join('');
}

function helpSlug(text, taken) {
  const base = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

// Body lines of one section -> HTML (### questions, paragraphs, lists).
function helpBlocksHtml(lines) {
  const out = [];
  let list = null; // 'ul' | 'ol'
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    const question = /^###\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (question) { close(); out.push(`<h3>${helpInline(question[1])}</h3>`); }
    else if (bullet || numbered) {
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${helpInline((bullet || numbered)[1])}</li>`);
    } else if (!line.trim()) close();
    else { close(); out.push(`<p>${helpInline(line)}</p>`); }
  }
  close();
  return out.join('');
}

// -> { title, sections: [{ id, title, html, text }] }; text is plain, for searching.
function helpSections(markdown) {
  const lines = String(markdown).split(/\r?\n/).filter((line) => !/^\s*<!--.*-->\s*$/.test(line));
  let title = 'Help';
  const sections = [];
  const taken = new Set();
  let current = null;
  for (const line of lines) {
    const h1 = /^#\s+(.+)$/.exec(line);
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h1 && !current) { title = h1[1].trim(); continue; }
    if (h2) { current = { title: h2[1].trim(), lines: [] }; sections.push(current); continue; }
    if (current) current.lines.push(line);
  }
  return {
    title,
    sections: sections.map((section) => ({
      id: helpSlug(section.title, taken),
      title: section.title,
      html: helpBlocksHtml(section.lines),
      text: `${section.title}\n${section.lines.join('\n').replace(/[*`#]/g, '')}`,
    })),
  };
}

// The sections where every typed word starts a word (any case): "pin" finds "pinned" but not "typing".
// No words keeps them all. Typed characters are matched literally, never as a pattern.
function helpFilter(sections, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return sections;
  // every symbol gets a backslash in front (code 92), so it is matched as typed and never as a pattern
  const literal = (word) => word.split('').map((ch) => (/[a-z0-9]/.test(ch) ? ch : String.fromCharCode(92) + ch)).join('');
  const patterns = words.map((word) => new RegExp(`(^|[^a-z0-9])${literal(word)}`));
  return sections.filter((section) => patterns.every((pattern) => pattern.test(section.text.toLowerCase())));
}

function helpTocHtml(sections, activeId) {
  return sections.map((section) => `<button type="button" class="help-toc-item${section.id === activeId ? ' active' : ''}" data-help-section="${helpEscape(section.id)}"${section.id === activeId ? ' aria-current="true"' : ''}>${helpEscape(section.title)}</button>`).join('');
}

function helpBodyHtml(sections) {
  return sections.map((section) => `<section class="help-section" id="help-${helpEscape(section.id)}"><h2>${helpEscape(section.title)}</h2>${section.html}</section>`).join('');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { helpSections, helpFilter, helpTocHtml, helpBodyHtml };
}
