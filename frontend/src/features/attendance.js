// IT Avenue Workspace - attendance (People > Attendance).
//
// My day: clock in and out, and my timesheet for the month. Team (managers and HR): who is in, late, absent or
// on leave on a day, and anyone's timesheet. HR can fix a day, edit work schedules, and export the period for
// payroll. Times are the company's (the server says which time zone); the server's clock is the only clock used.
// Loaded after leave.js.

const attendanceState = {
  view: 'me', today: null, loaded: false, error: '',
  month: new Date().toISOString().slice(0, 7), sheet: null, viewUserId: null,
  boardDate: '', board: null,
};

const ATTENDANCE_STATUS = {
  present: ['Present', 'att-present'], working: ['Working', 'att-working'], absent: ['Absent', 'att-absent'], leave: ['On leave', 'att-leave'],
  holiday: ['Holiday', 'att-rest'], rest: ['Rest day', 'att-rest'], incomplete: ['No clock-out', 'att-absent'], upcoming: ['', 'att-rest'], 'n/a': ['', 'att-rest'],
};

async function attendanceApi(path, method = 'GET', body) {
  const res = await api(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function canSeeTeamAttendance() {
  return canManageEmployees() || Boolean(attendanceState.today && attendanceState.today.isManager);
}

function attendanceDay(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

const attendanceHours = (minutes) => (minutes ? (Math.round((minutes / 60) * 100) / 100).toString() : '');

function attendanceStatusChip(d) {
  const [label, cls] = ATTENDANCE_STATUS[d.status] || ['', 'att-rest'];
  return label ? `<span class="att-chip ${cls}">${label}</span>` : '';
}

// ---- loading ----

async function loadAttendance() {
  try {
    attendanceState.today = await attendanceApi('/api/attendance/today');
    const target = attendanceState.viewUserId ? `&userId=${attendanceState.viewUserId}` : '';
    attendanceState.sheet = await attendanceApi(`/api/attendance/timesheet?month=${attendanceState.month}${target}`);
    if (attendanceState.view === 'team') {
      if (!attendanceState.boardDate) attendanceState.boardDate = attendanceState.today.today;
      attendanceState.board = await attendanceApi(`/api/attendance/board?date=${attendanceState.boardDate}`);
    }
    attendanceState.error = '';
  } catch (err) {
    attendanceState.error = err.message || 'Attendance is not available';
  }
  attendanceState.loaded = true;
  if (typeof peopleState !== 'undefined' && peopleState.tab === 'attendance' && peopleState.pageId === null) renderPeopleBody();
}

// ---- the tab ----

function renderAttendance(body) {
  if (attendanceState.error) { body.innerHTML = emptyRecordMarkup('Attendance is not available', attendanceState.error); return; }
  if (!attendanceState.loaded) { body.innerHTML = '<p class="pp-muted">Loading…</p>'; loadAttendance(); return; }
  const team = canSeeTeamAttendance();
  if (!team && attendanceState.view === 'team') attendanceState.view = 'me';
  body.innerHTML = `
    <div class="lv-tabs">
      <button type="button" class="lv-tab${attendanceState.view === 'me' ? ' active' : ''}" data-att-view="me">My day</button>
      ${team ? `<button type="button" class="lv-tab${attendanceState.view === 'team' ? ' active' : ''}" data-att-view="team">${canManageEmployees() ? 'Everyone' : 'My team'}</button>` : ''}
      <span class="emp-spacer"></span>
      ${canManageEmployees() ? '<button type="button" class="btn" data-att-schedules>Work schedules</button><button type="button" class="btn primary" data-att-export>Export for payroll</button>' : ''}
    </div>
    <div class="lv-body">${attendanceState.view === 'team' ? attendanceTeamHtml() : attendanceMeHtml()}</div>`;
}

function attendanceClockCard() {
  const t = attendanceState.today;
  const rec = t.record;
  let status;
  let buttons;
  if (!rec) {
    status = t.day && t.day.status === 'holiday' ? 'Today is a company holiday.' : t.day && t.day.status === 'rest' ? 'Today is a rest day.' : t.day && t.day.status === 'leave' ? 'You are on approved leave today.' : 'You have not clocked in yet.';
    buttons = '<button type="button" class="btn primary att-big" data-att-clock="in">Clock in</button>';
  } else if (rec.open) {
    const late = t.day && t.day.lateMinutes ? ` (${t.day.lateMinutes} min late)` : '';
    status = `Clocked in at ${rec.clockIn}${late}.`;
    buttons = '<button type="button" class="btn primary att-big" data-att-clock="out">Clock out</button>';
  } else {
    status = `Clocked in ${rec.clockIn}, out ${rec.clockOut}. Worked ${attendanceHours(t.day ? t.day.workedMinutes : 0) || '0'} hours.`;
    buttons = '';
  }
  return `<div class="att-clock">
    <div><strong class="att-date">${escapeText(attendanceDay(t.today))}</strong>
      <p class="att-status">${escapeText(status)}</p>
      <p class="pp-muted">Schedule: ${escapeText(t.schedule.name)} · ${t.schedule.start}–${t.schedule.end} · times are ${escapeText(t.timezone.replace('_', ' '))}</p></div>
    <div>${buttons}</div>
  </div>`;
}

function attendanceSheetHtml() {
  const s = attendanceState.sheet;
  if (!s) return '<p class="pp-muted">Loading…</p>';
  const [year, month] = attendanceState.month.split('-').map(Number);
  const title = new Date(year, month - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
  const t = s.totals;
  const mine = !attendanceState.viewUserId || attendanceState.viewUserId === Number(state.user.id);
  const editable = canManageEmployees();
  const rows = s.days.filter((d) => d.status !== 'n/a').map((d) => `
    <tr class="${['rest', 'holiday', 'upcoming'].includes(d.status) && !d.clockIn ? 'att-muted-row' : ''}"${editable ? ` data-att-edit="${d.date}" tabindex="0"` : ''}>
      <td>${escapeText(attendanceDay(d.date))}</td><td>${attendanceStatusChip(d)}${d.source === 'hr' ? '<span class="att-hr" title="Set by HR">HR</span>' : ''}</td>
      <td>${d.clockIn || ''}</td><td>${d.clockOut || ''}</td>
      <td>${d.lateMinutes ? `${d.lateMinutes} min` : ''}</td><td>${d.undertimeMinutes ? `${d.undertimeMinutes} min` : ''}</td>
      <td>${attendanceHours(d.workedMinutes)}</td><td>${d.overtimeMinutes ? attendanceHours(d.overtimeMinutes) : ''}</td>
      <td class="att-note">${escapeText(d.note || '')}</td></tr>`).join('');
  return `
    <div class="lv-cal-head">
      <button type="button" class="btn" data-att-month="-1" aria-label="Previous month">‹</button>
      <strong>${escapeText(title)}${mine ? '' : ` · ${escapeText(personName(s.person))}`}</strong>
      <button type="button" class="btn" data-att-month="1" aria-label="Next month">›</button>
      <button type="button" class="btn" data-att-month="0">This month</button>
      ${mine ? '' : '<button type="button" class="btn" data-att-mine>Back to mine</button>'}
    </div>
    <div class="lv-balances att-totals">
      ${[['Days present', `${t.presentDays} of ${t.scheduledDays}`], ['Absent', t.absentDays], ['Late', `${t.lateMinutes} min`], ['Hours worked', t.workedHours], ['Overtime', `${t.overtimeHours} h`], ['Leave', `${t.paidLeaveDays + t.unpaidLeaveDays} d`]]
    .map(([label, value]) => `<div class="lv-balance"><span class="lv-balance-name">${label}</span><strong>${escapeText(String(value))}</strong></div>`).join('')}
    </div>
    <div class="emp-table-wrap"><table class="emp-table att-table"><thead><tr><th>Date</th><th>Status</th><th>In</th><th>Out</th><th>Late</th><th>Short</th><th>Hours</th><th>Overtime h</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${editable ? '<p class="pp-hint">Click a day to fix or add a clock-in and clock-out.</p>' : ''}`;
}

function attendanceMeHtml() {
  return `${attendanceClockCard()}${attendanceSheetHtml()}`;
}

function attendanceTeamHtml() {
  const b = attendanceState.board;
  if (!b) return '<p class="pp-muted">Loading…</p>';
  const counts = { present: 0, working: 0, absent: 0, leave: 0, late: 0 };
  b.rows.forEach((r) => {
    if (r.status === 'present' || r.status === 'working') counts.present += 1;
    if (r.status === 'absent' || r.status === 'incomplete') counts.absent += 1;
    if (r.status === 'leave') counts.leave += 1;
    if (r.lateMinutes) counts.late += 1;
  });
  const sorted = b.rows.slice().sort((x, y) => personName(x).localeCompare(personName(y), undefined, { sensitivity: 'base' }));
  const rows = sorted.map((r) => `
    <tr data-att-person="${r.id}" tabindex="0"><td><span class="emp-person">${peopleAvatar(r, 'sm')}<span><strong>${escapeText(personName(r))}</strong><em>${escapeText(r.department || '')}</em></span></span></td>
      <td>${attendanceStatusChip(r)}${r.lateMinutes ? `<span class="att-late">${r.lateMinutes} min late</span>` : ''}</td>
      <td>${r.clockIn || ''}</td><td>${r.clockOut || ''}</td><td>${attendanceHours(r.workedMinutes)}</td><td class="pp-muted">${escapeText(r.schedule.start)}–${escapeText(r.schedule.end)}</td></tr>`).join('');
  return `
    <div class="emp-toolbar"><input type="date" id="att-board-date" class="pp-select" value="${escapeText(b.date)}" aria-label="Date">
      <span class="pp-muted">${counts.present} in · ${counts.late} late · ${counts.absent} absent · ${counts.leave} on leave</span></div>
    ${b.rows.length ? `<div class="emp-table-wrap"><table class="emp-table"><thead><tr><th>Employee</th><th>Status</th><th>In</th><th>Out</th><th>Hours</th><th>Schedule</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="pp-hint">Click a person to see their month.</p>` : emptyRecordMarkup('Nobody to show', b.scope === 'team' ? 'People who report to you show here.' : 'There are no active members.')}`;
}

// ---- HR: fix a day ----

function openAttendanceEditor(date) {
  const s = attendanceState.sheet;
  const d = s && s.days.find((x) => x.date === date);
  const modal = document.getElementById('attendance-modal');
  if (!d || !modal) return;
  modal.innerHTML = `
    <div class="modal-header"><h3>${escapeText(attendanceDay(date))} · ${escapeText(personName(s.person))}</h3><button class="modal-close" type="button" data-att-close aria-label="Close">&times;</button></div>
    <form id="attendance-form" data-date="${date}">
      <div class="modal-body pp-editor-body">
        <div class="pp-edit-pair">
          <div class="form-group"><label for="att-in">Clock in</label><input id="att-in" type="time" value="${d.clockIn || ''}" required></div>
          <div class="form-group"><label for="att-out">Clock out</label><input id="att-out" type="time" value="${d.clockOut || ''}"></div>
        </div>
        <div class="form-group"><label for="att-note">Note (why it was changed)</label><input id="att-note" type="text" maxlength="200" value="${escapeText(d.note || '')}"></div>
        <p class="form-note">Company time (${escapeText(s.timezone)}). A clock-out earlier than the clock-in means the next morning (a night shift). Leave clock-out empty if they have not clocked out.</p>
      </div>
      <div class="modal-footer">
        ${d.clockIn ? '<button class="btn danger" type="button" data-att-delete>Remove this record</button>' : ''}
        <button class="btn" type="button" data-att-close>Cancel</button><button class="btn primary" type="submit">Save</button>
      </div>
    </form>`;
  openSettingsModal(modal);
}

async function saveAttendanceRecord(event) {
  event.preventDefault();
  const form = event.target;
  try {
    await attendanceApi('/api/attendance/records', 'PUT', {
      userId: attendanceState.sheet.person.id, date: form.dataset.date,
      clockIn: document.getElementById('att-in').value, clockOut: document.getElementById('att-out').value || null, note: document.getElementById('att-note').value,
    });
    closeSettingsModal();
    showToast('Attendance saved.', 'success');
    await loadAttendance();
  } catch (err) {
    showToast(err.message || 'Could not save.', 'error');
  }
}

// ---- HR: schedules and the payroll export ----

async function openSchedules() {
  const modal = document.getElementById('schedules-modal');
  if (!modal) return;
  let data;
  try { data = await attendanceApi('/api/attendance/schedules'); } catch (err) { showToast(err.message || 'Could not load the schedules.', 'error'); return; }
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const row = (s) => `<div class="sch-row" data-schedule="${s ? s.id : 'new'}">
    <input type="text" maxlength="60" value="${escapeText(s ? s.name : '')}" placeholder="${s ? '' : 'New schedule name'}" data-sch-name aria-label="Name">
    <div class="sch-times"><label>Start <input type="time" value="${s ? s.start : '09:00'}" data-sch-start></label><label>End <input type="time" value="${s ? s.end : '18:00'}" data-sch-end></label>
      <label>Break <input type="number" min="0" max="240" value="${s ? s.breakMinutes : 60}" data-sch-break> min</label>
      <label>Grace <input type="number" min="0" max="120" value="${s ? s.graceMinutes : 10}" data-sch-grace> min</label>
      <label>Overtime after <input type="number" min="0" max="240" value="${s ? s.overtimeMinMinutes : 30}" data-sch-ot> min</label></div>
    <div class="sch-days">${days.map((d, i) => `<label class="admin-inline-check"><input type="checkbox" data-sch-day="${i}"${(s ? s.workDays : [1, 2, 3, 4, 5]).includes(i) ? ' checked' : ''}> ${d}</label>`).join('')}</div>
    <div class="sch-actions">${s ? `<span class="pp-muted">${s.people} ${s.people === 1 ? 'person' : 'people'}${s.isDefault ? ' · default' : ''}</span>
      <button type="button" class="btn" data-sch-save>Save</button>${s.isDefault ? '' : '<button type="button" class="btn" data-sch-default>Make default</button><button type="button" class="btn" data-sch-delete>Delete</button>'}`
    : '<button type="button" class="btn primary" data-sch-add>Add schedule</button>'}</div></div>`;
  modal.innerHTML = `
    <div class="modal-header"><h3>Work schedules</h3><button class="modal-close" type="button" data-att-close aria-label="Close">&times;</button></div>
    <div class="modal-body pp-editor-body">
      <p class="form-note">Late: clocking in after start + grace counts late minutes from the start. Overtime counts once they stay at least the overtime threshold past the end. Work on rest days and holidays is counted separately for payroll. People without their own schedule follow the default. Set a person's schedule in their employee record. Times are ${escapeText(data.timezone)}.</p>
      ${data.schedules.map(row).join('')}<h4 class="modal-section-title">New schedule</h4>${row(null)}
    </div>`;
  openSettingsModal(modal);
}

function readScheduleRow(row) {
  return {
    name: row.querySelector('[data-sch-name]').value, start: row.querySelector('[data-sch-start]').value, end: row.querySelector('[data-sch-end]').value,
    breakMinutes: Number(row.querySelector('[data-sch-break]').value), graceMinutes: Number(row.querySelector('[data-sch-grace]').value),
    overtimeMinMinutes: Number(row.querySelector('[data-sch-ot]').value),
    workDays: Array.from(row.querySelectorAll('[data-sch-day]')).filter((c) => c.checked).map((c) => Number(c.dataset.schDay)),
  };
}

async function scheduleAction(action, row) {
  try {
    const id = row.dataset.schedule;
    if (action === 'add') await attendanceApi('/api/attendance/schedules', 'POST', readScheduleRow(row));
    else if (action === 'save') await attendanceApi(`/api/attendance/schedules/${id}`, 'PUT', readScheduleRow(row));
    else if (action === 'default') await attendanceApi(`/api/attendance/schedules/${id}/default`, 'PUT', {});
    else if (action === 'delete') {
      if (!confirm('Delete this schedule? People on it follow the default schedule.')) return;
      await attendanceApi(`/api/attendance/schedules/${id}`, 'DELETE');
    }
    await openSchedules();
    showToast('Schedule saved.', 'success');
    if (attendanceState.loaded) loadAttendance();
  } catch (err) {
    showToast(err.message || 'Could not save the schedule.', 'error');
  }
}

function openAttendanceExport() {
  const modal = document.getElementById('attendance-export-modal');
  if (!modal) return;
  // the current pay period: 1st to 15th, or 16th to the end of the month
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const firstHalf = now.getDate() <= 15;
  const from = firstHalf ? `${y}-${m}-01` : `${y}-${m}-16`;
  const to = firstHalf ? `${y}-${m}-15` : `${y}-${m}-${String(new Date(y, now.getMonth() + 1, 0).getDate()).padStart(2, '0')}`;
  modal.innerHTML = `
    <div class="modal-header"><h3>Export for payroll</h3><button class="modal-close" type="button" data-att-close aria-label="Close">&times;</button></div>
    <form id="attendance-export-form">
      <div class="modal-body pp-editor-body">
        <div class="pp-edit-pair">
          <div class="form-group"><label for="ax-from">From</label><input id="ax-from" type="date" value="${from}" required></div>
          <div class="form-group"><label for="ax-to">To</label><input id="ax-to" type="date" value="${to}" required></div>
        </div>
        <label class="preference-toggle"><input type="radio" name="ax-kind" value="summary" checked><span>One row per employee (days, absences, leave, late, hours, overtime)</span></label>
        <label class="preference-toggle"><input type="radio" name="ax-kind" value="detail"><span>One row per employee per day (the full daily detail)</span></label>
        <p class="form-note">Up to 62 days. Includes active employees. Paid and unpaid leave are counted apart; days before a hire date or after a last day are left out. Holidays come from People > Manage > Leave settings.</p>
      </div>
      <div class="modal-footer"><button class="btn" type="button" data-att-close>Cancel</button><button class="btn primary" type="submit">Save CSV…</button></div>
    </form>`;
  openSettingsModal(modal);
}

async function submitAttendanceExport(event) {
  event.preventDefault();
  const from = document.getElementById('ax-from').value;
  const to = document.getElementById('ax-to').value;
  const detail = document.querySelector('input[name="ax-kind"]:checked').value === 'detail' ? '&detail=1' : '';
  try {
    const data = await attendanceApi(`/api/attendance/export?from=${from}&to=${to}${detail}`);
    const saved = await window.electronAPI.saveAccountsCsv('attendance', data.csv);
    if (saved && saved.saved) { closeSettingsModal(); showToast(`Saved ${data.count} employee${data.count === 1 ? '' : 's'}.`, 'success'); }
  } catch (err) {
    showToast(err.message || 'Could not export.', 'error');
  }
}

// ---- events ----

if (typeof document !== 'undefined') {
  document.addEventListener('click', async (event) => {
    const t = event.target;
    if (!t.closest) return;
    if (t.closest('[data-att-close]')) { closeSettingsModal(); return; }
    const view = t.closest('[data-att-view]');
    if (view) { attendanceState.view = view.dataset.attView; attendanceState.board = null; await loadAttendance(); return; }
    const clock = t.closest('[data-att-clock]');
    if (clock) {
      clock.disabled = true;
      try {
        attendanceState.today = await attendanceApi(`/api/attendance/clock-${clock.dataset.attClock}`, 'POST', {});
        showToast(clock.dataset.attClock === 'in' ? 'Clocked in.' : 'Clocked out.', 'success');
        await loadAttendance();
      } catch (err) { showToast(err.message || 'Could not clock.', 'error'); clock.disabled = false; }
      return;
    }
    const month = t.closest('[data-att-month]');
    if (month) {
      const step = Number(month.dataset.attMonth);
      const [y, m] = attendanceState.month.split('-').map(Number);
      attendanceState.month = step === 0 ? new Date().toISOString().slice(0, 7) : new Date(Date.UTC(y, m - 1 + step, 1)).toISOString().slice(0, 7);
      attendanceState.sheet = null;
      renderPeopleBody();
      loadAttendance();
      return;
    }
    if (t.closest('[data-att-mine]')) { attendanceState.viewUserId = null; attendanceState.sheet = null; attendanceState.view = 'me'; renderPeopleBody(); loadAttendance(); return; }
    const person = t.closest('[data-att-person]');
    if (person) { attendanceState.viewUserId = Number(person.dataset.attPerson); attendanceState.sheet = null; attendanceState.view = 'me'; renderPeopleBody(); loadAttendance(); return; }
    const edit = t.closest('[data-att-edit]');
    if (edit) { openAttendanceEditor(edit.dataset.attEdit); return; }
    if (t.closest('[data-att-delete]')) {
      const date = document.getElementById('attendance-form').dataset.date;
      if (!confirm('Remove this day\'s record?')) return;
      try { await attendanceApi(`/api/attendance/records/${attendanceState.sheet.person.id}/${date}`, 'DELETE'); closeSettingsModal(); showToast('Record removed.', 'success'); await loadAttendance(); } catch (err) { showToast(err.message || 'Could not remove it.', 'error'); }
      return;
    }
    if (t.closest('[data-att-schedules]')) { openSchedules(); return; }
    if (t.closest('[data-att-export]')) { openAttendanceExport(); return; }
    const sch = t.closest('[data-schedule]');
    if (sch && t.closest('button')) {
      const action = t.closest('[data-sch-add]') ? 'add' : t.closest('[data-sch-save]') ? 'save' : t.closest('[data-sch-default]') ? 'default' : t.closest('[data-sch-delete]') ? 'delete' : null;
      if (action) scheduleAction(action, sch);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !event.target.closest) return;
    const edit = event.target.closest('[data-att-edit]');
    if (edit) openAttendanceEditor(edit.dataset.attEdit);
  });

  document.addEventListener('change', async (event) => {
    if (event.target.id === 'att-board-date' && event.target.value) { attendanceState.boardDate = event.target.value; attendanceState.board = null; await loadAttendance(); }
  });

  document.addEventListener('submit', (event) => {
    if (event.target.id === 'attendance-form') saveAttendanceRecord(event);
    if (event.target.id === 'attendance-export-form') submitAttendanceExport(event);
  });
}
