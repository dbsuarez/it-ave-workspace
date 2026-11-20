const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
const config = require('./config');
const recovery = require('./backupRecovery');
const { ensureDefaultChannels } = require('./defaultChannels');
const kbPackage = require('./knowledgeBasePackage');

let resetting = false;

const countSql = `SELECT
  (SELECT COUNT(*) FROM messages) + (SELECT COUNT(*) FROM direct_messages) + (SELECT COUNT(*) FROM conversation_messages) AS messages,
  (SELECT COUNT(*) FROM files) AS files,
  (SELECT COUNT(*) FROM canvases WHERE id NOT IN (SELECT canvas_id FROM kb_articles WHERE canvas_id IS NOT NULL)) + (SELECT COUNT(*) FROM channel_canvases) AS canvases,
  (SELECT COUNT(*) FROM kb_articles) AS kb_articles,
  (SELECT COUNT(*) FROM channel_lists) AS lists,
  (SELECT COUNT(*) FROM moderation_audit_log) + (SELECT COUNT(*) FROM command_audit_log) AS audit_entries,
  (SELECT COUNT(*) FROM saved_items) + (SELECT COUNT(*) FROM reminders) + (SELECT COUNT(*) FROM scheduled_messages) AS personal_items,
  (SELECT COUNT(*) FROM attendance_records) + (SELECT COUNT(*) FROM attendance_punches) + (SELECT COUNT(*) FROM attendance_corrections) + (SELECT COUNT(*) FROM leave_requests) AS workforce_records`;

async function preview() {
  const row = (await pool.query(countSql)).rows[0];
  return {
    messages: Number(row.messages), files: Number(row.files), canvases: Number(row.canvases), knowledgeBaseArticles: Number(row.kb_articles), lists: Number(row.lists),
    auditEntries: Number(row.audit_entries), personalItems: Number(row.personal_items), workforceRecords: Number(row.workforce_records),
  };
}

async function clearUploads() {
  await fs.promises.mkdir(config.UPLOAD_DIR, { recursive: true });
  // People stay after a reset, so the profile photos they still use must stay too (they live in the same folder)
  const keep = new Set((await pool.query('SELECT photo_file FROM users WHERE photo_file IS NOT NULL')).rows.map((row) => row.photo_file));
  for (const name of await fs.promises.readdir(config.UPLOAD_DIR)) {
    if (keep.has(name)) continue;
    await fs.promises.rm(path.join(config.UPLOAD_DIR, name), { recursive: true, force: true });
  }
}

async function clearDatabase(client) {
  await client.query(`TRUNCATE TABLE
    messages, direct_messages, conversations, files, notes,
    channel_lists, channel_canvases, canvases,
    moderation_audit_log, command_audit_log, channel_timeouts, message_reports,
    saved_items, reminders, scheduled_messages, channel_links, invitations,
    attendance_records, attendance_punches, attendance_corrections, leave_requests,
    employee_tasks, profile_likes
    RESTART IDENTITY CASCADE`);
  await client.query('UPDATE users SET token_version = token_version + 1, profile_visit_count = 0, status = $1', ['offline']);
  await client.query('UPDATE channel_members SET last_message_at = NULL');
}

// The Knowledge Base is packed before work() wipes things and put back afterwards, so it survives a reset (a copy of the package is
// also kept next to the backups). A package that cannot be built stops the reset before anything is deleted; one that cannot be put
// back is reported, and the kept file can be restored from the Knowledge Base screen.
async function preserveKnowledgeBase(db, work, actorId) {
  const everything = Object.fromEntries(kbPackage.PART_NAMES.map((name) => [name, true]));
  const pkg = kbPackage.validatePackage(JSON.parse(JSON.stringify(await kbPackage.buildPackage(db, { parts: everything }))));
  await fs.promises.mkdir(config.BACKUP_DIR, { recursive: true });
  const file = path.join(config.BACKUP_DIR, `knowledge-base-before-reset-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.promises.writeFile(file, JSON.stringify(pkg));
  const articleCount = pkg.categories.reduce((sum, category) => sum + category.articles.length, 0);
  await work();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await kbPackage.restorePackage(client, pkg, { userId: actorId });
    await client.query('COMMIT');
    return { restored: true, file, articles: articleCount, created: result.created };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Knowledge Base restore after reset failed:', err);
    return { restored: false, file, articles: articleCount, error: err.message };
  } finally { client.release(); }
}

async function resetWorkspace(actorId, { keepKnowledgeBase = true } = {}) {
  if (resetting) throw Object.assign(new Error('Workspace reset is already running'), { status: 409 });
  resetting = true;
  const before = await preview();
  let safetyBackup;
  let cleanBackup;
  try {
    safetyBackup = await recovery.createBackup({ reason: 'before-workspace-reset' });
    await recovery.validateBackup(safetyBackup.stamp);
    const wipe = async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await clearDatabase(client);
        await ensureDefaultChannels(client);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally { client.release(); }
      await clearUploads();
    };
    let knowledgeBase = { kept: false };
    if (keepKnowledgeBase) knowledgeBase = { kept: true, ...(await preserveKnowledgeBase(pool, wipe, actorId)) };
    else await wipe();
    cleanBackup = await recovery.createBackup({ reason: 'clean-workspace-baseline' });
    await recovery.validateBackup(cleanBackup.stamp);
    const receipt = {
      resetAt: new Date().toISOString(), actorId, before,
      safetyBackup: safetyBackup.stamp, cleanBaselineBackup: cleanBackup.stamp, knowledgeBase,
    };
    await fs.promises.writeFile(path.join(config.BACKUP_DIR, `workspace-reset-${cleanBackup.stamp}.json`), JSON.stringify(receipt, null, 2));
    return receipt;
  } finally { resetting = false; }
}

module.exports = { clearDatabase, clearUploads, isResetting: () => resetting, preserveKnowledgeBase, preview, resetWorkspace };
