# IT Avenue Workspace: guide for the people who run it

This guide is for the people who run the workspace. It is not part of the in-app Help that employees read.

## Running the workspace

### How do I set a department head, or rename a department?
Go to **People > Manage > Departments** (HR and Owners).
1. Change the name, or click the head box and start typing a name. The list is alphabetical and shows `Name (username)`. Clear the box for no head.
2. Rows you changed get a purple bar, and the footer counts the unsaved changes.
3. Press **Save changes** once. Only the changed departments are saved.

The new head becomes the moderator of that department's forum immediately, and the old head loses it. Moderators someone added by hand keep their role.

### How do I add a department?
In the same dialog, fill in **New department** and press **Add**. Its forum is created automatically. Deleting a department archives its forum and keeps its content.

### How do I group channels and forums into a section?
Open the **Channel organizer**: click the gear icon beside **Channels** in the sidebar.
1. Under **Workspace sections**, press **+ Add** and name the section.
2. Move channels and forums into it with the dropdown beside each one, or drag them in.
3. Press **Save sections**.

Forums appear in the list for administrators by name only: you can place them in a section without being able to read them. Members only see a forum in the section if they are allowed to open it. Forums are created by creating a department, not by hand.

### How do I make a channel built-in, or change the order?
Only an **Owner** can do this.
- **Make one built-in:** open the channel's settings (**Moderation** > the channel), find **Built-in channel**, and press **Make built-in**. Everyone is added to it at once, new people join automatically, nobody can leave or be removed, and it cannot be renamed, archived or deleted. It moves into the **OFFICIAL** section. Press **Turn off built-in** to make it an ordinary channel again; people stay in it, but it leaves OFFICIAL. You can also tick **Built-in channel** when creating a channel.
- **What can be built-in:** a public, shared channel. Personal channels, private channels and department forums cannot. #welcome, #rules, #announcements and #general are required by the app and always stay built-in.
- **Change the order:** open the **Channel organizer**, and use the up and down arrows next to each channel in the **OFFICIAL** section. The new order is saved straight away and everyone sees it.

### How do I give someone more rights?
**Moderation > Roles** holds the roles and the **Assignments** table (the header stays visible as you scroll). Give a role the **Manage messages** permission to let its members moderate every forum and channel they can open. Roles also decide the colour of a person's name.

### How do I give a role to everyone in a department automatically?
In **Moderation > Roles**, press **Edit** on a role and tick the departments under **Given automatically to members of**. Everyone in those departments gets the role now, anyone who joins later gets it too, and anyone who leaves loses it. In the Assignments table such a box is ticked and cannot be changed by hand (hover it to see why); to take the role away from one person, remove them from the department or change the role's departments. A role someone was given by hand is never taken away by this, and the built-in Owner and Everyone roles can never be given this way.

Good to know: a person belongs to every department listed on their record, not only their main one. Changing someone's **main** department on their record keeps the old one as an extra, so they keep what it gave. To take them out of the old department, remove it in the department list on their record. You can only choose roles below your own rank, and every change appears in the audit log.

### Why can an Owner not read a private channel or forum?
By design. Owners see private channels and forums they are not members of only when the **private-channel switch** (Moderation, Superadmin tab) is on, and turning it on is recorded.

### The sidebar does not look right, or something is missing
Check you are a member of the department or channel, then reload with **Ctrl+R**. If it is still wrong, tell IT or HR what you expected to see and in which section.

### How do I keep the list of workspace backups tidy?
Under **Moderation > Recovery**, every backup has icon buttons (hover one to see its full name): **rename** (give it a name such as "Before payroll change" so you can tell it apart; the date stays beside it), **keep** (the star: a backup marked Keep is never deleted by a clean-up and cannot be deleted until Keep is turned off), **download** the database or the uploaded files, **check** that it can be read, **restore** from it, and **delete** it. Backups made by the app say why, for example "Before a workspace reset".

A backup that stopped halfway (missing its database or its uploaded files) cannot be restored. These are hidden behind a line such as "2 incomplete backups are hidden": the eye button shows them and the bin button deletes them all. The broom button above the list deletes every complete backup except the newest ones you choose to keep (and those marked Keep).

### Does a Workspace Reset delete the Knowledge Base?
Not by default. The reset panel has **Keep the Knowledge Base** ticked: the articles, pictures, comments and history are packed before the reset and put back after it. Untick it to wipe the Knowledge Base too. A copy of what was kept is also saved in the backups folder, and you can restore from it with **Restore**.
