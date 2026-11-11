# REAGHIDRA: how Slack Lists and Canvas work

Research record, 2026-11-11. Purpose: understand how Slack's **Lists** and **Canvas** features
behave so we can build our own versions, and keep the answer here so nobody has to repeat the work.

Written for: engineers continuing the IT Avenue Workspace project.

## The short version

1. **The installed Slack desktop app contains no Lists or Canvas logic.** Slack 4.53.280.0 for
   Windows is a thin Electron shell (about 10 MB of JavaScript plus the Chromium runtime). The real
   interface is downloaded from `app.slack.com` at runtime. So there is nothing in the package for
   REA or Ghidra to decompile for these features.
2. **Being paid ("pro") features does not block us.** The plan check happens on Slack's servers.
   Their behaviour is documented in Slack's public developer docs, which anyone can read. We used
   those. Details: [03](03-canvas-behaviour.md) and [04](04-lists-behaviour.md).
3. **What we cannot know from public sources:** Slack's UI-only behaviour (Lists views, sorting,
   grouping, board layout, item comments; Canvas version history, comments, templates, live
   co-editing). The public docs do not describe it, and the code that implements it is not on this
   machine. We should design those parts ourselves. See the gap list in [05](05-replication-plan.md).
4. **Ghidra was deliberately not run** on `Slack.exe` or the native addons. Reasoning in
   [01](01-method-and-evidence.md). Nothing was lost by that.

> **Heads-up.** A new Canvas system (Canvas 2.0: channel, DM and standalone canvases, collaborators,
> share links, live sync) was committed to this repository while this research was being written.
> [05](05-replication-plan.md) describes the code as it is after that change. Re-read the current Canvas
> and Lists code before acting on any plan here.

## Contents

| File | What it holds |
|---|---|
| [01-method-and-evidence.md](01-method-and-evidence.md) | What was run, in order, with hashes and REA evidence IDs; what each result proves and does not; why Ghidra was skipped |
| [02-slack-package-findings.md](02-slack-package-findings.md) | Anatomy of the Slack Windows package and the proof that Lists/Canvas code is absent |
| [03-canvas-behaviour.md](03-canvas-behaviour.md) | How Canvas works, from Slack's public docs (data model, edit operations, access) |
| [04-lists-behaviour.md](04-lists-behaviour.md) | How Lists work, from Slack's public docs (schema, column types, items, access) |
| [05-replication-plan.md](05-replication-plan.md) | What we already have, the gaps, and a design for closing them in our own way |
| [scripts/](scripts) | Read-only scripts that re-check the package findings (`rerun.ps1` runs them all) |

## Do not repeat

- Do not re-run REA static analysis hoping to find Lists/Canvas in the Slack package. It is not
  there (checked in the JavaScript, all eight native addons, and the 238 MB executable).
- Do not run a Ghidra import of `Slack.exe` for this purpose. It is a Chromium build; the import
  alone takes minutes and the answer is already known.
- If Slack ships a new version, `scripts/rerun.ps1` re-checks the package in seconds.

## Scope and conduct

- Only software installed on this machine by the user was inspected, read-only. Nothing was
  executed, patched, or signed in.
- No Slack source code, assets, or fonts were extracted or copied into this repository. The scripts
  count terms and print short windows to the console. The documents describe behaviour in our own
  words and link to Slack's public pages.
- Slack's user terms restrict reverse engineering of its software. This research stayed at the level
  of "does the installed package contain this feature" and otherwise relied on Slack's published
  documentation, which is what we recommend continuing to do.
- Our implementation must be written from the behaviour descriptions, not from Slack code.

## If more is ever needed

Observing Slack's paid UI behaviour would need a paid workspace that you own and authorise for the
purpose, plus runtime capture of the signed-in app. That was not done and is not recommended: the
fuses on `Slack.exe` disable the Node inspector, the captured traffic would contain real workspace
data, and the result would be Slack's private web-client behaviour rather than a documented
interface. Designing our own Lists views and Canvas history is cheaper and cleaner.
