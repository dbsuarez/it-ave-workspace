// Knowledge Base (docs/superpowers/specs/2026-11-19-knowledge-base-design.md): what a person may send and the search helpers. Pure.
// Articles are Markdown text; categories hold them in an order HR sets.

const MAX_CATEGORY_TITLE = 80;
const MAX_ARTICLE_TITLE = 160;
const MAX_BODY = 100000;
const MAX_IMPORT = 200;
const MIN_SEARCH = 2;
const MAX_SEARCH = 100;

const fail = (status, message) => Object.assign(new Error(message), { status });

function cleanCategoryTitle(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title) throw fail(400, 'A category needs a title');
  if (title.length > MAX_CATEGORY_TITLE) throw fail(400, `A category title can have at most ${MAX_CATEGORY_TITLE} characters`);
  return title;
}

function cleanArticleTitle(value) {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title) throw fail(400, 'An article needs a title');
  if (title.length > MAX_ARTICLE_TITLE) throw fail(400, `An article title can have at most ${MAX_ARTICLE_TITLE} characters`);
  return title;
}

// The Markdown of an article. Empty is fine while it is being written.
function cleanBody(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw fail(400, 'The article text must be text');
  if (value.length > MAX_BODY) throw fail(400, 'An article can have at most 100,000 characters');
  return value;
}

// The ILIKE pattern for a search: % and _ and \ in what was typed match themselves.
function searchPattern(value) {
  const term = typeof value === 'string' ? value.trim() : '';
  if (term.length < MIN_SEARCH) throw fail(400, `Type at least ${MIN_SEARCH} characters to search`);
  if (term.length > MAX_SEARCH) throw fail(400, `A search can have at most ${MAX_SEARCH} characters`);
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&nbsp;': ' ' };
const plain = (text) => String(text || '').replace(/<br\s*\/?>/gi, ' ').replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (entity) => ENTITIES[entity]).replace(/[#*_`>~|]/g, ' ').replace(/(^|\s)-{2,}(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();

// A short piece of the article around the first match (or its start), without the Markdown marks. width: about how many characters.
function snippetFor(body, term, width = 160) {
  const text = plain(body);
  if (!text) return '';
  const at = text.toLowerCase().indexOf(String(term || '').trim().toLowerCase());
  if (at < 0 || text.length <= width) return text.length > width ? `${text.slice(0, width).trim()}…` : text;
  const start = Math.max(0, at - Math.floor((width - String(term).trim().length) / 2));
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

// ids: what the person sent; existing: the ids that are there. The new order must be exactly those ids.
function cleanOrderIds(ids, existing) {
  const wanted = new Set((existing || []).map(Number));
  if (!Array.isArray(ids) || ids.length !== wanted.size || !ids.every((id) => Number.isInteger(id) && wanted.has(id)) || new Set(ids).size !== ids.length) {
    throw fail(400, 'The new order must list every item once');
  }
  return ids;
}

// [{ title, body }] for an import: 1 to 200 articles.
function cleanImport(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_IMPORT) throw fail(400, `An import has 1 to ${MAX_IMPORT} articles`);
  return list.map((item) => ({ title: cleanArticleTitle(item && item.title), body: cleanBody(item && item.body) }));
}

// The screens an article can be shown on as a Help link (keys are the app's section names; People opens on tabs, so Leave and Attendance have their own).
const KB_SCREENS = [
  ['home', 'Home and channels'], ['activity', 'Activity'], ['later', 'Later'], ['files', 'Files'], ['notes', 'Notes'], ['canvas2', 'Canvas'],
  ['drawings', 'Drawings'], ['sheets', 'Sheets'], ['people', 'People'], ['leave', 'Leave'], ['attendance', 'Attendance'], ['huddle', 'Huddle'], ['lists', 'Lists'],
].map(([key, label]) => ({ key, label }));
const KB_SCREEN_KEYS = new Set(KB_SCREENS.map((s) => s.key));

function cleanScreenKey(value) {
  if (typeof value !== 'string' || !KB_SCREEN_KEYS.has(value)) throw fail(400, 'Choose one of the screens in the list');
  return value;
}

// The chosen screens of an article, each once, in the given order. Nothing chosen is an empty list.
function cleanScreens(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw fail(400, 'Choose screens from the list');
  return [...new Set(list.map(cleanScreenKey))];
}

module.exports = {
  fail, KB_SCREENS, cleanScreens, cleanScreenKey, cleanCategoryTitle, cleanArticleTitle, cleanBody, searchPattern, snippetFor, cleanOrderIds, cleanImport,
  MAX_CATEGORIES: 100, MAX_ARTICLES_PER_CATEGORY: 500, MAX_IMPORT,
};
