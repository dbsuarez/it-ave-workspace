// IT Avenue Workspace - roles given by department (Moderation > Roles). Pure functions: data in, text or HTML out, every value
// escaped. A role can be marked "given automatically to members of these departments"; the server does the work (see
// backend/src/departmentRoles.js), this only shows and describes it.

function roleDeptEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const byName = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' });

// "given by MIS, Finance" for a role's row, or '' when no department gives it.
function roleDepartmentsText(role, departments) {
  const names = (departments || []).filter((department) => (role.departmentIds || []).includes(department.id)).sort(byName).map((department) => department.name);
  return names.length ? `given by ${names.join(', ')}` : '';
}

// One box per department, in name order, for the role editor.
function roleDepartmentChecklistHtml(departments, selectedIds, { disabled = false } = {}) {
  if (!departments || !departments.length) return '<p class="moderation-help">There are no departments yet.</p>';
  const chosen = new Set((selectedIds || []).map(Number));
  return `<div class="role-dept-list">${[...departments].sort(byName).map((department) => `
    <label class="role-perm"><input type="checkbox" name="roleDept" value="${Number(department.id)}"${chosen.has(Number(department.id)) ? ' checked' : ''}${disabled ? ' disabled' : ''}>
      <span><strong>${roleDeptEscape(department.name)}</strong><small>${Number(department.memberCount || 0)} ${Number(department.memberCount) === 1 ? 'person' : 'people'}</small></span></label>`).join('')}</div>`;
}

function sameDepartmentList(a, b) {
  const left = [...new Set((a || []).map(Number))].sort((x, y) => x - y);
  const right = [...new Set((b || []).map(Number))].sort((x, y) => x - y);
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

// What to ask before the choice is saved: who gets the role now, who loses it.
function roleDepartmentConfirmText(roleName, departments, before, after) {
  const beforeSet = new Set((before || []).map(Number));
  const afterSet = new Set((after || []).map(Number));
  const part = (ids, verb) => {
    const chosen = (departments || []).filter((department) => ids.has(Number(department.id)));
    if (!chosen.length) return '';
    const people = chosen.reduce((sum, department) => sum + Number(department.memberCount || 0), 0);
    return `Everyone in ${chosen.sort(byName).map((department) => department.name).join(', ')} (${people} ${people === 1 ? 'person' : 'people'}) will ${verb} "${roleName}" now. `;
  };
  const gain = part(new Set([...afterSet].filter((id) => !beforeSet.has(id))), 'get');
  const lose = part(new Set([...beforeSet].filter((id) => !afterSet.has(id))), 'lose');
  return `${gain}${lose}Someone who joins later gets it too, and someone who leaves loses it. A role someone was given by hand is never taken away.`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { roleDepartmentsText, roleDepartmentChecklistHtml, sameDepartmentList, roleDepartmentConfirmText };
}
