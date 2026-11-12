// IT Avenue Workspace - attendance (People > Attendance).
//
// My day: clock in and out as often as needed (in 8:00, out 12:00, in 13:00, out 17:00), and my timesheet for the
// month, with a way to ask for a correction. Team (managers and HR): who is in, late, absent or on leave on a day,
// and anyone's timesheet. Corrections waiting for me. HR also fixes days, edits work schedules, sets the office
// networks, approves new devices, and exports the period for payroll. Times are the company's (the server says which
// time zone); the server's clock is the only clock used. Loaded after leave.js.

const attendanceState = {
  view: 'me', today: null, loaded: false, error: '', device: null,
  month: new Date().toISOString().slice(0, 7), sheet: null, viewUserId: null,
  boardDate: '', board: null, queue: [], mine: [], waiting: 0, devices: null,
};

const ATTENDANCE_STATUS = {
  present: ['Present', 'att-present'], working: ['Working', 'att-working'], absent: ['Absent', 'att-absent'], leave: ['On leave', 'att-leave'],
  holiday: ['Holiday', 'att-rest'], rest: ['Rest day', 'att-rest'], incomplete: ['No clock-out', 'att-absent'], upcoming: ['', 'att-rest'], 'n/a': ['', 'att-rest'],
};
const CORRECTION_STATUS = { pending: 'Waiting', approved: 'Approved', rejected: 'Declined', cancelled: 'Cancelled' };

async function attendanceApi(path, method = 'GET', body, headers) {
  const res = await api(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(headers ? { headers } : {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { code: data.code });
  return data;
}

// This installation's id and name, sent with every clock-in and clock-out so HR can tell when someone uses a new device.
async function attendanceDeviceHeaders() {
  if (!attendanceState.device) {
    try {
      attendanceState.device = window.electronAPI && window.electronAPI.getDevice ? await window.electronAPI.getDevice() : null;
    } catch (err) {
      attendanceState.device = null;
    }
  }
  const d = attendanceState.device;
  return d && d.id ? { 'X-Device-Id': d.id, 'X-Device-Name': d.name || '' } : {};
}

function canSeeTeamAttendance() {
  return canManageEmployees() || Boolean(attendanceState.today && attendanceState.today.isManager);
}

function attendanceDay(value) {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

const attendanceHours = (minutes) => (minutes ? (Math.round((minutes / 60) * 100) / 100).toString() : '');
const punchLine = (d) => (d.punches && d.punches.length ? d.punches.map((p) => `${p.in}–${p.out || '…'}`).join(' · ') : '');

function attendanceStatusChip(d) {
  const [label, cls] = ATTENDANCE_STATUS[d.status] || ['', 'att-rest'];
  return label ? `<span class="att-chip ${cls}">${label}</span>` : '';
}

function attendanceFlagChip(d) {
  return d.deviceFlag ? '<span class="att-chip att-leave" title="Clocked from a device HR has not approved yet">New device</span>' : '';
}

function updateAttendanceBadge() {
  if (typeof updateLeaveBadges === 'function') updateLeaveBadges();
}

// ---- loading ----

async function loadAttendance() {
  try {
    attendanceState.today = await attendanceApi('/api/attendance/today');
    attendanceState.waiting = attendanceState.today.correctionsWaiting || 0;
    const target = attendanceState.viewUserId ? `&userId=${attendanceState.viewUserId}` : '';
    attendanceState.sheet = await attendanceApi(`/api/attendance/timesheet?month=${attendanceState.month}${target}`);
    if (attendanceState.view === 'me') attendanceState.mine = (await attendanceApi('/api/attendance/corrections/mine')).corrections;
    if (attendanceState.view === 'team') {
      if (!attendanceState.boardDate) attendanceState.boardDate = attendanceState.today.today;
      attendanceState.board = await attendanceApi(`/api/attendance/board?date=${attendanceState.boardDate}`);
    }
    if (attendanceState.view === 'corrections') attendanceState.queue = (await attendanceApi('/api/attendance/corrections/queue')).corrections;
    if (attendanceState.view === 'devices' && canManageEmployees()) attendanceState.devices = (await attendanceApi('/api/attendance/devices/pending')).devices;
    attendanceState.error = '';
  } catch (err) {
    attendanceState.error = err.message || 'Attendance is not available';
  }
  attendanceState.loaded = true;
  updateAttendanceBadge();
  if (typeof peopleState !== 'undefined' && peopleState.tab === 'attendance' && peopleState.pageId === null) renderPeopleBody();
}

// Quietly find out how many corrections wait for me (the badge); called once the app is up and when news arrives.
async function refreshAttendanceSummary() {
  try {
    const t = await attendanceApi('/api/attendance/today');
    attendanceState.waiting = t.correctionsWaiting || 0;
    if (!attendanceState.today) attendanceState.today = t;
    updateAttendanceBadge();
  } catch (err) {
    // guests and the like: no badge
  }
}

// A correction event from the server: someone asked, or my request was decided.
function handleAttendanceUpdated(event) {
  if (!event || !event.correction) return;
  const c = event.correction;
  const mine = state.user && Number(c.userId) === Number(state.user.id);
  if (event.kind === 'requested' && !mine) {
    showToast(`${personName(c)} asked to correct ${attendanceDay(c.date)}.`, 'info');
  } else if (mine && (event.kind === 'approved' || event.kind === 'rejected')) {
    showToast(`Your correction for ${attendanceDay(c.date)} was ${event.kind === 'approved' ? 'approved' : 'declined'}${c.decidedBy ? ` by ${c.decidedBy}` : ''}.`, event.kind === 'approved' ? 'success' : 'info');
  }
  if (attendanceState.loaded) loadAttendance(); else refreshAttendanceSummary();
}

// ---- the tab ----

function renderAttendance(body) {
  if (attendanceState.error) { body.innerHTML = emptyRecordMarkup('Attendance is not available', attendanceState.error); return; }
  if (!attendanceState.loaded) { body.innerHTML = '<p class="pp-muted">Loading…</p>'; loadAttendance(); return; }
  const team = canSeeTeamAttendance();
  if (!team && ['team', 'corrections', 'devices'].includes(attendanceState.view)) attendanceState.view = 'me';
  if (attendanceState.view === 'devices' && !canManageEmployees()) attendanceState.view = 'me';
  const tab = (key, label) => `<button type="button" class="lv-tab${attendanceState.view === key ? ' active' : ''}" data-att-view="${key}">${label}</button>`;
  body.innerHTML = `
    <div class="lv-tabs">
      ${tab('me', 'My day')}
      ${team ? tab('team', canManageEmployees() ? 'Everyone' : 'My team') : ''}
      ${team ? tab('corrections', `Corrections${attendanceState.waiting ? ` (${attendanceState.waiting})` : ''}`) : ''}
      ${canManageEmployees() ? tab('devices', 'New devices') : ''}
      <span class="emp-spacer"></span>
      ${canManageEmployees() ? '<button type="button" class="btn" data-att-networks>Office network</button><button type="button" class="btn" data-att-schedules>Work schedules</button><button type="button" class="btn primary" data-att-export>Export for payroll</button>' : ''}
    </div>
    <div class="lv-body">${{ team: attendanceTeamHtml, corrections: attendanceQueueHtml, devices: attendanceDevicesHtml }[attendanceState.view]?.() || attendanceMeHtml()}</div>`;
}

function attendanceClockCard() {
  const t = attendanceState.today;
  const net = t.network;
  const punches = t.day ? t.day.punches : [];
  let status;
  if (t.clockedIn) status = `Clocked in since ${t.openSince}${t.day && t.day.lateMinutes ? ` (${t.day.lateMinutes} min late)` : ''}.`;
  else if (punches.length) status = `Clocked out at ${punches[punches.length - 1].out}. Worked ${attendanceHours(t.day.workedMinutes) || '0'} hours so far.`;
  else if (t.day && t.day.status === 'holiday') status = 'Today is a company holiday.';
  else if (t.day && t.day.status === 'rest') status = 'Today is a rest day.';
  else if (t.day && t.day.status === 'leave') status = 'You are on approved leave today.';
  else status = 'You have not clocked in yet.';
  const blocked = net.enforced && !net.allowed;
  return `<div class="att-clock">
    <div><strong class="att-date">${escapeText(attendanceDay(t.today))}</strong>
      <p class="att-status">${escapeText(status)}</p>
      ${punches.length ? `<p class="att-punches">${punches.map((p) => `<span class="att-punch">${p.in}–${p.out || '…'}</span>`).join('')}</p>` : ''}
      <p class="pp-muted">Schedule: ${escapeText(t.schedule.name)} · ${t.schedule.start}–${t.schedule.end} · times are ${escapeText(t.timezone.replace('_', ' '))}</p>
      ${blocked ? `<p class="att-warn">You are not on the office network (your address is ${escapeText(net.ip)}), so you cannot clock in or out. If you work remotely, ask HR.</p>` : ''}
    </div>
    <div><button type="button" class="btn primary att-big" data-att-clock="${t.clockedIn ? 'out' : 'in'}"${blocked ? ' disabled' : ''}>${t.clockedIn ? 'Clock out' : 'Clock in'}</button></div>
  </div>`;
}

function attendanceSheetHtml() {
  const s = attendanceState.sheet;
  if (!s) return '<p class="pp-muted">Loading…</p>';
  const [year, month] = attendanceState.month.split('-').map(Number);
  const title = new Date(year, month - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
  const t = s.totals;
  const mine = !attendanceState.viewUserId || attendanceState.viewUserId === Number(state.user.id);
  const manage = canManageEmployees();
  const today = attendanceState.today.today;
  const rows = s.days.filter((d) => d.status !== 'n/a').map((d) => {
    const clickable = manage || (mine && d.date < today);
    const ips = d.punches.some((p) => p.inIp) ? d.punches.map((p) => `${p.in}–${p.out || '…'}: in ${p.inIp || '?'}${p.out ? `, out ${p.outIp || '?'}` : ''}`).join('\n') : '';
    return `
    <tr class="${['rest', 'holiday', 'upcoming'].includes(d.status) && !d.punches.length ? 'att-muted-row' : ''}"${clickable ? ` data-att-edit="${d.date}" tabindex="0"` : ''}>
      <td>${escapeText(attendanceDay(d.date))}</td>
      <td>${attendanceStatusChip(d)}${d.source === 'hr' ? '<span class="att-hr" title="Set by HR">HR</span>' : ''}${d.source === 'correction' ? '<span class="att-hr" title="Corrected on request">Corrected</span>' : ''}${manage || !mine ? attendanceFlagChip(d) : ''}</td>
      <td title="${escapeText(ips)}">${escapeText(punchLine(d))}</td>
      <td>${d.lateMinutes ? `${d.lateMinutes} min` : ''}</td><td>${d.overBreakMinutes ? `${d.overBreakMinutes} min` : ''}</td><td>${d.undertimeMinutes ? `${d.undertimeMinutes} min` : ''}</td>
      <td>${attendanceHours(d.workedMinutes)}</td><td>${d.overtimeMinutes ? attendanceHours(d.overtimeMinutes) : (d.afterHoursMinutes ? `<span class="pp-muted" title="After hours; no overtime for managerial staff">(${attendanceHours(d.afterHoursMinutes)})</span>` : '')}</td>
      <td class="att-note" title="${escapeText(d.note || '')}">${escapeText(d.note || '')}</td></tr>`;
  }).join('');
  return `
    <div class="lv-cal-head">
      <button type="button" class="btn" data-att-month="-1" aria-label="Previous month">‹</button>
      <strong>${escapeText(title)}${mine ? '' : ` · ${escapeText(personName(s.person))}`}</strong>
      <button type="button" class="btn" data-att-month="1" aria-label="Next month">›</button>
      <button type="button" class="btn" data-att-month="0">This month</button>
      ${mine ? '' : '<button type="button" class="btn" data-att-mine>Back to mine</button>'}
    </div>
    <div class="lv-balances att-totals">
      ${[['Days present', `${t.presentDays} of ${t.scheduledDays}`], ['Absent', t.absentDays], ['Late', `${t.lateMinutes} min`], ['Over break', `${t.overBreakMinutes} min`], ['Hours worked', t.workedHours],
    [s.person.jobLevel === 'managerial' ? 'Overtime (none: managerial)' : 'Overtime', `${t.overtimeHours} h`], ['Leave', `${t.paidLeaveDays + t.unpaidLeaveDays} d`]]
    .map(([label, value]) => `<div class="lv-balance"><span class="lv-balance-name">${label}</span><strong>${escapeText(String(value))}</strong></div>`).join('')}
    </div>
    <div class="emp-table-wrap"><table class="emp-table att-table"><thead><tr><th>Date</th><th>Status</th><th>Clock-ins and outs</th><th>Late</th><th>Over break</th><th>Short</th><th>Hours</th><th>Overtime h</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="pp-hint">${manage ? 'Click a day to fix it. Hover the times to see the IP addresses.' : mine ? 'Click a past day to ask for a correction (a missed clock-out, for example).' : ''}</p>`;
}

function attendanceMineRequestsHtml() {
  if (!attendanceState.mine.length) return '';
  return `<h3 class="lv-h">My correction requests</h3><div class="emp-table-wrap"><table class="emp-table"><thead><tr><th>Day</th><th>Asked for</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>${attendanceState.mine.map((c) => `
    <tr><td>${escapeText(attendanceDay(c.date))}</td><td>${escapeText(c.punches.map((p) => `${p.in}–${p.out || '…'}`).join(' · '))}</td><td class="att-note" title="${escapeText(c.reason)}">${escapeText(c.reason)}</td>
      <td><span class="lv-status lv-${c.status}">${CORRECTION_STATUS[c.status]}</span>${c.decidedBy ? `<em class="lv-by">by ${escapeText(c.decidedBy)}</em>` : ''}${c.decisionNote ? `<em class="lv-by">“${escapeText(c.decisionNote)}”</em>` : ''}</td>
      <td>${c.status === 'pending' ? `<button type="button" class="btn" data-att-cancel="${c.id}">Cancel</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}

function attendanceMeHtml() {
  const viewingMine = !attendanceState.viewUserId || attendanceState.viewUserId === Number(state.user.id);
  return `${viewingMine ? attendanceClockCard() : ''}${attendanceSheetHtml()}${viewingMine ? attendanceMineRequestsHtml() : ''}`;
}

function attendanceTeamHtml() {
  const b = attendanceState.board;
  if (!b) return '<p class="pp-muted">Loading…</p>';
  const counts = { present: 0, absent: 0, leave: 0, late: 0, flagged: 0 };
  b.rows.forEach((r) => {
    if (r.status === 'present' || r.status === 'working') counts.present += 1;
    if (r.status === 'absent' || r.status === 'incomplete') counts.absent += 1;
    if (r.status === 'leave') counts.leave += 1;
    if (r.lateMinutes) counts.late += 1;
    if (r.deviceFlag) counts.flagged += 1;
  });
  const sorted = b.rows.slice().sort((x, y) => personName(x).localeCompare(personName(y), undefined, { sensitivity: 'base' }));
  const rows = sorted.map((r) => `
    <tr data-att-person="${r.id}" tabindex="0"><td><span class="emp-person">${peopleAvatar(r, 'sm')}<span><strong>${escapeText(personName(r))}</strong><em>${escapeText(r.department || '')}${r.jobLevel === 'managerial' ? ' · Managerial' : ''}</em></span></span></td>
      <td>${attendanceStatusChip(r)}${r.lateMinutes ? `<span class="att-late">${r.lateMinutes} min late</span>` : ''}${attendanceFlagChip(r)}</td>
      <td>${escapeText(punchLine(r))}</td><td>${attendanceHours(r.workedMinutes)}</td><td class="pp-muted">${escapeText(r.schedule.start)}–${escapeText(r.schedule.end)}</td></tr>`).join('');
  return `
    <div class="emp-toolbar"><input type="date" id="att-board-date" class="pp-select" value="${escapeText(b.date)}" aria-label="Date">
      <span class="pp-muted">${counts.present} in · ${counts.late} late · ${counts.absent} absent · ${counts.leave} on leave${counts.flagged ? ` · ${counts.flagged} on a new device` : ''}</span></div>
    ${b.rows.length ? `<div class="emp-table-wrap"><table class="emp-table"><thead><tr><th>Employee</th><th>Status</th><th>Clock-ins and outs</th><th>Hours</th><th>Schedule</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="pp-hint">Click a person to see their month.</p>` : emptyRecordMarkup('Nobody to show', b.scope === 'team' ? 'People who report to you show here.' : 'There are no active members.')}`;
}

function attendanceQueueHtml() {
  if (!attendanceState.queue.length) return emptyRecordMarkup('No corrections waiting', 'Requests from your team show here for you to approve.');
  return `<div class="lv-cards">${attendanceState.queue.map((c) => `
    <div class="lv-card" data-correction-id="${c.id}">
      <div class="lv-card-head"><strong>${escapeText(personName(c))}</strong><span class="lv-status lv-pending">${escapeText(attendanceDay(c.date))}</span></div>
      <div>Asks for: <strong>${escapeText(c.punches.map((p) => `${p.in}–${p.out || '…'}`).join(' · '))}</strong></div>
      <p class="lv-reason">${escapeText(c.reason)}</p>
      <div class="admin-actions"><button type="button" class="btn primary" data-att-decide="approved">Approve</button><button type="button" class="btn" data-att-decide="rejected">Decline…</button></div>
    </div>`).join('')}</div>`;
}

function attendanceDevicesHtml() {
  const list = attendanceState.devices;
  if (!list) return '<p class="pp-muted">Loading…</p>';
  if (!list.length) return emptyRecordMarkup('No new devices', 'When someone clocks in from a phone or computer they have not used before, it shows here for you to approve.');
  return `<p class="pp-hint">The first device a person clocks in from is trusted automatically. Any other is flagged on their timesheet until you approve it (a new phone, for example). Forgetting a device flags it again if it is used.</p>
    <div class="emp-table-wrap"><table class="emp-table"><thead><tr><th>Employee</th><th>Device</th><th>First seen</th><th>Last seen</th><th>Clock-ins</th><th></th></tr></thead><tbody>${list.map((d) => `
    <tr><td><strong>${escapeText(personName(d))}</strong></td><td>${escapeText(d.name)}</td><td>${escapeText(new Date(d.firstSeen).toLocaleString())}</td><td>${escapeText(new Date(d.lastSeen).toLocaleString())}</td><td>${d.punches}</td>
      <td><button type="button" class="btn primary" data-att-device-trust="${d.id}">Approve</button> <button type="button" class="btn" data-att-device-forget="${d.id}">Forget</button></td></tr>`).join('')}</tbody></table></div>`;
}

// ---- a day: HR fixes it, an employee asks for a correction ----

function punchRowHtml(p) {
  return `<div class="att-punch-row"><label>In <input type="time" data-punch-in value="${escapeText(p.in || '')}" required></label>
    <label>Out <input type="time" data-punch-out value="${escapeText(p.out || '')}"></label><button type="button" class="btn" data-punch-remove aria-label="Remove this clock-in">×</button></div>`;
}

function openAttendanceEditor(date) {
  const s = attendanceState.sheet;
  const d = s && s.days.find((x) => x.date === date);
  const modal = document.getElementById('attendance-modal');
  if (!d || !modal) return;
  const manage = canManageEmployees();
  const punches = d.punches.length ? d.punches : [{ in: '', out: '' }];
  modal.innerHTML = `
    <div class="modal-header"><h3>${escapeText(attendanceDay(date))} · ${escapeText(personName(s.person))}</h3><button class="modal-close" type="button" data-att-close aria-label="Close">&times;</button></div>
    <form id="attendance-form" data-date="${date}" data-mode="${manage ? 'fix' : 'ask'}">
      <div class="modal-body pp-editor-body">
        <p class="form-note">${manage ? 'Set what the day should show.' : 'Tell us what the day should show. Your manager or HR approves it.'} Each row is one stretch of work: in 08:00, out 12:00; then in 13:00, out 17:00. Leave the last Out empty if they have not clocked out.</p>
        <div id="att-punches">${punches.map(punchRowHtml).join('')}</div>
        <button type="button" class="btn" data-punch-add>+ Add a clock-in</button>
        <div class="form-group"><label for="att-note">${manage ? 'Note (why it was changed)' : 'Reason'}</label><input id="att-note" type="text" maxlength="${manage ? 200 : 300}" value="${manage ? escapeText(d.note || '') : ''}"${manage ? '' : ' required'}></div>
        <p class="form-note">Company time (${escapeText(s.timezone)}). A time before the one above it means the next morning (a night shift).</p>
      </div>
      <div class="modal-footer">
        ${manage && d.punches.length ? '<button class="btn danger" type="button" data-att-delete>Remove this record</button>' : ''}
        <button class="btn" type="button" data-att-close>Cancel</button><button class="btn primary" type="submit">${manage ? 'Save' : 'Send request'}</button>
      </div>
    </form>`;
  openSettingsModal(modal);
}

function readPunchRows() {
  return Array.from(document.querySelectorAll('#att-punches .att-punch-row')).map((row) => ({
    in: row.querySelector('[data-punch-in]').value, out: row.querySelector('[data-punch-out]').value || null,
  })).filter((p) => p.in);
}

async function saveAttendanceRecord(event) {
  event.preventDefault();
  const form = event.target;
  const note = document.getElementById('att-note').value;
  try {
    if (form.dataset.mode === 'fix') {
      await attendanceApi('/api/attendance/records', 'PUT', { userId: attendanceState.sheet.person.id, date: form.dataset.date, punches: readPunchRows(), note });
      showToast('Attendance saved.', 'success');
    } else {
      await attendanceApi('/api/attendance/corrections', 'POST', { date: form.dataset.date, punches: readPunchRows(), reason: note });
      showToast('Correction requested.', 'success');
    }
    closeSettingsModal();
    await loadAttendance();
  } catch (err) {
    showToast(err.message || 'Could not save.', 'error');
  }
}

// ---- HR: schedules, office network, the payroll export ----

async function openSchedules() {
  const modal = document.getElementById('schedules-modal');
  if (!modal) return;
  let data;
  try { data = await attendanceApi('/api/attendance/schedules'); } catch (err) { showToast(err.message || 'Could not load the schedules.', 'error'); return; }
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const row = (s) => `<div class="sch-row" data-schedule="${s ? s.id : 'new'}">
    <input type="text" maxlength="60" value="${escapeText(s ? s.name : '')}" placeholder="${s ? '' : 'New schedule name'}" data-sch-name aria-label="Name">
    <div class="sch-times"><label>Start <input type="time" value="${s ? s.start : '08:00'}" data-sch-start></label><label>End <input type="time" value="${s ? s.end : '17:00'}" data-sch-end></label>
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
      <p class="form-note">Late: the first clock-in of the day after start + grace; late minutes count from the start. Over break: time away between clock-ins beyond the break plus grace. Undertime: the last clock-out before the end. Overtime counts once they stay at least the overtime threshold past the end, for rank-and-file employees only (managerial staff get none). Work on rest days and holidays is counted apart, also only for rank and file. People without their own schedule follow the default; set a person's schedule in their employee record. Times are ${escapeText(data.timezone)}.</p>
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

async function openNetworks() {
  const modal = document.getElementById('networks-modal');
  if (!modal) return;
  let data;
  try { data = await attendanceApi('/api/attendance/networks'); } catch (err) { showToast(err.message || 'Could not load the networks.', 'error'); return; }
  modal.innerHTML = `
    <div class="modal-header"><h3>Office network</h3><button class="modal-close" type="button" data-att-close aria-label="Close">&times;</button></div>
    <div class="modal-body pp-editor-body">
      <label class="preference-toggle"><input type="checkbox" id="net-enforced"${data.enforced ? ' checked' : ''}><span><strong>Employees can only clock in and out from these networks</strong></span></label>
      <p class="form-note">Add the public IP address of each office or branch (or a range such as 192.168.10.0/24). Employees you mark "Can clock in from anywhere" in their record are exempt. Every clock-in and clock-out records the address it came from, whether or not this rule is on.</p>
      ${/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(data.myIp) ? `<p class="att-warn"><strong>This will not work yet.</strong> The server sees every computer as ${escapeText(data.myIp)}, which is Docker's own address. That happens when the server runs in Docker Desktop on Windows or Mac. The IP address recorded with each clock-in and this network rule only work when the server is on a Linux server (or run directly on a computer) where it sees each computer's real address.</p>` : ''}
      <p class="form-note">The address this computer reaches the server from: <code class="emp-password">${escapeText(data.myIp)}</code> ${data.myIpAllowed ? '(listed)' : '<button type="button" class="btn" data-net-add-mine>Add it as a network</button>'}</p>
      ${data.networks.length ? data.networks.map((n) => `<div class="lv-type-row"><span>${escapeText(n.label)}</span><code>${escapeText(n.cidr)}</code><span></span><span></span><button type="button" class="btn" data-net-remove="${n.id}">Remove</button></div>`).join('') : '<p class="pp-muted">No networks yet.</p>'}
      <div class="lv-type-row" data-net-new><input type="text" maxlength="80" placeholder="Name, for example Main office" data-net-label aria-label="Name"><input type="text" maxlength="64" placeholder="203.0.113.7 or 192.168.10.0/24" data-net-cidr aria-label="Address"><span></span><span></span><button type="button" class="btn primary" data-net-add>Add</button></div>
    </div>`;
  openSettingsModal(modal);
}

async function networkAction(action, source) {
  try {
    if (action === 'add') await attendanceApi('/api/attendance/networks', 'POST', { label: source.querySelector('[data-net-label]').value, cidr: source.querySelector('[data-net-cidr]').value });
    else if (action === 'add-mine') {
      const label = await askText('What is this place called?', { placeholder: 'Main office', maxLength: 80, required: true });
      if (label === null) return;
      const data = await attendanceApi('/api/attendance/networks');
      await attendanceApi('/api/attendance/networks', 'POST', { label, cidr: data.myIp });
    } else if (action === 'remove') await attendanceApi(`/api/attendance/networks/${source}`, 'DELETE');
    else if (action === 'enforce') await attendanceApi('/api/attendance/network-policy', 'PUT', { enforced: source });
    await openNetworks();
    if (attendanceState.loaded) loadAttendance();
  } catch (err) {
    showToast(err.message || 'Could not change the network rule.', 'error');
    await openNetworks();
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
        <label class="preference-toggle"><input type="radio" name="ax-kind" value="summary" checked><span>One row per employee (days, absences, leave, late, break, hours, overtime)</span></label>
        <label class="preference-toggle"><input type="radio" name="ax-kind" value="detail"><span>One row per employee per day (the full daily detail with every clock-in and out)</span></label>
        <p class="form-note">Up to 62 days. Includes active employees. Overtime and rest-day/holiday hours are for rank-and-file employees only; managerial staff show their hours but no overtime. Paid and unpaid leave are counted apart; days before a hire date or after a last day are left out.</p>
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
    if (view) { attendanceState.view = view.dataset.attView; attendanceState.board = null; attendanceState.devices = null; attendanceState.viewUserId = null; await loadAttendance(); return; }
    const clock = t.closest('[data-att-clock]');
    if (clock) {
      clock.disabled = true;
      try {
        await attendanceApi(`/api/attendance/clock-${clock.dataset.attClock}`, 'POST', {}, await attendanceDeviceHeaders());
        showToast(clock.dataset.attClock === 'in' ? 'Clocked in.' : 'Clocked out.', 'success');
        await loadAttendance();
      } catch (err) { showToast(err.message || 'Could not clock.', 'error'); clock.disabled = false; await loadAttendance(); }
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
    if (t.closest('[data-punch-add]')) { document.getElementById('att-punches').insertAdjacentHTML('beforeend', punchRowHtml({ in: '', out: '' })); return; }
    const removePunch = t.closest('[data-punch-remove]');
    if (removePunch) { if (document.querySelectorAll('#att-punches .att-punch-row').length > 1) removePunch.closest('.att-punch-row').remove(); return; }
    if (t.closest('[data-att-delete]')) {
      const date = document.getElementById('attendance-form').dataset.date;
      if (!confirm('Remove this day\'s record?')) return;
      try { await attendanceApi(`/api/attendance/records/${attendanceState.sheet.person.id}/${date}`, 'DELETE'); closeSettingsModal(); showToast('Record removed.', 'success'); await loadAttendance(); } catch (err) { showToast(err.message || 'Could not remove it.', 'error'); }
      return;
    }
    const cancel = t.closest('[data-att-cancel]');
    if (cancel) {
      try { await attendanceApi(`/api/attendance/corrections/${cancel.dataset.attCancel}/cancel`, 'POST', {}); showToast('Request cancelled.', 'success'); await loadAttendance(); } catch (err) { showToast(err.message || 'Could not cancel.', 'error'); }
      return;
    }
    const decide = t.closest('[data-att-decide]');
    if (decide) {
      const id = Number(decide.closest('[data-correction-id]').dataset.correctionId);
      const status = decide.dataset.attDecide;
      let note = '';
      if (status === 'rejected') { note = await askText('Tell them why (optional):', { maxLength: 300 }); if (note === null) return; }
      try { await attendanceApi(`/api/attendance/corrections/${id}/decision`, 'PUT', { status, note }); showToast(status === 'approved' ? 'Approved. The day was updated.' : 'Declined.', 'success'); await loadAttendance(); } catch (err) { showToast(err.message || 'Could not save the decision.', 'error'); }
      return;
    }
    const trust = t.closest('[data-att-device-trust]');
    if (trust) { try { await attendanceApi(`/api/attendance/devices/${trust.dataset.attDeviceTrust}`, 'PUT', { trusted: true }); showToast('Device approved.', 'success'); await loadAttendance(); } catch (err) { showToast(err.message || 'Could not approve.', 'error'); } return; }
    const forget = t.closest('[data-att-device-forget]');
    if (forget) {
      if (!confirm('Forget this device? If they use it again it is flagged again (or trusted, if it is their only device).')) return;
      try { await attendanceApi(`/api/attendance/devices/${forget.dataset.attDeviceForget}`, 'DELETE'); await loadAttendance(); } catch (err) { showToast(err.message || 'Could not forget it.', 'error'); }
      return;
    }
    if (t.closest('[data-att-schedules]')) { openSchedules(); return; }
    if (t.closest('[data-att-networks]')) { openNetworks(); return; }
    if (t.closest('[data-att-export]')) { openAttendanceExport(); return; }
    const sch = t.closest('[data-schedule]');
    if (sch && t.closest('button')) {
      const action = t.closest('[data-sch-add]') ? 'add' : t.closest('[data-sch-save]') ? 'save' : t.closest('[data-sch-default]') ? 'default' : t.closest('[data-sch-delete]') ? 'delete' : null;
      if (action) { scheduleAction(action, sch); return; }
    }
    if (t.closest('[data-net-add]')) { networkAction('add', t.closest('[data-net-new]')); return; }
    if (t.closest('[data-net-add-mine]')) { networkAction('add-mine'); return; }
    const removeNet = t.closest('[data-net-remove]');
    if (removeNet) { networkAction('remove', removeNet.dataset.netRemove); }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !event.target.closest) return;
    const edit = event.target.closest('[data-att-edit]');
    if (edit) openAttendanceEditor(edit.dataset.attEdit);
  });

  document.addEventListener('change', async (event) => {
    if (event.target.id === 'att-board-date' && event.target.value) { attendanceState.boardDate = event.target.value; attendanceState.board = null; await loadAttendance(); }
    if (event.target.id === 'net-enforced') networkAction('enforce', event.target.checked);
  });

  document.addEventListener('submit', (event) => {
    if (event.target.id === 'attendance-form') saveAttendanceRecord(event);
    if (event.target.id === 'attendance-export-form') submitAttendanceExport(event);
  });
}
