// IT Avenue Workspace - leave (People > Leave).
//
// My leave: balances, a request form, my requests. Approvals: requests waiting for me (my direct reports'; HR sees
// everyone's). Calendar: who is away this month. HR also edits leave types and holidays, and adjusts a person's
// balance from their employee record (People > Manage). Loaded after employees.js.

const leaveState = {
  view: 'mine', me: null, approvals: [], waiting: 0, loaded: false, error: '',
  month: new Date().toISOString().slice(0, 7), scope: 'team', calendar: null,
  records: null, types: [], filters: { status: '', typeId: '', q: '', from: '', to: '' }, // HR: every request
};

const LEAVE_STATUS = { pending: 'Waiting', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' };

async function leaveApi(path, method = 'GET', body) {
  const res = await api(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// "Nov 16, 2026" from a plain YYYY-MM-DD (no time zone shifting).
function leaveDate(value, withYear = true) {
  if (!value) return '';
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], withYear ? { year: 'numeric', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
}

function leaveRange(r) {
  return r.startDate === r.endDate ? leaveDate(r.startDate) : `${leaveDate(r.startDate, false)} – ${leaveDate(r.endDate)}`;
}

function leaveDays(n) {
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

// The same counting the server does: Monday to Friday, minus holidays; a half day is 0.5 on one working day.
function leaveWorkingDays(start, end, halfDay, holidays) {
  if (!start || !end || end < start) return 0;
  const skip = new Set((holidays || []).map((h) => h.day));
  let count = 0;
  const [y1, m1, d1] = start.split('-').map(Number);
  const [y2, m2, d2] = end.split('-').map(Number);
  for (let t = Date.UTC(y1, m1 - 1, d1); t <= Date.UTC(y2, m2 - 1, d2); t += 86400000) {
    const date = new Date(t);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !skip.has(date.toISOString().slice(0, 10))) count += 1;
  }
  if (halfDay) return start === end && count === 1 ? 0.5 : 0;
  return count;
}

// ---- loading ----

async function loadLeave() {
  try {
    leaveState.me = await leaveApi('/api/leave/me');
    leaveState.waiting = leaveState.me.approvalsWaiting;
    leaveState.approvals = leaveState.me.approvalsWaiting ? (await leaveApi('/api/leave/approvals')).requests : [];
    if (leaveState.view === 'calendar') leaveState.calendar = await leaveApi(`/api/leave/calendar?month=${leaveState.month}&scope=${leaveState.scope}`);
    if (leaveState.view === 'records' && leaveState.me.canManage) {
      if (!leaveState.types.length) leaveState.types = (await leaveApi('/api/leave/types')).types;
      leaveState.records = await leaveApi(`/api/leave/records?${leaveFilterQuery()}`);
    }
    leaveState.error = '';
  } catch (err) {
    leaveState.error = err.message || 'Leave is not available';
  }
  leaveState.loaded = true;
  updateLeaveBadges();
  if (typeof peopleState !== 'undefined' && peopleState.tab === 'leave' && peopleState.pageId === null) renderPeopleBody();
}

// Quietly find out how many requests wait for me (the badge); called once the app is up and when news arrives.
async function refreshLeaveSummary() {
  try {
    const me = await leaveApi('/api/leave/me');
    leaveState.waiting = me.approvalsWaiting;
    updateLeaveBadges();
  } catch (err) {
    // guests and the like: no badge
  }
}

function updateLeaveBadges() {
  const badge = document.getElementById('people-badge');
  if (badge) {
    badge.hidden = !leaveState.waiting;
    badge.textContent = String(leaveState.waiting);
  }
}

// A leave event from the server: someone asked, or my request was decided.
function handleLeaveUpdated(event) {
  if (!event || !event.request) return;
  const r = event.request;
  const mine = state.user && Number(r.userId) === Number(state.user.id);
  if (event.kind === 'requested' && !mine) {
    showToast(`${personName(r)} asked for ${leaveDays(r.days)} of ${r.typeName}: ${leaveRange(r)}.`, 'info');
  } else if (mine && (event.kind === 'approved' || event.kind === 'rejected')) {
    showToast(`Your ${r.typeName} (${leaveRange(r)}) was ${event.kind}${r.decidedBy ? ` by ${r.decidedBy}` : ''}.`, event.kind === 'approved' ? 'success' : 'info');
  }
  if (leaveState.loaded) loadLeave(); else refreshLeaveSummary();
}

// ---- the tab ----

function renderLeave(body) {
  if (leaveState.error) { body.innerHTML = emptyRecordMarkup('Leave is not available', leaveState.error); return; }
  if (!leaveState.loaded) { body.innerHTML = '<p class="pp-muted">Loading…</p>'; loadLeave(); return; }
  const tabs = [['mine', 'My leave'], ['approvals', `Approvals${leaveState.waiting ? ` (${leaveState.waiting})` : ''}`], ['calendar', 'Calendar']];
  if (leaveState.me && leaveState.me.canManage) tabs.push(['records', 'All records']);
  body.innerHTML = `
    <div class="lv-tabs">${tabs.map(([key, label]) => `<button type="button" class="lv-tab${leaveState.view === key ? ' active' : ''}" data-leave-view="${key}">${label}</button>`).join('')}
      <span class="emp-spacer"></span>
      ${leaveState.view === 'mine' ? '<button type="button" class="btn primary" data-leave-request>Request leave</button>' : ''}</div>
    <div class="lv-body">${leaveState.view === 'mine' ? leaveMineHtml() : leaveState.view === 'approvals' ? leaveApprovalsHtml() : leaveState.view === 'records' ? leaveRecordsHtml() : leaveCalendarHtml()}</div>`;
  if (leaveState.view === 'calendar' && !leaveState.calendar) loadLeave();
  if (leaveState.view === 'records' && !leaveState.records) loadLeave();
}

function leaveMineHtml() {
  const me = leaveState.me;
  const balances = me.balances.map((b) => `
    <div class="lv-balance">
      <span class="lv-balance-name">${escapeText(b.name)}</span>
      <strong>${b.capped ? b.remaining : '∞'}</strong>
      <span class="pp-muted">${b.capped ? `of ${b.entitled} left` : 'no limit'}${b.used ? ` · ${b.used} used` : ''}${b.pending ? ` · ${b.pending} waiting` : ''}</span>
    </div>`).join('');
  const rows = me.requests.map((r) => `
    <tr><td>${escapeText(leaveRange(r))}</td><td>${escapeText(r.typeName)}</td><td>${leaveDays(r.days)}${r.halfDay ? ' (half)' : ''}</td>
      <td><span class="lv-status lv-${r.status}">${LEAVE_STATUS[r.status]}</span>${r.decidedBy && r.status !== 'cancelled' ? `<em class="lv-by">by ${escapeText(r.decidedBy)}</em>` : ''}${r.decisionNote ? `<em class="lv-by">“${escapeText(r.decisionNote)}”</em>` : ''}</td>
      <td>${r.status === 'pending' || (r.status === 'approved' && r.endDate >= new Date().toISOString().slice(0, 10)) ? `<button type="button" class="btn" data-leave-cancel="${r.id}">Cancel</button>` : ''}</td></tr>`).join('');
  return `<div class="lv-balances">${balances || '<p class="pp-muted">No leave types yet. HR sets them up.</p>'}</div>
    <p class="pp-hint">Balances are for ${me.year}. Weekends and company holidays are not counted.${me.hasManager ? '' : ' You have no manager set, so HR approves your requests.'}</p>
    <h3 class="lv-h">My requests</h3>
    ${me.requests.length ? `<div class="emp-table-wrap"><table class="emp-table"><thead><tr><th>Dates</th><th>Type</th><th>Days</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
    : emptyRecordMarkup('No leave requests yet', 'Use "Request leave" to ask for time off.', 'compact')}`;
}

function leaveFilterQuery() {
  const f = leaveState.filters;
  return Object.entries(f).filter(([, value]) => value !== '').map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
}

// HR: every request, any status, with filters and a CSV export.
function leaveRecordsHtml() {
  const f = leaveState.filters;
  const r = leaveState.records;
  const rows = r ? r.requests.map((x) => `
    <tr><td><strong>${escapeText(personName(x))}</strong>${x.employeeNo ? `<em class="lv-by">#${escapeText(x.employeeNo)}${x.department ? ` · ${escapeText(x.department)}` : ''}</em>` : (x.department ? `<em class="lv-by">${escapeText(x.department)}</em>` : '')}</td>
      <td>${escapeText(x.typeName)}</td><td>${escapeText(leaveRange(x))}</td><td>${leaveDays(x.days)}${x.halfDay ? ' (half)' : ''}</td>
      <td><span class="lv-status lv-${x.status}">${LEAVE_STATUS[x.status]}</span>${x.decidedBy ? `<em class="lv-by">by ${escapeText(x.decidedBy)}${x.decidedAt ? `, ${escapeText(new Date(x.decidedAt).toLocaleDateString())}` : ''}</em>` : ''}${x.decisionNote ? `<em class="lv-by">“${escapeText(x.decisionNote)}”</em>` : ''}</td>
      <td class="att-note" title="${escapeText(x.reason)}">${escapeText(x.reason)}</td></tr>`).join('') : '';
  return `
    <div class="emp-toolbar">
      <input type="search" id="lv-f-q" class="pp-search" placeholder="Name, username or employee no." value="${escapeText(f.q)}" aria-label="Search">
      <select id="lv-f-status" class="pp-select" aria-label="Status"><option value="">All statuses</option>${Object.entries(LEAVE_STATUS).map(([k, l]) => `<option value="${k}"${f.status === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <select id="lv-f-type" class="pp-select" aria-label="Leave type"><option value="">All types</option>${leaveState.types.map((t) => `<option value="${t.id}"${String(f.typeId) === String(t.id) ? ' selected' : ''}>${escapeText(t.name)}</option>`).join('')}</select>
      <label class="lv-f-date">From <input type="date" id="lv-f-from" value="${escapeText(f.from)}"></label>
      <label class="lv-f-date">To <input type="date" id="lv-f-to" value="${escapeText(f.to)}"></label>
      <span class="emp-spacer"></span>
      <button type="button" class="btn" data-leave-records-export>Export CSV</button>
    </div>
    ${!r ? '<p class="pp-muted">Loading…</p>' : r.requests.length
    ? `<div class="emp-table-wrap"><table class="emp-table"><thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th>Days</th><th>Status</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="pp-hint">${r.requests.length} record${r.requests.length === 1 ? '' : 's'}${r.truncated ? ' (the newest 500; narrow the filters or export for more)' : ''}, newest first. Dates filter finds leave that overlaps the range.</p>`
    : emptyRecordMarkup('No leave records', 'Nothing matches these filters.', 'compact')}`;
}

function leaveApprovalsHtml() {
  if (!leaveState.approvals.length) return emptyRecordMarkup('Nothing waiting', 'Requests from your team show here for you to approve.');
  return `<div class="lv-cards">${leaveState.approvals.map((r) => `
    <div class="lv-card" data-leave-id="${r.id}">
      <div class="lv-card-head"><strong>${escapeText(personName(r))}</strong><span class="lv-status lv-pending">${escapeText(r.typeName)}</span></div>
      <div>${escapeText(leaveRange(r))} · ${leaveDays(r.days)}${r.halfDay ? ' (half day)' : ''}</div>
      ${r.reason ? `<p class="lv-reason">${escapeText(r.reason)}</p>` : ''}
      <div class="admin-actions"><button type="button" class="btn primary" data-leave-decide="approved">Approve</button><button type="button" class="btn" data-leave-decide="rejected">Decline…</button></div>
    </div>`).join('')}</div>`;
}

function leaveCalendarHtml() {
  const cal = leaveState.calendar;
  const [year, month] = leaveState.month.split('-').map(Number);
  const title = new Date(year, month - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
  const head = `<div class="lv-cal-head">
    <button type="button" class="btn" data-leave-month="-1" aria-label="Previous month">‹</button>
    <strong>${escapeText(title)}</strong>
    <button type="button" class="btn" data-leave-month="1" aria-label="Next month">›</button>
    <button type="button" class="btn" data-leave-month="0">Today</button>
    <span class="emp-spacer"></span>
    ${leaveState.me && leaveState.me.canManage ? `<select id="leave-scope" class="pp-select" aria-label="Who to show"><option value="team"${leaveState.scope === 'team' ? ' selected' : ''}>My team</option><option value="all"${leaveState.scope === 'all' ? ' selected' : ''}>Everyone</option></select>` : ''}
  </div>`;
  if (!cal) return `${head}<p class="pp-muted">Loading…</p>`;
  const days = new Date(year, month, 0).getDate();
  const offset = new Date(year, month - 1, 1).getDay(); // Sunday first
  const holidayOn = new Map(cal.holidays.map((h) => [h.day, h.name]));
  const cells = [];
  for (let i = 0; i < offset; i += 1) cells.push('<div class="lv-day lv-blank"></div>');
  for (let day = 1; day <= days; day += 1) {
    const key = `${leaveState.month}-${String(day).padStart(2, '0')}`;
    const weekday = new Date(year, month - 1, day).getDay();
    const away = cal.requests.filter((r) => r.startDate <= key && r.endDate >= key);
    const shown = away.slice(0, 3).map((r) => `<span class="lv-chip lv-chip-${r.status}" title="${escapeText(personName(r))}: ${escapeText(r.typeName)}${r.status === 'pending' ? ' (waiting for approval)' : ''}">${escapeText(personName(r))}</span>`).join('');
    cells.push(`<div class="lv-day${weekday === 0 || weekday === 6 ? ' lv-weekend' : ''}${holidayOn.has(key) ? ' lv-holiday' : ''}">
      <span class="lv-daynum">${day}</span>${holidayOn.has(key) ? `<span class="lv-holiday-name">${escapeText(holidayOn.get(key))}</span>` : ''}${shown}${away.length > 3 ? `<span class="lv-more">+${away.length - 3} more</span>` : ''}</div>`);
  }
  return `${head}<div class="lv-cal"><div class="lv-dow">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<span>${d}</span>`).join('')}</div><div class="lv-grid">${cells.join('')}</div></div>
    <p class="pp-hint">Showing ${cal.scope === 'all' ? 'everyone' : 'you, your manager, the people who share your manager, and your direct reports'}. Lighter names are waiting for approval.</p>`;
}

// ---- requesting ----

function openLeaveRequest() {
  const modal = document.getElementById('leave-modal');
  const me = leaveState.me;
  if (!modal || !me) return;
  const today = new Date().toISOString().slice(0, 10);
  modal.innerHTML = `
    <div class="modal-header"><h3>Request leave</h3><button class="modal-close" type="button" data-leave-close aria-label="Close">&times;</button></div>
    <form id="leave-form">
      <div class="modal-body pp-editor-body">
        <div class="form-group"><label for="lv-type">Type</label><select id="lv-type">${me.balances.map((b) => `<option value="${b.typeId}">${escapeText(b.name)}${b.capped ? ` (${b.remaining} left)` : ''}</option>`).join('')}</select></div>
        <div class="pp-edit-pair">
          <div class="form-group"><label for="lv-start">From</label><input id="lv-start" type="date" min="${today}" value="${today}" required></div>
          <div class="form-group"><label for="lv-end">To</label><input id="lv-end" type="date" min="${today}" value="${today}" required></div>
        </div>
        <label class="preference-toggle"><input type="checkbox" id="lv-half"><span>Half day (a single day only)</span></label>
        <div class="form-group"><label for="lv-reason">Reason (optional)</label><textarea id="lv-reason" rows="3" maxlength="500"></textarea></div>
        <p class="form-note" id="lv-preview" aria-live="polite"></p>
        <p class="form-note">${me.hasManager ? 'Your manager and HR are told.' : 'You have no manager set, so HR approves this.'}</p>
      </div>
      <div class="modal-footer"><button class="btn" type="button" data-leave-close>Cancel</button><button class="btn primary" type="submit">Send request</button></div>
    </form>`;
  openSettingsModal(modal);
  updateLeavePreview();
}

function updateLeavePreview() {
  const start = document.getElementById('lv-start');
  const end = document.getElementById('lv-end');
  const half = document.getElementById('lv-half');
  const preview = document.getElementById('lv-preview');
  if (!start || !preview) return;
  if (end.value < start.value) end.value = start.value;
  half.disabled = start.value !== end.value;
  if (half.disabled) half.checked = false;
  const days = leaveWorkingDays(start.value, end.value, half.checked, leaveState.me.holidays);
  preview.textContent = days ? `That is ${leaveDays(days)} of leave.` : 'There are no working days in that range.';
}

async function submitLeaveRequest(event) {
  event.preventDefault();
  const value = (id) => document.getElementById(id).value;
  try {
    await leaveApi('/api/leave/requests', 'POST', {
      typeId: Number(value('lv-type')), startDate: value('lv-start'), endDate: value('lv-end'),
      halfDay: document.getElementById('lv-half').checked, reason: value('lv-reason'),
    });
    closeSettingsModal();
    showToast('Leave requested.', 'success');
    await loadLeave();
  } catch (err) {
    showToast(err.message || 'Could not send the request.', 'error');
  }
}

// ---- HR: leave types, holidays, one person's balance ----

async function openLeaveSettings() {
  const modal = document.getElementById('leave-settings-modal');
  if (!modal) return;
  let types;
  let holidays;
  try {
    types = (await leaveApi('/api/leave/types')).types;
    holidays = (await leaveApi(`/api/leave/holidays?year=${new Date().getFullYear()}`)).holidays;
  } catch (err) {
    showToast(err.message || 'Could not load the leave settings.', 'error');
    return;
  }
  const typeRow = (t) => `<div class="lv-type-row" data-type="${t ? t.id : 'new'}">
      <input type="text" maxlength="60" value="${escapeText(t ? t.name : '')}" placeholder="${t ? '' : 'New leave type'}" data-type-name aria-label="Name">
      <input type="number" min="0" max="365" step="0.5" value="${t ? t.daysPerYear : 0}" data-type-days aria-label="Days per year" title="Days per year (0 = no limit)">
      <label class="admin-inline-check"><input type="checkbox" data-type-paid${!t || t.paid ? ' checked' : ''}> Paid</label>
      ${t ? `<button type="button" class="btn" data-type-save>Save</button><button type="button" class="btn" data-type-delete>${t.active ? 'Delete' : 'Deleted'}</button>` : '<button type="button" class="btn primary" data-type-add>Add</button>'}
    </div>`;
  modal.innerHTML = `
    <div class="modal-header"><h3>Leave settings</h3><button class="modal-close" type="button" data-leave-close aria-label="Close">&times;</button></div>
    <div class="modal-body pp-editor-body">
      <h4 class="modal-section-title">Leave types</h4>
      <p class="form-note">Days per year is each person's allowance; 0 means no limit. A type that has requests is hidden instead of deleted.</p>
      ${types.filter((t) => t.active).map(typeRow).join('')}${typeRow(null)}
      <h4 class="modal-section-title">Company holidays ${new Date().getFullYear()}</h4>
      <p class="form-note">Holidays are not counted as leave days.</p>
      ${holidays.length ? holidays.map((h) => `<div class="lv-type-row lv-holiday-row"><span>${escapeText(leaveDate(h.day))}</span><span>${escapeText(h.name)}</span><span></span><button type="button" class="btn" data-holiday-delete="${h.day}">Remove</button></div>`).join('') : '<p class="pp-muted">No holidays added for this year.</p>'}
      <div class="lv-type-row" data-holiday-new><input type="date" data-holiday-day aria-label="Date"><input type="text" maxlength="100" placeholder="Name, for example Independence Day" data-holiday-name aria-label="Holiday name"><span></span><button type="button" class="btn primary" data-holiday-add>Add</button></div>
    </div>`;
  openSettingsModal(modal);
}

async function leaveSettingsAction(action, row) {
  try {
    if (action === 'holiday-add') {
      await leaveApi('/api/leave/holidays', 'POST', { day: row.querySelector('[data-holiday-day]').value, name: row.querySelector('[data-holiday-name]').value });
    } else if (action === 'holiday-delete') {
      await leaveApi(`/api/leave/holidays/${row.dataset.day}`, 'DELETE');
    } else {
      const body = { name: row.querySelector('[data-type-name]').value, daysPerYear: Number(row.querySelector('[data-type-days]').value), paid: row.querySelector('[data-type-paid]').checked };
      if (action === 'type-add') await leaveApi('/api/leave/types', 'POST', body);
      else if (action === 'type-save') await leaveApi(`/api/leave/types/${row.dataset.type}`, 'PUT', body);
      else if (action === 'type-delete') {
        if (!confirm('Delete this leave type? If people have used it, it is only hidden.')) return;
        await leaveApi(`/api/leave/types/${row.dataset.type}`, 'DELETE');
      }
    }
    await openLeaveSettings();
    if (leaveState.loaded) loadLeave();
  } catch (err) {
    showToast(err.message || 'Could not save.', 'error');
  }
}

// In an employee's record: this year's balance for each type, with a box to add or remove days.
async function loadEmployeeLeave(id) {
  const host = document.getElementById('emp-leave');
  if (!host) return;
  const year = new Date().getFullYear();
  try {
    const data = await leaveApi(`/api/leave/balances/${id}?year=${year}`);
    if (employeeState.editingId !== id) return;
    host.innerHTML = `<p class="form-note">${year}. Adjustment adds (or removes) days for this person only.</p>
      ${data.balances.map((b) => `<div class="lv-type-row" data-adjust-type="${b.typeId}">
        <span>${escapeText(b.name)}</span><span class="pp-muted">${b.capped ? `${b.remaining} left of ${b.entitled}` : 'no limit'} · ${b.used} used</span>
        <input type="number" min="-365" max="365" step="0.5" value="${b.adjustment}" data-adjust-value aria-label="Adjustment for ${escapeText(b.name)}">
        <button type="button" class="btn" data-adjust-save="${id}">Save</button></div>`).join('') || '<p class="pp-muted">No leave types yet.</p>'}`;
  } catch (err) {
    host.innerHTML = `<p class="pp-muted">${escapeText(err.message || 'Could not load the balances.')}</p>`;
  }
}

// ---- events ----

if (typeof document !== 'undefined') {
  document.addEventListener('click', async (event) => {
    const t = event.target;
    if (!t.closest) return;
    if (t.closest('[data-leave-close]')) { closeSettingsModal(); return; }
    const view = t.closest('[data-leave-view]');
    if (view) {
      leaveState.view = view.dataset.leaveView;
      if (leaveState.view === 'calendar') leaveState.calendar = null;
      if (leaveState.view === 'records') leaveState.records = null;
      renderPeopleBody();
      return;
    }
    if (t.closest('[data-leave-request]')) { openLeaveRequest(); return; }
    if (t.closest('[data-leave-records-export]')) {
      try {
        const data = await leaveApi(`/api/leave/records/export?${leaveFilterQuery()}`);
        const saved = await window.electronAPI.saveAccountsCsv('leave', data.csv);
        if (saved && saved.saved) showToast(`Saved ${data.count} record${data.count === 1 ? '' : 's'}${data.truncated ? ' (the newest 5000)' : ''}.`, 'success');
      } catch (err) { showToast(err.message || 'Could not export.', 'error'); }
      return;
    }
    const cancel = t.closest('[data-leave-cancel]');
    if (cancel) {
      if (!confirm('Cancel this leave request?')) return;
      try { await leaveApi(`/api/leave/requests/${cancel.dataset.leaveCancel}/cancel`, 'POST', {}); showToast('Request cancelled.', 'success'); await loadLeave(); } catch (err) { showToast(err.message || 'Could not cancel.', 'error'); }
      return;
    }
    const decide = t.closest('[data-leave-decide]');
    if (decide) {
      const id = Number(decide.closest('[data-leave-id]').dataset.leaveId);
      const status = decide.dataset.leaveDecide;
      let note = '';
      if (status === 'rejected') { note = await askText('Tell them why (optional):', { maxLength: 300 }); if (note === null) return; }
      try { await leaveApi(`/api/leave/requests/${id}/decision`, 'PUT', { status, note }); showToast(status === 'approved' ? 'Approved.' : 'Declined.', 'success'); await loadLeave(); } catch (err) { showToast(err.message || 'Could not save the decision.', 'error'); }
      return;
    }
    const monthButton = t.closest('[data-leave-month]');
    if (monthButton) {
      const step = Number(monthButton.dataset.leaveMonth);
      const [y, m] = leaveState.month.split('-').map(Number);
      leaveState.month = step === 0 ? new Date().toISOString().slice(0, 7) : new Date(Date.UTC(y, m - 1 + step, 1)).toISOString().slice(0, 7);
      leaveState.calendar = null;
      renderPeopleBody();
      return;
    }
    if (t.closest('[data-emp-leave-settings]')) { openLeaveSettings(); return; }
    const typeRow = t.closest('[data-type]');
    if (typeRow && t.closest('button')) {
      const action = t.closest('[data-type-add]') ? 'type-add' : t.closest('[data-type-save]') ? 'type-save' : t.closest('[data-type-delete]') ? 'type-delete' : null;
      if (action) { leaveSettingsAction(action, typeRow); return; }
    }
    const holidayAdd = t.closest('[data-holiday-add]');
    if (holidayAdd) { leaveSettingsAction('holiday-add', holidayAdd.closest('[data-holiday-new]')); return; }
    const holidayDelete = t.closest('[data-holiday-delete]');
    if (holidayDelete) { leaveSettingsAction('holiday-delete', { dataset: { day: holidayDelete.dataset.holidayDelete } }); return; }
    const adjust = t.closest('[data-adjust-save]');
    if (adjust) {
      const row = adjust.closest('[data-adjust-type]');
      try {
        await leaveApi('/api/leave/entitlements', 'PUT', { userId: Number(adjust.dataset.adjustSave), typeId: Number(row.dataset.adjustType), year: new Date().getFullYear(), adjustment: Number(row.querySelector('[data-adjust-value]').value) });
        showToast('Balance adjusted.', 'success');
        loadEmployeeLeave(Number(adjust.dataset.adjustSave));
      } catch (err) { showToast(err.message || 'Could not adjust the balance.', 'error'); }
    }
  });

  document.addEventListener('change', (event) => {
    const filterKey = { 'lv-f-status': 'status', 'lv-f-type': 'typeId', 'lv-f-from': 'from', 'lv-f-to': 'to' }[event.target.id];
    if (filterKey) { leaveState.filters[filterKey] = event.target.value; leaveState.records = null; renderPeopleBody(); return; }
    if (event.target.id === 'leave-scope') { leaveState.scope = event.target.value; leaveState.calendar = null; renderPeopleBody(); return; }
    if (['lv-start', 'lv-end', 'lv-half'].includes(event.target.id)) updateLeavePreview();
  });

  let leaveSearchTimer = null;
  document.addEventListener('input', (event) => {
    if (event.target.id !== 'lv-f-q') return;
    clearTimeout(leaveSearchTimer);
    const value = event.target.value;
    leaveSearchTimer = setTimeout(async () => {
      leaveState.filters.q = value;
      try { leaveState.records = await leaveApi(`/api/leave/records?${leaveFilterQuery()}`); } catch (err) { showToast(err.message || 'Could not search.', 'error'); return; }
      const input = document.getElementById('lv-f-q');
      const caret = input ? input.selectionStart : null;
      renderPeopleBody();
      const again = document.getElementById('lv-f-q');
      if (again) { again.focus(); if (caret !== null) again.setSelectionRange(caret, caret); }
    }, 300);
  });

  document.addEventListener('submit', (event) => {
    if (event.target.id === 'leave-form') submitLeaveRequest(event);
  });
}
