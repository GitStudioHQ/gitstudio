# GitStudio Desktop (Electron)

The native cross-platform desktop app (macOS / Windows / Linux), milestone **M13**.
It is a **reuse** of the proven shared core, not a rewrite:

- `@gitstudio/git-service` runs **unchanged** in Electron's Node main process
  (`GitContext`, the streaming log/ref/blame providers, `NodeGitAdapter` for repo
  discovery via `rev-parse --show-toplevel`).
- `@gitstudio/engine` (pure) lays out the commit graph (`computeGraphLayout`) and
  builds the diff/merge models.
- `@gitstudio/host-bridge` carries the protocol; the WireRow assembly is the
  shared `graphWire.buildWireRows` — the same code the VS Code graph panel uses.
- `@gitstudio/webview-ui` renders in the renderer: the `<gitstudio-graph>` Lit
  element, the Monaco `DiffView` (2-pane) and `MergeView` (3-pane), the theme
  bridge, and the JetBrains diff CSS — all **unmodified**.

## Architecture

| Process      | File                             | Role                                                                      |
| ------------ | -------------------------------- | ------------------------------------------------------------------------- |
| **main**     | `src/main/main.ts`               | `BrowserWindow`, app menu, `ipcMain.handle` endpoints (DesktopHostBridge) |
|              | `src/main/gitBridge.ts`          | wraps git-service + engine: graph paging, details, diff, status, conflicts, actions |
|              | `src/main/repoStore.ts`          | caches the open `GitContext`, recent repos                                |
| **preload**  | `src/preload/preload.ts`         | `contextBridge.exposeInMainWorld("gitstudio", …)` — typed `invoke`/`on`   |
| **renderer** | `src/renderer/renderer.ts`       | the app shell: titlebar, sidebar, graph, commit details, diff/merge       |
|              | `src/renderer/graphMount.ts`     | mounts `<gitstudio-graph>`, adapts the graph protocol to IPC              |
|              | `src/renderer/diffPanel.ts`      | mounts the shared `DiffView` / `MergeView`                                |
|              | `src/renderer/desktopTheme.ts`   | supplies the `--vscode-*` tokens + `vscode-dark/light` body class         |
| **shared**   | `src/shared/ipc.ts`              | the type-only IPC contract                                                |
|              | `src/shared/graphAdapterCore.ts` | pure page→graph-message translation (unit-tested)                         |

## Develop

```bash
npm run build --workspace apps/desktop    # build the three bundles + monaco worker
npm run dev   --workspace apps/desktop     # build + launch Electron
npm run check-types --workspace apps/desktop
npm test      --workspace apps/desktop
```

`electron` is marked external in `esbuild.js`, so the bundles build without the
Electron binary installed.

## Package

```bash
npm run package --workspace apps/desktop   # electron-builder --dir (host OS smoke)
npm run dist    --workspace apps/desktop    # full installers for the host OS
```

Config: `electron-builder.yml` (appId `dev.gitstudio.desktop`, productName
"GitStudio"; mac `dmg`, win `nsis`, linux `AppImage`; icon from
`brand/gitstudio-icon-512.png` via `build/icon.png`). CI builds all three on a
macOS/Windows/Ubuntu matrix on `app-v*` tags
(`.github/workflows/release-desktop.yml`); signing/publish steps skip cleanly
when their secrets are absent.

## Privacy

No accounts, no usage tracking. During the beta the app sends **anonymous,
scrubbed crash reports** (on by default; toggle via **Help → Send Anonymous
Crash Reports**) to the same collector as the extension. Details in
[PRIVACY.md](PRIVACY.md).
