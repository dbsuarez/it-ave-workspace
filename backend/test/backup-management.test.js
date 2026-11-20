// Backup list housekeeping: a name you choose, Keep (protects from clean-up), delete one, delete the incomplete ones, keep only the newest N.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backups-'));
process.env.BACKUP_DIR = dir;
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@127.0.0.1:1/unused';
const recovery = require('../src/backupRecovery');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const touch = (name, text = 'x') => fs.writeFileSync(path.join(dir, name), text);
const exists = (name) => fs.existsSync(path.join(dir, name));
function pair(stamp, { manifest = true, reason } = {}) {
  touch(`db-${stamp}.dump`); touch(`uploads-${stamp}.tar.gz`);
  if (manifest) touch(`manifest-${stamp}.json`, JSON.stringify({ stamp, reason }));
}
function reset() { for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true }); }

test('the list carries each backup\'s name, Keep mark and why it was made', async () => {
  reset();
  pair('20261101-100000', { reason: 'before-workspace-reset' });
  pair('20261102-100000');
  await recovery.renameBackup('20261102-100000', '  Before payroll change  ');
  await recovery.setBackupKeep('20261102-100000', true);
  const list = await recovery.listBackups();
  const second = list.find((b) => b.stamp === '20261102-100000');
  assert.equal(second.name, 'Before payroll change');
  assert.equal(second.keep, true);
  assert.equal(list.find((b) => b.stamp === '20261101-100000').reason, 'before-workspace-reset');
  assert.equal(list.find((b) => b.stamp === '20261101-100000').name, '');
  await recovery.renameBackup('20261102-100000', '');
  assert.equal((await recovery.listBackups()).find((b) => b.stamp === '20261102-100000').name, '', 'an empty name clears it');
});

test('a name is cleaned, and only a backup that exists can be named', async () => {
  reset();
  pair('20261101-100000');
  await assert.rejects(() => recovery.renameBackup('20269999-000000', 'x'), (err) => err.status === 404);
  await assert.rejects(() => recovery.renameBackup('../etc', 'x'), (err) => err.status === 400);
  await recovery.renameBackup('20261101-100000', `a\u0000b${'z'.repeat(200)}`);
  const name = (await recovery.listBackups())[0].name;
  assert.equal(name.length, 80);
  assert.equal(name.includes('\u0000'), false);
});

test('deleting a backup removes its files and its name; a Keep backup must be released first', async () => {
  reset();
  pair('20261101-100000'); pair('20261102-100000');
  await recovery.renameBackup('20261101-100000', 'old');
  await recovery.setBackupKeep('20261102-100000', true);
  await assert.rejects(() => recovery.deleteBackup('20261102-100000'), (err) => err.status === 409);
  assert.equal(exists('db-20261102-100000.dump'), true);
  await recovery.deleteBackup('20261101-100000');
  assert.deepEqual(['db-20261101-100000.dump', 'uploads-20261101-100000.tar.gz', 'manifest-20261101-100000.json'].map(exists), [false, false, false]);
  await recovery.setBackupKeep('20261102-100000', false);
  await recovery.deleteBackup('20261102-100000');
  assert.deepEqual(await recovery.listBackups(), []);
  await assert.rejects(() => recovery.deleteBackup('20261102-100000'), (err) => err.status === 404);
});

test('incomplete backups can be listed apart and cleared in one go, leaving complete ones alone', async () => {
  reset();
  pair('20261101-100000');
  touch('db-20261102-100000.dump');                 // the uploads half is missing
  touch('uploads-20261103-100000.tar.gz');          // the database half is missing
  touch('db-20261104-100000.dump.partial');         // a leftover of a backup that stopped
  const before = await recovery.listBackups();
  assert.deepEqual(before.filter((b) => !b.complete).map((b) => b.stamp).sort(), ['20261102-100000', '20261103-100000']);
  const out = await recovery.purgeBackups({ incomplete: true });
  assert.deepEqual(out.deleted.sort(), ['20261102-100000', '20261103-100000']);
  assert.equal(exists('db-20261102-100000.dump'), false);
  assert.equal(exists('db-20261104-100000.dump.partial'), false, 'a stopped backup\'s leftover is cleared too');
  assert.equal(exists('db-20261101-100000.dump'), true);
});

test('keeping only the newest N never touches a Keep backup, and counts only complete ones', async () => {
  reset();
  for (const day of ['01', '02', '03', '04', '05']) pair(`202611${day}-100000`);
  touch('db-20261106-100000.dump');
  await recovery.setBackupKeep('20261101-100000', true);
  await assert.rejects(() => recovery.purgeBackups({ keepNewest: 0 }), (err) => err.status === 400);
  const out = await recovery.purgeBackups({ keepNewest: 2 });
  assert.deepEqual(out.deleted.sort(), ['20261102-100000', '20261103-100000']);
  assert.deepEqual((await recovery.listBackups()).map((b) => b.stamp).sort(), ['20261101-100000', '20261104-100000', '20261105-100000', '20261106-100000']);
});

test('a purge needs to be told what to do', async () => {
  await assert.rejects(() => recovery.purgeBackups({}), (err) => err.status === 400);
});
