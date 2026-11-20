// The backup list: names, Keep, icon buttons with tooltips, incomplete backups tucked away.
const test = require('node:test');
const assert = require('node:assert/strict');
const { backupListHtml, backupReasonText } = require('../src/features/backup-list');

const full = (stamp, extra = {}) => ({ stamp, complete: true, database: { exists: true, size: 2048 }, uploads: { exists: true, size: 4096 }, compatibility: 'compatible', name: '', keep: false, reason: '', ...extra });
const half = (stamp) => ({ stamp, complete: false, database: { exists: true, size: 10 }, uploads: { exists: false, size: 0 }, compatibility: 'unverified', name: '', keep: false, reason: '' });

test('a named backup shows its name first and the date second; an unnamed one shows the date', () => {
  const html = backupListHtml({ backups: [full('20261102-100000', { name: 'Before <payroll>' }), full('20261101-100000')], showIncomplete: false });
  assert.match(html, /Before &lt;payroll&gt;/);
  assert.doesNotMatch(html, /Before <payroll>/);
  assert.match(html, /20261102-100000/);
  assert.match(html, /<strong[^>]*>20261101-100000<\/strong>/);
});

test('every action is an icon button whose tooltip and screen-reader label say what it does', () => {
  const html = backupListHtml({ backups: [full('20261101-100000')], showIncomplete: false });
  for (const [action, label] of [['rename-backup', 'Rename'], ['keep-backup', 'Keep'], ['download-backup', 'Download the database'], ['download-backup', 'Download the uploaded files'], ['validate-backup', 'Check'], ['restore-backup', 'Restore'], ['delete-backup', 'Delete']]) {
    const button = new RegExp(`<button[^>]*data-action="${action}"[^>]*title="[^"]*${label}[^"]*"[^>]*aria-label="[^"]*${label}`).exec(html);
    assert.ok(button, `${action} has a "${label}" tooltip and label`);
    assert.match(button[0], /class="[^"]*icon-btn/);
  }
  assert.equal(/<svg/.test(html), true);
  assert.equal(/>Database<\/button>|>Uploads<\/button>|>Validate<\/button>/.test(html), false, 'no text-only buttons left');
});

test('a Keep backup shows it, and cannot be deleted until Keep is turned off', () => {
  const kept = backupListHtml({ backups: [full('20261101-100000', { keep: true })], showIncomplete: false });
  assert.match(kept, /data-action="keep-backup"[^>]*aria-pressed="true"/);
  assert.match(kept, /data-action="delete-backup"[^>]*disabled/);
  assert.match(kept, /Turn Keep off to delete/);
  const loose = backupListHtml({ backups: [full('20261101-100000')], showIncomplete: false });
  assert.match(loose, /data-action="keep-backup"[^>]*aria-pressed="false"/);
  assert.doesNotMatch(loose, /data-action="delete-backup"[^>]*disabled/);
});

test('incomplete backups are tucked away behind a count, shown on request, with a button to clear them', () => {
  const backups = [full('20261103-100000'), half('20261102-100000'), half('20261101-100000')];
  const hidden = backupListHtml({ backups, showIncomplete: false });
  assert.equal((hidden.match(/class="[^"]*recovery-row/g) || []).length, 1);
  assert.match(hidden, /2 incomplete backups are hidden/);
  assert.match(hidden, /data-action="toggle-incomplete-backups"/);
  assert.match(hidden, /data-action="purge-incomplete-backups"[^>]*title="[^"]*Delete the 2 incomplete/);
  const shown = backupListHtml({ backups, showIncomplete: true });
  assert.equal((shown.match(/class="[^"]*recovery-row/g) || []).length, 3);
  assert.match(shown, /Incomplete/);
  const incompleteRow = shown.split('recovery-row').find((chunk) => chunk.includes('20261102-100000'));
  assert.equal(/data-action="restore-backup"|data-action="validate-backup"/.test(incompleteRow), false, 'an incomplete backup cannot be restored or checked');
  assert.doesNotMatch(backupListHtml({ backups: [full('20261103-100000')], showIncomplete: false }), /incomplete backups? (is|are) hidden/);
});

test('there is a clean-up button for keeping only the newest, and the reasons read as words', () => {
  assert.match(backupListHtml({ backups: [full('20261101-100000'), full('20261102-100000')], showIncomplete: false }), /data-action="purge-old-backups"[^>]*title="[^"]*newest/);
  assert.equal(backupReasonText('before-workspace-reset'), 'Before a workspace reset');
  assert.equal(backupReasonText('clean-workspace-baseline'), 'Clean baseline after a reset');
  assert.equal(backupReasonText('before-restore-20261101-100000'), 'Before restoring 20261101-100000');
  assert.equal(backupReasonText('manual'), '');
  assert.equal(backupReasonText(''), '');
});
