// GitStudio desktop — Electron main process.
//
// Creates the app window (contextIsolation on, nodeIntegration off, sandbox off
// so the preload can `require` the contextBridge), wires the application menu,
// and registers the DesktopHostBridge: a set of `ipcMain.handle` endpoints that
// wrap @gitstudio/git-service + @gitstudio/engine. No git logic lives here — it
// all delegates to GitBridge, which reuses the shared core verbatim.

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
} from "electron";
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { RepoStore } from "./repoStore";
import { GitBridge } from "./gitBridge";
import { GitHubBridge } from "./githubBridge";
import { initAutoUpdate } from "./autoUpdate";
import * as issuesApi from "./github/issues";
import * as prsApi from "./github/prs";
import * as actionsApi from "./github/actions";
import * as releasesApi from "./github/releases";
import * as notificationsApi from "./github/notifications";
import * as orgsApi from "./github/orgs";
import * as projectsApi from "./github/projects";
import * as gistsApi from "./github/gists";
import type {
  CommitActionResult,
  IpcChannel,
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
let repos: RepoStore;
let bridge: GitBridge;
let github: GitHubBridge;

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
    // Match the renderer's --app-bg for the chosen theme so the window frame
    // doesn't flash the wrong shade before the page paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0d1016" : "#eef1f5",
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
  handle("commit:rowStats", (shas) => bridge.rowStats(shas));
  handle("diff:files", () => bridge.diffFiles());
  handle("file:diff", (req) => bridge.fileDiff(req));
  handle("conflict:model", (path) => bridge.conflictModel(path));
  handle("blame:file", (path) => bridge.blameFile(path));
  handle("commit:action", (req) => bridge.commitAction(req));

  // Working-tree staging + commit (Changes view).
  handle("stage", (path) => bridge.stage(path));
  handle("unstage", (path) => bridge.unstage(path));
  handle("discard", (path) => bridge.discard(path));
  handle("stageAll", () => bridge.stageAll());
  handle("unstageAll", () => bridge.unstageAll());
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
  handle("sync:fetch", () => bridge.syncFetch());
  handle("sync:pull", () => bridge.syncPull());
  handle("sync:push", (opts) => bridge.syncPush(opts || undefined));

  // Branch management.
  handle("branches:list", () => bridge.branchesList());
  handle("branch:create", (req) => bridge.branchCreate(req));
  handle("branch:delete", (req) => bridge.branchDelete(req));

  // Compare (base…head).
  handle("compare:refs", (req) => bridge.compareRefs(req));
  handle("compare:fileDiff", (req) => bridge.compareFileDiff(req));

  // Code browser (GitHub-style file tree at HEAD).
  handle("repo:tree", (req) => bridge.treeList(req));
  handle("repo:file", (req) => bridge.fileText(req));

  // GitHub (PRs / Issues / Projects).
  handle("github:status", () => github.status());
  handle("github:connect", (pat) => github.connect(pat));
  handle("github:disconnect", () => github.disconnect());
  handle("github:deviceStart", () => github.deviceStart());
  handle("github:devicePoll", (req) => github.devicePoll(req));

  // Settings: git identity + local SSH keys.
  handle("git:identity", () => bridge.gitIdentity());
  handle("git:setIdentity", (req) => bridge.setGitIdentity(req));
  handle("ssh:keys", () => bridge.sshKeys());
  handle("pr:list", () => github.prList());
  handle("pr:detail", (n) => github.prDetail(n));
  handle("pr:checkout", (n) => github.prCheckout(n));
  handle("pr:merge", (req) => github.prMerge(req));
  handle("pr:commits", (n) => github.prCommits(n));
  handle("pr:conversation", (n) => github.prConversation(n));
  handle("pr:checks", (n) => github.prChecks(n));
  handle("pr:approve", (n) => github.prApprove(n));
  handle("actions:runs", () => github.actionsRuns());
  handle("issue:list", (req) => github.withRepo((c, o, r) => issuesApi.listIssues(c, o, r, req?.state ?? "open")));

  // ── Section modules: full CRUD for issues / PRs / actions / releases /
  //    notifications / orgs / projects / gists (each in src/main/github/*). ──
  // Issues.
  handle("issue:detail", (n) => github.withRepo((c, o, r) => issuesApi.getIssueDetail(c, o, r, n)));
  handle("issue:create", (req) => github.withRepo((c, o, r) => issuesApi.createIssue(c, o, r, req)));
  handle("issue:comment", (req) => github.withRepo((c, o, r) => issuesApi.commentIssue(c, o, r, req)));
  handle("issue:setState", (req) => github.withRepo((c, o, r) => issuesApi.setIssueState(c, o, r, req)));
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
  handle("release:delete", (id) => github.withRepo((c, o, r) => releasesApi.deleteRelease(c, o, r, id)));
  // Notifications (user-level).
  handle("notifications:list", (opts) => github.withClient((c) => notificationsApi.listNotifications(c, opts)));
  handle("notification:markRead", (req) => github.withClient((c) => notificationsApi.markNotificationRead(c, req.id)));
  handle("notifications:markAllRead", () => github.withClient((c) => notificationsApi.markAllNotificationsRead(c)));
  // Organizations (user-level).
  handle("orgs:list", () => github.withClient((c) => orgsApi.listOrgs(c)));
  handle("orgs:repos", (org) => github.withClient((c) => orgsApi.listOrgRepos(c, org)));
  handle("orgs:teams", (org) => github.withClient((c) => orgsApi.listOrgTeams(c, org)));
  handle("orgs:members", (org) => github.withClient((c) => orgsApi.listOrgMembers(c, org)));
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
  const state = await loadState();
  repos = new RepoStore(state.recent);
  bridge = new GitBridge(repos);
  github = new GitHubBridge(repos);
  repos.onChange((info) => {
    send("repo:changed", info);
    buildMenu();
  });

  registerIpc();
  buildMenu();
  // Dev builds show Electron's dock icon; force the GitStudio brand mark.
  try {
    app.dock?.setIcon(appIcon());
  } catch {
    /* non-macOS or icon missing — harmless */
  }
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
