const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATABASE_URL ||= 'postgres://127.0.0.1/test';
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'itavenue-backup-test-'));
process.env.BACKUP_DIR = backupDir;
const recovery = require('../src/backupRecovery');

test.after(() => fs.rmSync(backupDir, { recursive: true, force: true }));

test('backup identifiers cannot escape the configured backup directory', () => {
  assert.throws(() => recovery.backupPaths('../../etc/passwd'), /Invalid backup identifier/);
  const files = recovery.backupPaths('20261113-123456');
  assert.equal(files.database, path.join(backupDir, 'db-20261113-123456.dump'));
  assert.equal(files.uploads, path.join(backupDir, 'uploads-20261113-123456.tar.gz'));
});

test('backup inventory pairs database and uploads and keeps incomplete points visible', async () => {
  fs.writeFileSync(path.join(backupDir, 'db-20261113-123456.dump'), 'db');
  fs.writeFileSync(path.join(backupDir, 'uploads-20261113-123456.tar.gz'), 'files');
  fs.writeFileSync(path.join(backupDir, 'manifest-20261113-123456.json'), JSON.stringify({
    schemaRevision: 999999,
  }));
  fs.writeFileSync(path.join(backupDir, 'db-20261112-0900.dump'), 'legacy');
  fs.writeFileSync(path.join(backupDir, 'ignore-me.txt'), 'x');
  const list = await recovery.listBackups();
  assert.deepEqual(list.map((item) => [item.stamp, item.complete]), [
    ['20261113-123456', true],
    ['20261112-0900', false],
  ]);
  assert.equal(list[0].compatibility, 'newer-version');
  assert.equal(list[1].compatibility, 'unverified');
});
