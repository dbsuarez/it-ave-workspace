// Knowledge Base API (docs/superpowers/specs/2026-11-19-knowledge-base-design.md). Every signed-in member reads and searches published
// articles; people with the Manage knowledge base permission (HR by default, Owners always) also see drafts and edit.
// The text of an article is a Canvas (kb_articles.canvas_id): HR writes it with the Canvas editor (pictures, history, comments, export);
// the article keeps its category, order, published state, title and the screens it helps with.
const fs = require('fs');
const path = require('path');
const express = require('express');
const { query, pool } = require('../db');
const authenticateToken = require('../middleware/auth');
const { can } = require('../permissions');
const { parseSections } = require('../canvasSections');
const { displayName } = require('../personName');
const config = require('../config');
const kb = require('../knowledgeBase');

const router = express.Router();
router.use(authenticateToken);
router.use(express.json({ limit: '1mb' })); // one article is at most 100,000 characters; an import can be a whole handbook

const parseId = (value) => (/^\d+$/.test(String(value)) ? Number(value) : null);
const needId = (value) => {
  const id = parseId(value);
  if (!id) throw kb.fail(400, 'A valid id is required');
  return id;
};

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

// The signed-in person: an active member (guests are kept out), and whether they manage the Knowledge Base.
async function reader(userId) {
  const row = (await query('SELECT account_type, deactivated_at FROM users WHERE id = $1', [userId])).rows[0];
  if (!row || row.account_type !== 'member' || row.deactivated_at) throw kb.fail(403, 'The Knowledge Base is for workspace members');
  return { userId, canManage: await can(query, userId, 'manage_knowledge_base') };
}

async function manager(userId) {
  const who = await reader(userId);
  if (!who.canManage) throw kb.fail(403, 'Only people who manage the Knowledge Base can change it');
  return who;
}

const mapArticle = (row, canManage = false) => ({
  id: row.id, categoryId: row.category_id, categoryTitle: row.category_title, title: row.title, published: row.published,
  updatedAt: row.updated_at, updatedByName: displayName({ username: row.updated_by_username, first_name: row.updated_by_first, middle_name: row.updated_by_middle, last_name: row.updated_by_last }) || null,
  ...(canManage ? { canvasId: row.canvas_id } : {}),
});

// An article with its text (from the canvas), when it was last changed (the later of the article and its canvas) and by whom.
const ARTICLE_SELECT = `SELECT a.id, a.category_id, c.title AS category_title, a.canvas_id, COALESCE(cv.title, a.title) AS title, COALESCE(cv.content, a.body) AS body,
         a.published, a.position, GREATEST(a.updated_at, COALESCE(cv.updated_at, a.updated_at)) AS updated_at,
         u.username AS updated_by_username, u.first_name AS updated_by_first, u.middle_name AS updated_by_middle, u.last_name AS updated_by_last
  FROM kb_articles a JOIN kb_categories c ON c.id = a.category_id
  LEFT JOIN canvases cv ON cv.id = a.canvas_id AND cv.deleted_at IS NULL
  LEFT JOIN users u ON u.id = CASE WHEN cv.updated_at > a.updated_at
       THEN COALESCE((SELECT r.edited_by FROM canvas_revisions r WHERE r.canvas_id = cv.id ORDER BY r.revision DESC LIMIT 1), a.updated_by) ELSE a.updated_by END`;

// The articles of a category the person may see, in order.
async function visibleArticles(categoryId, canManage) {
  return (await query(`${ARTICLE_SELECT} WHERE a.category_id = $1 AND (a.published OR $2::boolean) ORDER BY a.position, a.id`, [categoryId, canManage])).rows;
}

const screensOf = async (articleId) => (await query('SELECT screen_key FROM kb_article_screens WHERE article_id = $1 ORDER BY screen_key', [articleId])).rows.map((r) => r.screen_key);

async function setScreens(db, articleId, screens) {
  await db.query('DELETE FROM kb_article_screens WHERE article_id = $1', [articleId]);
  if (screens.length) await db.query('INSERT INTO kb_article_screens (article_id, screen_key) SELECT $1, UNNEST($2::text[])', [articleId, screens]);
}

// The picture files of these canvases are removed from the disk after the rows are gone.
async function filesOfCanvases(canvasIds) {
  if (!canvasIds.length) return [];
  return (await query('SELECT filename FROM files WHERE canvas_id = ANY($1::int[])', [canvasIds])).rows.map((r) => r.filename);
}
function removeFiles(filenames) {
  for (const name of filenames) fs.promises.unlink(path.join(config.UPLOAD_DIR, name)).catch(() => {});
}

// Makes the canvas (the article's text) and the article together. db: a client inside a transaction.
async function createArticleIn(db, { categoryId, title, body, published, screens, userId }) {
  const canvasId = (await db.query(
    "INSERT INTO canvases (kind, title, content, created_by, owner_id) VALUES ('standalone', $1, $2, $3, $3) RETURNING id", [title, body, userId])).rows[0].id;
  const id = (await db.query(
    `INSERT INTO kb_articles (category_id, title, body, published, published_at, position, created_by, updated_by, canvas_id)
     VALUES ($1, $2, '', $3, CASE WHEN $3 THEN NOW() END, COALESCE((SELECT MAX(position) + 1 FROM kb_articles WHERE category_id = $1), 1), $4, $4, $5) RETURNING id`,
    [categoryId, title, published, userId, canvasId])).rows[0].id;
  if (screens.length) await setScreens(db, id, screens);
  return id;
}

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

// ---- reading ----

router.get('/', async (req, res) => {
  try {
    const who = await reader(req.user.userId);
    const rows = (await query(
      `SELECT c.id, c.title, COUNT(a.id) FILTER (WHERE a.published)::int AS published_count, COUNT(a.id) FILTER (WHERE NOT a.published)::int AS draft_count
       FROM kb_categories c LEFT JOIN kb_articles a ON a.category_id = c.id GROUP BY c.id ORDER BY c.position, c.id`)).rows;
    const categories = rows
      .filter((row) => who.canManage || row.published_count > 0)
      .map((row) => ({ id: row.id, title: row.title, articleCount: row.published_count, ...(who.canManage ? { draftCount: row.draft_count } : {}) }));
    res.json({ canManage: who.canManage, categories, ...(who.canManage ? { screenOptions: kb.KB_SCREENS } : {}) });
  } catch (err) { sendError(res, err, 'Knowledge base home error'); }
});

router.get('/search', async (req, res) => {
  try {
    const who = await reader(req.user.userId);
    const pattern = kb.searchPattern(req.query.q);
    const term = String(req.query.q).trim();
    const rows = (await query(
      `SELECT a.id, COALESCE(cv.title, a.title) AS title, COALESCE(cv.content, a.body) AS body, a.category_id, c.title AS category_title, a.published,
              GREATEST(a.updated_at, COALESCE(cv.updated_at, a.updated_at)) AS updated_at
       FROM kb_articles a JOIN kb_categories c ON c.id = a.category_id LEFT JOIN canvases cv ON cv.id = a.canvas_id AND cv.deleted_at IS NULL
       WHERE (a.published OR $2::boolean) AND (COALESCE(cv.title, a.title) ILIKE $1 ESCAPE '\\' OR COALESCE(cv.content, a.body) ILIKE $1 ESCAPE '\\')
       ORDER BY (COALESCE(cv.title, a.title) ILIKE $1 ESCAPE '\\') DESC, 7 DESC, a.id LIMIT 30`, [pattern, who.canManage])).rows;
    res.json({ results: rows.map((row) => ({
      id: row.id, title: row.title, categoryId: row.category_id, categoryTitle: row.category_title, published: row.published,
      snippet: kb.snippetFor(row.body, term), updatedAt: row.updated_at,
    })) });
  } catch (err) { sendError(res, err, 'Knowledge base search error'); }
});

// The published articles that help with one screen of the app (shown there as Help links).
router.get('/screens/:key', async (req, res) => {
  try {
    await reader(req.user.userId);
    const key = kb.cleanScreenKey(req.params.key);
    const rows = (await query(
      `SELECT a.id, COALESCE(cv.title, a.title) AS title FROM kb_article_screens s JOIN kb_articles a ON a.id = s.article_id
       LEFT JOIN canvases cv ON cv.id = a.canvas_id AND cv.deleted_at IS NULL
       WHERE s.screen_key = $1 AND a.published ORDER BY COALESCE(cv.title, a.title), a.id`, [key])).rows;
    res.json({ articles: rows });
  } catch (err) { sendError(res, err, 'Knowledge base screen help error'); }
});

router.get('/categories/:id', async (req, res) => {
  try {
    const who = await reader(req.user.userId);
    const id = needId(req.params.id);
    const category = (await query('SELECT id, title FROM kb_categories WHERE id = $1', [id])).rows[0];
    if (!category) throw kb.fail(404, 'Category not found');
    res.json({ category, articles: (await visibleArticles(id, who.canManage)).map((row) => mapArticle(row, who.canManage)) });
  } catch (err) { sendError(res, err, 'Knowledge base category error'); }
});

router.get('/articles/:id', async (req, res) => {
  try {
    const who = await reader(req.user.userId);
    const id = needId(req.params.id);
    const row = (await query(`${ARTICLE_SELECT} WHERE a.id = $1`, [id])).rows[0];
    if (!row || (!row.published && !who.canManage)) throw kb.fail(404, 'Article not found');
    const siblings = await visibleArticles(row.category_id, who.canManage);
    const at = siblings.findIndex((entry) => entry.id === row.id);
    const brief = (entry) => (entry ? { id: entry.id, title: entry.title } : null);
    res.json({
      article: { ...mapArticle(row, who.canManage), body: row.body, screens: await screensOf(id) },
      sections: parseSections(row.body || '').map((section) => ({ id: section.id, type: section.type, text: section.text })),
      siblings: { previous: brief(siblings[at - 1]), next: brief(siblings[at + 1]) },
    });
  } catch (err) { sendError(res, err, 'Knowledge base article error'); }
});

// ---- categories ----

router.post('/categories', async (req, res) => {
  try {
    await manager(req.user.userId);
    const title = kb.cleanCategoryTitle(req.body && req.body.title);
    if ((await query('SELECT COUNT(*)::int AS n FROM kb_categories')).rows[0].n >= kb.MAX_CATEGORIES) throw kb.fail(400, `There can be at most ${kb.MAX_CATEGORIES} categories`);
    const category = (await query(
      'INSERT INTO kb_categories (title, position) VALUES ($1, COALESCE((SELECT MAX(position) + 1 FROM kb_categories), 1)) RETURNING id, title', [title])).rows[0];
    res.status(201).json({ category });
  } catch (err) { sendError(res, err, 'Create category error'); }
});

router.patch('/categories/:id', async (req, res) => {
  try {
    await manager(req.user.userId);
    const id = needId(req.params.id);
    const title = kb.cleanCategoryTitle(req.body && req.body.title);
    const row = (await query('UPDATE kb_categories SET title = $2 WHERE id = $1 RETURNING id, title', [id, title])).rows[0];
    if (!row) throw kb.fail(404, 'Category not found');
    res.json({ category: row });
  } catch (err) { sendError(res, err, 'Rename category error'); }
});

router.delete('/categories/:id', async (req, res) => {
  try {
    await manager(req.user.userId);
    const id = needId(req.params.id);
    const canvasIds = (await query('SELECT canvas_id FROM kb_articles WHERE category_id = $1 AND canvas_id IS NOT NULL', [id])).rows.map((r) => r.canvas_id);
    const filenames = await filesOfCanvases(canvasIds);
    const removed = await query('DELETE FROM kb_categories WHERE id = $1 RETURNING id', [id]); // its articles go with it
    if (!removed.rows.length) throw kb.fail(404, 'Category not found');
    if (canvasIds.length) await query('DELETE FROM canvases WHERE id = ANY($1::int[])', [canvasIds]); // the texts and their pictures
    removeFiles(filenames);
    res.json({ removed: true });
  } catch (err) { sendError(res, err, 'Delete category error'); }
});

async function saveOrder(table, idsInOrder, scopeSql, scopeParams) {
  await inTransaction(async (client) => {
    for (let i = 0; i < idsInOrder.length; i += 1) {
      await client.query(`UPDATE ${table} SET position = $1 WHERE id = $2 ${scopeSql}`, [i + 1, idsInOrder[i], ...scopeParams]);
    }
  });
}

router.put('/order', async (req, res) => {
  try {
    await manager(req.user.userId);
    const existing = (await query('SELECT id FROM kb_categories')).rows.map((r) => r.id);
    await saveOrder('kb_categories', kb.cleanOrderIds(req.body && req.body.ids, existing), '', []);
    res.json({ ok: true });
  } catch (err) { sendError(res, err, 'Order categories error'); }
});

router.put('/categories/:id/order', async (req, res) => {
  try {
    await manager(req.user.userId);
    const id = needId(req.params.id);
    if (!(await query('SELECT 1 FROM kb_categories WHERE id = $1', [id])).rows.length) throw kb.fail(404, 'Category not found');
    const existing = (await query('SELECT id FROM kb_articles WHERE category_id = $1', [id])).rows.map((r) => r.id);
    await saveOrder('kb_articles', kb.cleanOrderIds(req.body && req.body.ids, existing), 'AND category_id = $3', [id]);
    res.json({ ok: true });
  } catch (err) { sendError(res, err, 'Order articles error'); }
});

// ---- articles ----

async function articleCount(categoryId) {
  return (await query('SELECT COUNT(*)::int AS n FROM kb_articles WHERE category_id = $1', [categoryId])).rows[0].n;
}

router.post('/articles', async (req, res) => {
  try {
    const who = await manager(req.user.userId);
    const categoryId = needId(req.body && req.body.categoryId);
    if (!(await query('SELECT 1 FROM kb_categories WHERE id = $1', [categoryId])).rows.length) throw kb.fail(404, 'Category not found');
    if ((await articleCount(categoryId)) >= kb.MAX_ARTICLES_PER_CATEGORY) throw kb.fail(400, `A category can have at most ${kb.MAX_ARTICLES_PER_CATEGORY} articles`);
    const title = kb.cleanArticleTitle(req.body.title);
    const body = kb.cleanBody(req.body.body);
    const screens = kb.cleanScreens(req.body.screens);
    const id = await inTransaction((client) => createArticleIn(client, { categoryId, title, body, published: req.body.published === true, screens, userId: who.userId }));
    const row = (await query(`${ARTICLE_SELECT} WHERE a.id = $1`, [id])).rows[0];
    res.status(201).json({ article: { ...mapArticle(row, true), body: row.body, screens: await screensOf(id) } });
  } catch (err) { sendError(res, err, 'Create article error'); }
});

router.patch('/articles/:id', async (req, res) => {
  try {
    const who = await manager(req.user.userId);
    const id = needId(req.params.id);
    const body = req.body || {};
    const current = (await query('SELECT id, category_id, published, canvas_id FROM kb_articles WHERE id = $1', [id])).rows[0];
    if (!current) throw kb.fail(404, 'Article not found');
    const title = body.title !== undefined ? kb.cleanArticleTitle(body.title) : null;
    const text = body.body !== undefined ? kb.cleanBody(body.body) : null;
    const screens = body.screens !== undefined ? kb.cleanScreens(body.screens) : null;
    let categoryId = null;
    if (body.categoryId !== undefined) {
      categoryId = needId(body.categoryId);
      if (!(await query('SELECT 1 FROM kb_categories WHERE id = $1', [categoryId])).rows.length) throw kb.fail(404, 'Category not found');
      if (categoryId !== current.category_id && (await articleCount(categoryId)) >= kb.MAX_ARTICLES_PER_CATEGORY) throw kb.fail(400, `A category can have at most ${kb.MAX_ARTICLES_PER_CATEGORY} articles`);
    }
    await inTransaction(async (client) => {
      const sets = []; const params = [id];
      const set = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };
      let edited = false;
      if (title !== null) { set('title', title); edited = true; if (current.canvas_id) await client.query('UPDATE canvases SET title = $2 WHERE id = $1', [current.canvas_id, title]); }
      if (text !== null && current.canvas_id) {
        const canvas = (await client.query('UPDATE canvases SET content = $2, revision = revision + 1, updated_at = NOW() WHERE id = $1 RETURNING id, title, content, revision', [current.canvas_id, text])).rows[0];
        await client.query('INSERT INTO canvas_revisions (canvas_id, revision, title, content, edited_by) VALUES ($1, $2, $3, $4, $5)', [canvas.id, canvas.revision, canvas.title, canvas.content, who.userId]);
        edited = true;
      }
      if (body.published !== undefined) {
        const published = body.published === true;
        set('published', published);
        if (published && !current.published) sets.push('published_at = NOW()');
        edited = true;
      }
      if (categoryId !== null && categoryId !== current.category_id) {
        set('category_id', categoryId);
        sets.push(`position = COALESCE((SELECT MAX(position) + 1 FROM kb_articles WHERE category_id = $${params.length}), 1)`);
      }
      if (edited) { set('updated_by', who.userId); sets.push('updated_at = NOW()'); }
      if (sets.length) await client.query(`UPDATE kb_articles SET ${sets.join(', ')} WHERE id = $1`, params);
      if (screens !== null) await setScreens(client, id, screens);
    });
    const row = (await query(`${ARTICLE_SELECT} WHERE a.id = $1`, [id])).rows[0];
    res.json({ article: { ...mapArticle(row, true), body: row.body, screens: await screensOf(id) } });
  } catch (err) { sendError(res, err, 'Update article error'); }
});

router.delete('/articles/:id', async (req, res) => {
  try {
    await manager(req.user.userId);
    const id = needId(req.params.id);
    const article = (await query('SELECT canvas_id FROM kb_articles WHERE id = $1', [id])).rows[0];
    if (!article) throw kb.fail(404, 'Article not found');
    const filenames = await filesOfCanvases(article.canvas_id ? [article.canvas_id] : []);
    await query('DELETE FROM kb_articles WHERE id = $1', [id]);
    if (article.canvas_id) await query('DELETE FROM canvases WHERE id = $1', [article.canvas_id]); // the text, its history, comments and pictures
    removeFiles(filenames);
    res.json({ removed: true });
  } catch (err) { sendError(res, err, 'Delete article error'); }
});

// POST { articles: [{ title, body }], publish } -> { created }: the articles go at the end of the category, in the order given
// (drafts unless publish is true). This is how a handbook pasted from another tool becomes chapters.
router.post('/categories/:id/import', async (req, res) => {
  try {
    const who = await manager(req.user.userId);
    const categoryId = needId(req.params.id);
    if (!(await query('SELECT 1 FROM kb_categories WHERE id = $1', [categoryId])).rows.length) throw kb.fail(404, 'Category not found');
    const articles = kb.cleanImport(req.body && req.body.articles);
    if ((await articleCount(categoryId)) + articles.length > kb.MAX_ARTICLES_PER_CATEGORY) throw kb.fail(400, `A category can have at most ${kb.MAX_ARTICLES_PER_CATEGORY} articles`);
    const publish = Boolean(req.body.publish);
    await inTransaction(async (client) => {
      for (const article of articles) {
        await createArticleIn(client, { categoryId, title: article.title, body: article.body, published: publish, screens: [], userId: who.userId });
      }
    });
    res.status(201).json({ created: articles.length });
  } catch (err) { sendError(res, err, 'Import articles error'); }
});

module.exports = router;
