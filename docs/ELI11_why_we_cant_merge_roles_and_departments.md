# ELI11: Why can't we just make roles named after the departments?

You have asked this a few times. This page is the answer, written so you can read it in five minutes the next time it
crosses your mind. "ELI11" means "explain it like I'm eleven".

## The short answer

**A department says where you belong. A role says what you are allowed to do.**
Those are two different questions, so they need two different boxes. If we poured them into one box, every time someone
moved to another department they would silently gain or lose powers, and the people who should only move staff around
(HR) would end up handing out powers by accident.

## The school picture

Think of a school.

- Your **class** (Grade 6-B) says where you belong: which room you sit in, which teacher you report to, who your
  classmates are. The school office decides it.
- Your **badges** (hall monitor, club president, librarian helper) say what you are allowed to do. The principal decides
  them.

Now someone says: "Why not just make the badge named after the class? A '6-B badge'."

Then:

- A girl moves from 6-B to 6-C. The office moves her class, but nobody remembers to swap the badge. Now she sits in 6-C
  holding a 6-B badge. Which rooms can she enter now?
- The hall monitor of 6-B is also in the chess club. Is she a "6-B" or a "hall monitor" or a "chess club" person? She is
  all three, and the three things have nothing to do with each other.
- Two classes both need a hall monitor with the **same powers**. With "badge = class" you would make two different
  badges that mean the same thing, and fix both every time the rules change.

That is the whole problem. Belonging and powers move on different schedules, are decided by different people, and are
checked for different reasons.

## How it looks in IT Avenue Workspace

| | **Department** | **Role** |
| --- | --- | --- |
| Question it answers | Where do you belong? | What may you do? |
| Examples | MIS, Human Resource, Management, Fabrication/Engineering Unit | Owner, HR, Everyone, a "Channel manager" role, someone allowed to use `/announce` |
| Who sets it | HR (People › Manage, the employee record) | Whoever has the "manage roles" power (Moderation › Roles) |
| How many per person | One main department; a person can be in more than one | As many as needed; their powers add up |
| What it is used for | The org chart and headcount, who heads the department, leave and attendance reports, `@department` mentions, letting a whole department into a private channel | Every permission check in the app: send messages, create channels, manage people, delete others' messages, post announcements |
| What it can NOT do | Give anyone a power | Say where someone works |

Two things in the app already show the line between them:

1. **A department can open a door, but cannot hand out powers.** On a channel's permissions screen a department row may
   only say "can see this channel". If you try to give a department any action (send, delete, manage), the app refuses
   and tells you to use a role or a person instead. This is on purpose.
2. **HR can move people between departments but cannot make anyone powerful.** That is why the two are separate: HR's job
   is to keep employee records right. It is not their job (and it would not be safe) for a department move to change who
   can delete messages or manage channels.

## What would actually go wrong if we merged them

Real examples from your own company:

1. **Moving someone.** A person moves from MIS to Management. With merged roles, HR changing the record would also change
   their powers, with no review. A mistake in a department list becomes a security hole.
2. **The same power in different departments.** A team lead in Fabrication and a team lead in MIS both need to create
   channels. With merged roles you need a "Fabrication lead" role *and* an "MIS lead" role, and you must keep them
   identical forever. Today it is one role, given to both.
3. **Different powers inside one department.** In MIS the head can manage channels and the staff cannot. They share the
   same department. If the department *is* the role, you cannot tell the head apart from the staff.
4. **Someone in two departments.** Their powers should be the union of what they are allowed to do, not "whichever
   department word is on the record".
5. **Someone who leaves a department but keeps a duty.** A person can stop being in MIS yet still be a channel moderator.
   With merged roles, leaving the department would take the duty away too.
6. **Reports and the org chart.** Headcount, "who is the head of Human Resource", and leave reports need one clean list
   of departments. Roles are a list of powers, and one person can hold many, so counting people by role would count the
   same person several times.

## "But we already have roles named like departments"

Yes, some. When we folded the old "user groups" into roles, each old group became a role with **no powers** at all. They
exist only so people can be mentioned together (`@mis`). They are labels, not authority. Whether the label matches a
department is a coincidence of naming, not a link. The department list in HR is the real one.

## What if I want "everyone in MIS can do X"?

You can have that today, in two honest ways:

- **Create a role** (say "MIS tools") with the powers you want, and give it to the people who need it. Explicit and
  reviewable, and it survives department moves.
- **Open a private channel to a department**, so everyone currently in that department gets in automatically and a
  transferred person loses access by themselves. That is the department-channel feature.

## The middle path, if you ever want more convenience

The real wish behind the question is usually: "I don't want to tick two things for every new hire." That is a fair
wish, and the answer is not merging. It would be a **rule that links them on purpose**: for example "anyone added to the
MIS department automatically gets the 'MIS tools' role, and loses it when they leave". The two boxes stay separate, but
one fills in the other, so a human decided it once. **This is built now:** in **Moderation > Roles**, edit a role and tick the departments under
"Given automatically to members of". Details in the User Guide.

## Three questions to settle it next time

When you wonder whether something should be a department or a role, ask:

1. **Is this about where a person belongs, or what they may do?** Belongs means department. May do means role.
2. **Who should be able to change it?** HR for records means department. Admins for powers means role.
3. **If the person moves tomorrow, should this change by itself?** Yes means department. No, it should be a deliberate
   decision, means role.

## Where to see each one in the app

- Departments: **People › Manage** (the employee record and the Departments list), the Directory filter, the org chart,
  and the **Department access** choice when creating a channel.
- Roles: **Moderation › Roles** (what each role may do and who holds it), and a channel's **Permissions** card.

For the technical design see [ROLES_DESIGN.md](ROLES_DESIGN.md) and [EMPLOYEE_MANAGEMENT.md](EMPLOYEE_MANAGEMENT.md).
