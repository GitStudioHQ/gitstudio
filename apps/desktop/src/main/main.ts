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
import type { IpcMainInvokeEvent, MenuItemConstructorOptions, WebContents } from "electron";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { RepoStore } from "./repoStore";
import { GitBridge } from "./gitBridge";
import { GitHubBridge } from "./githubBridge";
import { AiBridge } from "./aiBridge";
import { TerminalBridge } from "./terminalBridge";
import { pickCloneDir, startClone, listGhRepos, killActiveClones } from "./cloneBridge";
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
let ai: AiBridge;
let terminal: TerminalBridge;

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
  contents.session.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
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
    killActiveClones();
    mainWindow = undefined;
  });

  // External links / navigation lockdown is applied to every webContents via the
  // app-level "web-contents-created" handler registered in boot().

  await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

/**
 * The dock/window mark for an appearance.
 *
 * macOS cannot carry light/dark variants inside an `.icns`, so an Electron app
 * has to adapt the dock icon itself (`app.dock.setIcon`) — which only works if
 * BOTH tiles are properly designed. The light tile used to be the dark mark's
 * artwork dropped onto a pale background unchanged: its light-violet lanes and
 * near-white node cores disappeared, and the nodes that straddle the cube's
 * edge simply vanished. It is now re-tuned (deep brand-violet lanes and rings,
 * white cores) so it reads on the pale tile.
 *
 * Both files are the macOS-padded variant (824px art inset in a 1024 canvas per
 * Apple's icon grid) — a full-bleed square gets scaled edge-to-edge into the
 * dock slot and renders visibly bigger than every neighbouring app.
 */
function iconPath(variant: "dark" | "light"): string {
  return join(
    __dirname,
    variant === "light" ? "../renderer/icon-light.png" : "../renderer/icon.png",
  );
}

/** Window/dev icon for the current OS appearance. */
function appIcon(): string {
  return iconPath(nativeTheme.shouldUseDarkColors ? "dark" : "light");
}

/** Swap the macOS dock icon to the given brand tile (best-effort). */
function setDockIcon(variant: "dark" | "light"): void {
  try {
    app.dock?.setIcon(iconPath(variant));
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
          click: () => openExternalSafely("https://gitstudio.dev"),
        },
        {
          label: "Report an Issue",
          click: () =>
            openExternalSafely("https://github.com/GitStudioHQ/gitstudio/issues"),
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
    "branches:list": "List branches",
    "branch:create": "Create branch",
    "branch:delete": "Delete branch",
    "branch:pullFf": "Pull branch",
    "compare:refs": "Compare",
    "compare:fileDiff": "Compare file",
    "repo:tree": "Read tree",
    "repo:file": "Read file",
    "repo:open": "Open repository",
    "repo:openPath": "Open repository",
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
    actionCtx.run({ id: ++actionSeq, label: actionLabel(channel) }, () =>
      fn(payload as IpcRequest<C>, event),
    ),
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
  handle("branch:pullFf", (req) => bridge.branchPullFf(req.name));

  // Compare (base…head).
  handle("compare:refs", (req) => bridge.compareRefs(req));
  handle("compare:fileDiff", (req) => bridge.compareFileDiff(req));

  // Code browser (GitHub-style file tree at HEAD).
  handle("repo:tree", (req) => bridge.treeList(req));
  handle("repo:file", (req) => bridge.fileText(req));
  handle("repo:headCommit", () => bridge.headCommit());

  // Integrated terminal (PTY) — launches in the active repo's directory.
  handle("terminal:create", async (opts) =>
    terminal.create(opts, repos.current()?.root),
  );
  handle("terminal:write", async (req) => terminal.write(req.id, req.data));
  handle("terminal:resize", async (req) => terminal.resize(req.id, req.cols, req.rows));
  handle("terminal:kill", async (req) => terminal.kill(req.id));

  // Clone / browse repos.
  handle("clone:pickDir", () => pickCloneDir());
  handle("clone:start", (req) => startClone(req, (p) => send("clone:progress", p)));
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
  // Cross-repo read-only item view (notifications for OTHER repos open in-app).
  handle("github:externalItem", (req) => github.externalItem(req));
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
  handle("branch:merge", (req) => bridge.branchMerge(req));
  handle("branch:rebase", (req) => bridge.branchRebase(req));
  handle("branch:rename", (req) => bridge.branchRename(req));
  handle("branch:setUpstream", (req) => bridge.branchSetUpstream(req));
  handle("branch:deleteRemote", (req) => bridge.branchDeleteRemote(req));
  handle("git:opState", () => bridge.opState());
  handle("merge:abort", () => bridge.mergeAbort());
  handle("merge:continue", () => bridge.mergeContinue());
  handle("rebase:abort", () => bridge.rebaseAbort());
  handle("rebase:continue", () => bridge.rebaseContinue());
  handle("rebase:skip", () => bridge.rebaseSkip());
  handle("tag:create", (req) => bridge.tagCreate(req));

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
  handle("actions:runLog", (req) => github.withRepo((c, o, r) => actionsApi.runLog(c, o, r, req)));
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
  // Belt-and-suspenders navigation lockdown: any webContents that ever gets
  // created (not just the main window) inherits the same hardening.
  app.on("web-contents-created", (_e, contents) => hardenWebContents(contents));

  const state = await loadState();
  repos = new RepoStore(state.recent);
  bridge = new GitBridge(repos);
  github = new GitHubBridge(repos);
  ai = new AiBridge(repos, send);
  repos.onChange((info) => {
    send("repo:changed", info);
    buildMenu();
  });
  // Stream every git command the open repo runs to the renderer's Output tab.
  let gitLogId = 0;
  repos.onGitRun = (e) => {
    const action = actionCtx.getStore();
    send("git:log", {
      id: ++gitLogId,
      args: e.args,
      command: `git ${e.args.join(" ")}`,
      durationMs: e.durationMs,
      exitCode: e.exitCode,
      failed: e.failed,
      ...(e.stderr ? { stderr: e.stderr } : {}),
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
  initAutoUpdate({ isDev: !app.isPackaged });

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
});
process.on("unhandledRejection", (reason) => {
  // eslint-disable-next-line no-console
  console.error("GitStudio main: unhandled rejection:", reason);
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
