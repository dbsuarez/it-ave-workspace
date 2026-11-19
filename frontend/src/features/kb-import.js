// IT Avenue Workspace - Knowledge Base import: pasted Markdown (for example a handbook turned into text by another tool) split into
// articles at its headings, so HR can check the list and save it as chapters. Pure and tested (frontend/test/kb-import.test.js).

const KB_MAX_IMPORT = 200;
const KB_MAX_TITLE = 160;

// options: level (1 = split at "# ", 2 = at "## "), introTitle (when set, text before the first heading becomes an article with it),
// fallbackTitle (used when the text has no heading at that level). -> { articles: [{ title, body }], preamble, skipped }
function splitMarkdownIntoArticles(markdown, { level = 1, introTitle = '', fallbackTitle = 'Imported text' } = {}) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const marker = new RegExp(`^#{${level}}\\s+(.+?)\\s*#*\\s*$`);
  const sections = [];
  let current = null;
  const preamble = [];
  let fence = null;
  for (const line of lines) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
    }
    const heading = !fence && !fenceMatch ? marker.exec(line) : null;
    if (heading) {
      current = { title: heading[1].trim().slice(0, KB_MAX_TITLE), lines: [] };
      sections.push(current);
    } else if (current) current.lines.push(line);
    else preamble.push(line);
  }
  const intro = preamble.join('\n').trim();
  let articles = sections.map((section) => ({ title: section.title, body: section.lines.join('\n').trim() })).filter((article) => article.title);
  if (!sections.length) {
    articles = intro ? [{ title: fallbackTitle, body: intro }] : [];
    return { articles, preamble: '', skipped: 0 };
  }
  if (intro && introTitle) articles.unshift({ title: introTitle, body: intro });
  const skipped = Math.max(0, articles.length - KB_MAX_IMPORT);
  return { articles: articles.slice(0, KB_MAX_IMPORT), preamble: intro, skipped };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { splitMarkdownIntoArticles, KB_MAX_IMPORT };
}
