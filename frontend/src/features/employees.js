// IT Avenue Workspace - employee management (People > Manage), for the Superadmin and HR.
//
// A table of every employee's record (number, department, title, manager, status, hire date) with filters and
// a CSV export, an editor for one record, the list of departments, and adding people (the same form as in
// Moderation). Loaded after people.js; the People view calls renderEmployeeManagement().

const employeeState = {
  list: [], departments: [], loaded: false, error: '', status: '', department: '', editingId: null,
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
    const [employees, departments] = await Promise.all([hrApi('/api/hr/employees'), hrApi('/api/hr/departments')]);
    employeeState.list = employees.employees;
    employeeState.departments = departments.departments;
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
  const rows = employeeState.list
    .filter((e) => employeeMatches(e, peopleState.query))
    .filter((e) => !employeeState.status || e.employmentStatus === employeeState.status)
    .filter((e) => !employeeState.department || String(e.departmentId || '') === employeeState.department);
  const counts = { active: 0, on_leave: 0, resigned: 0 };
  employeeState.list.forEach((e) => { counts[e.employmentStatus] += 1; });
  body.innerHTML = `
    <div class="emp-toolbar">
      <select id="emp-filter-status" class="pp-select" aria-label="Status">
        <option value="">All statuses (${employeeState.list.length})</option>
        ${Object.entries(EMPLOYEE_STATUSES).map(([key, label]) => `<option value="${key}"${employeeState.status === key ? ' selected' : ''}>${label} (${counts[key]})</option>`).join('')}
      </select>
      <select id="emp-filter-department" class="pp-select" aria-label="Department">
        <option value="">All departments</option>
        ${employeeState.departments.map((d) => `<option value="${d.id}"${employeeState.department === String(d.id) ? ' selected' : ''}>${escapeText(d.name)} (${d.memberCount})</option>`).join('')}
      </select>
      <span class="emp-spacer"></span>
      <button type="button" class="btn" data-emp-departments>Departments</button>
      <button type="button" class="btn" data-emp-export>Export CSV</button>
      <button type="button" class="btn primary" data-emp-add>Add people</button>
    </div>
    ${rows.length ? `<div class="emp-table-wrap"><table class="emp-table">
      <thead><tr><th>Employee</th><th>No.</th><th>Department</th><th>Job title</th><th>Reports to</th><th>Status</th><th>Hired</th></tr></thead>
      <tbody>${rows.map((e) => {
    const boss = e.managerId ? byId.get(e.managerId) : null;
    return `<tr data-emp-row="${e.id}" tabindex="0">
        <td><span class="emp-person">${peopleAvatar(e, 'sm')}<span><strong>${escapeText(employeeFullName(e))}</strong><em>@${escapeText(e.username)}${e.isHr ? ' · HR' : ''}${e.isSuperadmin ? ' · Superadmin' : ''}</em></span></span></td>
        <td>${escapeText(e.employeeNo) || '<span class="pp-muted">—</span>'}</td>
        <td>${escapeText(e.department) || '<span class="pp-muted">—</span>'}</td>
        <td>${escapeText(e.jobTitle) || '<span class="pp-muted">—</span>'}</td>
        <td>${boss ? escapeText(employeeFullName(boss)) : '<span class="pp-muted">—</span>'}</td>
        <td><span class="emp-status emp-status-${e.employmentStatus}">${EMPLOYEE_STATUSES[e.employmentStatus]}</span></td>
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
        <div class="pp-edit-triple">
          <div class="form-group"><label for="emp-status">Status</label><select id="emp-status">${Object.entries(EMPLOYEE_STATUSES).map(([k, l]) => option(k, l, e.employmentStatus)).join('')}</select></div>
          <div class="form-group"><label for="emp-hired">Hire date</label><input id="emp-hired" type="date" value="${escapeText(e.hireDate || '')}"></div>
          <div class="form-group"><label for="emp-lastday">Last day</label><input id="emp-lastday" type="date" value="${escapeText(e.separationDate || '')}"></div>
        </div>
        ${state.moderation.isSuperadmin ? `<label class="preference-toggle"><input type="checkbox" id="emp-hr"${e.isHr ? ' checked' : ''}><span>HR: can manage employee records, departments and reporting lines</span></label>` : ''}
        <p class="form-note">Email: ${escapeText(e.email)}${e.phone ? ` · Phone: ${escapeText(e.phone)}` : ''}. The employee edits their own photo, phone and page.</p>
      </div>
      <div class="modal-footer">
        <button class="btn" type="button" data-emp-page="${e.id}">Open their page</button>
        <button class="btn" type="button" data-emp-close>Cancel</button>
        <button class="btn primary" type="submit">Save</button>
      </div>
    </form>`;
  openSettingsModal(modal);
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
    employmentStatus: value('emp-status'), hireDate: value('emp-hired') || null, separationDate: value('emp-lastday') || null,
  };
  try {
    await hrApi(`/api/hr/employees/${e.id}`, 'PUT', record);
    const manager = value('emp-manager') === '' ? null : Number(value('emp-manager'));
    if (manager !== (e.managerId || null)) await hrApi(`/api/people/${e.id}/manager`, 'PUT', { managerId: manager });
    const hrBox = document.getElementById('emp-hr');
    if (hrBox && hrBox.checked !== e.isHr) await hrApi(`/api/hr/employees/${e.id}/hr-role`, 'PUT', { isHr: hrBox.checked });
    closeSettingsModal();
    showToast('Employee record saved.', 'success');
    await loadEmployeeManagement();
    if (typeof loadPeople === 'function') loadPeople();
  } catch (err) {
    showToast(err.message || 'Could not save the record.', 'error');
  }
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
    if (typeof loadPeople === 'function') loadPeople();
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

// ---- events ---------------------------------------------------------------------------------------

if (typeof document !== 'undefined') {
  document.addEventListener('click', (event) => {
    const t = event.target;
    if (!t.closest) return;
    if (t.closest('[data-emp-close]')) { closeSettingsModal(); return; }
    const row = t.closest('[data-emp-row]');
    if (row) { openEmployeeEditor(Number(row.dataset.empRow)); return; }
    if (t.closest('[data-emp-departments]')) { openDepartments(); return; }
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
    const row = event.target.closest('[data-emp-row]');
    if (row) openEmployeeEditor(Number(row.dataset.empRow));
  });

  document.addEventListener('change', (event) => {
    if (event.target.id === 'emp-filter-status') { employeeState.status = event.target.value; renderPeopleBody(); }
    if (event.target.id === 'emp-filter-department') { employeeState.department = event.target.value; renderPeopleBody(); }
  });

  document.addEventListener('submit', (event) => {
    if (event.target.id === 'employee-form') saveEmployeeRecord(event);
  });
}
