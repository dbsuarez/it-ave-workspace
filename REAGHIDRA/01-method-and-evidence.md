# 01. Method and evidence

Date: 2026-11-11. Tools: REA (`rea-agents` MCP, via Claude Code), Python 3 read-only scripts,
Slack's public documentation. Host: Windows 11.

Every finding below is labelled **Observed** (read directly from the artifact), **Inferred**
(a conclusion from observations), or **Unknown**. REA evidence IDs are kept so a result can be
re-opened while the REA session retains it; the hashes make any result checkable by anyone.

## Target

| Item | Value |
|---|---|
| Product | Slack desktop for Windows (Microsoft Store / MSIX package) |
| Package | `91750D7E.Slack_4.53.280.0_x64__8she8kybcnzg4`, version 4.53.280.0 |
| Install folder | `C:\Program Files\WindowsApps\<package>\app` (readable from PowerShell, REA and Python; Git Bash is denied `cd` into it) |
| `Slack.exe` | 249,803,840 bytes (238 MB), PE x86-64, SHA-256 `31aa792e6da09c2d32f2e823cece8006a09acd436a116bea842fb1af04a49db8` |
| `resources\app.asar` | 9.9 MB, SHA-256 `4343eaaec5e49d593aae9596152dce4edd9a0f45dcf9928534d823a6e6e80041` |

## Steps, in order

| # | Step | Tool | Result |
|---|---|---|---|
| 1 | Is Slack installed, and where? | PowerShell `Get-AppxPackage` | Yes, 4.53.280.0; files readable |
| 2 | Electron hardening ("fuses") | REA `inspect_electron_fuses` on `Slack.exe` (evidence `ev_190a95af…1351`) | Run-as-Node off, inspector arguments off, embedded ASAR integrity on, load-only-from-ASAR on, cookie encryption on. **Observed** |
| 3 | Static analysis of the whole JavaScript shell | REA `analyze_javascript_application` on `app.asar` (summary evidence `ev_e4f6ad0e…3851`, parent `ev_a73a5446…c28`) | 668 relevant files, 457 JavaScript files parsed with 0 parse failures, 919 modules. **Observed** |
| 4 | Where is the product logic? | Python `01_asar_scan.py` (term counts in every packed file) | Zero Lists terms; "canvas" present only in the preload and main bundles. **Observed** |
| 5 | What is the "canvas" text? | Python `02_asar_context.py` (short windows) | Session-recording code (`recordCanvas`, `CanvasMutation`, `ReplayCanvas`, `HTMLCanvasElement` hooks) plus one empty placeholder `canvasHandoffEpic`. Not the Slack Canvas product. **Observed**, conclusion **Inferred** |
| 6 | What do the native addons do? | REA `inspect_native_exports` (`ev_a4ea2b3c…6eb6`) and `inspect_pe_imports` (`ev_184302fb…88f8`) on `slackdesktoputils.node`; Python `03_native_scan.py` on all eight addons | Operating-system integration only (clipboard, window hooks, GDI+, registry, focus/notification state). No Lists/Canvas terms. **Observed** |
| 7 | Anything Slack-specific in the 238 MB executable? | Python `03_native_scan.py`, `04_exe_context.py` | Three stray hits, all Chromium/Blink text (`Tainted canvases may not be exported`, an SVG source file name). **Observed** |
| 8 | What do Lists and Canvas actually do? | Slack public docs (web search plus page reads) | Documented in 03 and 04 |

### Why an integrity retry was needed

The first `analyze_javascript_application` call failed with `artifact_integrity_mismatch` for an
unpacked native addon: the archive's declared hash does not match the file on disk. This is the
usual result of Windows code signing being applied after the archive is written. It was retried
with `integrity_policy=record-and-continue`, which keeps those eight `.node` files marked
"observed but untrusted". No other file mismatched.

## What the results prove, and what they do not

- **Observed:** the shipped package has no Lists code and no Canvas product code in any of its
  JavaScript, native addons, or the main executable. Searches were by term (see "Limits").
- **Inferred:** Lists and Canvas are implemented by the web client that the shell loads from
  Slack's servers at runtime (the shell has `WEBAPP_LOADED` handling, a `webappSrcPath`, and loads
  `app.slack.com`). This explains the absence but was not observed by running the app.
- **Unknown:** how that downloaded web client implements either feature. It is not on this machine.

### Limits of the searches

- Term counting finds text. Code that builds names at runtime or is encrypted/minified beyond
  recognition would not match. The JavaScript is minified but not encrypted, and plain strings
  (API method names, UI labels) survive minification, so a real implementation would be expected to
  match something. None did.
- REA's JavaScript graph is **partial** by its own accounting (60,725 unresolved semantic items,
  mostly dynamic calls). That does not weaken the term search above, but it means the REA graph
  should not be used to claim "no code path exists".
- Only 4.53.280.0 was examined.

## Why Ghidra was not run

The REA/Ghidra setup on this machine works (see [`docs/REA-GHIDRA-SETUP.md`](../docs/REA-GHIDRA-SETUP.md))
and was available. It was not used because it cannot answer this question:

- Ghidra decompiles native machine code. `Slack.exe` is a Chromium/Electron build; decompiling it
  describes the browser engine, not Slack's features. A cold import of this size takes many minutes.
- The only Slack-authored native code is the eight small addons. Their imports and exports show
  operating-system integration, and none contain any Lists or Canvas term, so there is nothing for a
  decompiler to explain.
- Lists and Canvas are web-client features. Their logic is JavaScript delivered at runtime, outside
  the installed package.

If a future question genuinely needs native analysis (for example how `slackdesktoputils.node`
installs its window hooks), follow the flow in the setup document: `open_binary`, `binary_overview`,
`procedure_pseudo_code`, `close_binary`, allowing roughly 200 seconds for the first import.

## Plan gating and access

Slack's docs state that Lists are available only on paid plans, and that free workspaces cannot
create standalone canvases and are limited to one canvas tab per channel. This affects only people
**using** the features. It does not affect:

- the installed app (identical for every plan; the gating is applied by the server), or
- Slack's public documentation (open to everyone).

So the only information we are missing is information Slack does not publish and that lives in
paid-plan UI. See 05 for how the plan handles that.

## How to repeat

```powershell
powershell -ExecutionPolicy Bypass -File REAGHIDRA\scripts\rerun.ps1
```

This re-prints package hashes and re-runs the term scans. To repeat the REA steps, call
`inspect_electron_fuses` on `Slack.exe`, then `analyze_javascript_application` on `app.asar` with
`detail: "summary"` and `integrity_policy: "record-and-continue"`.
