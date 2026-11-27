// Issue #158: the details pane lights the file whose diff is open, and the
// HOST keeps that true — it alone sees the diff's tab. Two halves:
//
//  - activeFile.ts's decision, as a table: given the diffs the pane opened and
//    the tabs there are, which file is the open one.
//  - the real graph host (graphPanel.ts) over a scripted tab strip: what it
//    posts as the user opens files from the pane, switches between their
//    diffs' tabs, routes one to the comparison and closes them.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as kit from "./graphPanel.kit";

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const { ActiveFileTracker, DIFF_ON_ITS_WAY_MS } = require("../src/graph/activeFile") as typeof import("../src/graph/activeFile");
type TabSeen = import("../src/graph/activeFile").TabSeen;

// ── The decision ─────────────────────────────────────────────────────────────

const ROOT = "/work/widgets";
const diffOf = (sha: string, path: string, root = ROOT) => ({
  root,
  sha,
  path,
  original: `gitstudio-rev:/${path}?rev=${sha}~1&root=${root}`,
  modified: `gitstudio-rev:/${path}?rev=${sha}&root=${root}`,
  title: `${path.split("/").pop()} (${sha.slice(0, 7)})`,
});
const tabOf = (d: ReturnType<typeof diffOf>): TabSeen => ({ kind: "diff", original: d.original, modified: d.modified });
const comparisonOf = (d: ReturnType<typeof diffOf>): TabSeen => ({ kind: "comparison", label: d.title });
const OTHER: TabSeen = { kind: "other" };

test("the open file: the pane's diff in front is it, one still open keeps it, none puts it out", () => {
  const A = diffOf("a".repeat(40), "src/widgets/a.ts");
  const B = diffOf("a".repeat(40), "src/widgets/b.ts");
  const t = new ActiveFileTracker();
  assert.equal(t.active(ROOT), undefined, "nothing opened, nothing open");
  assert.equal(t.following, false);

  let now = 1_000;
  t.open(A, now);
  assert.deepEqual(t.active(ROOT), { sha: A.sha, path: A.path }, "opened: it is the open one at once");
  // On its way: tabs change (the editor's last tab still in front), and it holds.
  t.settle({ front: OTHER, all: [OTHER] }, (now += 10));
  assert.deepEqual(t.active(ROOT)?.path, A.path, "a diff on its way keeps the light");
  t.settle({ front: tabOf(A), all: [OTHER, tabOf(A)] }, (now += 10));
  assert.deepEqual(t.active(ROOT)?.path, A.path, "its tab came");

  // Another file opened, its preview tab replacing A's.
  t.open(B, (now += 10));
  t.settle({ front: tabOf(A), all: [OTHER, tabOf(A)] }, (now += 1));
  assert.equal(t.active(ROOT)?.path, B.path, "B on its way: A still in front does not take the light back");
  t.settle({ front: tabOf(B), all: [OTHER, tabOf(B)] }, (now += 10));
  assert.equal(t.active(ROOT)?.path, B.path);

  // Something else in front, B still open behind it: B stays.
  t.settle({ front: OTHER, all: [OTHER, tabOf(B)] }, (now += 10));
  assert.equal(t.active(ROOT)?.path, B.path, "a diff still open keeps the light while another tab is in front");

  // A opened again, B kept in a tab of its own: switching between them moves it.
  t.open(A, (now += 10));
  t.settle({ front: tabOf(A), all: [OTHER, tabOf(B), tabOf(A)] }, (now += 10));
  assert.equal(t.active(ROOT)?.path, A.path);
  t.settle({ front: tabOf(B), all: [OTHER, tabOf(B), tabOf(A)] }, (now += 10));
  assert.equal(t.active(ROOT)?.path, B.path, "switching to another of the pane's diffs moves the light");
  // B closed: VS Code puts A in front.
  t.settle({ front: tabOf(A), all: [OTHER, tabOf(A)] }, (now += 10));
  assert.equal(t.active(ROOT)?.path, A.path, "closing it moves the light to the diff now in front");
  // A closed too.
  t.settle({ front: OTHER, all: [OTHER] }, (now += 10));
  assert.equal(t.active(ROOT), undefined, "the last one closed: no open file");
  assert.equal(t.following, false, "and nothing left to follow");
});

test("the open file: a diff routed to the comparison is known by its label, and a diff that never came lets go", () => {
  const A = diffOf("b".repeat(40), "src/widgets/same.ts");
  const B = diffOf("b".repeat(40), "src/gadgets/same.ts"); // the same file name: the same label
  const t = new ActiveFileTracker();
  let now = 5_000;
  t.open(A, now);
  t.settle({ front: tabOf(A), all: [tabOf(A)] }, (now += 5));
  // The router: the comparison in front, then VS Code's tab closed.
  t.settle({ front: comparisonOf(A), all: [tabOf(A), comparisonOf(A)] }, (now += 5));
  t.settle({ front: comparisonOf(A), all: [comparisonOf(A)] }, (now += 5));
  assert.equal(t.active(ROOT)?.path, A.path, "the comparison standing in for the diff keeps the light");
  // A second file of the same name, routed too: the comparisons share a label.
  t.open(B, (now += 5));
  t.settle({ front: tabOf(B), all: [comparisonOf(A), tabOf(B)] }, (now += 5));
  t.settle({ front: comparisonOf(B), all: [comparisonOf(A), comparisonOf(B)] }, (now += 5));
  assert.equal(t.active(ROOT)?.path, B.path, "a shared label keeps the one opened last");
  t.settle({ front: OTHER, all: [OTHER] }, (now += 5));
  assert.equal(t.active(ROOT), undefined, "the comparisons closed: no open file");

  // A diff asked for whose tab never appears gives the light up once it is overdue.
  t.open(A, (now += 5));
  t.settle({ front: OTHER, all: [OTHER] }, (now += 10));
  assert.equal(t.active(ROOT)?.path, A.path, "still on its way");
  t.settle({ front: OTHER, all: [OTHER] }, (now += DIFF_ON_ITS_WAY_MS));
  assert.equal(t.active(ROOT), undefined, "overdue, and no tab shows it");
});

test("the open file: what is remembered stays small — only diffs with a tab, and the one on its way", () => {
  const t = new ActiveFileTracker();
  let now = 9_000;
  const all: TabSeen[] = [];
  for (let i = 0; i < 200; i++) {
    const d = diffOf("c".repeat(40), `f${i}.ts`);
    t.open(d, (now += 1));
    // Each a preview replacing the last.
    all.splice(0, all.length, tabOf(d));
    t.settle({ front: tabOf(d), all }, (now += 1));
  }
  assert.equal(t.active(ROOT)?.path, "f199.ts");
  assert.equal((t as any).opened.length, 1, "a preview replaced is forgotten");
});

test("review #162: closing the diff that has the light hands it to another of the pane's diffs still open", () => {
  const A = diffOf("c".repeat(40), "src/widgets/a.ts");
  const B = diffOf("c".repeat(40), "src/widgets/b.ts");
  const t = new ActiveFileTracker();
  let now = 30_000;
  t.open(A, now);
  t.settle({ front: tabOf(A), all: [tabOf(A)] }, (now += 5));
  t.open(B, (now += 5));
  t.settle({ front: tabOf(B), all: [tabOf(A), tabOf(B)] }, (now += 5));
  t.settle({ front: tabOf(A), all: [tabOf(A), tabOf(B)] }, (now += 5));
  assert.equal(t.active(ROOT)?.path, A.path, "A's tab in front has the light");
  // A closed, and VS Code puts a source file in front: B is still open.
  assert.equal(t.settle({ front: OTHER, all: [OTHER, tabOf(B)] }, (now += 5)), true, "the light moved: said");
  assert.equal(t.active(ROOT)?.path, B.path, "the pane's other diff, still open, has it");
  // B closed too: none left, the light goes out.
  t.settle({ front: OTHER, all: [OTHER] }, (now += 5));
  assert.equal(t.active(ROOT), undefined);
});

test("the open file is each repository's own: the same working-tree file of another is not it", () => {
  const W = "0".repeat(40);
  const A = diffOf(W, "package.json", "/work/a");
  const B = diffOf(W, "package.json", "/work/b");
  const t = new ActiveFileTracker();
  let now = 20_000;
  t.open(A, now);
  t.settle({ front: tabOf(A), all: [tabOf(A)] }, (now += 5));
  assert.deepEqual(t.active("/work/a"), { sha: W, path: "package.json" });
  assert.equal(t.active("/work/b"), undefined, "the same sha and path in another repository is not open");
  // b's own opened beside it, then a's tab brought back in front: each keeps its own.
  t.open(B, (now += 5));
  t.settle({ front: tabOf(B), all: [tabOf(A), tabOf(B)] }, (now += 5));
  t.settle({ front: tabOf(A), all: [tabOf(A), tabOf(B)] }, (now += 5));
  assert.equal(t.active("/work/b")?.path, "package.json", "b's diff is still open: a's in front does not put b's out");
  assert.equal(t.active("/work/a")?.path, "package.json");
  // b's closed: only b's goes out, and the change is reported.
  assert.equal(t.settle({ front: tabOf(A), all: [tabOf(A)] }, (now += 5)), true);
  assert.equal(t.active("/work/b"), undefined);
  assert.equal(t.active("/work/a")?.path, "package.json");
  assert.equal(t.settle({ front: OTHER, all: [OTHER, tabOf(A)] }, (now += 5)), false, "nothing moved: says so");
});

// ── The host, over a scripted tab strip ──────────────────────────────────────

const vscode = require("vscode") as any;
const { CommitGraphPanel } = require("../src/graph/graphPanel") as typeof import("../src/graph/graphPanel");

interface Tab {
  label: string;
  input: unknown;
}
class Listeners<T> {
  readonly fns = new Set<(v: T) => void>();
  readonly event = (fn: (v: T) => void) => {
    this.fns.add(fn);
    return { dispose: () => this.fns.delete(fn) };
  };
  fire(v: T): void {
    for (const f of [...this.fns]) f(v);
  }
}
const tabsChanged = new Listeners<unknown>();
const groupsChanged = new Listeners<unknown>();
const group = { tabs: [] as Tab[], activeTab: undefined as Tab | undefined };
vscode.window.tabGroups = {
  get all() {
    return [group];
  },
  get activeTabGroup() {
    return group;
  },
  onDidChangeTabs: tabsChanged.event,
  onDidChangeTabGroups: groupsChanged.event,
};
/** The editor shows `tab` in front (added, or replacing `replace`). */
function show(tab: Tab, replace?: Tab): void {
  const i = replace ? group.tabs.indexOf(replace) : -1;
  if (i >= 0) group.tabs[i] = tab;
  else if (!group.tabs.includes(tab)) group.tabs.push(tab);
  group.activeTab = tab;
  tabsChanged.fire({});
}
function close(tab: Tab, front?: Tab): void {
  group.tabs = group.tabs.filter((t) => t !== tab);
  group.activeTab = front ?? group.tabs.at(-1);
  tabsChanged.fire({});
}
const diffs = () => kit.ran.filter((c) => c.command === "vscode.diff");
/** The tab VS Code would make for the n-th vscode.diff the host ran. */
const tabFor = (n: number): Tab => {
  const [original, modified, title] = diffs()[n - 1].args as [unknown, unknown, string];
  return { label: title, input: { original, modified } };
};

const live: { dispose(): void }[] = [];
afterEach(() => {
  while (live.length) {
    try {
      live.pop()!.dispose();
    } catch {
      /* keep cleaning up */
    }
  }
  kit.resetRecords();
  group.tabs = [];
  group.activeTab = undefined;
});

function graph(opts: { sidebar?: boolean } = {}) {
  const r = kit.mkRepo();
  live.push(r);
  r.commit("base", "base.txt");
  r.write("a.txt", "a\n");
  r.write("b.txt", "b\n");
  const sha = r.commit("two files", "c.txt");
  const entry = { root: r.dir, ctx: r.ctx };
  const repos = {
    onDidChange: () => ({ dispose() {} }),
    getActive: () => entry,
    getAll: () => [entry],
    isDiscovering: () => false,
    getUndoLedger: () => undefined,
    findByPath: () => entry,
  };
  const w = kit.fakeWebview();
  const host = CommitGraphPanel.forView(w as never, repos as never, kit.Uri.file("/ext") as never, { sidebar: opts.sidebar });
  live.push(host);
  w.send({ type: "ready" });
  const marks = () => w.posted.filter((m) => m.type === "activeFile");
  return { r, sha, w, host, marks, last: () => marks().at(-1) };
}

test("the host lights the file whose diff it opened, follows its tabs, and puts the light out when they close", async () => {
  const g = graph();
  await kit.until(() => g.w.posted.find((m) => m.type === "graphInit"), "graphInit");

  // A file opened from the pane: the light is its file, before the tab is even there.
  g.w.send({ type: "openFile", sha: g.sha, path: "a.txt", status: "A" });
  await kit.until(() => diffs().length === 1, "the diff");
  assert.deepEqual(g.last(), { type: "activeFile", sha: g.sha, path: "a.txt" });
  assert.deepEqual(diffs()[0].args[3], { preview: true }, "Enter / a click: the diff takes focus as before");
  const a = tabFor(1);
  show(a);
  const settled = g.marks().length;

  // Space: another file, the keyboard kept in the list, its preview replacing a's.
  g.w.send({ type: "openFile", sha: g.sha, path: "b.txt", status: "A", preserveFocus: true });
  await kit.until(() => diffs().length === 2, "the second diff");
  assert.deepEqual(diffs()[1].args[3], { preview: true, preserveFocus: true }, "Space keeps the keyboard where it is");
  assert.deepEqual(g.last(), { type: "activeFile", sha: g.sha, path: "b.txt" });
  const b = tabFor(2);
  show(b, a);
  assert.equal(g.marks().length, settled + 1, "the tab arriving moves nothing: no word sent");

  // A file of the editor's own in front, b still open behind it: b stays lit.
  const file: Tab = { label: "notes.md", input: { uri: kit.Uri.file("/notes.md") } };
  show(file);
  assert.deepEqual(g.last(), { type: "activeFile", sha: g.sha, path: "b.txt" });

  // a again, kept this time beside b: switching tabs moves the light.
  g.w.send({ type: "openFile", sha: g.sha, path: "a.txt", status: "A" });
  await kit.until(() => diffs().length === 3, "a again");
  const a2 = tabFor(3);
  show(a2);
  show(b);
  assert.deepEqual(g.last(), { type: "activeFile", sha: g.sha, path: "b.txt" }, "b in front: b is lit");
  show(a2);
  assert.deepEqual(g.last(), { type: "activeFile", sha: g.sha, path: "a.txt" }, "a in front: a is lit");

  // Closing: the light goes to the pane's diff now in front, then out.
  close(a2, b);
  assert.deepEqual(g.last(), { type: "activeFile", sha: g.sha, path: "b.txt" });
  close(b, file);
  assert.deepEqual(g.last(), { type: "activeFile" }, "the last of them closed: no light");
  const out = g.marks().length;
  close(file);
  assert.equal(g.marks().length, out, "with nothing to follow, a tab change sends nothing");
});

test("the host: a diff routed to the comparison keeps the light; a commit shown again is told its open file", async () => {
  const g = graph();
  const init = await kit.until(() => g.w.posted.find((m) => m.type === "graphInit"), "graphInit");
  g.w.send({ type: "openFile", sha: g.sha, path: "a.txt", status: "A" });
  await kit.until(() => diffs().length === 1, "the diff");
  const native = tabFor(1);
  show(native);
  // The default diff viewer routes it: the comparison opens in front, VS Code's tab closes.
  const comparison: Tab = { label: native.label, input: { viewType: "mainThreadWebview-gitstudio.diffView" } };
  show(comparison);
  close(native, comparison);
  assert.deepEqual(g.last(), { type: "activeFile", sha: g.sha, path: "a.txt" }, "the comparison is the diff");

  // Another commit, then this one again: each details post is followed by the open file.
  const other = init.rows.find((row: { sha: string }) => row.sha !== g.sha).sha;
  g.w.send({ type: "selectCommit", sha: other });
  await kit.until(() => g.w.posted.filter((m) => m.type === "commitDetails").length >= 1, "details");
  const afterDetails = g.w.posted.slice(g.w.posted.findIndex((m) => m.type === "commitDetails"));
  assert.deepEqual(afterDetails[1], { type: "activeFile", sha: g.sha, path: "a.txt" }, "said after the details, for the commit it is in");

  close(comparison);
  assert.deepEqual(g.last(), { type: "activeFile" }, "the comparison closed: no light");
});

test("the host: the Commits rail (no pane) does not listen to tabs, and a closed graph stops listening", () => {
  const before = tabsChanged.fns.size;
  const rail = graph({ sidebar: true });
  assert.equal(tabsChanged.fns.size, before, "the rail has no files to light");
  const g = graph();
  assert.equal(tabsChanged.fns.size, before + 1);
  assert.equal(groupsChanged.fns.size, before + 1);
  g.host.dispose();
  rail.host.dispose();
  assert.equal(tabsChanged.fns.size, before, "disposed: it hears tabs no more");
  assert.equal(groupsChanged.fns.size, before);
});

test("the host: a working-tree file open in one repository lights nothing when the graph shows another", async () => {
  const { UNCOMMITTED_SHA } = require("@gitstudio/git-service/index") as typeof import("@gitstudio/git-service/index");
  // Two repositories whose working trees changed the same file: the same sha, the same path.
  const dirty = () => {
    const r = kit.mkRepo();
    live.push(r);
    r.commit("base", "shared.txt");
    r.write("shared.txt", "changed\n");
    const change = { uri: kit.Uri.file(join(r.dir, "shared.txt")), originalUri: kit.Uri.file(join(r.dir, "shared.txt")), status: 5 };
    return {
      root: r.dir,
      ctx: r.ctx,
      repo: { state: { indexChanges: [], workingTreeChanges: [change], untrackedChanges: [], mergeChanges: [] } },
    };
  };
  const a = dirty();
  const b = dirty();
  let active = a;
  const repos = {
    onDidChange: () => ({ dispose() {} }),
    getActive: () => active,
    getAll: () => [a, b],
    isDiscovering: () => false,
    getUndoLedger: () => undefined,
    findByPath: () => active,
  };
  const w = kit.fakeWebview();
  const host = CommitGraphPanel.forView(w as never, repos as never, kit.Uri.file("/ext") as never, {});
  live.push(host);
  w.send({ type: "ready" });
  await kit.until(() => w.posted.find((m) => m.type === "graphInit"), "graphInit");
  const details = () => w.posted.filter((m) => m.type === "commitDetails").length;
  /** What the host said right after the n-th details. */
  const afterDetails = (n: number) => {
    const at = w.posted.map((m, i) => (m.type === "commitDetails" ? i : -1)).filter((i) => i >= 0)[n - 1];
    return w.posted[at + 1];
  };

  w.send({ type: "selectCommit", sha: UNCOMMITTED_SHA });
  await kit.until(() => details() === 1, "a's working tree");
  w.send({ type: "openFile", sha: UNCOMMITTED_SHA, path: "shared.txt", wip: true, status: "M" });
  await kit.until(() => diffs().length === 1, "a's diff");
  show(tabFor(1));
  assert.deepEqual(w.posted.filter((m) => m.type === "activeFile").at(-1), { type: "activeFile", sha: UNCOMMITTED_SHA, path: "shared.txt" });

  // The graph now shows b, whose working tree changed the same file.
  active = b;
  w.send({ type: "selectCommit", sha: UNCOMMITTED_SHA });
  await kit.until(() => details() === 2, "b's working tree");
  assert.deepEqual(afterDetails(2), { type: "activeFile" }, "a's open diff lights nothing in b");

  // Back on a, its diff still open: lit again.
  active = a;
  w.send({ type: "selectCommit", sha: UNCOMMITTED_SHA });
  await kit.until(() => details() === 3, "a's working tree again");
  assert.deepEqual(afterDetails(3), { type: "activeFile", sha: UNCOMMITTED_SHA, path: "shared.txt" });
});
