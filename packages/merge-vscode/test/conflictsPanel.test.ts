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
