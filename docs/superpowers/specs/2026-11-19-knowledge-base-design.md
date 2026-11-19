# Knowledge Base

Approved by the user in the conversation of 2026-11-19 ("approved, put it in the rail as Knowledge Base, yes last updated is good", no read confirmation).

## Intent
Employees look things up themselves ("How do I file a leave?"). HR writes and maintains the content: frequently asked questions in categories, and the **employee handbook** (a category whose articles are its chapters, in order). The handbook arrives by screenshots turned into text by another tool, pasted in, edited, and saved as PDF.

## Goals / non-goals
- Goals: categories and articles written in Markdown; everyone signed in as a member reads and searches; HR manages by default; draft/publish; "Last updated" on every article; import pasted Markdown split into articles; save an article or a whole category as one PDF.
- Non-goals (v1): read confirmation or sign-off, comments, version history, pictures inside articles, links from other screens (such as the Leave screen) into articles, guests reading it.
- Anti-goal: employees seeing unfinished drafts, or being able to edit.

## Approaches considered
1. **A real Knowledge Base (chosen):** `kb_categories` and `kb_articles`, Markdown bodies, reuse of the Canvas reading view and PDF export.
2. Each article a shared Canvas: quick, but no search, ordering or safe read-only for employees. Rejected.
3. Upload the handbook as a PDF: not searchable, not mixable with FAQs. Rejected.

## Design
- Permission **`manage_knowledge_base`** ("Create and edit Knowledge Base articles (HR)"); Owners always; the legacy HR role gets it by migration (same pattern as `manage_sheets`).
- Tables: `kb_categories (id, title, position, created_at)`; `kb_articles (id, category_id -> cascade, title, body, position, published, created_by, created_at, updated_by, updated_at, published_at)`. Limits: category title 80, article title 160, body 100,000 characters, 100 categories, 500 articles per category, import up to 200 articles at once.
- Read access: any active **member** (not guests). Members see only published articles (and categories that have at least one, plus empty ones to managers). Managers (`manage_knowledge_base`) see drafts, marked "Draft".
- `updated_at` changes when the title, body or published state changes (not when reordering). It is shown as "Updated <date> by <full name>" (the server sends the name: full name, username only as the fallback).
- Reading view: the article body is split into sections by the existing Canvas parser (`backend/src/canvasSections.js parseSections`) and shown with `renderCanvasSections` (headings, lists, tables, callouts, checklists, code).
- API `/api/kb` (own JSON parser, 1 MB):
  - GET `/` -> `{ canManage, categories: [{ id, title, articleCount, draftCount? }] }`.
  - GET `/categories/:id` -> `{ category, articles: [{ id, title, published, updatedAt, updatedByName }] }` in order.
  - GET `/articles/:id` -> `{ article: { id, categoryId, categoryTitle, title, body, published, updatedAt, updatedByName }, sections, siblings: { previous, next } }`.
  - GET `/search?q=` -> up to 30 `{ id, title, categoryId, categoryTitle, snippet, updatedAt }` (title first, then text; at least 2 characters; case-insensitive; `%` and `_` are literal).
  - Managers: POST `/categories`, PATCH `/categories/:id`, DELETE `/categories/:id`, PUT `/order` (`{ ids }` for categories); POST `/articles`, PATCH `/articles/:id` (title, body, published, categoryId), DELETE `/articles/:id`, PUT `/categories/:id/order` (`{ ids }` for its articles); POST `/categories/:id/import` (`{ articles: [{ title, body }], publish }`).
- Screen: rail item **Knowledge Base** (after Sheets, hidden for guests). Home: a search box and the categories as cards. Category: its articles in order (handbook-style table of contents) with move up/down and "Save as PDF" for managers and members alike. Article: title, last updated, body, previous/next within the category, "Save as PDF". Managers also get: New category, Rename, Delete, New article, Edit (title, Markdown body with a live preview, Published checkbox), Delete, and **Import**: paste Markdown, choose to split at `#` or `##` headings, preview the list of articles, create them as drafts (or published).
- PDF: the desktop app's existing `canvas:export` (`format: 'pdf'`, `title`, `html`). A category becomes one document (the category title, then each article).

## Left to the builder
Exact markup and styling (follow the Sheets and Notes screens), the Markdown preview wiring, file split.

## Tasks
1. Backend: migration, permission, `backend/src/knowledgeBase.js` (pure cleaning and search helpers), the routes, real-database tests.
2. Frontend pure modules with tests: `kb-import.js` (split pasted Markdown into articles), `kb-view.js` (markup for home, category, article, editor, import preview).
3. Frontend screen: `knowledge-base.js` controller, rail item, view in `index.html`, wiring in `renderer.js`, styles.
4. Save as PDF (article and category).
5. Docs and Help, full test run, browser check, backup and rebuild, handoff and memory.

## Addendum (2026-11-19, same day): the text of an article is a Canvas; Help links; pictures and history
The user asked "why not reuse our Canvas 2.0 for building the knowledge base?" and the design changed accordingly. Canvas already has the visual editor, pictures, version history, comments and PDF/Word/Markdown export, so the Knowledge Base no longer has its own Markdown box, picture upload or version table.
- **An article is a Knowledge Base record plus a Canvas.** `kb_articles.canvas_id` points at a `canvases` row (kind `standalone`) that holds the title and Markdown text. The article keeps its category, order, published state, help screens and `updated_at`. The title is the canvas title (editing either changes both). "Last updated" is the later of the article and its canvas, by whoever last changed it (the newest canvas revision's editor, else the article's `updated_by`). Articles written before this got a canvas made from their text by the migration.
- **Who may do what with that canvas** (`security.js getStandaloneCanvasRole`): people with `manage_knowledge_base` are editors; any active member is a viewer once the article is published; nobody else (a draft is for HR only). Ordinary Canvas sharing does not apply. Pictures follow the same rule through the existing canvas-image access. Knowledge Base canvases are left out of the personal Canvas lists, and the Canvas routes refuse delete, share, collaborators, hand-over and access-request for them (400); deleting happens in the Knowledge Base and removes the canvas, its history, comments and picture files.
- **Writing:** on an article, HR presses **Edit text**: the Canvas editor opens on that canvas with a **Back to the Knowledge Base** button. **Details** (title, category, published, help screens) is a small dialog; **New article** opens it first, then the editor. **Import** (pasted Markdown split at headings) creates one canvas per article. Pictures, History, Comments and Export are the Canvas ones.
- **Help links from other screens.** HR ticks, per article, the screens it helps with (Home and channels, Activity, Later, Files, Notes, Canvas, Drawings, Sheets, People, Leave, Attendance, Huddle, Lists) in Details (`kb_article_screens`). A **Help** chip at the top right of such a screen opens the article (a menu when there are several). `GET /api/kb/screens/:key` returns the published articles linked to a screen; the screen list comes from `knowledgebase.js KB_SCREENS` and is sent to managers with `GET /api/kb` (`screenOptions`). People opens on tabs, so Leave and Attendance have their own keys.
- Save as PDF now inlines pictures (fetched with the sign-in, like Canvas export).
- Not built: notifying people when an article changes, per-article permissions, a separate "history" for article settings (title/published/screens are not versioned; the text is, by Canvas).
