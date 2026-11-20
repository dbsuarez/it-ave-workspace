// IT Avenue Workspace - the list of workspace backups (Moderation > Recovery). Pure: data in, HTML out (frontend/test/backup-list.test.js).
// Each action is an icon button; its tooltip (title) and aria-label carry the full wording. A backup can have a name you choose and a
// Keep mark (clean-ups never delete it). Incomplete backups (one half missing) are tucked behind a count so they do not clutter the list.

const bkEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function bkSize(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

const BK_ICONS = {
  rename: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  keep: '<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  uploads: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  validate: '<path d="M22 11.1V12a10 10 0 1 1-5.9-9.1"/><path d="M22 4L12 14l-3-3"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>',
  broom: '<path d="M19 3l-7 7"/><path d="M10.5 9.5l4 4-3.5 5.5H4.5L3 14z"/><path d="M8 14l1.5 3"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
};

// A small icon-only button. `extra` is added attributes (data-..., disabled, aria-pressed).
function bkIconButton(icon, label, action, extra = '', danger = false) {
  const text = bkEscape(label);
  return `<button type="button" class="icon-btn bk-icon${danger ? ' danger' : ''} superadmin-only" data-action="${action}" ${extra} title="${text}" aria-label="${text}"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${BK_ICONS[icon]}</svg></button>`;
}

// What the manifest's reason (why the backup was made) says in words. Manual ones need no explanation.
function backupReasonText(reason) {
  const value = String(reason || '');
  if (!value || value === 'manual') return '';
  if (value === 'before-workspace-reset') return 'Before a workspace reset';
  if (value === 'clean-workspace-baseline') return 'Clean baseline after a reset';
  const before = /^before-restore-(\d{8}-\d{4,6})$/.exec(value);
  return before ? `Before restoring ${before[1]}` : '';
}

function bkRow(backup) {
  const stamp = bkEscape(backup.stamp);
  const own = `data-backup-stamp="${stamp}"`;
  const named = Boolean(backup.name);
  const reason = backupReasonText(backup.reason);
  const detail = backup.complete
    ? `Database ${bkSize(backup.database.size)} · Uploads ${bkSize(backup.uploads.size)} · ${backup.compatibility === 'compatible' ? 'Compatible' : backup.compatibility === 'newer-version' ? 'Newer version — restore unavailable' : 'Not yet checked'}`
    : 'Incomplete — one half of this backup is missing, so it cannot be restored';
  const badges = `${backup.keep ? '<span class="sidebar-section-badge">Keep</span>' : ''}${backup.complete ? '' : '<span class="sidebar-section-badge">Incomplete</span>'}${reason ? `<span class="sidebar-section-badge">${bkEscape(reason)}</span>` : ''}`;
  const actions = [
    bkIconButton('rename', 'Rename this backup', 'rename-backup', `${own} data-backup-name="${bkEscape(backup.name || '')}"`),
    bkIconButton('keep', backup.keep ? 'Marked Keep: clean-ups never delete it. Click to turn off' : 'Keep this backup: clean-ups never delete it', 'keep-backup', `${own} aria-pressed="${backup.keep ? 'true' : 'false'}"`),
    backup.database.exists ? bkIconButton('database', 'Download the database', 'download-backup', `${own} data-backup-kind="database"`) : '',
    backup.uploads.exists ? bkIconButton('uploads', 'Download the uploaded files', 'download-backup', `${own} data-backup-kind="uploads"`) : '',
    backup.complete && backup.compatibility !== 'newer-version' ? bkIconButton('validate', 'Check that this backup can be read', 'validate-backup', own) + bkIconButton('restore', 'Restore the workspace from this backup', 'restore-backup', own, true) : '',
    bkIconButton('trash', backup.keep ? 'Turn Keep off to delete this backup' : 'Delete this backup', 'delete-backup', `${own}${backup.keep ? ' disabled' : ''}`, true),
  ].join('');
  return `<div class="moderation-row recovery-row"><span><strong class="bk-title">${named ? bkEscape(backup.name) : stamp}</strong>${named ? ` <small class="bk-stamp">${stamp}</small>` : ''} ${badges}<small>${bkEscape(detail)}</small></span><div class="moderation-row-actions bk-actions">${actions}</div></div>`;
}

// backups: the API list. showIncomplete: whether the incomplete ones are listed too.
function backupListHtml({ backups, showIncomplete }) {
  const complete = backups.filter((backup) => backup.complete);
  const incomplete = backups.filter((backup) => !backup.complete);
  const shown = showIncomplete ? backups : complete;
  const tools = complete.length > 1 ? bkIconButton('broom', 'Delete all but the newest backups (you choose how many; backups marked Keep are never deleted)', 'purge-old-backups') : '';
  const strip = incomplete.length
    ? `<div class="bk-incomplete-strip"><span>${showIncomplete ? `Showing ${incomplete.length} incomplete backup${incomplete.length === 1 ? '' : 's'}.` : `${incomplete.length} incomplete backup${incomplete.length === 1 ? ' is' : 's are'} hidden.`}</span>${bkIconButton('eye', showIncomplete ? 'Hide the incomplete backups' : 'Show the incomplete backups', 'toggle-incomplete-backups')}${bkIconButton('trash', `Delete the ${incomplete.length} incomplete backup${incomplete.length === 1 ? '' : 's'}`, 'purge-incomplete-backups', '', true)}</div>`
    : '';
  const rows = shown.map(bkRow).join('') || '<p>No backups yet. Create one before making major workspace changes.</p>';
  return `${tools ? `<div class="bk-tools">${tools}</div>` : ''}${strip}<div class="moderation-list">${rows}</div>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { backupListHtml, backupReasonText, bkSize };
}
