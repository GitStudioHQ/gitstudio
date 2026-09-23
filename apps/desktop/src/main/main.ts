// GitStudio desktop — Electron main process.
//
// Creates the app window (contextIsolation on, nodeIntegration off, sandbox off
// so the preload can `require` the contextBridge), wires the application menu,
// and registers the DesktopHostBridge: a set of `ipcMain.handle` endpoints that
// wrap @gitstudio/git-service + @gitstudio/engine. No git logic lives here — it
// all delegates to GitBridge, which reuses the shared core verbatim.

import { session,
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
} from "electron";
import type { IpcMainInvokeEvent, MenuItemConstructorOptions, WebContents } from "electron";
import { AsyncLocalStorage } from "node:async_hooks";
import { join, basename, extname, dirname, resolve as resolvePath } from "node:path";
import { readFile, writeFile, mkdir, stat, readdir, rename, rmdir, rm } from "node:fs/promises";
import { redactCredentials } from "@gitstudio/host-bridge/scrub";
import { RepoStore } from "./repoStore";
import { cannotOpenNotice } from "./repoNotice";
import { GitBridge } from "./gitBridge";
import { GitHubBridge } from "./githubBridge";
import { RebaseBridge } from "./rebaseBridge";
import { AiBridge } from "./aiBridge";
import { TerminalBridge } from "./terminalBridge";
import { pickCloneDir, startClone, listGhRepos, killActiveClones } from "./cloneBridge";
import { AppSettings } from "./appSettings";
import {
  visibleRepoFolders,
  realOrResolve,
  localStatuses,
  wasLastScanTruncated,
  LocalRepoScanner,
  samePath,
  trashRefusalResolved,
} from "./localRepos";
import { claimRepos, countFolder, isUnder, relativePath } from "../shared/repoGrouping";
import { openGitHubRepo, managedReposDir } from "./ghRepoOpen";
import { initAutoUpdate } from "./autoUpdate";
import { editorsView, openEditor, revealRoot, withIcons } from "./editors";
import type { UpdateManager } from "./autoUpdate";
import { ErrorReporter } from "./errorReporter";
import { isExpectedError, reportableResultMessage } from "./expectedError";
import { RepoWatcher } from "./repoWatcher";
import * as issuesApi from "./github/issues";
import * as myWorkApi from "./github/myWork";
import * as prsApi from "./github/prs";
import * as actionsApi from "./github/actions";
import * as releasesApi from "./github/releases";
import * as notificationsApi from "./github/notifications";
import * as orgsApi from "./github/orgs";
import * as repoBrowseApi from "./github/repoBrowse";
import * as searchApi from "./github/search";
import * as projectsApi from "./github/projects";
import * as gistsApi from "./github/gists";
import type {
  CommitActionResult,
  IpcChannel,
  LocalCopy,
  RepoFolder,
  IpcEvents,
  IpcRequest,
  IpcResponse,
  RepoInfo,
} from "../shared/ipc";

// Set the product name BEFORE the app is ready so the macOS app menu, the dock
// label, and userData path all read "GitStudio" instead of "Electron" (which is
// the default for an unpackaged dev build).
app.setName("GitStudio");

let mainWindow: BrowserWindow | undefined;
/** The poll→confirm→pull update manager; set once at startup. */
let updates: UpdateManager | undefined;
let repos: RepoStore;
let appSettings: AppSettings;
const localRepos = new LocalRepoScanner();
let bridge: GitBridge;
let github: GitHubBridge;
let rebase: RebaseBridge;
let ai: AiBridge;
let terminal: TerminalBridge;
/** Filesystem watcher for the open repo; re-created whenever the repo changes. */
let repoWatcher: RepoWatcher | undefined;

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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(event, data);
  }
}

/**
 * Only ever hand http(s)/mailto URLs to the OS. The renderer routes every
 * `window.open` through here, and many of those URLs come straight from the
 * GitHub API (PR/check `details_url`, release asset `download_url`, …) — i.e.
 * attacker-influenced. `shell.openExternal` will otherwise happily launch
 * `file://`, `smb://`, and registered custom-protocol handlers.
 */
function openExternalSafely(rawUrl: string): void {
  try {
    const u = new URL(rawUrl);
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:") {
      void shell.openExternal(rawUrl);
    }
  } catch {
    // Not a parseable URL — ignore.
  }
}

/**
 * Lock a webContents down: external links open in the OS browser (allowlisted),
 * top-level navigation away from the bundled app is blocked (an XSS or a stray
 * `location =` must never be able to load a remote origin into a window whose
 * preload exposes the full IPC surface), child webviews are forbidden, and all
 * device-permission requests are denied (the app needs none).
 */
function hardenWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (url !== contents.getURL()) {
      event.preventDefault();
      openExternalSafely(url);
    }
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  // Deny every permission request EXCEPT plain clipboard writes — the blanket
  // deny made navigator.clipboard.writeText reject, so every Copy button
  // (including the GitHub device-flow confirmation code) errored instead of
  // copying. Writes only; clipboard READS stay denied.
  contents.session.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(permission === "clipboard-sanitized-write"),
  );
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 880,
    minHeight: 560,
    show: false,
    // Match the renderer's --app-bg for the chosen theme so the window frame
    // doesn't flash the wrong shade before the page paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0d1016" : "#eef1f5",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // Vertically center the traffic lights in the slim 40px topbar (macOS).
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 18, y: 13 } }
      : {}),
    title: "GitStudio",
    icon: appIcon(),
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload only touches contextBridge + ipcRenderer, both available in
      // a sandboxed preload, so we keep the renderer fully sandboxed.
      sandbox: true,
      spellcheck: false,
    },
  });

  // The integrated terminal's PTY manager streams output to this window.
  terminal = new TerminalBridge((channel, payload) =>
    mainWindow?.webContents.send(channel, payload),
  );

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    terminal?.killAll();
    // Nothing left to notify, and holding a recursive watch on a directory after
    // the window is gone is how a quit ends up waiting on the filesystem.
    repoWatcher?.dispose();
    repoWatcher = undefined;
    killActiveClones();
    mainWindow = undefined;
  });

  // External links / navigation lockdown is applied to every webContents via the
  // app-level "web-contents-created" handler registered in boot().

  await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

/** The dock/window brand mark for a theme variant (dev/window icon; electron-builder
 *  embeds the packaged icon separately). Light theme gets the light-tile mark. */
function iconPath(variant: "dark" | "light"): string {
  return join(__dirname, variant === "light" ? "../renderer/icon-light.png" : "../renderer/icon.png");
}

/** The DOCK tile for a theme variant: the same artwork on Apple's icon grid
 *  (the tile is 824/1024 of the canvas, transparent margins), so it sits at
 *  the size of every other icon in the Dock. The window icon above stays
 *  full-bleed — Windows and Linux taskbars expect that. */
function dockIconPath(variant: "dark" | "light"): string {
  return join(__dirname, variant === "light" ? "../renderer/dock-light.png" : "../renderer/dock.png");
}


/** Brand icon for the window `icon:`; electron-builder embeds the platform icon,
 *  this is the dev/window one. Tracks the OS scheme so it isn't visibly wrong. */
function appIcon(): string {
  return iconPath(nativeTheme.shouldUseDarkColors ? "dark" : "light");
}

/**
 * Swap the macOS dock icon to the given brand variant (best-effort).
 *
 * This used to return early on macOS 26 — the system renders the bundle's Icon
 * Composer icon itself, and the worry was that handing `dock.setIcon` a PNG
 * would get it framed as a smaller "legacy" icon on its own backing. The result
 * was a Settings control that did nothing: the dock never matched what the
 * selector said was picked.
 *
 * The framing concern is already answered by the artwork. `brand/margined.py`
 * puts the tile on Apple's grid (824px of a 1024 canvas, transparent margins),
 * which is exactly the geometry the legacy path expects — that script exists
 * because a full-bleed PNG rendered visibly larger than its neighbours. So the
 * swap runs everywhere now, and a picked icon is the icon you get.
 */
function setDockIcon(variant: "dark" | "light"): void {
  try {
    app.dock?.setIcon(dockIconPath(variant));
  } catch {
    /* non-macOS or missing — harmless */
  }
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
    recentSubmenu.push({ label: "No recent repositories", enabled: false });
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
          label: "Clone repository…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => send("menu:command", { command: "cloneRepo" }),
        },
        { type: "separator" },
        {
          label: "Refresh",
          // ⌘R, the chord everyone's hands already know. It used to be ⌘⇧R to
          // dodge the `reload` role, which claims ⌘R by default — but that meant
          // the most reflexive refresh gesture there is HARD-RELOADED the
          // renderer: every view rebuilt from nothing, every cache dropped, the
          // repo re-opened, and whatever you had typed gone. It looked like the
          // app had crashed and recovered.
          //
          // And ⌘⇧R was no safer: that is `forceReload`'s default, so Refresh
          // and Force Reload were bound to the SAME chord and which one fired
          // came down to menu order. Both dev roles are explicitly re-bound
          // below, so neither can reclaim a chord by default ever again.
          accelerator: "CmdOrCtrl+R",
          click: () => send("menu:command", { command: "refresh" }),
        },
        {
          label: "Close repository",
          // NOT CmdOrCtrl+W. On macOS that is the most reflexive shortcut
          // there is and it means "close this window"; here it threw you back
          // to the welcome screen with the window still open. The Window menu
          // owns ⌘W now, and closing the repo is a deliberate act.
          accelerator: "CmdOrCtrl+Shift+W",
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
        // NOT `role: "undo"`. That role means "undo some typing", and it owns
        // the ⌘Z accelerator app-wide — so with it here, undoing anything that
        // is not text is unreachable from the keyboard. The renderer takes the
        // keystroke and picks: its own stack when something is on it, the
        // text undo below it when there isn't.
        {
          label: "Undo",
          accelerator: "CmdOrCtrl+Z",
          click: () => send("menu:command", { command: "undo" }),
        },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      // The menu named "View" could not reach a single one of the app's
      // eighteen views: it was Electron's stock template verbatim, so the only
      // things a user could "view" were the zoom level and the dev tools.
      label: "View",
      submenu: [
        {
          label: "Toggle Sidebar",
          accelerator: "CmdOrCtrl+B",
          click: () => send("menu:command", { command: "toggleSidebar" }),
        },
        {
          label: "Toggle Terminal",
          accelerator: "CmdOrCtrl+`",
          click: () => send("menu:command", { command: "toggleTerminal" }),
        },
        {
          label: "Command Palette…",
          accelerator: "CmdOrCtrl+K",
          click: () => send("menu:command", { command: "palette" }),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        // Kept, but where they belong: developer tools, not "views".
        {
          label: "Developer",
          // Accelerators stated, not inherited. A `role` carries its default
          // chord even nested three levels down a submenu, which is how ⌘R came
          // to restart the app and ⌘⇧R came to mean two different things.
          submenu: [
            { role: "reload" as const, accelerator: "Alt+CmdOrCtrl+R" },
            { role: "forceReload" as const, accelerator: "Alt+CmdOrCtrl+Shift+R" },
            { role: "toggleDevTools" as const },
          ],
        },
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
          click: () => openExternalSafely("https://gitstudio.dev"),
        },
        {
          label: "Report an Issue",
          click: () =>
            openExternalSafely("https://github.com/GitStudioHQ/gitstudio/issues"),
        },
        { type: "separator" as const },
        {
          label: "Send Anonymous Crash Reports",
          type: "checkbox" as const,
          checked: ErrorReporter.current?.isEnabled() ?? true,
          click: (item) => ErrorReporter.current?.setEnabled(item.checked),
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
  // Opening a repo teaches the app where you keep repos. See
  // rememberRepoFolder: the next one you put beside it needs no introduction.
  if (info) void rememberRepoFolder(info.root);
  if (!info) {
    // In-app, not a native alert. This is the most likely first-run failure
    // (open the wrong folder) and dialogs.ts is explicit that native dialogs
    // read as jarring — an OS modal was the worst possible first impression.
    // And not "not inside a Git repository" about a repository this account
    // cannot read: git says the same sentence for both, so the notice asks
    // the filesystem which one it is (see cannotOpenNotice).
    send("app:notice", cannotOpenNotice(path));
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

// Every IPC invocation runs inside an "action" async context; the git-command
// observer reads it so the Output tab can group the commands a single user
// action executed under a human label (AsyncLocalStorage follows the awaits,
// so concurrent actions never cross-tag each other's commands).
const actionCtx = new AsyncLocalStorage<{ id: number; label: string }>();
let actionSeq = 0;

/** Human label for the action behind an IPC channel (Output-tab group title). */
function actionLabel(channel: string): string {
  const NAMES: Record<string, string> = {
    "graph:load": "Load history",
    "refs:list": "Refresh refs",
    "head:get": "Read HEAD",
    status: "Refresh status",
    "commit:details": "Inspect commit",
    "commit:rowStats": "Commit stats",
    "diff:files": "List changes",
    "file:diff": "Open diff",
    "conflict:model": "Open conflict",
    "blame:file": "Blame file",
    "commit:action": "Commit action",
    stage: "Stage",
    unstage: "Unstage",
    discard: "Discard",
    stageAll: "Stage all",
    unstageAll: "Unstage all",
    commit: "Commit",
    "stash:list": "List stashes",
    "stash:apply": "Apply stash",
    "stash:pop": "Pop stash",
    "stash:drop": "Drop stash",
    "stash:save": "Stash",
    "worktree:list": "List worktrees",
    "worktree:add": "Add worktree",
    "worktree:remove": "Remove worktree",
    "sync:status": "Check sync",
    "sync:fetch": "Fetch",
    "sync:pull": "Pull",
    "sync:push": "Push",
    "branch:push": "Push branch",
    "branches:list": "List branches",
    "ref:log": "Read ref history",
    "branch:create": "Create branch",
    "branch:delete": "Delete branch",
    "branch:pullFf": "Pull branch",
    "tag:create": "Create tag",
    "tag:delete": "Delete tag",
    "tag:push": "Push tag",
    "compare:refs": "Compare",
    "compare:fileDiff": "Compare file",
    "repo:tree": "Read tree",
    "repo:file": "Read file",
    "repo:open": "Open repository",
    "repo:openPath": "Open repository",
    "repos:local": "List local repositories",
    "repos:localStatus": "Check local repositories for changes",
    "repos:scanTruncated": "Report whether the repository scan was cut short",
    "repos:reveal": "Reveal repository",
    "repos:removeRecent": "Forget repository",
    "repos:trash": "Delete clone",
    "clone:start": "Clone",
    "pr:checkout": "Checkout PR",
    "git:identity": "Read identity",
    "git:setIdentity": "Set identity",
  };
  if (NAMES[channel]) return NAMES[channel];
  // "branch:rename" → "Branch rename" — readable even for unmapped channels.
  return channel.replace(/[:.]/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Registers a typed `ipcMain.handle` endpoint. */
function handle<C extends IpcChannel>(
  channel: C,
  fn: (payload: IpcRequest<C>, event: IpcMainInvokeEvent) => Promise<IpcResponse<C>>,
): void {
  ipcMain.handle(channel, (event, payload) =>
    actionCtx.run({ id: ++actionSeq, label: actionLabel(channel) }, async () => {
      try {
        const result = await fn(payload as IpcRequest<C>, event);
        // A handled failure carrying a message (e.g. a non-zero git command) is
        // the desktop analog of the extension's showGitError — report it too.
        //
        // `expected` is the returned-result twin of ExpectedError: some handlers
        // report "not connected to GitHub" by RETURNING ok:false rather than
        // throwing, and this branch was reporting exactly the message the
        // throwing path had just been taught to skip. The rule lives in
        // expectedError.ts so it can be tested on its own; test/
        // expectedConditions.test.ts is the census that keeps the call sites
        // honest about which of their refusals are conditions.
        const failure = reportableResultMessage(result);
        if (failure) {
          ErrorReporter.current?.captureGitError(actionLabel(channel), failure);
        }
        return result;
      } catch (err) {
        // A thrown handler is an unexpected bug — capture it, then let it
        // propagate to the renderer exactly as before.
        //
        // Unless it is an answer rather than a fault: "you have not connected
        // GitHub" is a state the user is allowed to be in, and filing it as a
        // crash produced reports for people who had simply not signed in.
        if (!isExpectedError(err)) {
          ErrorReporter.current?.captureError(`ipc:${channel}`, err);
        }
        throw err;
      }
    }),
  );
}

function registerIpc(): void {
  handle("repo:open", () => openRepoDialog());
  handle("repo:openPath", (path) => openRepoPath(path));
  handle("repo:recent", async () => repos.recentRepos());
  handle("search:repos", (req) => github.withClient((c) => searchApi.searchRepos(c, req)));
  handle("search:users", (req) => github.withClient((c) => searchApi.searchUsers(c, req)));
  handle("search:code", (req) => github.withClient((c) => searchApi.searchCode(c, req)));
  handle("repos:local", () => localCopiesWithBands());
  handle("repos:localStatus", (roots) => localStatuses(roots));
  handle("repos:scanTruncated", async () => {
    await scanLocalCopies(); // the flag describes the scan the list came from
    return wasLastScanTruncated();
  });
  handle("repos:reveal", async (root) => {
    // Only reveal something the app already lists. `showItemInFolder` on an
    // arbitrary renderer-supplied string is the one shell call here with no
    // natural bound, and every real caller passes a row from this same scan.
    // A REPOSITORY the app lists, or a FOLDER it tracks. The guard checked only
    // the first, so "Show this folder in Finder" — the control on every folder
    // band — was dead on all of them: it passed a tracked folder path, which is
    // never a repo root, and got a silent false back.
    const copies = await scanLocalCopies();
    const folders = [appSettings.effectiveCloneDir(), ...appSettings.repoFolders()];
    const known =
      copies.some((c) => samePath(c.root, root)) || folders.some((f) => samePath(f, root));
    if (!known) return false;
    shell.showItemInFolder(root);
    return true;
  });
  handle("repos:folders", () => listRepoFolders());
  handle("repos:addFolder", async () => {
    if (!mainWindow) return undefined;
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: "Track a folder of repositories",
      message: "GitStudio will list every repository inside this folder.",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: appSettings.effectiveCloneDir(),
    });
    if (picked.canceled || !picked.filePaths.length) return undefined;
    if (await appSettings.addRepoFolder(picked.filePaths[0])) localRepos.invalidate();
    return listRepoFolders();
  });
  handle("repos:addFolderPath", async (dir) => {
    if (await appSettings.addRepoFolder(dir)) localRepos.invalidate();
    return listRepoFolders();
  });
  handle("repos:removeFolder", async (dir) => {
    if (await appSettings.removeRepoFolder(dir)) localRepos.invalidate();
    return listRepoFolders();
  });
  handle("repos:removeRecent", async (root) => {
    if (repos.removeRecent(root)) {
      void saveState();
      localRepos.invalidate();
      buildMenu(); // the Recent Repositories submenu is built from this list
      send("repo:recentChanged", repos.recentRepos());
    }
    // Same shape repos:local answers with — the renderer buckets by band,
    // and an unstamped answer would empty every band on the screen.
    return localCopiesWithBands();
  });
  handle("repos:restoreRecent", async (root) => {
    // Only if it is still there: putting a path back in a list of things you
    // can open, when it cannot be opened, is not an undo.
    let exists = false;
    try {
      exists = (await stat(root)).isDirectory();
    } catch {
      exists = false;
    }
    if (exists && repos.restoreRecent(root)) {
      void saveState();
      localRepos.invalidate();
      buildMenu();
      send("repo:recentChanged", repos.recentRepos());
    }
    // Same shape repos:local answers with — the renderer buckets by band,
    // and an unstamped answer would empty every band on the screen.
    return localCopiesWithBands();
  });
  handle("repos:untrash", async ({ from, to }) => {
    try {
      // Both of these describe the Trash having moved on since the undo toast
      // was shown — a condition, not a defect, so neither is crash-reported
      // (see main/expectedError.ts). A rename that THROWS still is.
      if (await exists(to))
        return { ok: false, expected: true, message: "Something is there again — not overwriting it." };
      if (!(await exists(from)))
        return { ok: false, expected: true, message: "It is no longer in the Trash." };
      await rename(from, to);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "Couldn't put it back." };
    }
    localRepos.invalidate();
    return { ok: true };
  });
  handle("repos:deleteEmptyFolder", async (dir) => {
    // rmdir, never rm -r. The check and the delete are not atomic, but rmdir
    // itself refuses a non-empty directory, so the race ends in an error and
    // not in someone's work being deleted.
    try {
      const entries = await readdir(dir);
      // .DS_Store is Finder's, not the user's, and rmdir fails on a directory
      // holding only that. Nothing else is ever removed here: anything else
      // present means the folder is not empty and the answer is no.
      const JUNK = new Set([".DS_Store"]);
      if (entries.some((e) => !JUNK.has(e))) {
        return {
          ok: false,
          expected: true,
          message: "That folder isn't empty, so GitStudio won't delete it.",
        };
      }
      for (const junk of entries) await rm(join(dir, junk), { force: true });
      await rmdir(dir);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "Couldn't delete that folder." };
    }
    localRepos.invalidate();
    return { ok: true };
  });
  handle("repos:trash", async (root) => {
    // Deleting someone's working copy is the most destructive thing this app
    // can do, so the rule lives in ONE pure function and is enforced HERE —
    // never in the renderer, which can't be trusted to be the only caller.
    const refusal = await trashRefusalResolved(root, {
      cloneDir: appSettings.effectiveCloneDir(),
      current: repos.current()?.root,
    });
    if (refusal) return { ok: false, changed: false, expected: true, message: refusal };
    // Where it lands is not returned by trashItem, and the OS renames on a
    // name collision ("gitstudio 2"), so guessing ~/.Trash/<basename> would
    // hand undo the wrong path — and undo moving the WRONG folder back is a
    // worse bug than having no undo. Diff the folder around the call instead,
    // and offer undo only when exactly one thing appeared.
    const trash = join(app.getPath("home"), ".Trash");
    const before = await trashEntries(trash);
    try {
      await shell.trashItem(root);
    } catch (e) {
      return {
        ok: false,
        changed: false,
        expected: true,
        message: e instanceof Error ? e.message : "Couldn't move that folder to the trash.",
      };
    }
    if (repos.removeRecent(root)) void saveState();
    localRepos.invalidate();
    buildMenu();
    send("repo:recentChanged", repos.recentRepos());
    const after = await trashEntries(trash);
    const added = [...after].filter((e) => !before.has(e));
    return { ok: true, changed: true, trashed: added.length === 1 ? join(trash, added[0]) : undefined };
  });
  handle("repo:current", async () => repos.current());
  handle("repo:close", async () => {
    closeRepo();
  });

  handle("graph:load", (opts) => bridge.graphLoad(opts));
  handle("graph:reaches", (a) => bridge.graphReaches(a.sha));
  handle("refs:list", () => bridge.refsList());
  handle("refs:contains", (a) => bridge.refsContains(a.sha));
  handle("head:get", () => bridge.head());
  handle("status", () => bridge.status());
  handle("commit:details", (sha) => bridge.commitDetails(sha));
  handle("commit:rowStats", (shas) => bridge.rowStats(shas));
  handle("diff:files", () => bridge.diffFiles());
  handle("file:diff", (req) => bridge.fileDiff(req));
  handle("conflict:model", (path) => bridge.conflictModel(path));
  handle("blame:file", (path) => bridge.blameFile(path));
  handle("commit:action", (req) => bridge.commitAction(req));
  // Interactive rebase (Rebase view) — driven by the shared RebaseRunner, the
  // same module the VS Code extension uses. Continue/abort/skip are already
  // registered below (the mid-operation controls) and drive the same git state.
  handle("rebase:load", (req) => rebase.load(req ?? {}));
  handle("rebase:apply", (req) => rebase.apply(req));

  // Working-tree staging + commit (Changes view).
  handle("stage", (path) => bridge.stage(path));
  handle("unstage", (path) => bridge.unstage(path));
  handle("discard", (path) => bridge.discard(path));
  handle("stageAll", () => bridge.stageAll());
  handle("unstageAll", () => bridge.unstageAll());
  handle("hunks:list", (path) => bridge.hunksList(path));
  handle("hunks:stage", (req) => bridge.hunksStage(req));
  handle("commit", (req) => bridge.commit(req));

  // Stashes.
  handle("stash:list", () => bridge.stashList());
  handle("stash:apply", (ref) => bridge.stashApply(ref));
  handle("stash:pop", (ref) => bridge.stashPop(ref));
  handle("stash:drop", (ref) => bridge.stashDrop(ref));
  handle("stash:save", (opts) => bridge.stashSave(opts));

  // Worktrees.
  handle("worktree:list", () => bridge.worktreeList());
  handle("worktree:add", (req) => worktreeAddDialog(req));
  handle("worktree:remove", (req) => bridge.worktreeRemove(req));
  handle("worktree:open", (path) => openRepoPath(path));

  // Sync (control remote changes).
  handle("sync:status", () => bridge.syncStatus());
  handle("sync:fetch", (opts) => bridge.syncFetch(opts || undefined));
  // pull-diverged-reviewed: pull-stop-reviewed: pure forwarder. The bridge
  // answers a diverged branch with `diverged` and a pull that stopped on
  // conflicts with `stopped` (both ok:false + expected); the RENDERER asks, or
  // takes the user to Changes, and a chosen mode rides back through opts.
  handle("sync:pull", (opts) => bridge.syncPull(opts || undefined));
  // push-force-reviewed: pure forwarder — the renderer decides about force
  // and it rides through in opts.
  handle("sync:push", (opts) => bridge.syncPush(opts || undefined));
  handle("branch:push", (a) => bridge.branchPush(a.name));
  handle("branch:publish", (req) => bridge.branchPublishAs(req));

  // Branch management.
  handle("branches:list", () => bridge.branchesList());
  handle("ref:log", (req) => bridge.refLog(req));
  handle("stash:restore", (req) => bridge.stashRestore(req));
  handle("discard:snapshot", () => bridge.discardSnapshot());
  handle("discard:undo", (req) => bridge.discardUndo(req));
  handle("branch:create", (req) => bridge.branchCreate(req));
  handle("branch:delete", (req) => bridge.branchDelete(req));
  handle("branches:people", () => bridge.branchesPeople());
  handle("branch:pullFf", (req) => bridge.branchPullFf(req.name));

  // Compare (base…head).
  handle("compare:refs", (req) => bridge.compareRefs(req));
  handle("compare:fileDiff", (req) => bridge.compareFileDiff(req));

  // Code browser (GitHub-style file tree at HEAD).
  handle("repo:tree", (req) => bridge.treeList(req));
  handle("repo:file", (req) => bridge.fileText(req));
  handle("repo:headCommit", (opts) => bridge.headCommit(opts || undefined));

  // Integrated terminal (PTY) — launches in the active repo's directory.
  handle("terminal:create", async (opts) =>
    terminal.create(opts, repos.current()?.root),
  );
  handle("terminal:write", async (req) => terminal.write(req.id, req.data));
  handle("terminal:resize", async (req) => terminal.resize(req.id, req.cols, req.rows));
  handle("terminal:kill", async (req) => terminal.kill(req.id));

  // Clone / browse repos.
  handle("clone:pickDir", (req) => pickCloneDir(req?.defaultPath ?? appSettings.effectiveCloneDir()));
  handle("clone:start", async (req) => {
    const r = await startClone(req, (p) => send("clone:progress", p));
    // Cloning somewhere teaches the app where you keep repos, exactly as
    // opening one does — including when the destination was a one-off folder
    // chosen in the sheet rather than the configured clone folder.
    if (r.ok) {
      await rememberRepoFolder(r.root);
      // The scan is cached for 30 seconds, so without this the repository you
      // just cloned is missing from the list that sent you to clone it —
      // `rememberRepoFolder` only invalidates when the FOLDER is new, and
      // cloning into the folder you already use is the common case.
      localRepos.invalidate();
    }
    return r;
  });
  handle("github:repos", (req) =>
    github.withClient((c) => listGhRepos(c, req?.search)),
  );

  // GitHub (PRs / Issues / Projects).
  handle("github:status", () => github.status());
  handle("github:connect", (pat) => github.connect(pat));
  handle("github:disconnect", () => github.disconnect());
  handle("github:deviceStart", () => github.deviceStart());
  handle("github:devicePoll", (req) => github.devicePoll(req));

  // Settings: git identity + local SSH keys.
  handle("git:identity", () => bridge.gitIdentity());
  handle("git:setIdentity", (req) => bridge.setGitIdentity(req));
  handle("clipboard:write", async (text) => {
    clipboard.writeText(typeof text === "string" ? text : String(text ?? ""));
  });

  // App info + updates (poll → confirm → pull → apply).
  handle("app:info", async () => ({ version: app.getVersion(), platform: process.platform }));
  // ── Open in editor ──
  const editorsNow = (force = false) => withIcons(editorsView(appSettings.editorPrefs(), force));
  handle("editors:list", () => editorsNow());
  handle("editors:refresh", () => editorsNow(true));
  handle("editors:open", async ({ id, root }) => {
    const target = root ?? repos.current()?.root;
    if (!target) return { ok: false, expected: true, message: "Open a repository first." };
    return openEditor(id, target, appSettings.editorPrefs());
  });
  handle("editors:setShown", async ({ id, shown }) => {
    await appSettings.setEditorShown(id, shown);
    return editorsNow();
  });
  handle("editors:setDefault", async ({ id }) => {
    await appSettings.setDefaultEditor(id);
    return editorsNow();
  });
  handle("editors:addCustom", async ({ name, command }) => {
    if (!name.trim() || !command.trim()) return editorsNow();
    await appSettings.addCustomEditor(name, command);
    return editorsNow();
  });
  handle("editors:removeCustom", async ({ id }) => {
    await appSettings.removeCustomEditor(id);
    return editorsNow();
  });
  handle("editors:reveal", async (req) => {
    const target = (req && req.root) || repos.current()?.root;
    if (target) revealRoot(target);
  });
  handle("settings:get", () => Promise.resolve(appSettings.view()));
  handle("settings:update", (patch) => appSettings.update(patch));
  handle("settings:pickCloneDir", async () => {
    const r = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
      title: "Choose the default clone folder",
      defaultPath: appSettings.effectiveCloneDir(),
    });
    if (r.canceled || !r.filePaths[0]) return undefined;
    return appSettings.update({ cloneDir: r.filePaths[0] });
  });
  handle("update:check", async () =>
    updates
      ? updates.check(true)
      : { status: "disabled" as const, current: app.getVersion(), message: "Updater not ready." },
  );
  // `updates` is undefined only before boot finishes wiring it — the user has
  // pressed a button the window should not have shown yet. Not a defect worth a
  // crash report (see main/expectedError.ts).
  handle("update:download", async () =>
    updates ? updates.download() : { ok: false, expected: true, message: "Updater not ready." },
  );
  handle("update:install", async () =>
    updates ? updates.install() : { ok: false, expected: true, message: "Updater not ready." },
  );
  handle("ssh:keys", () => bridge.sshKeys());
  handle("pr:list", (req) => github.prList(req?.state ?? "open"));
  handle("pr:detail", (n) => github.prDetail(n));
  handle("pr:checkout", (n) => github.prCheckout(n));
  handle("pr:merge", (req) => github.prMerge(req));
  handle("pr:commits", (n) => github.prCommits(n));
  handle("pr:conversation", (n) => github.prConversation(n));
  handle("pr:checks", (n) => github.prChecks(n));
  handle("pr:approve", (n) => github.prApprove(n));
  handle("actions:runs", (req) => github.withRepo((c, o, r) => actionsApi.listRuns(c, o, r, req)));
  handle("issue:list", (req) => github.withRepo((c, o, r) => issuesApi.listIssues(c, o, r, req?.state ?? "open")));

  // ── Section modules: full CRUD for issues / PRs / actions / releases /
  //    notifications / orgs / projects / gists (each in src/main/github/*). ──
  // Issues.
  handle("issue:detail", (n) => github.withRepo((c, o, r) => issuesApi.getIssueDetail(c, o, r, n)));
  // Cross-repo read-only item view (notifications for OTHER repos open in-app).
  handle("github:externalItem", (req) => github.externalItem(req));
  handle("github:myWork", (req) =>
    // {scope:"all"} runs on the CLIENT alone — withRepo would refuse when no
    // repository is open or its origin is not GitHub, and the whole point of
    // the cross-repo answer is that it does not depend on what is open.
    req && req.scope === "all"
      ? github.withClient((c) => myWorkApi.myWork(c, undefined, undefined))
      : github.withRepo((c, o, r) => myWorkApi.myWork(c, o, r)),
  );
  handle("issue:create", (req) => github.withRepo((c, o, r) => issuesApi.createIssue(c, o, r, req)));
  handle("issue:comment", (req) => github.withRepo((c, o, r) => issuesApi.commentIssue(c, o, r, req)));
  handle("issue:search", (req) => github.withRepo((c, o, r) => issuesApi.searchIssues(c, o, r, req)));
  handle("issue:editComment", (req) =>
    github.withRepo((c, o, r) => issuesApi.editIssueComment(c, o, r, req)),
  );
  handle("issue:deleteComment", (id) =>
    github.withRepo((c, o, r) => issuesApi.deleteIssueComment(c, o, r, id)),
  );
  handle("issue:react", (req) => github.withRepo((c, o, r) => issuesApi.reactTo(c, o, r, req)));
  handle("issue:setState", (req) => github.withRepo((c, o, r) => issuesApi.setIssueState(c, o, r, req)));
  handle("issue:setLocked", (req) => github.withRepo((c, o, r) => issuesApi.setIssueLocked(c, o, r, req)));
  handle("issue:edit", (req) => github.withRepo((c, o, r) => issuesApi.editIssue(c, o, r, req)));
  handle("issue:labels", () => github.withRepo((c, o, r) => issuesApi.listLabels(c, o, r)));
  handle("issue:setLabels", (req) => github.withRepo((c, o, r) => issuesApi.setIssueLabels(c, o, r, req)));
  handle("issue:setAssignees", (req) => github.withRepo((c, o, r) => issuesApi.setIssueAssignees(c, o, r, req)));
  // Pull request write actions (reads/approve/checkout/merge stay on the bridge).
  handle("pr:create", (req) => github.withRepo((c, o, r) => prsApi.prCreate(c, o, r, req)));
  handle("pr:comment", (req) => github.withRepo((c, o, r) => prsApi.prComment(c, o, r, req)));
  handle("pr:review", (req) => github.withRepo((c, o, r) => prsApi.prReview(c, o, r, req)));
  handle("pr:setState", (req) => github.withRepo((c, o, r) => prsApi.prSetState(c, o, r, req)));
  handle("pr:requestReviewers", (req) => github.withRepo((c, o, r) => prsApi.prRequestReviewers(c, o, r, req)));
  handle("pr:markReady", (n) => github.withRepo((c, o, r) => prsApi.prMarkReady(c, o, r, n)));
  handle("pr:branches", () => github.withRepo((c, o, r) => prsApi.prBranches(c, o, r)));
  handle("pr:reviewers", () => github.withRepo((c, o, r) => prsApi.prReviewers(c, o, r)));
  // Actions control.
  handle("actions:runDetail", (id) => github.withRepo((c, o, r) => actionsApi.getRunDetail(c, o, r, id)));
  handle("actions:workflows", () => github.withRepo((c, o, r) => actionsApi.listWorkflows(c, o, r)));
  handle("actions:dispatchInputs", (id) => github.withRepo((c, o, r) => actionsApi.getDispatchInputs(c, o, r, id)));
  handle("actions:rerun", (id) => github.withRepo((c, o, r) => actionsApi.rerunRun(c, o, r, id)));
  handle("actions:rerunFailed", (id) => github.withRepo((c, o, r) => actionsApi.rerunFailedJobs(c, o, r, id)));
  handle("actions:cancel", (id) => github.withRepo((c, o, r) => actionsApi.cancelRun(c, o, r, id)));
  handle("actions:dispatch", (req) => github.withRepo((c, o, r) => actionsApi.dispatchWorkflow(c, o, r, req)));
  // Releases.
  handle("release:list", () => github.withRepo((c, o, r) => releasesApi.listReleases(c, o, r)));
  handle("release:detail", (id) => github.withRepo((c, o, r) => releasesApi.getRelease(c, o, r, id)));
  handle("release:tags", () => github.withRepo((c, o, r) => releasesApi.listTags(c, o, r)));
  handle("release:create", (input) => github.withRepo((c, o, r) => releasesApi.createRelease(c, o, r, input)));
  handle("release:update", (input) => github.withRepo((c, o, r) => releasesApi.updateRelease(c, o, r, input)));
  handle("release:generateNotes", (req) =>
    github.withRepo((c, o, r) => releasesApi.generateNotes(c, o, r, req)),
  );
  handle("release:delete", (id) => github.withRepo((c, o, r) => releasesApi.deleteRelease(c, o, r, id)));
  handle("release:uploadAssets", async (req) => {
    // The file dialog lives HERE (main) — the renderer has no filesystem.
    const picked = await dialog.showOpenDialog({
      title: "Attach assets to the release",
      buttonLabel: "Upload",
      properties: ["openFile", "multiSelections"],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, changed: false, message: "No files selected.", expected: true };
    }
    return github.withRepo(async (c, o, r) => {
      for (const fp of picked.filePaths) {
        const name = basename(fp);
        const data = await readFile(fp);
        const res = await releasesApi.uploadAssetData(c, o, r, req.id, name, data, assetContentType(name));
        if (!res.ok) {
          return { ...res, message: `${name}: ${res.message ?? "upload failed"}` };
        }
      }
      const n = picked.filePaths.length;
      return { ok: true, changed: false, message: `Uploaded ${n} asset${n === 1 ? "" : "s"}.` };
    });
  });
  handle("release:deleteAsset", (id) => github.withRepo((c, o, r) => releasesApi.deleteAsset(c, o, r, id)));
  // Notifications (user-level).
  handle("notifications:list", (opts) => github.withClient((c) => notificationsApi.listNotifications(c, opts)));
  // Ambient: polls on launch, so it must NOT unlock the token (that prompted for
  // the keychain password on every start). Reports 0 while still locked.
  handle("notifications:unreadCount", async () => {
    const threads = await github.withClientIfUnlocked((c) =>
      notificationsApi.listNotifications(c, { all: false, participating: false }),
    );
    return threads ? threads.filter((t) => t.unread).length : 0;
  });
  handle("notification:markRead", (req) => github.withClient((c) => notificationsApi.markNotificationRead(c, req.id)));
  handle("notifications:markAllRead", () => github.withClient((c) => notificationsApi.markAllNotificationsRead(c)));
  // Organizations (user-level).
  handle("orgs:list", () => github.withClient((c) => orgsApi.listOrgs(c)));
  handle("orgs:repos", (org) => github.withClient((c) => orgsApi.listOrgRepos(c, org)));
  handle("orgs:teams", (org) => github.withClient((c) => orgsApi.listOrgTeams(c, org)));
  handle("orgs:members", (org) => github.withClient((c) => orgsApi.listOrgMembers(c, org)));
  handle("orgs:repoDetail", (fullName) => github.withClient((c) => orgsApi.getOrgRepoDetail(c, fullName)));
  handle("ghrepo:open", (req) =>
    openGitHubRepo(
      req.fullName,
      repos,
      (p) => send("clone:progress", p),
      appSettings.effectiveCloneDir(),
      req.dest,
      req.name,
    ),
  );
  handle("ghrepo:tree", (req) =>
    github.withClient((c) => repoBrowseApi.listRepoDir(c, req.fullName, req.path, req.ref)),
  );
  handle("ghrepo:file", (req) =>
    github.withClient((c) => repoBrowseApi.readRepoFile(c, req.fullName, req.path, req.ref)),
  );
  handle("ghrepo:readme", (req) =>
    github.withClient((c) =>
      typeof req === "string"
        ? repoBrowseApi.readRepoReadme(c, req)
        : repoBrowseApi.readRepoReadme(c, req.fullName, req.ref),
    ),
  );
  handle("ghrepo:branches", (fullName) =>
    github.withClient((c) => repoBrowseApi.listRepoBranches(c, fullName)),
  );
  handle("ghrepo:paths", (req) =>
    github.withClient((c) => repoBrowseApi.listRepoPaths(c, req.fullName, req.ref)),
  );
  handle("ghrepo:commits", (req) =>
    github.withClient((c) => repoBrowseApi.listRepoCommits(c, req.fullName, req.ref)),
  );
  handle("orgs:teamMembers", (req) => github.withClient((c) => orgsApi.listTeamMembers(c, req.org, req.slug)));
  handle("github:userInfo", (login) => github.withClient((c) => orgsApi.getUserInfo(c, login)));
  handle("users:repos", (login) => github.withClient((c) => orgsApi.listUserRepos(c, login)));
  handle("users:orgs", (login) => github.withClient((c) => orgsApi.listUserOrgs(c, login)));
  // Projects v2.
  handle("project:list", () => github.withRepo((c, o, r) => projectsApi.listProjects(c, o, r)));
  handle("project:board", (id) => github.withRepo((c, o, r) => projectsApi.getProjectBoard(c, o, r, id)));
  handle("project:moveItem", (req) => github.withRepo((c, o, r) => projectsApi.moveProjectItem(c, o, r, req)));
  handle("project:addItem", (req) => github.withRepo((c, o, r) => projectsApi.addProjectItem(c, o, r, req)));
  // Gists (user-level).
  handle("gist:list", () => github.withClient((c) => gistsApi.listGists(c)));
  handle("gist:detail", (id) => github.withClient((c) => gistsApi.getGist(c, id)));
  handle("gist:create", (req) => github.withClient((c) => gistsApi.createGist(c, req)));
  handle("gist:update", (req) => github.withClient((c) => gistsApi.updateGist(c, req)));
  handle("gist:delete", (id) => github.withClient((c) => gistsApi.deleteGist(c, id)));

  // ── AI / Agent / MCP (optional; degrades to "no connection" when unset) ──
  handle("ai:settings", () => ai.getSettings());
  handle("ai:catalog", async () => ai.catalog());
  handle("ai:addConnection", (req) => ai.addConnection(req.preset));
  handle("ai:updateConnection", (patch) => ai.updateConnection(patch));
  handle("ai:removeConnection", (req) => ai.removeConnection(req.id));
  handle("ai:setDefault", (req) => ai.setDefault(req.id));
  handle("ai:setKey", (req) => ai.setKey(req.id, req.key));
  handle("ai:setAgentConfig", (patch) => ai.setAgentConfig(patch));
  handle("ai:models", (req) => ai.listModels(req ? req.connectionId : undefined));
  handle("ai:test", (req) => ai.test(req.id));
  handle("ai:task", (req) => ai.runTask(req.requestId, req.task, req.input));
  handle("ai:agentRun", (req) => ai.runAgentTask(req));
  handle("ai:agentConfirm", async (ans) => {
    ai.confirmAnswer(ans);
  });
  handle("ai:cancel", async (req) => {
    ai.cancel(req.requestId);
  });
  handle("ai:mcpInfo", async () => ai.mcpInfo());
  handle("ai:mcpInstall", async (req) => ai.mcpInstall(req));
  // Assistant chats (persisted sessions; warm CLI processes live in main).
  handle("ai:chatList", () => ai.chatList());
  handle("ai:chatCurrent", () => ai.chatCurrent());
  handle("ai:chatGet", (req) => ai.chatGet(req.id));
  handle("ai:chatNew", (req) => ai.chatNew(req?.setCurrent !== false));
  handle("ai:chatSetCurrent", async (req) => {
    await ai.chatSetCurrent(req.id);
  });
  handle("ai:chatSend", (req) => ai.chatSend(req));
  handle("ai:chatDelete", async (req) => {
    await ai.chatDelete(req.id);
  });

  // ── Local-git depth (engine-backed via GitBridge) ──
  handle("conflict:resolve", (req) => bridge.conflictResolve(req));
  handle("conflict:takeSide", (req) => bridge.conflictTakeSide(req));
  handle("conflict:list", () => bridge.conflictList());
  handle("stage:lines", (req) => bridge.stageLines(req));
  handle("blocks:set", (req) => bridge.blocksSet(req));
  handle("branch:merge", (req) => bridge.branchMerge(req));
  handle("branch:rebase", (req) => bridge.branchRebase(req));
  handle("branch:rename", (req) => bridge.branchRename(req));
  handle("branch:setUpstream", (req) => bridge.branchSetUpstream(req));
  handle("branch:deleteRemote", (req) => bridge.branchDeleteRemote(req));
  handle("commit:branches", (sha) => bridge.commitBranches(sha));
  handle("git:opState", () => bridge.opState());
  handle("merge:abort", () => bridge.mergeAbort());
  handle("merge:continue", () => bridge.mergeContinue());
  handle("cherryPick:abort", () => bridge.cherryPickAbort());
  handle("cherryPick:continue", () => bridge.cherryPickContinue());
  handle("revert:abort", () => bridge.revertAbort());
  handle("revert:continue", () => bridge.revertContinue());
  handle("cherryPick:skip", () => bridge.cherryPickSkip());
  handle("revert:skip", () => bridge.revertSkip());
  handle("am:abort", () => bridge.amAbort());
  handle("am:skip", () => bridge.amSkip());
  handle("am:continue", () => bridge.amContinue());
  handle("rebase:abort", () => bridge.rebaseAbort());
  handle("rebase:continue", () => bridge.rebaseContinue());
  handle("rebase:skip", () => bridge.rebaseSkip());
  handle("tag:create", (req) => bridge.tagCreate(req));
  handle("tag:delete", (name) => bridge.tagDelete(name));
  handle("tag:restore", (req) => bridge.tagRestore(req));
  handle("branch:restoreRemote", (req) => bridge.branchRestoreRemote(req));
  handle("tag:push", (req) => bridge.tagPush(req));

  // ── GitHub depth (PR review / issues / actions / search / repo admin) ──
  handle("pr:fileDiff", (req) => github.withRepo((c, o, r) => prsApi.fileDiff(c, o, r, req)));
  handle("pr:reviewThreads", (n) => github.withRepo((c, o, r) => prsApi.reviewThreads(c, o, r, n)));
  handle("pr:addReviewComment", (req) => github.withRepo((c, o, r) => prsApi.addReviewComment(c, o, r, req)));
  handle("pr:replyThread", (req) => github.withRepo((c, o, r) => prsApi.replyThread(c, o, r, req)));
  handle("pr:resolveThread", (req) => github.withRepo((c, o, r) => prsApi.resolveThread(c, o, r, req)));
  handle("pr:edit", (req) => github.withRepo((c, o, r) => prsApi.edit(c, o, r, req)));
  handle("pr:setLabels", (req) => github.withRepo((c, o, r) => prsApi.setLabels(c, o, r, req)));
  handle("pr:setAssignees", (req) => github.withRepo((c, o, r) => prsApi.setAssignees(c, o, r, req)));
  handle("pr:updateBranch", (n) => github.withRepo((c, o, r) => prsApi.updateBranch(c, o, r, n)));
  handle("pr:labels", () => github.withRepo((c, o, r) => prsApi.labels(c, o, r)));
  handle("pr:prefill", () => github.withRepo((c, o, r) => prsApi.prefill(c, o, r)));
  handle("issue:milestones", () => github.withRepo((c, o, r) => issuesApi.milestones(c, o, r)));
  handle("issue:setMilestone", (req) => github.withRepo((c, o, r) => issuesApi.setMilestone(c, o, r, req)));
  handle("labels:list", () => github.withRepo((c, o, r) => issuesApi.listLabels(c, o, r)));
  handle("label:create", (req) => github.withRepo((c, o, r) => issuesApi.createLabel(c, o, r, req)));
  handle("label:update", (req) => github.withRepo((c, o, r) => issuesApi.updateLabel(c, o, r, req)));
  handle("label:delete", (name) => github.withRepo((c, o, r) => issuesApi.deleteLabel(c, o, r, name)));
  handle("actions:jobLog", (req) => github.withRepo((c, o, r) => actionsApi.jobLog(c, o, r, req)));
  handle("actions:jobLogChunk", (req) => github.withRepo((c, o, r) => actionsApi.jobLogChunk(c, o, r, req)));
  handle("actions:saveLog", (req) => github.withRepo((c, o, r) => actionsApi.saveLog(c, o, r, req)));
  handle("actions:artifacts", (id) => github.withRepo((c, o, r) => actionsApi.artifacts(c, o, r, id)));
  handle("actions:downloadArtifact", (req) => github.withRepo((c, o, r) => actionsApi.downloadArtifact(c, o, r, req)));
  handle("actions:secrets", () => github.withRepo((c, o, r) => actionsApi.secrets(c, o, r)));
  handle("actions:setSecret", (req) => github.withRepo((c, o, r) => actionsApi.setSecret(c, o, r, req)));
  handle("actions:deleteSecret", (name) => github.withRepo((c, o, r) => actionsApi.deleteSecret(c, o, r, name)));
  handle("actions:variables", () => github.withRepo((c, o, r) => actionsApi.variables(c, o, r)));
  handle("actions:setVariable", (req) => github.withRepo((c, o, r) => actionsApi.setVariable(c, o, r, req)));
  handle("actions:deleteVariable", (name) => github.withRepo((c, o, r) => actionsApi.deleteVariable(c, o, r, name)));

  // Appearance: the renderer owns the in-app theme override, so it tells us
  // which brand variant the dock should wear.
  handle("appearance:dockIcon", async (payload) => {
    setDockIcon(payload.variant);
  });
}

/** Picks (or creates) a folder, then adds a worktree there for `ref`. */
async function worktreeAddDialog(req: {
  ref: string;
  newBranch?: boolean;
}): Promise<CommitActionResult> {
  if (!mainWindow) {
    return { ok: false, changed: false, message: "No window." };
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `New worktree for ${req.ref}`,
    properties: ["openDirectory", "createDirectory"],
    buttonLabel: "Create Worktree Here",
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, changed: false };
  }
  return bridge.worktreeAdd(result.filePaths[0], req.ref, req.newBranch);
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  // Arm anonymous crash reporting first, so failures during startup are caught.
  // On by default; honors the persisted opt-out and never throws — see
  // errorReporter.ts and PRIVACY.md.
  await ErrorReporter.init().catch(() => undefined);

  // Belt-and-suspenders navigation lockdown: any webContents that ever gets
  // created (not just the main window) inherits the same hardening.
  app.on("web-contents-created", (_e, contents) => hardenWebContents(contents));

  const state = await loadState();
  repos = new RepoStore(state.recent);
  appSettings = await AppSettings.load(app.getPath("userData"), {
    defaultCloneDir: managedReposDir(),
    home: app.getPath("home"),
  });
  bridge = new GitBridge(repos, {
    // The graph's branch filter (issue #30), remembered per repository.
    get: (root) => appSettings.graphRefFilter(root),
    set: (root, refs) => appSettings.setGraphRefFilter(root, refs),
  });
  github = new GitHubBridge(repos);
  // Authenticate ATTACHMENT images from the renderer. A private repository's
  // issue screenshots live at github.com/user-attachments/…, which answers a
  // 302-to-S3 only for an authenticated request — and an <img> tag sends no
  // headers. The hook injects the token for EXACTLY that path and nothing
  // else: the S3 hop has its own signed URL (and AWS rejects a request
  // carrying both a signature and an Authorization header), and Chromium
  // re-runs this filter per hop, so the token never travels past github.com.
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ["https://github.com/user-attachments/*"] },
    (details, callback) => {
      const token = github.peekToken();
      if (token) {
        details.requestHeaders["Authorization"] = `Bearer ${token}`;
      }
      callback({ requestHeaders: details.requestHeaders });
    },
  );
  rebase = new RebaseBridge(repos);
  ai = new AiBridge(repos, send);
  repos.onChange((info) => {
    send("repo:changed", info);
    buildMenu();
    // Re-point the filesystem watcher at whatever is open now. Closing a repo
    // (info === undefined) leaves no watcher, which also stops us holding a
    // handle on a directory the user may be about to delete or unmount.
    repoWatcher?.dispose();
    repoWatcher = undefined;
    const root = repos?.getContext()?.root;
    if (root) {
      repoWatcher = new RepoWatcher(root, (info) => send("repo:filesChanged", info));
    }
  });
  // Stream every git command the open repo runs to the renderer's Output tab.
  let gitLogId = 0;
  repos.onGitRun = (e) => {
    const action = actionCtx.getStore();
    // The Output tab is a surface the user reads, copies and pastes into bug
    // reports, and `git remote add origin https://user:ghp_…@github.com/org/repo`
    // puts a token straight into argv. Only the credential is removed — the
    // command has to stay legible to be worth showing at all.
    const args = e.args.map(redactCredentials);
    send("git:log", {
      id: ++gitLogId,
      args,
      command: `git ${args.join(" ")}`,
      durationMs: e.durationMs,
      exitCode: e.exitCode,
      failed: e.failed,
      ...(e.stderr ? { stderr: redactCredentials(e.stderr) } : {}),
      ...(action ? { actionId: action.id, action: action.label } : {}),
      at: Date.now(),
    });
  };

  registerIpc();
  buildMenu();
  // Dev builds show Electron's dock icon; force the GitStudio brand mark. Pick a
  // sensible initial variant from the OS scheme so it doesn't flash the wrong
  // tile before the renderer reports its (possibly overridden) theme.
  setDockIcon(nativeTheme.shouldUseDarkColors ? "dark" : "light");
  await createWindow();
  updates = initAutoUpdate({ isDev: !app.isPackaged, send });

  // Re-open the last repo, if any, so the window lands on real history.
  if (state.current) {
    await repos.open(state.current).catch(() => undefined);
    buildMenu();
  }
}

// A single git call or GitHub request must never take the whole app down. Log
// and keep running — the renderer surfaces user-facing failures itself.
process.on("uncaughtException", (err) => {
  // eslint-disable-next-line no-console
  console.error("GitStudio main: uncaught exception:", err);
  ErrorReporter.current?.captureError("uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("GitStudio main: unhandled rejection:", reason);
  ErrorReporter.current?.captureError("unhandledRejection", reason);
});

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
  ai?.dispose();
  repos?.dispose();
});

/** MIME type for a release-asset upload, from the file extension. GitHub only
 *  uses it for the download response's Content-Type — octet-stream is fine. */
function assetContentType(name: string): string {
  switch (extname(name).toLowerCase()) {
    case ".dmg": return "application/x-apple-diskimage";
    case ".zip": case ".vsix": case ".nupkg": return "application/zip";
    case ".gz": case ".tgz": return "application/gzip";
    case ".txt": case ".md": return "text/plain";
    case ".json": return "application/json";
    default: return "application/octet-stream";
  }
}

/** The Settings → Repositories manager's list: the clone folder ∪ recents. */
function scanLocalCopies(): Promise<LocalCopy[]> {
  return localRepos.scan({
    cloneDir: appSettings.effectiveCloneDir(),
    folders: appSettings.repoFolders(),
    recents: repos.recentRepos().map((r) => r.root),
    current: repos.current()?.root,
  });
}

/**
 * The scan, with each copy told where it renders.
 *
 * The renderer used to work this out itself, from the two payloads, with string
 * arithmetic on `dirname` — which matched only direct children, so nineteen of
 * this machine's twenty-seven repositories fell through into a heading reading
 * "Opened from elsewhere". It cannot do better on its own: it has no realpath,
 * so a tracked folder reached through a symlink contains nothing as far as it
 * can tell. Decided here, once, and shipped.
 */
async function localCopiesWithBands(): Promise<LocalCopy[]> {
  const copies = await scanLocalCopies();
  const dirs = [appSettings.effectiveCloneDir(), ...appSettings.repoFolders()];
  const reals = await Promise.all(dirs.map((d) => realOrResolve(d)));
  const bandOf = new Map(reals.map((r, i) => [r, dirs[i]]));
  const claims = claimRepos(reals, copies.map((c) => c.root));
  return copies.map((c) => {
    const claim = claimFor(c.root, claims, bandOf);
    return claim ? { ...c, band: claim.band, group: claim.group } : c;
  });
}

/**
 * Every folder scanned for repositories, with what is in it.
 *
 * The clone folder leads and cannot be removed — it is where clones land, so
 * untracking it would mean the app could not see what it had just written.
 */
/** Does this path exist? */
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** The names in ~/.Trash right now, or an empty set if it can't be read
 *  (another platform, or a sandbox). An empty set simply means no undo. */
async function trashEntries(dir: string): Promise<Set<string>> {
  try {
    return new Set(await readdir(dir));
  } catch {
    return new Set();
  }
}

async function listRepoFolders(): Promise<RepoFolder[]> {
  const home = app.getPath("home");
  const show = (p: string): string => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);
  const cloneDir = appSettings.effectiveCloneDir();
  const dirs = [cloneDir, ...appSettings.repoFolders()];
  const copies = await scanLocalCopies();

  // Real paths on both sides. A folder tracked through a symlink contains
  // nothing at all if the comparison is made on the path as typed — and
  // scanLocalCopies already hands back realpath'd roots, so only this side was
  // missing. `realOrResolve` falls back for a folder that is not there.
  const reals = await Promise.all(dirs.map((d) => realOrResolve(d)));

  // ONE pass decides where every repository renders, and the counts are read
  // off that same pass. The head's number and the rows under it can then not
  // disagree, which the previous comment claimed and the arithmetic did not
  // deliver: it counted direct children only, so ~/Developer said "6" while
  // standing over twenty-seven.
  const claims = claimRepos(reals, copies.map((c) => c.root));
  const bandOf = new Map(reals.map((r, i) => [r, dirs[i]]));

  const rows = await Promise.all(
    dirs.map(async (path, i) => {
      const real = reals[i];
      let missing = false;
      try {
        missing = !(await stat(path)).isDirectory();
      } catch {
        missing = true;
      }
      // Worktrees keep their claims (they render, in their band, labeled) but
      // the LABEL count is of repositories, and a worktree is a checkout of
      // one — while containedCount guards DELETION, and a folder holding only
      // worktrees is emphatically not empty (trashing it eats live checkouts).
      const repoOnly = countFolder(
        real,
        copies.filter((c) => !c.worktreeOf).map((c) => c.root),
        claims,
      );
      const everything = countFolder(real, copies.map((c) => c.root), claims);
      // A tracked folder inside another tracked folder renders as a GROUP in
      // that one's band, in the place its path puts it, rather than as a band
      // of its own torn out of the alphabetical run.
      const outer = reals.find((r) => r !== real && isUnder(r, real));
      return {
        path,
        display: show(path),
        real,
        isCloneDir: resolvePath(path) === resolvePath(cloneDir),
        isDefaultCloneDir:
          resolvePath(path) === resolvePath(cloneDir) && appSettings.view().cloneDirIsDefault,
        repoCount: repoOnly.direct,
        containedCount: repoOnly.contained,
        containedAnyCount: everything.contained,
        missing,
        ...(outer
          ? { nestedIn: bandOf.get(outer) ?? outer, group: relativePath(outer, real) }
          : {}),
      };
    }),
  );
  return visibleRepoFolders(rows);
}

/** The claim for one repository, in the terms the renderer draws with. */
function claimFor(root: string, claims: ReturnType<typeof claimRepos>, bandOf: Map<string, string>):
  | { band: string; group: string }
  | undefined {
  const c = claims.get(root);
  if (!c) return undefined;
  return { band: bandOf.get(c.band) ?? c.band, group: c.group };
}

/**
 * Remember the folder a repository was found in.
 *
 * The point is that you should not have to tell GitStudio about a repo twice.
 * Clone something into ~/work and the app knows about ~/work from then on, so
 * the next repo you clone there by hand — or with the CLI, or by unzipping
 * something — is simply THERE the next time you look, without ever having
 * opened it here.
 *
 * The parent, not the repo: a repo root is one repository, and its parent is
 * where you keep repositories.
 */
async function rememberRepoFolder(root: string | undefined): Promise<void> {
  if (!root) return;
  const parent = dirname(root);
  // Never the home directory itself. Scanning it would enumerate every folder
  // in it on every listing, and "I keep my repos in ~" is a claim about one
  // repo, not about the folder.
  if (!parent || resolvePath(parent) === resolvePath(app.getPath("home"))) return;
  try {
    if (await appSettings.addRepoFolder(parent)) localRepos.invalidate();
  } catch {
    /* best-effort: a folder we failed to remember is one you can still add */
  }
}
