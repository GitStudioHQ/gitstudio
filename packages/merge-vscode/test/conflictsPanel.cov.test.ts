import { settle, stub, type StubPanel } from "./support/useVscodeStub";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as vscode from "vscode";
import type {
  ConflictFileView,
  ConflictsSnapshot,
  ConflictsState,
  OperationOutcome,
  OperationView,
} from "@gitstudio/host-bridge/conflictsProtocol";
import { ConflictsDashboard } from "../src/conflictsPanel";
import { ExitGuard } from "../src/exitGuard";
import type { MergeHostCore } from "../src/host";
import type { MergeProduct, MergeRepo } from "../src/product";
import { view } from "./fixtures";

// The conflicts dashboard's host (conflictsPanel.ts): every action the page
// can send, what git is told to run for it, and what the page is told back.

const MERGE_EDITOR = "cov.mergeEditor";

interface Recorded {
  host: MergeHostCore;
  notes: { kind: string; text: string }[];
  undo: string[];
  globalState: Map<string, unknown>;
}

function hostFor(over: Partial<MergeProduct> = {}, opts: { failStateWrites?: boolean } = {}): Recorded {
  const notes: { kind: string; text: string }[] = [];
  const undo: string[] = [];
  const globalState = new Map<string, unknown>();
  const product = {
    key: "gitstudio",
    brand: { name: "GitStudio", mark: "gitstudio" },
    displayName: "GitStudio",
    settingsSection: "cov.merge",
    viewTypes: { mergeEditor: MERGE_EDITOR, diffView: "cov.diff", conflicts: "cov.conflicts" },
    runWithUndo: async <T,>(_repo: MergeRepo, label: string, fn: () => Promise<T>): Promise<T> => {
      undo.push(label);
      return fn();
    },
    ...over,
  } as unknown as MergeProduct;
  const host: MergeHostCore = {
    context: {
      extensionUri: vscode.Uri.file("/ext"),
      globalState: {
        get: (k: string) => globalState.get(k),
        update: async (k: string, v: unknown) => {
          if (opts.failStateWrites) throw new Error("storage is read-only");
          globalState.set(k, v);
        },
      },
    } as unknown as vscode.ExtensionContext,
    product,
    exitGuard: new ExitGuard(),
    settings: () => ({ autoOpen: true, autoApplyNonConflicting: false }),
    defers: () => false,
    notify: async (kind: string, text: string) => {
      notes.push({ kind, text });
      return undefined;
    },
    changed: () => {},
  };
  return { host, notes, undo, globalState };
}

interface RepoState {
  files: ConflictFileView[];
  op: OperationView;
  /** The next whole-file action's result, or a throw. */
  fileResult?: { ok: boolean; changed: boolean; message?: string; expected?: boolean } | Error;
  /** The next verb's outcome, or a throw. */
  verbResult?: OperationOutcome | Error;
  /** operation.view() throws. */
  viewFails?: boolean;
  /** snapshot() throws. */
  snapshotFails?: boolean;
}

function repoWith(state: RepoState): MergeRepo & { calls: string[] } {
  const calls: string[] = [];
  const fileAct = async (what: string) => {
    calls.push(what);
    const r = state.fileResult ?? { ok: true, changed: true };
    if (r instanceof Error) throw r;
    return r;
  };
  const verbAct = async (what: string) => {
    calls.push(what);
    const r = state.verbResult ?? { ok: true, view: view("none"), remainingConflicts: 0 };
    if (r instanceof Error) throw r;
    // git is now where the verb left it.
    state.op = r.view;
    if (r.ok) state.files = [];
    return r;
  };
  return {
    root: "/r",
    calls,
    ctx: {
      conflictOps: {
        snapshot: async (): Promise<ConflictsSnapshot> => {
          if (state.snapshotFails) throw new Error("git is busy");
          return {
            repoName: "r",
            op: state.op,
            files: state.files,
            total: state.files.length,
            resolved: state.files.filter((f) => f.status === "resolved").length,
          };
        },
        takeRole: (path: string, role: string) => fileAct(`takeRole:${path}:${role}`),
        restore: (path: string) => fileAct(`restore:${path}`),
        deleteFile: (path: string) => fileAct(`deleteFile:${path}`),
      },
      conflict: { listConflicts: async () => state.files.filter((f) => f.status === "pending").map((f) => f.path) },
      operation: {
        view: async () => {
          if (state.viewFails) throw new Error("git is busy");
          return state.op;
        },
        continue: (o: unknown) => verbAct(`continue:${JSON.stringify(o)}`),
        skip: () => verbAct("skip"),
        abort: () => verbAct("abort"),
      },
    },
  } as unknown as MergeRepo & { calls: string[] };
}

const pending = (path: string): ConflictFileView => ({ path, status: "pending", shape: "text" });

const states = (panel: StubPanel): ConflictsState[] =>
  (panel.posted as { type: string; state: ConflictsState }[]).filter((m) => m.type === "state").map((m) => m.state);
const last = (panel: StubPanel): ConflictsState => {
  const all = states(panel);
  assert.ok(all.length > 0, "a state was posted");
  return all[all.length - 1];
};

async function opened(rec: Recorded, repo: MergeRepo, openConflict: (uri: vscode.Uri) => Promise<void> = async () => {}) {
  const dashboard = new ConflictsDashboard(rec.host, openConflict);
  await dashboard.show(repo);
  const panel = stub.panels[stub.panels.length - 1];
  panel.receive({ type: "ready" });
  await settle();
  return { dashboard, panel };
}

beforeEach(() => stub.reset());

test("a page that loads before git could be read asks again, and gets the state then", async () => {
  const state: RepoState = { files: [pending("a.txt")], op: view("merge"), snapshotFails: true };
  const repo = repoWith(state);
  const rec = hostFor();
  const dashboard = new ConflictsDashboard(rec.host, async () => {});
  await dashboard.show(repo);
  const panel = stub.panels[0];
  assert.equal(panel.viewType, "cov.conflicts");
  state.snapshotFails = false;
  panel.receive({ type: "ready" });
  await settle();
  assert.deepEqual(last(panel).files.map((f) => f.path), ["a.txt"]);
  assert.equal(panel.title, "Conflicts (1)");
});

test("Resolve Conflicts… on a dashboard already open brings it forward instead of opening another", async () => {
  const repo = repoWith({ files: [pending("a.txt")], op: view("merge") });
  const { dashboard, panel } = await opened(hostFor(), repo);
  await dashboard.show(repo);
  assert.equal(stub.panels.length, 1);
  assert.equal(panel.revealed.length, 1);
  assert.equal(dashboard.openFor, repo);
});

test("the page's Close closes it, and it stays closed for the rest of this stop", async () => {
  const state: RepoState = { files: [pending("a.txt")], op: view("merge") };
  const repo = repoWith(state);
  const { dashboard, panel } = await opened(hostFor(), repo);
  panel.receive({ type: "close" });
  await settle();
  assert.equal(panel.disposed, true);
  assert.equal(dashboard.openFor, undefined);
  await dashboard.onStateChanged(repo);
  assert.equal(stub.panels.length, 1, "not re-opened at the next git event");
});

test("support links open in the browser, and only web pages", async () => {
  const repo = repoWith({ files: [pending("a.txt")], op: view("merge") });
  const { panel } = await opened(hostFor(), repo);
  panel.receive({ type: "openExternal", url: "https://github.com/GitStudioHQ/merge-studio/issues" });
  panel.receive({ type: "openExternal", url: "HTTPS://example.com/x" });
  panel.receive({ type: "openExternal", url: "http://example.com" });
  panel.receive({ type: "openExternal", url: "command:workbench.action.reloadWindow" });
  panel.receive({ type: "openExternal", url: "file:///etc/passwd" });
  await settle();
  assert.deepEqual(
    (stub as unknown as { opened: string[] }).opened,
    // (The stand-in Uri keeps the scheme as written.)
    ["https://github.com/GitStudioHQ/merge-studio/issues", "HTTPS://example.com/x"],
  );
});

test("the sides tip's Got it is remembered, and the tip leaves the page at once", async () => {
  const rec = hostFor({ sidesTip: { version: "1.0", dismissedKey: "cov.sidesTip", why: "https://example.com/why" } });
  const repo = repoWith({ files: [pending("a.txt")], op: view("rebase") });
  const { panel } = await opened(rec, repo);
  const tip = last(panel).tip;
  assert.equal(tip?.id, "cov.sidesTip");
  assert.equal(tip?.why, "https://example.com/why");
  assert.match(tip!.text, /^New in GitStudio 1\.0: during a rebase, Yours is your commit \(test\), on the left\./);
  panel.receive({ type: "dismissTip", id: "cov.sidesTip" });
  await settle();
  assert.equal(rec.globalState.get("cov.sidesTip"), true);
  assert.equal(last(panel).tip, undefined);
});

test("a failure while handling a page action is reported, not swallowed", async () => {
  const rec = hostFor({ sidesTip: { version: "1.0", dismissedKey: "cov.sidesTip" } }, { failStateWrites: true });
  const repo = repoWith({ files: [pending("a.txt")], op: view("rebase") });
  const { panel } = await opened(rec, repo);
  panel.receive({ type: "dismissTip", id: "cov.sidesTip" });
  await settle();
  assert.deepEqual(rec.notes, [{ kind: "error", text: "storage is read-only" }]);
});

test("an empty message from the page does nothing", async () => {
  const repo = repoWith({ files: [pending("a.txt")], op: view("merge") });
  const rec = hostFor();
  const { panel } = await opened(rec, repo);
  const before = panel.posted.length;
  panel.receive(undefined);
  await settle();
  assert.equal(panel.posted.length, before);
  assert.deepEqual(rec.notes, []);
  assert.deepEqual(repo.calls, []);
});

test("a row's Merge… opens that file of THIS repository in the resolver", async () => {
  const repo = repoWith({ files: [pending("src/a.txt")], op: view("merge") });
  const asked: string[] = [];
  const { panel } = await opened(hostFor(), repo, async (uri) => {
    asked.push(uri.toString());
  });
  panel.receive({ type: "merge", path: "src/a.txt" });
  await settle();
  assert.deepEqual(asked, [vscode.Uri.file("/r/src/a.txt").toString()]);
});

test("Accept runs git inside the product's undo envelope, named for the file", async () => {
  const rec = hostFor();
  const repo = repoWith({ files: [pending("a.txt")], op: view("merge") });
  const { panel } = await opened(rec, repo);
  panel.receive({ type: "accept", path: "a.txt", role: "yours", seq: 1 });
  await settle();
  assert.deepEqual(repo.calls, ["takeRole:a.txt:yours"]);
  assert.deepEqual(rec.undo, ["Accept Yours: a.txt"]);
  assert.equal(last(panel).done, 1);
});

test("Restore runs outside the undo envelope; Delete runs inside it", async () => {
  const rec = hostFor();
  const repo = repoWith({ files: [pending("a.txt"), pending("b.txt")], op: view("merge") });
  const { panel } = await opened(rec, repo);
  panel.receive({ type: "restore", path: "a.txt", seq: 1 });
  panel.receive({ type: "delete", path: "b.txt", seq: 2 });
  await settle();
  assert.deepEqual(repo.calls, ["restore:a.txt", "deleteFile:b.txt"]);
  assert.deepEqual(rec.undo, ["Delete the conflicted file: b.txt"]);
  assert.equal(last(panel).done, 2);
});

test("without an undo envelope, Accept runs git directly", async () => {
  const rec = hostFor({ runWithUndo: undefined });
  const repo = repoWith({ files: [pending("a.txt")], op: view("merge") });
  const { panel } = await opened(rec, repo);
  panel.receive({ type: "accept", path: "a.txt", role: "theirs", seq: 1 });
  await settle();
  assert.deepEqual(repo.calls, ["takeRole:a.txt:theirs"]);
});

test("a whole-file action git refuses shows its reason on the page: a warning when expected, an error when not", async () => {
  const state: RepoState = {
    files: [pending("a.txt")],
    op: view("merge"),
    fileResult: { ok: false, changed: false, expected: true, message: "a.txt changed on disk; look again." },
  };
  const repo = repoWith(state);
  const { panel } = await opened(hostFor(), repo);
  panel.receive({ type: "accept", path: "a.txt", role: "yours", seq: 1 });
  await settle();
  assert.deepEqual(last(panel).notice, { kind: "warn", text: "a.txt changed on disk; look again." });

  state.fileResult = new Error("fatal: unable to write index");
  panel.receive({ type: "restore", path: "a.txt", seq: 2 });
  await settle();
  assert.deepEqual(last(panel).notice, { kind: "error", text: "fatal: unable to write index" });
  assert.equal(last(panel).files[0].status, "pending", "the row is no longer busy");
});

test("a successful file action closes that file's merge editor tab (it would show a stale conflict)", async () => {
  const repo = repoWith({ files: [pending("a.txt"), pending("b.txt")], op: view("merge") });
  const aTab = { input: { viewType: MERGE_EDITOR, uri: vscode.Uri.file("/r/a.txt") } };
  const bTab = { input: { viewType: MERGE_EDITOR, uri: vscode.Uri.file("/r/b.txt") } };
  stub.tabGroupsAll = [{ tabs: [aTab, bTab] }];
  const { panel } = await opened(hostFor(), repo);
  panel.receive({ type: "delete", path: "a.txt", seq: 1 });
  await settle();
  assert.deepEqual(stub.closedTabs, [aTab]);
});

test("Continue passes the drop confirmation to git and shows the outcome", async () => {
  const repo = repoWith({ files: [], op: view("rebase", { canContinue: true }) });
  const { panel } = await opened(hostFor(), repo);
  panel.receive({ type: "continue", confirmDrop: true, seq: 1 });
  await settle();
  assert.deepEqual(repo.calls, ['continue:{"confirmDrop":true}']);
  const s = last(panel);
  assert.equal(s.busy, false);
  assert.deepEqual(s.outcome, { kind: "done", text: "Rebase complete." });
});

test("Skip runs git's skip and says which commit was left out", async () => {
  const repo = repoWith({ files: [pending("a.txt")], op: view("rebase", { canSkip: true }) });
  const { panel } = await opened(hostFor(), repo);
  panel.receive({ type: "skip", seq: 1 });
  await settle();
  assert.deepEqual(repo.calls, ["skip"]);
  assert.equal(last(panel).outcome?.kind, "done");
});

test("Abort saves the conflicted files, aborts, and closes every merge editor tab once it worked", async () => {
  const state: RepoState = { files: [pending("a.txt")], op: view("merge") };
  const repo = repoWith(state);
  const order: string[] = [];
  (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [
    {
      uri: vscode.Uri.file("/r/a.txt"),
      isDirty: true,
      save: async () => {
        order.push("save");
        return true;
      },
    },
  ];
  const abort = repo.ctx.operation.abort.bind(repo.ctx.operation);
  (repo.ctx.operation as { abort: unknown }).abort = async () => {
    order.push("abort");
    return abort();
  };
  const t1 = { input: { viewType: MERGE_EDITOR, uri: vscode.Uri.file("/r/a.txt") } };
  const t2 = { input: { viewType: MERGE_EDITOR, uri: vscode.Uri.file("/r/z.txt") } };
  stub.tabGroupsAll = [{ tabs: [t1, t2] }];
  const { panel } = await opened(hostFor(), repo);
  panel.receive({ type: "abort", seq: 1 });
  await settle();
  assert.deepEqual(order, ["save", "abort"]);
  assert.deepEqual(stub.closedTabs, [t1, t2]);
  assert.deepEqual(last(panel).outcome, {
    kind: "done",
    text: "Merge cancelled — the repository is back where it was before.",
  });
});

test("an Abort git refused keeps the merge editors, and the page says why", async () => {
  const repo = repoWith({
    files: [pending("a.txt")],
    op: view("merge"),
    verbResult: { ok: false, view: view("merge"), remainingConflicts: 1, message: "error: cannot abort" },
  });
  stub.tabGroupsAll = [{ tabs: [{ input: { viewType: MERGE_EDITOR, uri: vscode.Uri.file("/r/a.txt") } }] }];
  const { panel } = await opened(hostFor(), repo);
  panel.receive({ type: "abort", seq: 1 });
  await settle();
  assert.deepEqual(stub.closedTabs, []);
  assert.deepEqual(last(panel).outcome, { kind: "failed", text: "error: cannot abort" });
});

test("a verb that throws, or whose operation cannot be read, is shown as failed and the page is freed", async () => {
  const state: RepoState = { files: [pending("a.txt")], op: view("rebase", { canContinue: true }), verbResult: new Error("fatal: bad object") };
  const repo = repoWith(state);
  const { panel } = await opened(hostFor(), repo);
  panel.receive({ type: "continue", seq: 1 });
  await settle();
  assert.deepEqual(last(panel).outcome, { kind: "failed", text: "fatal: bad object" });
  assert.equal(last(panel).busy, false);

  state.verbResult = undefined;
  state.viewFails = true;
  panel.receive({ type: "skip", seq: 2 });
  await settle();
  assert.deepEqual(last(panel).outcome, { kind: "failed", text: "git is busy" });
  assert.equal(last(panel).busy, false);
  assert.ok(!repo.calls.includes("skip"), "git's skip never ran on an unreadable operation");
});

test("disposing the dashboard closes its panel", async () => {
  const repo = repoWith({ files: [pending("a.txt")], op: view("merge") });
  const { dashboard, panel } = await opened(hostFor(), repo);
  dashboard.dispose();
  assert.equal(panel.disposed, true);
  assert.equal(dashboard.openFor, undefined);
});
