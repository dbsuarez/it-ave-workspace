# Roles given by department: design

Status: approved by the user on 2026-11-18 ("yes, go ahead, no exception per-person, owner not included").

## Why
People in a department usually need the same tools. Today someone has to tick the department and then the matching role for
every new person. A rule links them on purpose: "everyone in MIS gets the MIS tools role, and loses it when they leave MIS".
Departments and roles stay separate things; the rule only fills in the role box.

## Goals
- A role can be marked "given automatically to members of these departments".
- Joining a department gives the role; leaving it (or the department being deleted, or the rule removed) takes it away.
- A role someone was given by hand for another reason is never taken away by a rule.
- Changing a rule brings the existing members in line at once.

## Non-goals
- No per-person exception (user decision): a rule-given role cannot be unticked for one person.
- The built-in Owner and Everyone roles can never be rule targets. Only custom roles.
- No separate "head of department" rule: a head is normally a member and gets the member roles.

## Decisions (mine, stated so they can be corrected)
- Every department a person belongs to counts (`user_departments`), not only the primary one.
- The rule is set on the role (Moderation > Roles), by someone who can manage roles, for roles below their own. A People manager
  is not necessarily a role manager, and the escalation check already lives there.
- Marked rows: `user_roles.auto` is true when a rule gave the role. A manual assignment of a role the rule would also give stays
  manual (`ON CONFLICT DO NOTHING`), so it survives leaving the department.

## Approaches considered
1. **Computed on the fly** (rule roles merged in wherever permissions are read). Always in step, but permissions are read in
   many SQL places; one missed place is a security bug. Rejected.
2. **Stored rows marked `auto`, re-checked after every membership or rule change** (chosen). Permission code is untouched.
   Cost: every place that changes membership must call the re-check; a startup re-check heals any miss.

## Design
- `department_roles (department_id, role_id)`, both cascading; `user_roles.auto BOOLEAN NOT NULL DEFAULT false`.
- `backend/src/departmentRoles.js`: `reconcileUser`, `reconcileDepartment`, `reconcileEveryone`; each returns who changed.
  `applyDepartmentRoles` wraps it with the audit entry (`roles_assigned`, details say it came from a department rule) and the
  live `permissions_updated` event.
- Called after: editing a person's department (hr.js), account creation/import (admin.js), the multi-department editor
  (channelAccessPolicies.js), deleting a department (hr.js), changing a role's departments, and once at startup.
- API: `PUT /api/roles/:id/departments { departmentIds }` (role manager, `canManageRole`, custom roles only);
  `GET /api/roles` rows carry `departmentIds`; `GET /api/roles/assignments` also returns `auto: { userId: [roleId] }`;
  `PUT /api/roles/users/:id` leaves rule-given roles alone (they are never removed by hand).
- UI: a role's card gets "Given automatically to members of" with department chips; the Assignments table shows rule-given
  roles ticked and locked ("from a department"). The change asks for confirmation with the number of people affected.

## Tasks
1. Schema and re-check logic (`departmentRoles.js`), real-database tests.
2. Hook into membership changes and startup; audit and live refresh.
3. Role API: set departments, protect rule-given rows, expose them.
4. Roles screen: department chips, locked rows.
5. Docs (User Guide replaces "not built"), backup, rebuild, throwaway live check, handoff.
