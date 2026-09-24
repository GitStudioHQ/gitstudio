import { settle, stub } from "./support/useVscodeStub";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ConflictFileView, ConflictsSnapshot } from "@gitstudio/host-bridge/conflictsProtocol";
import { ConflictsDashboard } from "../src/conflictsPanel";
import { ExitGuard } from "../src/exitGuard";
import type { MergeHostCore } from "../src/host";
import type { MergeProduct, MergeRepo } from "../src/product";
import { view } from "./fixtures";

// The conflicts dashboard's HOST (conflictsPanel.ts) against a stand-in for
// the vscode module: what the panel does when the user closes its tab, and
// how a whole-file action treats a merge editor that holds unsaved work.

const MERGE_EDITOR = "test.mergeEditor";

function hostFor(order: string[] = []): MergeHostCore {
  const product = {
    key: "gitstudio",
    brand: { name: "GitStudio", mark: "gitstudio" },
    displayName: "GitStudio",
    settingsSection: "test.merge",
    viewTypes: { mergeEditor: MERGE_EDITOR, diffView: "test.diff", conflicts: "test.conflicts" },
  } as unknown as MergeProduct;
  return {
    context: { extensionUri: vscode.Uri.file("/ext") } as unknown as vscode.ExtensionContext,
    product,
    exitGuard: new ExitGuard(),
    settings: () => ({
      autoOpen: true,
      autoApplyNonConflicting: false,
      conflictResolver: "embedded",
      diffTool: "embedded",
      preferredIde: "auto",
      jetbrainsPath: "",
    }),
    defers: () => false,
    notify: async () => undefined,
    changed: () => order.push("changed"),
  };
}

/** A repository whose snapshot the test sets; takeRole records its turn in `order`. */
function repoWith(state: { files: ConflictFileView[]; episode: string }, order: string[] = []): MergeRepo {
  const snapshot = async (): Promise<ConflictsSnapshot> => {
    const op = view("rebase", { episode: state.episode });
    return {
      repoName: "r",
      op,
      files: state.files,
      total: state.files.length,
      resolved: state.files.filter((f) => f.status === "resolved").length,
    };
  };
  return {
    root: "/r",
    ctx: {
      conflictOps: {
        snapshot,
        takeRole: async (path: string, role: string) => {
          order.push(`takeRole:${path}:${role}`);
          state.files = state.files.map((f) => (f.path === path ? { ...f, status: "resolved" } : f));
          return { ok: true, changed: true };
        },
      },
      conflict: { listConflicts: async () => state.files.filter((f) => f.status === "pending").map((f) => f.path) },
      operation: { view: async () => view("rebase", { episode: state.episode }) },
    },
  } as unknown as MergeRepo;
}

const pending = (path: string): ConflictFileView => ({ path, status: "pending", shape: "text" });

beforeEach(() => stub.reset());

test("closing the dashboard's TAB is a close: it stays closed for the rest of this stop", async () => {
  // Merge Studio re-opened its dashboard on the next git event, so it could
  // not stay closed while conflicts remained (PLAN matrix row 46). The
  // controller keeps a close per episode — but only if the host tells it, and
  // the tab's ✕ is how most people close a tab.
  const state = { files: [pending("a.txt"), pending("b.txt")], episode: "rebase:1" };
  const repo = repoWith(state);
  const dashboard = new ConflictsDashboard(hostFor(), async () => {});
  await dashboard.onStateChanged(repo);
  assert.equal(stub.panels.length, 1, "shown automatically at the stop");
  stub.panels[0].dispose(); // the user's ✕
  await dashboard.onStateChanged(repo); // the next git event, same stop
  await dashboard.onStateChanged(repo);
  assert.equal(stub.panels.length, 1, "not re-opened while the user keeps it closed");

  state.episode = "rebase:2"; // git stopped at the next commit
  await dashboard.onStateChanged(repo);
  assert.equal(stub.panels.length, 2, "a new stop shows it again");
});

test("a dashboard WE closed (the operation ended elsewhere) is not remembered as the user's close", async () => {
  const state = { files: [pending("a.txt")], episode: "rebase:1" };
  const repo = repoWith(state);
  const dashboard = new ConflictsDashboard(hostFor(), async () => {});
  await dashboard.onStateChanged(repo);
  assert.equal(stub.panels.length, 1);
  // Aborted from a terminal: nothing in progress, nothing unmerged.
  const ended = { ...state };
  ended.files = [];
  ended.episode = "none";
  const endedRepo = repoWith(ended);
  (repo as { ctx: unknown }).ctx = endedRepo.ctx;
  (repo.ctx.conflictOps as { snapshot: unknown }).snapshot = async () => ({
    repoName: "r",
    op: view("none"),
    files: [],
    total: 0,
    resolved: 0,
  });
  await dashboard.onStateChanged(repo);
  assert.equal(stub.panels[0].disposed, true, "closed because the operation ended");
  // A new merge stops with conflicts under the same (none-kind) key.
  (repo.ctx.conflictOps as { snapshot: unknown }).snapshot = async () => ({
    repoName: "r",
    op: view("merge", { episode: "merge:9" }),
    files: [pending("c.txt")],
    total: 1,
    resolved: 0,
  });
  await dashboard.onStateChanged(repo);
  assert.equal(stub.panels.length, 2, "the next conflicts show it");
});

test("Accept Theirs on a file whose merge editor holds unsaved work saves it first, so closing that editor asks nothing", async () => {
  // Closing a dirty editor makes VS Code ask "Save changes?" — a modal — and
  // "Save" wrote the half-done merge over the side git had just checked out
  // and staged, leaving the working file different from what was resolved.
  const order: string[] = [];
  const state = { files: [pending("a.txt")], episode: "rebase:1" };
  const repo = repoWith(state, order);
  const uri = vscode.Uri.file("/r/a.txt");
  const doc = {
    uri,
    isDirty: true,
    save: async () => {
      order.push("save");
      doc.isDirty = false;
      return true;
    },
  };
  (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [doc];
  const tab = { input: { viewType: MERGE_EDITOR, uri } };
  stub.tabGroupsAll = [{ tabs: [tab] }];
  stub.onCloseTabs = () => {
    order.push(`close:${doc.isDirty ? "dirty" : "clean"}`);
  };
  const dashboard = new ConflictsDashboard(hostFor(order), async () => {});
  await dashboard.show(repo);
  const panel = stub.panels[0];
  panel.receive({ type: "ready" });
  await settle();
  panel.receive({ type: "accept", path: "a.txt", role: "theirs" });
  await settle();
  const saveAt = order.indexOf("save");
  const takeAt = order.indexOf("takeRole:a.txt:theirs");
  assert.ok(saveAt >= 0 && saveAt < takeAt, order.join(" → "));
  assert.ok(order.includes("close:clean"), order.join(" → "));
  assert.ok(!order.includes("close:dirty"), order.join(" → "));
});

// ── One press, one row (the owner, 24 Sep 2026: "clicking accept left on the
// first row flashes and refreshes all other rows … it looks like a server side
// website"). The host locked the whole page for one file (`busy`), posted the
// same state again after every git event, and a watcher's read taken while git
// was still at it could paint the pressed row as it was.

interface PostedState {
  type: string;
  state: {
    busy: boolean;
    done?: number;
    files: { path: string; status: string }[];
  };
}

/** A repository whose takeRole waits until the test lets it finish. */
function gatedRepo(state: { files: ConflictFileView[]; episode: string }) {
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const repo = repoWith(state);
  (repo.ctx.conflictOps as { takeRole: unknown }).takeRole = async (path: string) => {
    started.push(path);
    await new Promise<void>((r) => gates.set(path, r));
    state.files = state.files.map((f) => (f.path === path ? { ...f, status: "resolved", choice: "yours" } : f));
    return { ok: true, changed: true };
  };
  return { repo, started, release: (path: string) => gates.get(path)?.() };
}

const states = (panel: { posted: unknown[] }) => (panel.posted as PostedState[]).filter((m) => m.type === "state").map((m) => m.state);
const statusOf = (s: PostedState["state"]) => s.files.map((f) => `${f.path}:${f.status}`).join(" ");

async function openDashboard(repo: MergeRepo) {
  const dashboard = new ConflictsDashboard(hostFor(), async () => {});
  await dashboard.show(repo);
  const panel = stub.panels[stub.panels.length - 1];
  panel.receive({ type: "ready" });
  await settle();
  return { dashboard, panel };
}

test("a press on one row marks THAT row busy and never the page; its result comes with `done`", async () => {
  const state = { files: [pending("a.txt"), pending("b.txt"), pending("c.txt")], episode: "rebase:1" };
  const { repo, release } = gatedRepo(state);
  const { panel } = await openDashboard(repo);
  const before = states(panel).length;
  panel.receive({ type: "accept", path: "a.txt", role: "yours", seq: 1 });
  await settle();
  const during = states(panel).slice(before);
  assert.equal(during.length, 1, "one state for the press");
  assert.equal(statusOf(during[0]), "a.txt:busy b.txt:pending c.txt:pending", "only the pressed row is busy");
  assert.equal(during[0].busy, false, "the page is not locked for one row");
  assert.equal(during[0].done, 0, "and nothing is done yet");
  release("a.txt");
  await settle();
  const after = states(panel).slice(before);
  const last = after[after.length - 1];
  assert.equal(statusOf(last), "a.txt:resolved b.txt:pending c.txt:pending");
  assert.equal(last.done, 1, "the state that shows it says the press is done");
  assert.ok(after.every((s) => !s.busy), "no state of the press ever locked the page");
});

test("a second row pressed while git is at the first waits its turn (one git command at a time) and is never dropped", async () => {
  const state = { files: [pending("a.txt"), pending("b.txt"), pending("c.txt")], episode: "rebase:1" };
  const { repo, started, release } = gatedRepo(state);
  const { panel } = await openDashboard(repo);
  panel.receive({ type: "accept", path: "a.txt", role: "yours", seq: 1 });
  panel.receive({ type: "accept", path: "b.txt", role: "yours", seq: 2 });
  await settle();
  assert.deepEqual(started, ["a.txt"], "the second waits for the first");
  assert.equal(statusOf(states(panel).at(-1)!), "a.txt:busy b.txt:busy c.txt:pending", "both rows say so; the third is untouched");
  release("a.txt");
  await settle();
  assert.deepEqual(started, ["a.txt", "b.txt"], "then it runs");
  assert.equal(states(panel).at(-1)!.done, 1);
  assert.equal(statusOf(states(panel).at(-1)!), "a.txt:resolved b.txt:busy c.txt:pending");
  release("b.txt");
  await settle();
  assert.equal(states(panel).at(-1)!.done, 2);
  assert.equal(statusOf(states(panel).at(-1)!), "a.txt:resolved b.txt:resolved c.txt:pending");
});

test("a watcher's read that overlaps a press never says it is done", async () => {
  // git has written the file (the read sees it resolved) but the action has
  // not returned: that state must not end the row's working state early.
  const state = { files: [pending("a.txt"), pending("b.txt")], episode: "rebase:1" };
  const { repo, release } = gatedRepo(state);
  const { dashboard, panel } = await openDashboard(repo);
  panel.receive({ type: "accept", path: "a.txt", role: "yours", seq: 1 });
  await settle();
  state.files = state.files.map((f) => (f.path === "a.txt" ? { ...f, status: "resolved" } : f));
  await dashboard.onStateChanged(repo); // vscode.git's refresh, mid-press
  await settle();
  const mid = states(panel).at(-1)!;
  assert.equal(mid.done, 0, "a read that began before the press finished does not claim it");
  assert.equal(statusOf(mid), "a.txt:busy b.txt:pending", "and the row is still at work");
  release("a.txt");
  await settle();
  assert.equal(states(panel).at(-1)!.done, 1);
});

test("the same state is never posted twice, the page's HTML is set once, and a dashboard on screen is not revealed", async () => {
  const state = { files: [pending("a.txt"), pending("b.txt")], episode: "rebase:1" };
  const repo = repoWith(state);
  const { dashboard, panel } = await openDashboard(repo);
  const n = states(panel).length;
  for (let i = 0; i < 3; i++) await dashboard.onStateChanged(repo); // git events with nothing new
  await settle();
  assert.equal(states(panel).length, n, "nothing new, nothing posted");
  panel.receive({ type: "accept", path: "a.txt", role: "yours", seq: 1 });
  await settle();
  for (let i = 0; i < 3; i++) await dashboard.onStateChanged(repo);
  await settle();
  const posted = states(panel).slice(n);
  assert.equal(posted.length, 2, "one state for the press, one for its result (" + posted.map(statusOf).join(" | ") + ")");
  assert.equal(panel.htmlSets, 1, "the page was loaded once and never reloaded");
  assert.equal(stub.panels.length, 1, "and never replaced by a new panel");
  assert.equal(panel.revealed.length, 0, "already on screen: not revealed (a file dropping out of pending used to reveal it)");
  panel.visible = false; // the merge editor over it
  panel.receive({ type: "accept", path: "b.txt", role: "yours", seq: 2 });
  await settle();
  assert.equal(panel.revealed.length, 1, "behind another editor, finishing a file brings it back");
});

test("the page loading again (a reload) starts its numbering again: an earlier press never counts as done for it", async () => {
  const state = { files: [pending("a.txt"), pending("b.txt")], episode: "rebase:1" };
  const { repo, release } = gatedRepo(state);
  const { panel } = await openDashboard(repo);
  panel.receive({ type: "accept", path: "a.txt", role: "yours", seq: 7 });
  await settle();
  panel.receive({ type: "ready" }); // the page reloaded while git was at it
  await settle();
  release("a.txt");
  await settle();
  assert.equal(states(panel).at(-1)!.done, 0, "the old page's press 7 is not this page's");
  assert.equal(statusOf(states(panel).at(-1)!), "a.txt:resolved b.txt:pending", "its result is shown all the same");
});
