const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('./config');

const run = promisify(execFile);
const BACKUP_DIR = config.BACKUP_DIR;
const STATUS_FILE = path.join(BACKUP_DIR, 'recovery-status.json');
const STAMP_RE = /^\d{8}-\d{4}(?:\d{2})?$/;
let activeOperation = null;

const stampNow = () => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: config.COMPANY_TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
};

async function writeStatus(status) {
  await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
  await fs.promises.writeFile(STATUS_FILE, JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2));
}

async function readStatus() {
  try { return JSON.parse(await fs.promises.readFile(STATUS_FILE, 'utf8')); } catch { return { state: 'idle' }; }
}

function backupPaths(stamp) {
  if (!STAMP_RE.test(String(stamp))) throw Object.assign(new Error('Invalid backup identifier'), { status: 400 });
  return {
    database: path.join(BACKUP_DIR, `db-${stamp}.dump`),
    uploads: path.join(BACKUP_DIR, `uploads-${stamp}.tar.gz`),
  };
}

async function listBackups() {
  await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
  const entries = await fs.promises.readdir(BACKUP_DIR, { withFileTypes: true });
  const stamps = new Set();
  for (const entry of entries) {
    const match = /^(?:db-|uploads-)(\d{8}-\d{4,6})\.(?:dump|tar\.gz)$/.exec(entry.name);
    if (match) stamps.add(match[1]);
  }
  const backups = [];
  for (const stamp of stamps) {
    const paths = backupPaths(stamp);
    const [database, uploads] = await Promise.all([paths.database, paths.uploads].map(async (file) => {
      try { const stat = await fs.promises.stat(file); return { exists: true, size: stat.size, modifiedAt: stat.mtime.toISOString() }; }
      catch { return { exists: false, size: 0, modifiedAt: null }; }
    }));
    backups.push({ stamp, complete: database.exists && uploads.exists, database, uploads });
  }
  return backups.sort((a, b) => b.stamp.localeCompare(a.stamp));
}

async function createBackup({ reason = 'manual' } = {}) {
  if (activeOperation) throw Object.assign(new Error('Another backup or restore is already running'), { status: 409 });
  activeOperation = 'backup';
  const stamp = stampNow();
  const files = backupPaths(stamp);
  const dbPartial = `${files.database}.partial`;
  const uploadsPartial = `${files.uploads}.partial`;
  try {
    await writeStatus({ state: 'backing-up', stamp, reason });
    await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
    await run('pg_dump', ['--dbname', config.DATABASE_URL, '--format=custom', '--file', dbPartial], { maxBuffer: 1024 * 1024 });
    await fs.promises.rename(dbPartial, files.database);
    await run('tar', ['-czf', uploadsPartial, '-C', config.UPLOAD_DIR, '.'], { maxBuffer: 1024 * 1024 });
    await fs.promises.rename(uploadsPartial, files.uploads);
    await writeStatus({ state: 'ready', stamp, reason });
    return { stamp };
  } catch (err) {
    await Promise.all([dbPartial, uploadsPartial].map((file) => fs.promises.rm(file, { force: true }).catch(() => {})));
    await writeStatus({ state: 'failed', stamp, operation: 'backup', error: err.message });
    throw err;
  } finally { activeOperation = null; }
}

async function validateBackup(stamp) {
  const files = backupPaths(stamp);
  await Promise.all([files.database, files.uploads].map(async (file) => {
    if (!(await fs.promises.stat(file).catch(() => null))) throw Object.assign(new Error('The database and uploads backup pair is incomplete'), { status: 404 });
  }));
  await run('pg_restore', ['--list', files.database], { maxBuffer: 8 * 1024 * 1024 });
  const archive = await run('tar', ['-tzf', files.uploads], { maxBuffer: 8 * 1024 * 1024 });
  const unsafe = archive.stdout.split(/\r?\n/).filter(Boolean).some((entry) => {
    const clean = entry.replace(/^\.\//, '');
    return path.isAbsolute(clean) || clean.split('/').includes('..');
  });
  if (unsafe) throw Object.assign(new Error('Uploads archive contains an unsafe path'), { status: 400 });
  return { valid: true, stamp };
}

async function restoreBackup(stamp, query) {
  if (activeOperation) throw Object.assign(new Error('Another backup or restore is already running'), { status: 409 });
  activeOperation = 'restore';
  const files = backupPaths(stamp);
  let safetyBackup = null;
  const extracted = path.join('/tmp', `itavenue-uploads-${Date.now()}`);
  try {
    await validateBackup(stamp);
    activeOperation = null;
    safetyBackup = await createBackup({ reason: `before-restore-${stamp}` });
    activeOperation = 'restore';
    await writeStatus({ state: 'restoring', stamp, safetyBackup: safetyBackup.stamp });
    await fs.promises.mkdir(extracted, { recursive: true });
    await run('tar', ['-xzf', files.uploads, '-C', extracted], { maxBuffer: 8 * 1024 * 1024 });
    await run('pg_restore', ['--dbname', config.DATABASE_URL, '--clean', '--if-exists', '--no-owner', '--single-transaction', files.database], { maxBuffer: 16 * 1024 * 1024 });
    for (const name of await fs.promises.readdir(config.UPLOAD_DIR)) {
      await fs.promises.rm(path.join(config.UPLOAD_DIR, name), { recursive: true, force: true });
    }
    for (const name of await fs.promises.readdir(extracted)) {
      await fs.promises.cp(path.join(extracted, name), path.join(config.UPLOAD_DIR, name), { recursive: true });
    }
    const migrations = require('./migrations');
    for (const sql of migrations) await query(sql);
    await writeStatus({ state: 'restored', stamp, safetyBackup: safetyBackup.stamp });
    return { restored: true, stamp, safetyBackup: safetyBackup.stamp };
  } catch (err) {
    await writeStatus({ state: 'failed', stamp, operation: 'restore', safetyBackup: safetyBackup?.stamp || null, error: err.message });
    throw err;
  } finally {
    activeOperation = null;
    await fs.promises.rm(extracted, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { backupPaths, createBackup, isRestoring: () => activeOperation === 'restore', listBackups, readStatus, restoreBackup, validateBackup };
