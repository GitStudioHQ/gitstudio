# GitStudio Desktop (reserved)

The native cross-platform desktop app (macOS / Windows / Linux) is built **last**,
after the VS Code/Cursor extension and all pillars are verified (milestone **M13**).

It reuses the shared core verbatim:

- `@gitstudio/engine` — pure diff/merge/graph/blame/rebase/staging logic
- `@gitstudio/git-service` — the spawned-git-CLI data layer (runs unchanged in Electron's Node main process)
- `@gitstudio/webview-ui` — the same Lit + Monaco UI, rendered in a desktop window
- `@gitstudio/host-bridge` — the typed protocol; desktop implements `DesktopHostBridge` (IPC) + a CLI-backed `HostGitAdapter`

Planned shell: **Electron** (maximum reuse — the Node git-service and the web UI
drop in directly), packaged with electron-builder into `.dmg` / `.exe` / `.AppImage`
on a CI OS matrix, released under `app-v*` tags. Nothing here yet.
