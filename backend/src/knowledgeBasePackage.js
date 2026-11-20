// Knowledge Base package: the whole Knowledge Base (or the chosen part of it) as one file that can be saved, checked and restored.
// Used by the Backup and Restore buttons of the Knowledge Base and by the workspace reset, which keeps the Knowledge Base through it.
// The file is JSON: readable by hand, no dependency on the database version. Pictures are inside it (base64).
// docs/superpowers/specs/2026-11-20-knowledge-base-backup-design.md
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const kb = require('./knowledgeBase');
const { fullName } = require('./personName');

const FORMAT = 'itavenue-knowledge-base';
const VERSION = 1;
const PART_NAMES = ['pictures', 'screens', 'history', 'comments'];
const MAX_PICTURE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_PICTURE_BYTES = 80 * 1024 * 1024;
const MAX_PICTURES = 2000;
const MAX_HISTORY = 100;
const MAX_COMMENTS = 1000;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const ACTIONS = new Set(['skip', 'replace', 'copy']);

const asDate = (value) => (value ? new Date(value).toISOString() : null);

// ---- export ------------------------------------------------------------------------------------------------------------

// db: anything with query(). selection: null (everything) or { categoryIds, articleIds } (a chosen category brings all its articles).
// parts: which extras go in: { pictures, screens, history, comments }.
async function buildPackage(db, { selection = null, parts = {} } = {}) {
  const use = Object.fromEntries(PART_NAMES.map((name) => [name, Boolean(parts[name])]));
  const wantCategory = new Set((selection && selection.categoryIds) || []);
  const wantArticle = new Set((selection && selection.articleIds) || []);
  const picked = (category, article) => !selection || wantCategory.has(category) || wantArticle.has(article);

  const categories = (await db.query('SELECT id, title, position FROM kb_categories ORDER BY position, id')).rows;
  const articles = (await db.query(
    `SELECT a.id, a.category_id, a.title AS article_title, a.body, a.published, a.position, a.canvas_id, cv.title AS canvas_title, cv.content
     FROM kb_articles a LEFT JOIN canvases cv ON cv.id = a.canvas_id ORDER BY a.category_id, a.position, a.id`)).rows
    .filter((row) => picked(row.category_id, row.id));
  const articleIds = articles.map((row) => row.id);
  const canvasIds = articles.map((row) => row.canvas_id).filter(Boolean);

  const screens = new Map();
  if (use.screens && articleIds.length) {
    for (const row of (await db.query('SELECT article_id, screen_key FROM kb_article_screens WHERE article_id = ANY($1::int[]) ORDER BY screen_key', [articleIds])).rows) {
      if (!screens.has(row.article_id)) screens.set(row.article_id, []);
      screens.get(row.article_id).push(row.screen_key);
    }
  }
  const history = new Map();
  if (use.history && canvasIds.length) {
    for (const row of (await db.query('SELECT canvas_id, title, content, edited_by, edited_at FROM canvas_revisions WHERE canvas_id = ANY($1::int[]) ORDER BY canvas_id, revision', [canvasIds])).rows) {
      if (!history.has(row.canvas_id)) history.set(row.canvas_id, []);
      history.get(row.canvas_id).push({ title: row.title, content: row.content, editedBy: row.edited_by, editedAt: asDate(row.edited_at) });
    }
  }
  const comments = new Map();
  if (use.comments && canvasIds.length) {
    for (const row of (await db.query(
      `SELECT m.id, m.canvas_id, m.parent_id, m.user_id, m.body, m.anchor, m.resolved_at, m.created_at, u.first_name, u.middle_name, u.last_name, u.username
       FROM canvas_comments m LEFT JOIN users u ON u.id = m.user_id WHERE m.canvas_id = ANY($1::int[]) ORDER BY m.id`, [canvasIds])).rows) {
      if (!comments.has(row.canvas_id)) comments.set(row.canvas_id, []);
      comments.get(row.canvas_id).push({
        key: `m${row.id}`, parent: row.parent_id ? `m${row.parent_id}` : null, userId: row.user_id, name: fullName(row) || row.username || '',
        body: row.body, anchor: row.anchor || null, resolved: Boolean(row.resolved_at), createdAt: asDate(row.created_at),
      });
    }
  }
  const pictures = {};
  const pictureKeys = new Map();
  if (use.pictures && canvasIds.length) {
    let total = 0;
    for (const row of (await db.query('SELECT id, canvas_id, filename, original_name, mime_type FROM files WHERE canvas_id = ANY($1::int[]) ORDER BY id', [canvasIds])).rows) {
      if (!IMAGE_TYPES[row.mime_type]) continue;
      let data;
      try { data = await fs.promises.readFile(path.join(config.UPLOAD_DIR, row.filename)); } catch { continue; } // a picture missing on disk is left out
      total += data.length;
      if (total > MAX_TOTAL_PICTURE_BYTES) throw kb.fail(413, 'The pictures are too big to put in one backup. Leave Pictures out, or back up fewer articles.');
      pictures[String(row.id)] = { name: row.original_name || `picture-${row.id}.${IMAGE_TYPES[row.mime_type]}`, mime: row.mime_type, data: data.toString('base64') };
      if (!pictureKeys.has(row.canvas_id)) pictureKeys.set(row.canvas_id, []);
      pictureKeys.get(row.canvas_id).push(String(row.id));
    }
  }

  const byCategory = new Map();
  for (const row of articles) {
    if (!byCategory.has(row.category_id)) byCategory.set(row.category_id, []);
    const article = {
      key: `a${row.id}`, title: row.canvas_title || row.article_title, published: Boolean(row.published), position: row.position,
      text: row.canvas_id ? row.content || '' : row.body || '',
    };
    if (use.screens) article.screens = screens.get(row.id) || [];
    if (use.history) article.history = history.get(row.canvas_id) || [];
    if (use.comments) article.comments = comments.get(row.canvas_id) || [];
    if (use.pictures) article.pictures = pictureKeys.get(row.canvas_id) || [];
    byCategory.get(row.category_id).push(article);
  }
  return {
    format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), parts: use,
    categories: categories
      .filter((category) => byCategory.has(category.id) || wantCategory.has(category.id) || !selection)
      .map((category) => ({ key: `c${category.id}`, title: category.title, position: category.position, articles: byCategory.get(category.id) || [] })),
    pictures,
  };
}

// ---- checking a file ---------------------------------------------------------------------------------------------------

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

// Reads only what it knows, checks every limit, and returns a clean copy. Throws a 400 with a plain message.
function validatePackage(raw) {
  if (!raw || typeof raw !== 'object' || raw.format !== FORMAT) throw kb.fail(400, 'This is not a Knowledge Base backup file');
  if (!Number.isInteger(raw.version) || raw.version > VERSION) throw kb.fail(400, 'This backup was made by a newer version of the app (version number is newer than this app understands)');
  if (!Array.isArray(raw.categories) || raw.categories.length > kb.MAX_CATEGORIES) throw kb.fail(400, `A backup holds at most ${kb.MAX_CATEGORIES} categories`);
  const parts = Object.fromEntries(PART_NAMES.map((name) => [name, Boolean(raw.parts && raw.parts[name])]));

  const pictures = {};
  const rawPictures = raw.pictures && typeof raw.pictures === 'object' ? raw.pictures : {};
  if (Object.keys(rawPictures).length > MAX_PICTURES) throw kb.fail(400, 'This backup holds too many pictures');
  for (const [key, picture] of Object.entries(rawPictures)) {
    const ext = picture && IMAGE_TYPES[picture.mime];
    if (!ext || typeof picture.data !== 'string' || !/^[A-Za-z0-9+/=\r\n]*$/.test(picture.data)) throw kb.fail(400, 'A picture in this backup is not a PNG, JPG, GIF or WebP image');
    if (Buffer.byteLength(picture.data, 'base64') > MAX_PICTURE_BYTES) throw kb.fail(400, 'A picture in this backup is bigger than 10 MB');
    pictures[String(key).slice(0, 20)] = { name: text(picture.name, 120) || `picture.${ext}`, mime: picture.mime, data: picture.data.replace(/\s+/g, '') };
  }

  const seen = new Set();
  const unique = (key, label) => {
    const value = text(key, 40);
    if (!value || seen.has(value)) throw kb.fail(400, `${label} in this backup has a missing or repeated key`);
    seen.add(value);
    return value;
  };
  const categories = raw.categories.map((category) => {
    if (!category || typeof category !== 'object') throw kb.fail(400, 'A category in this backup is not readable');
    const articles = Array.isArray(category.articles) ? category.articles : [];
    if (articles.length > kb.MAX_ARTICLES_PER_CATEGORY) throw kb.fail(400, `A category holds at most ${kb.MAX_ARTICLES_PER_CATEGORY} articles`);
    return {
      key: unique(category.key, 'A category'),
      title: kb.cleanCategoryTitle(category.title),
      articles: articles.map((article) => {
        if (!article || typeof article !== 'object') throw kb.fail(400, 'An article in this backup is not readable');
        const clean = {
          key: unique(article.key, 'An article'), title: kb.cleanArticleTitle(article.title), published: Boolean(article.published), text: kb.cleanBody(article.text || ''),
        };
        if (parts.screens) clean.screens = kb.cleanScreens(article.screens);
        if (parts.pictures) clean.pictures = (Array.isArray(article.pictures) ? article.pictures : []).map(String).filter((key) => pictures[key]);
        if (parts.history) {
          clean.history = (Array.isArray(article.history) ? article.history : []).slice(-MAX_HISTORY)
            .map((entry) => ({ title: text(entry && entry.title, 160) || clean.title, content: kb.cleanBody(entry && entry.content), editedBy: Number.isInteger(entry && entry.editedBy) ? entry.editedBy : null, editedAt: entry && entry.editedAt ? new Date(entry.editedAt).toISOString() : null }))
            .filter((entry) => !Number.isNaN(Date.parse(entry.editedAt || new Date().toISOString())));
        }
        if (parts.comments) {
          clean.comments = (Array.isArray(article.comments) ? article.comments : []).slice(0, MAX_COMMENTS)
            .map((comment) => ({
              key: text(comment && comment.key, 40), parent: comment && comment.parent ? text(comment.parent, 40) : null, userId: Number.isInteger(comment && comment.userId) ? comment.userId : null,
              name: text(comment && comment.name, 120), body: text(comment && comment.body, 5000), anchor: comment && comment.anchor ? text(comment.anchor, 500) : null,
              resolved: Boolean(comment && comment.resolved), createdAt: comment && comment.createdAt && !Number.isNaN(Date.parse(comment.createdAt)) ? new Date(comment.createdAt).toISOString() : null,
            }))
            .filter((comment) => comment.key && comment.body);
        }
        return clean;
      }),
    };
  });
  return { format: FORMAT, version: raw.version, exportedAt: raw.exportedAt ? text(raw.exportedAt, 40) : null, parts, categories, pictures };
}

async function findCategory(db, title) {
  return (await db.query('SELECT id FROM kb_categories WHERE LOWER(BTRIM(title)) = LOWER(BTRIM($1)) ORDER BY id LIMIT 1', [title])).rows[0] || null;
}

async function findArticle(db, categoryId, title) {
  return (await db.query(
    `SELECT a.id, a.canvas_id FROM kb_articles a LEFT JOIN canvases cv ON cv.id = a.canvas_id
     WHERE a.category_id = $1 AND LOWER(BTRIM(COALESCE(cv.title, a.title))) = LOWER(BTRIM($2)) ORDER BY a.id LIMIT 1`, [categoryId, title])).rows[0] || null;
}

// What is in the file, and which of its articles are already in the Knowledge Base (same category and title).
async function describePackage(db, pkg) {
  const categories = [];
  for (const category of pkg.categories) {
    const existing = await findCategory(db, category.title);
    const articles = [];
    for (const article of category.articles) {
      articles.push({ key: article.key, title: article.title, published: article.published, exists: existing ? Boolean(await findArticle(db, existing.id, article.title)) : false });
    }
    categories.push({ key: category.key, title: category.title, exists: Boolean(existing), articles });
  }
  return { exportedAt: pkg.exportedAt, parts: pkg.parts, pictureCount: Object.keys(pkg.pictures).length, categories };
}

// ---- restore -----------------------------------------------------------------------------------------------------------

const safeName = (name) => String(name || 'picture').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'picture';

// client: a database client inside a transaction (the caller commits). options:
//   userId   who restores (the author of what is created)
//   articles null = every article in the file; or [{ key, action }] = only these, action 'skip' | 'replace' | 'copy' for an article that already exists
//   parts    { pictures, screens, history, comments } set to false to leave one out (default: everything the file has)
// Returns counts and the files written. If it fails, the picture files it wrote are removed again.
async function restorePackage(client, pkg, { userId, articles = null, parts = {} } = {}) {
  const use = Object.fromEntries(PART_NAMES.map((name) => [name, Boolean(pkg.parts[name]) && parts[name] !== false]));
  const chosen = articles === null ? null : new Map(articles.map((entry) => [entry.key, ACTIONS.has(entry.action) ? entry.action : 'skip']));
  const written = [];
  const result = { created: 0, replaced: 0, copied: 0, skipped: 0, categoriesCreated: 0 };

  const addPictures = async (canvasId, article) => {
    const map = new Map();
    if (!use.pictures) return map;
    await fs.promises.mkdir(config.UPLOAD_DIR, { recursive: true });
    for (const key of article.pictures || []) {
      const picture = pkg.pictures[key];
      if (!picture) continue;
      const data = Buffer.from(picture.data, 'base64');
      let name = safeName(picture.name);
      if (!/\.(png|jpe?g|gif|webp)$/i.test(name)) name = `${name}.${IMAGE_TYPES[picture.mime]}`;
      const filename = `${Date.now()}-${crypto.randomInt(1e9)}-${name}`;
      await fs.promises.writeFile(path.join(config.UPLOAD_DIR, filename), data);
      written.push(filename);
      const id = (await client.query(
        'INSERT INTO files (canvas_id, filename, original_name, size, mime_type, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [canvasId, filename, picture.name, data.length, picture.mime, userId])).rows[0].id;
      map.set(key, id);
    }
    return map;
  };
  const remap = (content, map) => (map.size ? content.replace(/\(file:(\d+)/g, (whole, id) => (map.has(id) ? `(file:${map.get(id)}` : whole)) : content);
  const knownUser = async (id) => (id && (await client.query('SELECT 1 FROM users WHERE id = $1', [id])).rows.length ? id : null);

  const createArticle = async (categoryId, article, title) => {
    const canvasId = (await client.query("INSERT INTO canvases (kind, title, content, created_by, owner_id) VALUES ('standalone', $1, '', $2, $2) RETURNING id", [title, userId])).rows[0].id;
    const pictureMap = await addPictures(canvasId, article);
    const content = remap(article.text, pictureMap);
    const history = use.history ? article.history || [] : [];
    await client.query('UPDATE canvases SET content = $2, revision = $3 WHERE id = $1', [canvasId, content, history.length + 1]);
    const id = (await client.query(
      `INSERT INTO kb_articles (category_id, title, body, published, published_at, position, created_by, updated_by, canvas_id)
       VALUES ($1, $2, '', $3, CASE WHEN $3 THEN NOW() END, COALESCE((SELECT MAX(position) + 1 FROM kb_articles WHERE category_id = $1), 1), $4, $4, $5) RETURNING id`,
      [categoryId, title, article.published, userId, canvasId])).rows[0].id;
    if (use.screens && (article.screens || []).length) await client.query('INSERT INTO kb_article_screens (article_id, screen_key) SELECT $1, UNNEST($2::text[])', [id, article.screens]);
    let revision = 0;
    for (const entry of history) {
      revision += 1;
      await client.query(
        'INSERT INTO canvas_revisions (canvas_id, revision, title, content, edited_by, edited_at) VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()))',
        [canvasId, revision, entry.title, remap(entry.content, pictureMap), await knownUser(entry.editedBy), entry.editedAt]);
    }
    if (use.comments) {
      const newIds = new Map();
      for (const comment of article.comments || []) {
        const parent = comment.parent && newIds.has(comment.parent) ? newIds.get(comment.parent) : null;
        const newId = (await client.query(
          `INSERT INTO canvas_comments (canvas_id, parent_id, user_id, body, anchor, resolved_at, created_at)
           VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN NOW() END, COALESCE($7::timestamptz, NOW())) RETURNING id`,
          [canvasId, parent, await knownUser(comment.userId), comment.body, comment.anchor, comment.resolved, comment.createdAt])).rows[0].id;
        newIds.set(comment.key, newId);
      }
    }
    return id;
  };

  const replaceArticle = async (existing, article) => {
    const old = (await client.query('SELECT id, title, content, revision FROM canvases WHERE id = $1 FOR UPDATE', [existing.canvas_id])).rows[0];
    if (!old) return;
    // what is being replaced stays in the history
    await client.query(
      `INSERT INTO canvas_revisions (canvas_id, revision, title, content, edited_by) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (canvas_id, revision) DO UPDATE SET title = EXCLUDED.title, content = EXCLUDED.content, edited_by = EXCLUDED.edited_by, edited_at = NOW()`,
      [old.id, old.revision, old.title, old.content, userId]);
    const pictureMap = await addPictures(old.id, article);
    await client.query('UPDATE canvases SET title = $2, content = $3, revision = revision + 1, updated_at = NOW() WHERE id = $1', [old.id, article.title, remap(article.text, pictureMap)]);
    await client.query(
      'UPDATE kb_articles SET title = $2, published = $3, published_at = CASE WHEN $3 AND published_at IS NULL THEN NOW() WHEN NOT $3 THEN NULL ELSE published_at END, updated_by = $4, updated_at = NOW() WHERE id = $1',
      [existing.id, article.title, article.published, userId]);
    if (use.screens) {
      await client.query('DELETE FROM kb_article_screens WHERE article_id = $1', [existing.id]);
      if ((article.screens || []).length) await client.query('INSERT INTO kb_article_screens (article_id, screen_key) SELECT $1, UNNEST($2::text[])', [existing.id, article.screens]);
    }
  };

  try {
    for (const category of pkg.categories) {
      const todo = category.articles.filter((article) => !chosen || chosen.has(article.key));
      if (!todo.length) continue;
      let found = await findCategory(client, category.title);
      if (!found) {
        found = (await client.query('INSERT INTO kb_categories (title, position) VALUES ($1, COALESCE((SELECT MAX(position) + 1 FROM kb_categories), 1)) RETURNING id', [category.title])).rows[0];
        result.categoriesCreated += 1;
      }
      for (const article of todo) {
        const existing = await findArticle(client, found.id, article.title);
        if (!existing) { await createArticle(found.id, article, article.title); result.created += 1; continue; }
        const action = chosen ? chosen.get(article.key) : 'skip';
        if (action === 'replace') { await replaceArticle(existing, article); result.replaced += 1; }
        else if (action === 'copy') {
          let title = `${article.title} (restored)`.slice(0, 160);
          for (let n = 2; await findArticle(client, found.id, title); n += 1) title = `${article.title} (restored ${n})`.slice(0, 160);
          await createArticle(found.id, article, title);
          result.copied += 1;
        } else result.skipped += 1;
      }
    }
  } catch (err) {
    await Promise.all(written.map((name) => fs.promises.unlink(path.join(config.UPLOAD_DIR, name)).catch(() => {})));
    throw err;
  }
  return { ...result, written };
}

module.exports = { FORMAT, VERSION, PART_NAMES, buildPackage, validatePackage, describePackage, restorePackage };
