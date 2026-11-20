# Knowledge Base backup, restore and reset-proofing (design)

**Why.** A Workspace Reset wiped every Knowledge Base article (the reset truncates `canvases ... CASCADE`; article text is a canvas) and every uploaded picture, leaving only empty categories. The Owner wants the Knowledge Base to survive a reset, plus their own Backup and Restore with checkboxes.

**Goals.** One mechanism for all three: a Knowledge Base package. Export what is ticked; restore all or ticked articles; the reset packs the Knowledge Base before wiping and restores it after.
**Non-goals.** Backing up anything else; scheduled backups; merging two versions of one article.

**Approaches considered.** (1) a package used by Backup, Restore and the reset (chosen); (2) skipping KB rows inside the reset (many tables, nothing for Backup/Restore); (3) both separately (duplicate work).

**Decisions (the user said "go with your suggestion").**
- Package = one JSON file (`itavenue-knowledge-base`, version 1): categories, articles (text, published, order), and optionally pictures (base64), Help-screen links, version history, comments. *Ruling: JSON, not zip, so no new dependency; readable by hand.*
- Who: people with Manage knowledge base (HR by default, Owners always), via `/api/kb-backup` (`outline`, `export`, `preview`, `restore`).
- Restore matches by category title and article title. An existing article is skipped unless the person chooses Replace the text (the old text is kept in History) or Add a copy ("(restored)"). Nothing is changed that was not chosen.
- Reset: "Keep the Knowledge Base" is ticked by default in the reset panel. The package is built (and a copy kept in the backups folder) before anything is deleted; if it cannot be built the reset stops. If putting it back fails the reset reports it and the kept file can be restored with Restore.
- Pictures are re-linked: restored files get new ids, and `file:ID` in the text is rewritten.

**Code.** `backend/src/knowledgeBasePackage.js` (build, validate, describe, restore), `routes/knowledgeBaseBackup.js`, `workspaceReset.js` (`preserveKnowledgeBase`), `frontend/src/features/kb-backup.js`.
