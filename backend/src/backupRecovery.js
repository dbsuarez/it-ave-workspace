const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const { Pool } = require('pg');
const config = require('./config');
const migrations = require('./migrations');
const { ensureDefaultChannels } = require('./defaultChannels');
const appVersion = require('../package.json').version;

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
    manifest: path.join(BACKUP_DIR, `manifest-${stamp}.json`),
  };
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject));
  return hash.digest('hex');
}

async function readManifest(file) {
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { return null; }
}

async function writeManifest(stamp, files, extra = {}) {
  const manifest = {
    format: 1, stamp, createdAt: new Date().toISOString(), appVersion,
    schemaRevision: migrations.length,
    checksums: { database: await sha256(files.database), uploads: await sha256(files.uploads) },
    ...extra,
  };
  await fs.promises.writeFile(files.manifest, JSON.stringify(manifest, null, 2));
  return manifest;
}

async function applyCurrentMigrations(target) {
  let pending = migrations.map((sql, index) => ({ sql, index, error: null }));
  while (pending.length) {
    const deferred = [];
    let applied = 0;
    for (const migration of pending) {
      try {
        await target.query(migration.sql);
        applied += 1;
      } catch (error) {
        deferred.push({ ...migration, error });
      }
    }
    if (!deferred.length) return;
    if (!applied) {
      const first = deferred[0];
      first.error.message = `Migration ${first.index + 1} could not be applied: ${first.error.message}`;
      throw first.error;
    }
    pending = deferred;
  }
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
    const manifest = await readManifest(paths.manifest);
    const compatibility = Number(manifest?.schemaRevision) > migrations.length
      ? 'newer-version'
      : manifest?.validatedWithSchemaRevision === migrations.length ? 'compatible' : 'unverified';
    backups.push({ stamp, complete: database.exists && uploads.exists, database, uploads, manifest, compatibility });
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
    await writeManifest(stamp, files);
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
  let manifest = await readManifest(files.manifest);
  if (Number(manifest?.schemaRevision) > migrations.length) {
    throw Object.assign(new Error('This backup was created by a newer app version and cannot be restored here'), { status: 400 });
  }
  if (manifest?.checksums) {
    const checksums = { database: await sha256(files.database), uploads: await sha256(files.uploads) };
    if (checksums.database !== manifest.checksums.database || checksums.uploads !== manifest.checksums.uploads) {
      throw Object.assign(new Error('Backup checksum verification failed'), { status: 400 });
    }
  }
  const scratch = `itavenue_validate_${process.pid}_${Date.now()}`;
  const maintenance = new URL(config.DATABASE_URL);
  maintenance.pathname = '/postgres';
  const scratchUrl = new URL(config.DATABASE_URL);
  scratchUrl.pathname = `/${scratch}`;
  try {
    await run('createdb', ['--maintenance-db', maintenance.toString(), scratch]);
    await run('pg_restore', ['--dbname', scratchUrl.toString(), '--no-owner', files.database], { maxBuffer: 16 * 1024 * 1024 });
    const scratchPool = new Pool({ connectionString: scratchUrl.toString() });
    try { await applyCurrentMigrations(scratchPool); } finally { await scratchPool.end(); }
  } finally {
    await run('dropdb', ['--force', '--maintenance-db', maintenance.toString(), scratch]).catch(() => {});
  }
  manifest = await writeManifest(stamp, files, {
    ...(manifest || { source: 'legacy' }),
    validatedAt: new Date().toISOString(), validatedWithAppVersion: appVersion,
    validatedWithSchemaRevision: migrations.length,
  });
  return { valid: true, compatible: true, stamp, manifest };
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
    await applyCurrentMigrations({ query });
    await ensureDefaultChannels({ query });
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

module.exports = { applyCurrentMigrations, backupPaths, createBackup, isRestoring: () => activeOperation === 'restore', listBackups, readStatus, restoreBackup, validateBackup };
