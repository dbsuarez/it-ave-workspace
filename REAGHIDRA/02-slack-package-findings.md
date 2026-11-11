# 02. Slack package findings

What the Slack 4.53.280.0 Windows package is made of, and the evidence that it does not contain
Lists or Canvas. See [01](01-method-and-evidence.md) for how each fact was obtained.

## Architecture

```
Slack.exe (238 MB, Chromium + Electron runtime)
└── resources/app.asar (9.9 MB)  ← the only Slack-authored JavaScript
     ├── dist/main.bundle.cjs        main process: windows, menus, login, notifications, updates
     ├── dist/preload.bundle.js      bridge injected into the web client page
     ├── dist/component-preload-entry-point.bundle.js
     ├── dist/*.html + *.bundle.js   small local windows (about box, basic-auth, net log, settings…)
     ├── dist/resources/locales/…    desktop-shell strings (menus, dialogs), not product UI
     └── node_modules/ (74 packages) incl. 3 Slack-authored: native-keymap, node-pre-gyp, slack-desktop-utils
resources/app.asar.unpacked/         8 native addons (see below)
```

**Observed:** `dist` holds 132 files, `node_modules` 678, plus `package.json` and `LICENSE`
(812 files in total, 784 packed and 28 unpacked).

The shell hosts the real application as a web page. **Observed** in `main.bundle.cjs`: handling for
`WEBAPP_LOADED`, a `webappSrcPath`, `REDUX_UPDATE_FROM_WEBAPP`, `SHOW_WEBAPP_DIALOG`,
`TOGGLE_WEBAPP_DEVTOOLS`, 22 `loadURL` calls (login, error page, component windows, native sign-in),
and the hosts `app.slack.com`, `a.slack-edge.com` / `b.slack-edge.com` (static assets), `slack.com`,
`spellcheck.slack-edge.com`, `toolbelt.tinyspeck.com`, `sentry.io`.
**Inferred:** the channel, message, Lists and Canvas screens are that web page, downloaded when the
app starts.

## Electron hardening (REA fuse reader)

| Fuse | State |
|---|---|
| RunAsNode | disabled |
| EnableCookieEncryption | enabled |
| EnableNodeOptionsEnvironmentVariable | disabled |
| EnableNodeCliInspectArguments | disabled |
| EnableEmbeddedAsarIntegrityValidation | enabled |
| OnlyLoadAppFromAsar | enabled |
| LoadBrowserProcessSpecificV8Snapshot | disabled |
| GrantFileProtocolExtraPrivileges | disabled |
| WasmTrapHandlers | enabled |

Meaning: the app cannot be run as plain Node, ignores `--inspect`, refuses a modified ASAR, and
loads app code only from `app.asar`. Static reading is possible; casual runtime tampering is not.
(Fuses do not prove the app has no other debugging switch.)

## What REA found in the JavaScript

- 457 JavaScript files parsed with no failures; 919 modules; 5,202 findings.
- Electron surface is tiny: 2 context-bridge APIs exposing 3 members; 4 IPC operations, all using
  dynamically built channel names (so not paired automatically).
- Eight integrity contradictions, all unpacked native `.node` files (signed after packing).
- Graph coverage is partial (see 01), so use it for orientation, not for absence claims.

## Where Lists and Canvas do not appear

| Term searched | In app JavaScript | In native addons | In `Slack.exe` |
|---|---|---|---|
| `slackLists`, `slack_list`, `slack-list` | 0 | 0 | 0 |
| `conversations.canvases`, `files.info`, `rich_text` | 0 | 0 | 0 |
| `canvases` | 0 | 0 | 2 (Chromium text) |
| `document_content` | 0 | 0 | 1 (Chromium source file name) |
| `canvas` (any case) | 259 | not searched | not searched (Chromium has many) |

The 259 JavaScript hits break down as follows. **Observed**: 128 in `preload.bundle.js` and 128 in
`component-preload-entry-point.bundle.js` (the same bundled library), 3 in `main.bundle.cjs`. The
identifiers in the preload bundles are `recordCanvas`, `CanvasMutation`, `ReplayCanvas`,
`getCanvasManager`, `OffscreenCanvas`, `HTMLCanvasElement.prototype.getContext`, and similar: a
session-replay/monitoring recorder that watches the browser's drawing element. **Inferred:** that is
unrelated to the Canvas document product. The three `main.bundle.cjs` hits are one constant,
`CANVAS_HANDOFF_EPIC = "canvasHandoffEpic"`, registered as a handler whose body is empty. That
suggests Canvas is only a named hook in the shell's event system, with no behaviour.

(`quip` appears 14 times, mostly inside Spanish locale strings such as "equipo". That is a
substring match, not a reference to the Quip product, though the contexts were not individually
checked.)

## Native addons

| Addon | Size | What the evidence shows |
|---|---|---|
| `slackdesktoputils.node` (Slack-authored) | 445 KB | Two exports. Imports clipboard, window hooks (`SetWindowsHookExW`, `SetWinEventHook`), `SendInput`, `GetAsyncKeyState`, GDI+ drawing, registry change notification, COM/WinRT, and Node's N-API. Operating-system and overlay helpers |
| `keymapping.node` | 155 KB | Keyboard layout mapping (package `@tinyspeck/native-keymap`) |
| `electron_native_auth.node` | 121 KB | Native sign-in |
| `file_handler_info.node` | 118 KB | File-handler lookup |
| `registry.node` | 690 KB | Windows registry access |
| `focusassist.node`, `notificationstate.node` | 133 KB, 103 KB | Do-not-disturb / focus state |
| `cf-prefs.node` | 99 KB | macOS preferences bridge (present in the Windows package) |

Roles for all but `slackdesktoputils.node` come from their package names and file names; only
`slackdesktoputils.node` was inspected in depth. None of the eight contains a Lists or Canvas term.

## Conclusion

The installed package has no Lists or Canvas implementation to replicate. The behaviour has to come
from Slack's published documentation (03, 04) and our own design (05).
