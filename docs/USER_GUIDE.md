<!-- This file is the single source for the in-app Help (the ? button). After editing it, run `npm run help` in frontend/ so the app picks up the change; `npm run check` fails if the two are out of step. -->
# IT Avenue Workspace: User guide

Short answers to the things people ask most. Use the search box at the top of Help to find a word.

## Getting around

### Where is everything?
The strip on the left has the main places: **Home** (channels and forums), **DMs**, **Activity** (mentions, replies and reactions to you), **Later** (saved items and reminders), **Files**, **Notes**, **Canvas**, **People**, **Huddle** (audio calls) and **More** (Lists and Canvases). **Moderation** appears only if you are allowed to moderate or manage the workspace.

### Keyboard shortcuts
- **Ctrl+K** searches messages, people and files.
- **Ctrl+N** starts a new message.
- **Esc** cancels a reply or closes a menu.

### How do I find something?
Type in the search box at the top. It looks through the messages, people and files you are allowed to see, and nothing else. Typing `/search` followed by words in any channel gives you the same results privately.

## Channels and messages

### How do I send a message, a file or a reply?
Pick a channel on the left, type, and press Enter. The paperclip attaches files (up to 10 at once, or drag them onto the window). Use the reply arrow on a message to answer it, and the smiley to react.

### What is the difference between a channel and a forum?
A channel is a running conversation, shown with a **#**. A forum is a list of separate **topics**, shown with a **speech-bubble icon**. Every department has its own forum (see the next section).

### Slash commands
Type **/** in a channel to see what you can use.
- **/help** lists the commands available to you.
- **/search words** searches, with the answer shown only to you.
- **/poll "Question?" "Option A" "Option B"** starts a poll. Add `--multi` to let people pick several, `--anonymous` to hide who voted, and `--closes 2h` to close it automatically.
- **/announce text** posts an announcement. It only works in channels marked as announcement channels, and only for people who have the Announce permission. You see a preview first and confirm.

Slash commands that post to everyone (**/poll** and **/announce**) do not work inside a forum, because a forum only takes posts inside topics.

## Department forums

### What is my department's forum?
Each department has a private forum called `dept-` and the department name, for example `dept-mis`. Only people in that department can open it. Find it in the sidebar by its speech-bubble icon. If your administrator has grouped forums into a section, look there.

### How do I start a topic?
Open the forum, press **New topic**, give it a title (up to 120 characters), write the first post, optionally attach files, and press **Start topic**. The topic opens straight away.

### How do I reply?
Click a topic to open it. The posts appear like an ordinary conversation, and you write at the bottom. **← All topics** takes you back to the list.

### What do Active and Archived mean?
**Active** holds the topics in use. A moderator can archive a finished topic, which moves it to **Archived** and makes it read-only. It can be brought back.

### Can I find a topic later?
Yes. Search finds topics by their title, posts by their text, and attachments by their file name (not by what is inside the file).

### Why can't I see a forum, or why did it disappear?
A forum is open only to people currently in that department. If you were moved to another department, you lose that forum straight away and get the new one. An Owner who is not in the department does not see it either, unless the Owner private-channel switch in Moderation is on.

## Moderating a forum

Only the **department head**, an **Owner who can open the forum**, and people whose role has the **Manage messages** permission see these buttons. They are small icons; hover over one to see what it does.

### How do I pin a topic?
Click the **pin** icon on the topic (in the list or at the top of the open topic). Pinned topics move to a **Pinned** group at the top of the forum and stay there, however busy other topics are. A pinned topic works well as that forum's announcement. Click the same icon again to **unpin**.

### How do I lock a topic?
Click the **padlock**. Nobody can reply or edit their own posts in a locked topic, and the message box shows "This topic is locked". Click it again to unlock. A moderator can still remove a post.

### How do I archive, rename or delete a topic?
- **Archive** (box icon) moves it to the Archived tab and makes it read-only; click again to **unarchive**.
- **Rename** (pencil icon) changes the title. The person who started a topic can rename their own while it is open.
- **Delete** (red bin) removes the topic and all its posts for good, after a confirmation. The person who started a topic can delete it only while nobody has replied.

Every pin, lock, archive, rename and delete is recorded in the forum's audit log.

## People

### Where do I see who works here?
**People** has the **Directory** (switch between cards and a list, and show active or inactive people), **My team** (your direct reports), the **Org chart**, **Leave**, and **Attendance**. **Manage** appears for HR and Owners.

### Who is the head of a department?
Open **People > Manage > Departments**: each department shows its head. Ask HR or an Owner to change it.

## For administrators

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

### How do I give someone more rights?
**Moderation > Roles** holds the roles and the **Assignments** table (the header stays visible as you scroll). Give a role the **Manage messages** permission to let its members moderate every forum and channel they can open. Roles also decide the colour of a person's name.

### Why can an Owner not read a private channel or forum?
By design. Owners see private channels and forums they are not members of only when the **private-channel switch** (Moderation, Superadmin tab) is on, and turning it on is recorded.

### The sidebar does not look right, or something is missing
Check you are a member of the department or channel, then reload with **Ctrl+R**. If it is still wrong, tell an administrator what you expected to see and in which section.
