// IT Avenue Workspace - employee management (People > Manage), for the Superadmin and HR.
//
// A table of every employee's record (number, department, title, manager, status, hire date) with filters and
// a CSV export, an editor for one record, the list of departments, and adding people (the same form as in
// Moderation). Loaded after people.js; the People view calls renderEmployeeManagement().

const employeeState = {
  list: [], departments: [], schedules: [], loaded: false, error: '', status: '', department: '', editingId: null,
  sort: { key: 'name', dir: 'asc' }, // the table is in name order until a column header is clicked
};

const EMPLOYEE_STATUSES = { active: 'Active', on_leave: 'On leave', resigned: 'Resigned' };
const EMPLOYEE_TYPES = { '': 'Not set', regular: 'Regular', probationary: 'Probationary', contractual: 'Contractual', part_time: 'Part-time', intern: 'Intern' };

function canManageEmployees() {
  return Boolean(state.moderation && (state.moderation.isSuperadmin || state.moderation.isHr));
}

async function hrApi(path, method = 'GET', body) {
  const res = await api(path, { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function loadEmployeeManagement() {
  try {
    const [employees, departments, schedules] = await Promise.all([hrApi('/api/hr/employees'), hrApi('/api/hr/departments'), hrApi('/api/attendance/schedules')]);
    employeeState.list = employees.employees;
    employeeState.departments = departments.departments;
    employeeState.schedules = schedules.schedules;
    employeeState.error = '';
  } catch (err) {
    employeeState.error = err.message || 'Could not load employees';
  }
  employeeState.loaded = true;
  if (typeof peopleState !== 'undefined' && peopleState.tab === 'manage') renderPeopleBody();
}

// After something changed elsewhere (accounts were created): refresh quietly when the table has been opened.
function reloadEmployeeManagement() {
  if (employeeState.loaded) loadEmployeeManagement();
  if (typeof peopleState !== 'undefined' && peopleState.loaded) loadPeople(true);
}

function employeeFullName(e) {
  return personName(e);
}

function employeeMatches(e, query) {
  const q = String(query || '').trim().toLowerCase();
  return !q || [e.username, personFullName(e), e.email, e.employeeNo, e.jobTitle, e.department].some((v) => String(v || '').toLowerCase().includes(q));
}

function employeeDate(value) {
  if (!value) return '';
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

// "Onboarding 2/4" while a checklist is under way.
function employeeChecklistBadge(e) {
  const parts = ['onboarding', 'offboarding']
    .filter((kind) => e.checklists && e.checklists[kind].total > e.checklists[kind].done)
    .map((kind) => `${kind === 'onboarding' ? 'Onboarding' : 'Offboarding'} ${e.checklists[kind].done}/${e.checklists[kind].total}`);
  return parts.length ? `<span class="emp-progress">${parts.join(' · ')}</span>` : '';
}

// What each column sorts by. Empty values always go last, whichever way the column is sorted.
const EMPLOYEE_SORTS = {
  name: (e) => personName(e).toLowerCase(),
  no: (e) => String(e.employeeNo || '').toLowerCase(),
  department: (e) => String(e.department || '').toLowerCase(),
  title: (e) => String(e.jobTitle || '').toLowerCase(),
  manager: (e, byId) => (e.managerId && byId.get(e.managerId) ? personName(byId.get(e.managerId)).toLowerCase() : ''),
  status: (e) => (e.deactivatedAt ? 'deactivated' : e.employmentStatus),
  hired: (e) => e.hireDate || '',
};

function sortEmployees(list, byId) {
  const { key, dir } = employeeState.sort;
  const pick = EMPLOYEE_SORTS[key] || EMPLOYEE_SORTS.name;
  const sign = dir === 'desc' ? -1 : 1;
  return list.slice().sort((a, b) => {
    const x = pick(a, byId);
    const y = pick(b, byId);
    if (x === '' && y !== '') return 1;
    if (y === '' && x !== '') return -1;
    const order = x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' });
    return order !== 0 ? sign * order : personName(a).localeCompare(personName(b), undefined, { sensitivity: 'base' });
  });
}

function employeeHeader(key, label) {
  const active = employeeState.sort.key === key;
  const arrow = active ? (employeeState.sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  return `<th aria-sort="${active ? (employeeState.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}"><button type="button" class="emp-sort" data-emp-sort="${key}">${label}${arrow}</button></th>`;
}

function renderEmployeeManagement(body) {
  if (employeeState.error) {
    body.innerHTML = emptyRecordMarkup('Employee records are not available', employeeState.error);
    return;
  }
  if (!employeeState.loaded) {
    body.innerHTML = '<p class="pp-muted">Loading…</p>';
    loadEmployeeManagement();
    return;
  }
  const byId = new Map(employeeState.list.map((e) => [e.id, e]));
  const rows = sortEmployees(employeeState.list, byId)
    .filter((e) => employeeMatches(e, peopleState.query))
    .filter((e) => !employeeState.status || (employeeState.status === 'deactivated' ? Boolean(e.deactivatedAt) : e.employmentStatus === employeeState.status && !e.deactivatedAt))
    .filter((e) => !employeeState.department || String(e.departmentId || '') === employeeState.department);
  const counts = { active: 0, on_leave: 0, resigned: 0 };
  counts.deactivated = 0;
  employeeState.list.forEach((e) => { if (e.deactivatedAt) counts.deactivated += 1; else counts[e.employmentStatus] += 1; });
  body.innerHTML = `
    <div class="emp-toolbar">
      <select id="emp-filter-status" class="pp-select" aria-label="Status">
        <option value="">All statuses (${employeeState.list.length})</option>
        ${Object.entries({ ...EMPLOYEE_STATUSES, deactivated: 'Deactivated' }).map(([key, label]) => `<option value="${key}"${employeeState.status === key ? ' selected' : ''}>${label} (${counts[key]})</option>`).join('')}
      </select>
      <select id="emp-filter-department" class="pp-select" aria-label="Department">
        <option value="">All departments</option>
        ${employeeState.departments.map((d) => `<option value="${d.id}"${employeeState.department === String(d.id) ? ' selected' : ''}>${escapeText(d.name)} (${d.memberCount})</option>`).join('')}
      </select>
      <span class="emp-spacer"></span>
      <button type="button" class="btn" data-emp-departments>Departments</button>
      <button type="button" class="btn" data-emp-checklists>Checklists</button>
      <button type="button" class="btn" data-emp-leave-settings>Leave settings</button>
      <button type="button" class="btn" data-emp-export>Export CSV</button>
      <button type="button" class="btn primary" data-emp-add>Add people</button>
    </div>
    ${rows.length ? `<div class="emp-table-wrap"><table class="emp-table">
      <thead><tr>${employeeHeader('name', 'Employee')}${employeeHeader('no', 'No.')}${employeeHeader('department', 'Department')}${employeeHeader('title', 'Job title')}${employeeHeader('manager', 'Reports to')}${employeeHeader('status', 'Status')}${employeeHeader('hired', 'Hired')}</tr></thead>
      <tbody>${rows.map((e) => {
    const boss = e.managerId ? byId.get(e.managerId) : null;
    return `<tr data-emp-row="${e.id}" tabindex="0">
        <td><span class="emp-person">${peopleAvatar(e, 'sm')}<span><strong>${escapeText(employeeFullName(e))}</strong><em>@${escapeText(e.username)}${e.isHr ? ' · HR' : ''}${e.isSuperadmin ? ' · Superadmin' : ''}</em></span></span></td>
        <td>${escapeText(e.employeeNo) || '<span class="pp-muted">—</span>'}</td>
        <td>${escapeText(e.department) || '<span class="pp-muted">—</span>'}</td>
        <td>${escapeText(e.jobTitle) || '<span class="pp-muted">—</span>'}</td>
        <td>${boss ? escapeText(employeeFullName(boss)) : '<span class="pp-muted">—</span>'}</td>
        <td><span class="emp-status emp-status-${e.deactivatedAt ? 'resigned' : e.employmentStatus}">${e.deactivatedAt ? 'Deactivated' : EMPLOYEE_STATUSES[e.employmentStatus]}</span>${employeeChecklistBadge(e)}</td>
        <td>${escapeText(employeeDate(e.hireDate)) || '<span class="pp-muted">—</span>'}</td>
      </tr>`;
  }).join('')}</tbody></table></div>`
    : emptyRecordMarkup(employeeState.list.length ? 'No one matches' : 'No employees yet', employeeState.list.length ? 'Try a different search or filter.' : 'Use "Add people" to create accounts.')}`;
}

// ---- one employee's record ---------------------------------------------------------------------

function openEmployeeEditor(id) {
  const e = employeeState.list.find((item) => item.id === id);
  const modal = document.getElementById('employee-modal');
  if (!e || !modal) return;
  employeeState.editingId = id;
  const option = (value, label, current) => `<option value="${escapeText(String(value))}"${String(current) === String(value) ? ' selected' : ''}>${escapeText(label)}</option>`;
  modal.innerHTML = `
    <div class="modal-header"><h3>${escapeText(employeeFullName(e))}</h3>
      <button class="modal-close" type="button" data-emp-close aria-label="Close">&times;</button></div>
    <form id="employee-form">
      <div class="modal-body pp-editor-body">
        ${state.moderation.isSuperadmin ? `<div class="form-group"><label for="emp-username">Username (what they sign in with)</label><input id="emp-username" type="text" maxlength="50" value="${escapeText(e.username)}"><p class="form-note">Changing it does not change old @mentions in messages and canvases.</p></div>` : ''}
        <div class="pp-edit-triple">
          <div class="form-group"><label for="emp-last">Last name</label><input id="emp-last" type="text" maxlength="100" value="${escapeText(e.lastName)}"></div>
          <div class="form-group"><label for="emp-first">First name</label><input id="emp-first" type="text" maxlength="100" value="${escapeText(e.firstName)}"></div>
          <div class="form-group"><label for="emp-middle">Middle name</label><input id="emp-middle" type="text" maxlength="100" value="${escapeText(e.middleName)}"></div>
        </div>
        <div class="pp-edit-pair">
          <div class="form-group"><label for="emp-no">Employee number</label><input id="emp-no" type="text" maxlength="40" value="${escapeText(e.employeeNo)}"></div>
          <div class="form-group"><label for="emp-type">Employment type</label><select id="emp-type">${Object.entries(EMPLOYEE_TYPES).map(([k, l]) => option(k, l, e.employmentType)).join('')}</select></div>
        </div>
        <div class="pp-edit-pair">
          <div class="form-group"><label for="emp-department">Department</label><select id="emp-department"><option value="">None</option>${employeeState.departments.map((d) => option(d.id, d.name, e.departmentId || '')).join('')}</select></div>
          <div class="form-group"><label for="emp-title">Job title</label><input id="emp-title" type="text" maxlength="100" value="${escapeText(e.jobTitle)}"></div>
        </div>
        <div class="pp-edit-pair">
          <div class="form-group"><label for="emp-manager">Reports to</label><select id="emp-manager"><option value="">No manager</option>${employeeState.list.filter((o) => o.id !== e.id).map((o) => option(o.id, employeeFullName(o), e.managerId || '')).join('')}</select></div>
          <div class="form-group"><label for="emp-location">Location</label><input id="emp-location" type="text" maxlength="100" value="${escapeText(e.location)}"></div>
        </div>
        <div class="pp-edit-pair">
          <div class="form-group"><label for="emp-level">Position level</label><select id="emp-level"><option value="rank_and_file"${e.jobLevel !== 'managerial' ? ' selected' : ''}>Rank and file (earns overtime)</option><option value="managerial"${e.jobLevel === 'managerial' ? ' selected' : ''}>Managerial (no overtime)</option></select></div>
          <label class="preference-toggle emp-remote"><input type="checkbox" id="emp-remote"${e.remoteClock ? ' checked' : ''}><span>Can clock in from anywhere (not only the office network)</span></label>
        </div>
        <div class="form-group"><label for="emp-schedule">Work schedule</label><select id="emp-schedule"><option value="">Default${(employeeState.schedules.find((s) => s.isDefault) || {}).name ? ` (${escapeText(employeeState.schedules.find((s) => s.isDefault).name)})` : ''}</option>${employeeState.schedules.filter((s) => !s.isDefault).map((s) => option(s.id, `${s.name} (${s.start}–${s.end})`, e.scheduleId || '')).join('')}</select></div>
        <div class="pp-edit-triple">
          <div class="form-group"><label for="emp-status">Status</label><select id="emp-status">${Object.entries(EMPLOYEE_STATUSES).map(([k, l]) => option(k, l, e.employmentStatus)).join('')}</select></div>
          <div class="form-group"><label for="emp-hired">Hire date</label><input id="emp-hired" type="date" value="${escapeText(e.hireDate || '')}"></div>
          <div class="form-group"><label for="emp-lastday">Last day</label><input id="emp-lastday" type="date" value="${escapeText(e.separationDate || '')}"></div>
        </div>
        ${state.moderation.isSuperadmin ? `<label class="preference-toggle"><input type="checkbox" id="emp-hr"${e.isHr ? ' checked' : ''}><span>HR: can manage employee records, departments and reporting lines</span></label>` : ''}
        <div class="form-group"><label for="emp-email">Email</label><input id="emp-email" type="email" maxlength="255" value="${escapeText(e.email)}" autocomplete="off"></div>
        <p class="form-note">${e.phone ? `Phone: ${escapeText(e.phone)}. ` : ''}The employee edits their own photo, phone and page.</p>
        <div data-emp-roles-section><h4 class="modal-section-title">Roles</h4>
        <div id="emp-roles"><p class="pp-muted">Loading…</p></div></div>
        <h4 class="modal-section-title">Leave balances</h4>
        <div id="emp-leave"><p class="pp-muted">Loading…</p></div>
        <h4 class="modal-section-title">Checklists</h4>
        <div id="emp-tasks" class="emp-tasks"><p class="pp-muted">Loading…</p></div>
        <h4 class="modal-section-title">Account</h4>
        <div class="emp-account">
          ${e.deactivatedAt
    ? `<p class="form-note">Deactivated ${escapeText(new Date(e.deactivatedAt).toLocaleDateString())}. They cannot sign in. Their messages and files stay.</p><button type="button" class="btn" data-emp-reactivate="${e.id}">Reactivate account</button>`
    : `<button type="button" class="btn" data-emp-reset="${e.id}">Reset password</button><button type="button" class="btn danger" data-emp-deactivate="${e.id}">Deactivate account…</button>`}
        </div>
        <div id="emp-account-note" aria-live="polite"></div>
      </div>
      <div class="modal-footer">
        <button class="btn" type="button" data-emp-page="${e.id}">Open their page</button>
        <button class="btn" type="button" data-emp-close>Cancel</button>
        <button class="btn primary" type="submit">Save</button>
      </div>
    </form>`;
  openSettingsModal(modal);
  loadEmployeeTasks(id);
  if (typeof loadEmployeeRoles === 'function') loadEmployeeRoles(id);
  if (typeof loadEmployeeLeave === 'function') loadEmployeeLeave(id);
}

async function saveEmployeeRecord(event) {
  event.preventDefault();
  const e = employeeState.list.find((item) => item.id === employeeState.editingId);
  if (!e) return;
  const value = (id) => document.getElementById(id).value;
  const record = {
    lastName: value('emp-last'), firstName: value('emp-first'), middleName: value('emp-middle'),
    employeeNo: value('emp-no'), employmentType: value('emp-type'), jobTitle: value('emp-title'), location: value('emp-location'),
    departmentId: value('emp-department') === '' ? null : Number(value('emp-department')),
    jobLevel: value('emp-level'), remoteClock: document.getElementById('emp-remote').checked,
    employmentStatus: value('emp-status'), hireDate: value('emp-hired') || null, separationDate: value('emp-lastday') || null,
  };
  const emailField = document.getElementById('emp-email');
  if (emailField && emailField.value.trim().toLowerCase() !== String(e.email || '').toLowerCase()) record.email = emailField.value;
  const usernameField = document.getElementById('emp-username');
  if (usernameField && usernameField.value.trim() !== e.username) record.username = usernameField.value;
  try {
    await hrApi(`/api/hr/employees/${e.id}`, 'PUT', record);
    const manager = value('emp-manager') === '' ? null : Number(value('emp-manager'));
    if (manager !== (e.managerId || null)) await hrApi(`/api/people/${e.id}/manager`, 'PUT', { managerId: manager });
    const schedule = value('emp-schedule') === '' ? null : Number(value('emp-schedule'));
    if (schedule !== (e.scheduleId || null)) await hrApi(`/api/attendance/people/${e.id}/schedule`, 'PUT', { scheduleId: schedule });
    const hrBox = document.getElementById('emp-hr');
    if (hrBox && hrBox.checked !== e.isHr) await hrApi(`/api/hr/employees/${e.id}/hr-role`, 'PUT', { isHr: hrBox.checked });
    closeSettingsModal();
    showToast('Employee record saved.', 'success');
    await loadEmployeeManagement();
    if (typeof loadPeople === 'function') loadPeople(true);
  } catch (err) {
    showToast(err.message || 'Could not save the record.', 'error');
  }
}

// ---- checklists, passwords, and leaving ----------------------------------------------------------------

async function loadEmployeeTasks(id) {
  const host = document.getElementById('emp-tasks');
  if (!host) return;
  try {
    const data = await hrApi(`/api/hr/employees/${id}/tasks`);
    if (employeeState.editingId !== id) return;
    renderEmployeeTasks(id, data.tasks);
  } catch (err) {
    host.innerHTML = `<p class="pp-muted">${escapeText(err.message || 'Could not load the checklists.')}</p>`;
  }
}

function renderEmployeeTasks(id, tasks) {
  const host = document.getElementById('emp-tasks');
  if (!host) return;
  const e = employeeState.list.find((item) => item.id === id);
  if (e) {
    for (const kind of ['onboarding', 'offboarding']) {
      const own = tasks.filter((t) => t.kind === kind);
      e.checklists[kind] = { done: own.filter((t) => t.done).length, total: own.length };
    }
  }
  host.innerHTML = ['onboarding', 'offboarding'].map((kind) => {
    const own = tasks.filter((t) => t.kind === kind);
    const done = own.filter((t) => t.done).length;
    const label = kind === 'onboarding' ? 'Onboarding' : 'Offboarding';
    return `<div class="emp-task-block" data-task-kind="${kind}">
      <div class="emp-task-head"><strong>${label}</strong><span class="pp-muted">${own.length ? `${done} of ${own.length} done` : 'No list yet'}</span>
        ${own.length ? '' : `<button type="button" class="btn" data-task-apply="${kind}">Start the standard list</button>`}</div>
      ${own.map((t) => `<label class="emp-task${t.done ? ' done' : ''}"><input type="checkbox" data-task-toggle="${t.id}"${t.done ? ' checked' : ''}><span>${escapeText(t.title)}</span>${t.done && t.doneBy ? `<em>by ${escapeText(t.doneBy)}</em>` : ''}<button type="button" class="emp-task-x" data-task-delete="${t.id}" aria-label="Remove this task">×</button></label>`).join('')}
      <div class="emp-task-add"><input type="text" maxlength="160" placeholder="Add a task" data-task-input="${kind}" aria-label="Add a ${label.toLowerCase()} task"><button type="button" class="btn" data-task-add="${kind}">Add</button></div>
    </div>`;
  }).join('');
}

async function changeTasks(id, fn) {
  try {
    await fn();
    await loadEmployeeTasks(id);
  } catch (err) {
    showToast(err.message || 'Could not change the checklist.', 'error');
    loadEmployeeTasks(id);
  }
}

async function resetEmployeePassword(id) {
  const e = employeeState.list.find((item) => item.id === id);
  if (!e || !confirm(`Reset ${employeeFullName(e)}'s password? They are signed out now and must choose a new one when they sign in with the temporary password.`)) return;
  try {
    const data = await hrApi(`/api/hr/employees/${id}/reset-password`, 'POST', {});
    document.getElementById('emp-account-note').innerHTML = `<p class="admin-help">Temporary password for <strong>${escapeText(data.username)}</strong> (shown only now):</p><p><code class="emp-password">${escapeText(data.password)}</code> <button type="button" class="btn" data-emp-copy="${escapeText(data.password)}">Copy</button></p>`;
  } catch (err) {
    showToast(err.message || 'Could not reset the password.', 'error');
  }
}

async function deactivateEmployee(id) {
  const e = employeeState.list.find((item) => item.id === id);
  if (!e || !confirm(`Deactivate ${employeeFullName(e)}?\n\nThey are signed out now and cannot sign in. Their messages and files stay. People who report to them move up to their manager.`)) return;
  try {
    const lastDay = (document.getElementById('emp-lastday') || {}).value || null;
    const data = await hrApi(`/api/hr/employees/${id}/deactivate`, 'POST', lastDay ? { lastDay } : {});
    closeSettingsModal();
    showToast(`Account deactivated${data.reassignedReports ? `; ${data.reassignedReports} ${data.reassignedReports === 1 ? 'report moved' : 'reports moved'} up` : ''}.`, 'success');
    await loadEmployeeManagement();
    if (typeof loadPeople === 'function') loadPeople(true);
  } catch (err) {
    showToast(err.message || 'Could not deactivate the account.', 'error');
  }
}

async function reactivateEmployee(id) {
  try {
    await hrApi(`/api/hr/employees/${id}/reactivate`, 'POST', {});
    closeSettingsModal();
    showToast('Account reactivated. Reporting lines were not restored.', 'success');
    await loadEmployeeManagement();
    if (typeof loadPeople === 'function') loadPeople(true);
  } catch (err) {
    showToast(err.message || 'Could not reactivate the account.', 'error');
  }
}

// The standard checklists new hires and leavers start with: one task per line.
async function openChecklistTemplates() {
  const modal = document.getElementById('checklists-modal');
  if (!modal) return;
  let data;
  try {
    data = await hrApi('/api/hr/task-templates');
  } catch (err) {
    showToast(err.message || 'Could not load the checklists.', 'error');
    return;
  }
  modal.innerHTML = `
    <div class="modal-header"><h3>Standard checklists</h3><button class="modal-close" type="button" data-emp-close aria-label="Close">&times;</button></div>
    <div class="modal-body pp-editor-body">
      <p class="form-note">New accounts start with the onboarding list. Deactivating an account starts the offboarding list. One task per line. Changing a list does not change lists people already have.</p>
      ${['onboarding', 'offboarding'].map((kind) => `<div class="form-group"><label for="tpl-${kind}">${kind === 'onboarding' ? 'Onboarding' : 'Offboarding'}</label>
        <textarea id="tpl-${kind}" class="tpl-area" rows="7" maxlength="6000">${escapeText((data[kind] || []).join('\n'))}</textarea>
        <div class="tpl-actions"><button type="button" class="btn primary" data-tpl-save="${kind}">Save ${kind}</button></div></div>`).join('')}
    </div>`;
  openSettingsModal(modal);
}

// ---- departments --------------------------------------------------------------------------------

function openDepartments() {
  const modal = document.getElementById('departments-modal');
  if (!modal) return;
  const members = employeeState.list;
  const headSelect = (d) => `<select data-dept-head aria-label="Head of ${escapeText(d.name)}"><option value="">No head</option>${members.map((m) => `<option value="${m.id}"${d.headId === m.id ? ' selected' : ''}>${escapeText(employeeFullName(m))}</option>`).join('')}</select>`;
  modal.innerHTML = `
    <div class="modal-header"><h3>Departments</h3><button class="modal-close" type="button" data-emp-close aria-label="Close">&times;</button></div>
    <div class="modal-body pp-editor-body">
      <p class="form-note">Departments are shared across the workspace. Renaming one renames it for everyone in it.</p>
      ${employeeState.departments.length ? employeeState.departments.map((d) => `
        <div class="dept-row" data-dept="${d.id}">
          <input type="text" maxlength="100" value="${escapeText(d.name)}" data-dept-name aria-label="Department name">
          ${headSelect(d)}
          <span class="pp-muted dept-count">${d.memberCount} ${d.memberCount === 1 ? 'person' : 'people'}</span>
          <button type="button" class="btn" data-dept-save>Save</button>
          <button type="button" class="btn" data-dept-delete>Delete</button>
        </div>`).join('') : '<p class="pp-muted">No departments yet.</p>'}
      <h4 class="modal-section-title">New department</h4>
      <div class="dept-row" data-dept="new">
        <input type="text" maxlength="100" placeholder="Name" data-dept-name aria-label="New department name">
        ${headSelect({ name: 'new', headId: null })}
        <span></span>
        <button type="button" class="btn primary" data-dept-add>Add</button>
      </div>
    </div>`;
  openSettingsModal(modal);
}

async function departmentAction(row, action) {
  const name = row.querySelector('[data-dept-name]').value;
  const headValue = row.querySelector('[data-dept-head]').value;
  const headId = headValue === '' ? null : Number(headValue);
  try {
    if (action === 'add') await hrApi('/api/hr/departments', 'POST', { name, headId });
    else if (action === 'save') await hrApi(`/api/hr/departments/${row.dataset.dept}`, 'PUT', { name, headId });
    else if (action === 'delete') {
      if (!confirm('Delete this department? People in it stay, with no department.')) return;
      await hrApi(`/api/hr/departments/${row.dataset.dept}`, 'DELETE');
    }
    await loadEmployeeManagement();
    openDepartments();
    if (typeof loadPeople === 'function') loadPeople(true);
    showToast(action === 'delete' ? 'Department deleted.' : 'Department saved.', 'success');
  } catch (err) {
    showToast(err.message || 'Could not change the department.', 'error');
  }
}

// ---- adding people and exporting -----------------------------------------------------------------

function openAddPeople() {
  const modal = document.getElementById('add-people-modal');
  if (!modal) return;
  modal.innerHTML = `
    <div class="modal-header"><h3>Add people</h3><button class="modal-close" type="button" data-emp-close aria-label="Close">&times;</button></div>
    <div class="modal-body pp-editor-body"><div data-accounts-host></div></div>`;
  openSettingsModal(modal);
  if (typeof refreshAccountsForms === 'function') refreshAccountsForms();
}

async function exportEmployees() {
  try {
    const data = await hrApi('/api/hr/export');
    const saved = await window.electronAPI.saveAccountsCsv('employees', data.csv);
    if (saved && saved.saved) showToast(`Saved ${data.count} employee${data.count === 1 ? '' : 's'}.`, 'success');
  } catch (err) {
    showToast(err.message || 'Could not export.', 'error');
  }
}

async function addEmployeeTask(kind) {
  const input = document.querySelector(`[data-task-input="${kind}"]`);
  const title = input ? input.value.trim() : '';
  if (!title) return;
  const id = employeeState.editingId;
  await changeTasks(id, () => hrApi(`/api/hr/employees/${id}/tasks`, 'POST', { kind, title }));
}

// ---- events ---------------------------------------------------------------------------------------

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const t = event.target;
    if (!t.closest) return;
    if (t.closest('[data-emp-close]')) { closeSettingsModal(); return; }
    const sort = t.closest('[data-emp-sort]');
    if (sort) {
      const key = sort.dataset.empSort;
      employeeState.sort = employeeState.sort.key === key ? { key, dir: employeeState.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' };
      renderPeopleBody();
      return;
    }
    const row = t.closest('[data-emp-row]');
    if (row) { openEmployeeEditor(Number(row.dataset.empRow)); return; }
    if (t.closest('[data-emp-departments]')) { openDepartments(); return; }
    if (t.closest('[data-emp-checklists]')) { openChecklistTemplates(); return; }
    const reset = t.closest('[data-emp-reset]');
    if (reset) { resetEmployeePassword(Number(reset.dataset.empReset)); return; }
    const deactivate = t.closest('[data-emp-deactivate]');
    if (deactivate) { deactivateEmployee(Number(deactivate.dataset.empDeactivate)); return; }
    const reactivate = t.closest('[data-emp-reactivate]');
    if (reactivate) { reactivateEmployee(Number(reactivate.dataset.empReactivate)); return; }
    const copy = t.closest('[data-emp-copy]');
    if (copy) { navigator.clipboard.writeText(copy.dataset.empCopy).then(() => showToast('Copied.', 'success')); return; }
    const remove = t.closest('[data-task-delete]');
    if (remove) { event.preventDefault(); changeTasks(employeeState.editingId, () => hrApi(`/api/hr/tasks/${remove.dataset.taskDelete}`, 'DELETE')); return; }
    const apply = t.closest('[data-task-apply]');
    if (apply) { changeTasks(employeeState.editingId, () => hrApi(`/api/hr/employees/${employeeState.editingId}/tasks`, 'POST', { kind: apply.dataset.taskApply, apply: true })); return; }
    const add = t.closest('[data-task-add]');
    if (add) { addEmployeeTask(add.dataset.taskAdd); return; }
    const save = t.closest('[data-tpl-save]');
    if (save) {
      const kind = save.dataset.tplSave;
      const titles = document.getElementById(`tpl-${kind}`).value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      hrApi('/api/hr/task-templates', 'PUT', { kind, titles }).then(() => showToast(`${kind === 'onboarding' ? 'Onboarding' : 'Offboarding'} list saved.`, 'success')).catch((err) => showToast(err.message || 'Could not save.', 'error'));
      return;
    }
    if (t.closest('[data-emp-add]')) { openAddPeople(); return; }
    if (t.closest('[data-emp-export]')) { exportEmployees(); return; }
    const page = t.closest('[data-emp-page]');
    if (page) { closeSettingsModal(); openPersonPage(Number(page.dataset.empPage)); return; }
    const dept = t.closest('[data-dept-save], [data-dept-delete], [data-dept-add]');
    if (dept) {
      const action = dept.hasAttribute('data-dept-save') ? 'save' : dept.hasAttribute('data-dept-delete') ? 'delete' : 'add';
      departmentAction(dept.closest('[data-dept]'), action);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !event.target.closest) return;
    const taskInput = event.target.closest('[data-task-input]');
    if (taskInput) { event.preventDefault(); addEmployeeTask(taskInput.dataset.taskInput); return; }
    const row = event.target.closest('[data-emp-row]');
    if (row) openEmployeeEditor(Number(row.dataset.empRow));
  });

  document.addEventListener('change', (event) => {
    if (event.target.dataset && event.target.dataset.taskToggle) {
      const id = employeeState.editingId;
      changeTasks(id, () => hrApi(`/api/hr/tasks/${event.target.dataset.taskToggle}`, 'PUT', { done: event.target.checked }));
      return;
    }
    if (event.target.id === 'emp-filter-status') { employeeState.status = event.target.value; renderPeopleBody(); }
    if (event.target.id === 'emp-filter-department') { employeeState.department = event.target.value; renderPeopleBody(); }
  });

  document.addEventListener('submit', (event) => {
    if (event.target.id === 'employee-form') saveEmployeeRecord(event);
  });
}
