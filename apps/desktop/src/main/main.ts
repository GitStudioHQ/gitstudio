// GitStudio desktop — Electron main process.
//
// Creates the app window (contextIsolation on, nodeIntegration off, sandbox off
// so the preload can `require` the contextBridge), wires the application menu,
// and registers the DesktopHostBridge: a set of `ipcMain.handle` endpoints that
// wrap @gitstudio/git-service + @gitstudio/engine. No git logic lives here — it
// all delegates to GitBridge, which reuses the shared core verbatim.

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { RepoStore } from "./repoStore";
import { GitBridge } from "./gitBridge";
import { initAutoUpdate } from "./autoUpdate";
import type {
  IpcChannel,
  IpcEvents,
  IpcRequest,
  IpcResponse,
  RepoInfo,
} from "../shared/ipc";

let mainWindow: BrowserWindow | undefined;
let repos: RepoStore;
let bridge: GitBridge;

/** Where the recent-repos list is persisted between sessions. */
function statePath(): string {
  return join(app.getPath("userData"), "gitstudio-state.json");
}

async function loadState(): Promise<{ recent: string[]; current?: string }> {
  try {
    const raw = await readFile(statePath(), "utf8");
    const parsed = JSON.parse(raw) as { recent?: string[]; current?: string };
    return { recent: parsed.recent ?? [], current: parsed.current };
  } catch {
    return { recent: [] };
  }
}

async function saveState(): Promise<void> {
  try {
    await mkdir(app.getPath("userData"), { recursive: true });
    await writeFile(statePath(), JSON.stringify(repos.serialize(), null, 2));
  } catch {
    // Persistence is best-effort; never block on it.
  }
}

function send<E extends keyof IpcEvents>(event: E, data: IpcEvents[E]): void {
  mainWindow?.webContents.send(event, data);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 560,
    show: false,
    backgroundColor: "#11141a",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    title: "GitStudio",
    icon: appIcon(),
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => (mainWindow = undefined));

  // Keep external links out of the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

/** Brand icon; electron-builder embeds the platform icon, this is the dev/window one. */
function appIcon(): string {
  return join(__dirname, "../renderer/icon.png");
}

// ── Menu ─────────────────────────────────────────────────────────────────────

function buildMenu(): void {
  const isMac = process.platform === "darwin";

  const recentSubmenu: MenuItemConstructorOptions[] = repos
    .recentRepos()
    .map((r) => ({
      label: r.name,
      sublabel: r.root,
      click: () => void openRepoPath(r.root),
    }));
  if (recentSubmenu.length === 0) {
    recentSubmenu.push({ label: "No Recent Repositories", enabled: false });
  }

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "Repo",
      submenu: [
        {
          label: "Open Repository…",
          accelerator: "CmdOrCtrl+O",
          click: () => void openRepoDialog(),
        },
        { label: "Open Recent", submenu: recentSubmenu },
        { type: "separator" },
        {
          label: "Refresh",
          accelerator: "CmdOrCtrl+R",
          click: () => send("menu:command", { command: "refresh" }),
        },
        {
          label: "Close Repository",
          accelerator: "CmdOrCtrl+W",
          click: () => closeRepo(),
        },
        ...(isMac
          ? []
          : [
              { type: "separator" as const },
              { role: "quit" as const },
            ]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [
              { type: "separator" as const },
              { role: "front" as const },
            ]
          : [{ role: "close" as const }]),
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "GitStudio Website",
          click: () => void shell.openExternal("https://gitstudio.dev"),
        },
        {
          label: "Report an Issue",
          click: () =>
            void shell.openExternal(
              "https://github.com/GitStudioHQ/gitstudio/issues",
            ),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Repo lifecycle ───────────────────────────────────────────────────────────

async function openRepoDialog(): Promise<RepoInfo | undefined> {
  if (!mainWindow) {
    return undefined;
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Open Git Repository",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return undefined;
  }
  return openRepoPath(result.filePaths[0]);
}

async function openRepoPath(path: string): Promise<RepoInfo | undefined> {
  const info = await repos.open(path);
  if (!info && mainWindow) {
    await dialog.showMessageBox(mainWindow, {
      type: "warning",
      message: "Not a Git repository",
      detail: `${path} is not inside a Git repository.`,
    });
  }
  buildMenu();
  void saveState();
  return info;
}

function closeRepo(): void {
  repos.close();
  buildMenu();
  void saveState();
}

// ── IPC registration ─────────────────────────────────────────────────────────

/** Registers a typed `ipcMain.handle` endpoint. */
function handle<C extends IpcChannel>(
  channel: C,
  fn: (payload: IpcRequest<C>, event: IpcMainInvokeEvent) => Promise<IpcResponse<C>>,
): void {
  ipcMain.handle(channel, (event, payload) =>
    fn(payload as IpcRequest<C>, event),
  );
}

function registerIpc(): void {
  handle("repo:open", () => openRepoDialog());
  handle("repo:openPath", (path) => openRepoPath(path));
  handle("repo:recent", async () => repos.recentRepos());
  handle("repo:current", async () => repos.current());
  handle("repo:close", async () => {
    closeRepo();
  });

  handle("graph:load", (opts) => bridge.graphLoad(opts));
  handle("refs:list", () => bridge.refsList());
  handle("head:get", () => bridge.head());
  handle("status", () => bridge.status());
  handle("commit:details", (sha) => bridge.commitDetails(sha));
  handle("diff:files", () => bridge.diffFiles());
  handle("file:diff", (req) => bridge.fileDiff(req));
  handle("conflict:model", (path) => bridge.conflictModel(path));
  handle("blame:file", (path) => bridge.blameFile(path));
  handle("commit:action", (req) => bridge.commitAction(req));
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  const state = await loadState();
  repos = new RepoStore(state.recent);
  bridge = new GitBridge(repos);
  repos.onChange((info) => {
    send("repo:changed", info);
    buildMenu();
  });

  registerIpc();
  buildMenu();
  await createWindow();
  initAutoUpdate({ isDev: !app.isPackaged });

  // Re-open the last repo, if any, so the window lands on real history.
  if (state.current) {
    await repos.open(state.current).catch(() => undefined);
    buildMenu();
  }
}

app.whenReady().then(boot).catch((err) => {
  // eslint-disable-next-line no-console
  console.error("GitStudio failed to start:", err);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on("before-quit", () => {
  void saveState();
  repos?.dispose();
});
