// Knowledge Base backup and restore (docs/superpowers/specs/2026-11-20-knowledge-base-backup-design.md): people who manage the Knowledge Base
// (HR by default, Owners always) save all of it, or the chosen categories and articles, to one file, and bring all or chosen articles back.
// The file travels as JSON (pictures inside), so this router parses its own, larger, bodies before the general parser.
const express = require('express');
const { query, pool } = require('../db');
const authenticateToken = require('../middleware/auth');
const { can } = require('../permissions');
const kb = require('../knowledgeBase');
const pkg = require('../knowledgeBasePackage');

const router = express.Router();
router.use(authenticateToken);
router.use(express.json({ limit: '120mb' }));

function sendError(res, err, label) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(`${label}:`, err);
  return res.status(500).json({ error: 'Server error' });
}

async function manager(userId) {
  const row = (await query('SELECT account_type, deactivated_at FROM users WHERE id = $1', [userId])).rows[0];
  if (!row || row.account_type !== 'member' || row.deactivated_at || !(await can(query, userId, 'manage_knowledge_base'))) {
    throw kb.fail(403, 'Only people who manage the Knowledge Base can back it up or restore it');
  }
  return userId;
}

const ids = (list) => (Array.isArray(list) ? [...new Set(list.filter((n) => Number.isInteger(n) && n > 0))] : []);

// What can be backed up: every category with its articles (for the checkboxes).
router.get('/outline', async (req, res) => {
  try {
    await manager(req.user.userId);
    const categories = (await query('SELECT id, title FROM kb_categories ORDER BY position, id')).rows;
    const articles = (await query(
      `SELECT a.id, a.category_id, COALESCE(cv.title, a.title) AS title, a.published FROM kb_articles a LEFT JOIN canvases cv ON cv.id = a.canvas_id ORDER BY a.category_id, a.position, a.id`)).rows;
    res.json({ categories: categories.map((c) => ({ id: c.id, title: c.title, articles: articles.filter((a) => a.category_id === c.id).map((a) => ({ id: a.id, title: a.title, published: a.published })) })) });
  } catch (err) { sendError(res, err, 'Knowledge base outline error'); }
});

// Body: { categoryIds, articleIds, parts: { pictures, screens, history, comments } }. Nothing chosen backs up everything.
router.post('/export', async (req, res) => {
  try {
    await manager(req.user.userId);
    const categoryIds = ids(req.body && req.body.categoryIds);
    const articleIds = ids(req.body && req.body.articleIds);
    const selection = categoryIds.length || articleIds.length ? { categoryIds, articleIds } : null;
    const built = await pkg.buildPackage({ query }, { selection, parts: (req.body && req.body.parts) || {} });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="knowledge-base-${stamp}.json"`);
    res.json(built);
  } catch (err) { sendError(res, err, 'Knowledge base export error'); }
});

// Body: { package }. Says what the file holds and which articles already exist.
router.post('/preview', async (req, res) => {
  try {
    await manager(req.user.userId);
    const clean = pkg.validatePackage(req.body && req.body.package);
    res.json(await pkg.describePackage({ query }, clean));
  } catch (err) { sendError(res, err, 'Knowledge base preview error'); }
});

// Body: { package, articles: [{ key, action: 'skip' | 'replace' | 'copy' }], parts: { pictures, screens, history, comments } }.
router.post('/restore', async (req, res) => {
  try {
    const userId = await manager(req.user.userId);
    const clean = pkg.validatePackage(req.body && req.body.package);
    if (!Array.isArray(req.body.articles)) throw kb.fail(400, 'Choose the articles to restore');
    const articles = req.body.articles.filter((entry) => entry && typeof entry.key === 'string').map((entry) => ({ key: entry.key, action: entry.action }));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await pkg.restorePackage(client, clean, { userId, articles, parts: req.body.parts || {} });
      await client.query('COMMIT');
      const { written, ...counts } = result;
      res.json(counts);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
  } catch (err) { sendError(res, err, 'Knowledge base restore error'); }
});

module.exports = router;
