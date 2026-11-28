// Issue #161: the "N commits selected" summary lists the files the selection
// changed, as one change, and a click opens a file's diff across them. The
// real graph host (graphPanel.ts) over a real repository: what it posts for a
// selection, and what it opens for a file of it.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as kit from "./graphPanel.kit";

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const { CommitGraphPanel } = require("../src/graph/graphPanel") as typeof import("../src/graph/graphPanel");

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
});

const diffs = () => kit.ran.filter((c) => c.command === "vscode.diff");

function graph() {
  const r = kit.mkRepo();
  live.push(r);
  const base = r.commit("base", "a.txt", "1\n2\n3\n");
  const c1 = r.commit("c1", "a.txt", "1\n2\n3\n4\n");
  const c2 = r.commit("c2", "b.txt", "b\n");
  const c3 = r.commit("c3", "a.txt", "1\n2\n3\n4\n5\n");
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
  const host = CommitGraphPanel.forView(w as never, repos as never, kit.Uri.file("/ext") as never, {});
  live.push(host);
  w.send({ type: "ready" });
  const files = () => w.posted.filter((m) => m.type === "commitsFiles");
  return { r, w, base, c1, c2, c3, files };
}

test("a run of commits is answered as one change, base to tip, with git's counts", async () => {
  const g = graph();
  await kit.until(() => g.w.posted.find((m) => m.type === "graphInit"), "graphInit");
  g.w.send({ type: "selectCommits", shas: [g.c3, g.c2, g.c1] });
  const m = await kit.until(() => g.files()[0], "commitsFiles");
  assert.deepEqual(m, {
    type: "commitsFiles",
    shas: [g.c3, g.c2, g.c1],
    files: {
      kind: "stack",
      files: [
        { path: "a.txt", status: "M", additions: 2, deletions: 0, from: g.base, to: g.c3 },
        { path: "b.txt", status: "A", additions: 1, deletions: 0, from: g.base, to: g.c3 },
      ],
    },
  });
});

test("a selection with a gap is combined file by file; only the one it settles on is read", async () => {
  const g = graph();
  await kit.until(() => g.w.posted.find((m) => m.type === "graphInit"), "graphInit");
  // Shift+Down over two rows: two selections, and the first is never read.
  g.w.send({ type: "selectCommits", shas: [g.c3, g.c2] });
  g.w.send({ type: "selectCommits", shas: [g.c3, g.c1] });
  const m = await kit.until(() => g.files()[0], "commitsFiles");
  assert.deepEqual(m.shas, [g.c3, g.c1]);
  assert.deepEqual(m.files, {
    kind: "pieces",
    files: [{ path: "a.txt", status: "M", additions: 0, deletions: 0, from: g.base, to: g.c3 }],
  });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(g.files().length, 1, "the selection it passed through was never answered");
});

test("a file of it opens as a diff between the two revisions, and is the lit one while open", async () => {
  const g = graph();
  await kit.until(() => g.w.posted.find((m) => m.type === "graphInit"), "graphInit");
  const key = `selection:3:${g.c3}:${g.c1}`;
  g.w.send({ type: "openCombinedFile", key, path: "a.txt", status: "M", from: g.base, to: g.c3, preserveFocus: true });
  await kit.until(() => diffs().length === 1, "the diff");
  const [original, modified, title, options] = diffs()[0].args as [any, any, string, unknown];
  assert.equal(title, `a.txt (${g.base.slice(0, 7)} ↔ ${g.c3.slice(0, 7)})`);
  assert.match(String(original), new RegExp(`rev=${g.base}`));
  assert.match(String(modified), new RegExp(`rev=${g.c3}`));
  assert.deepEqual(options, { preview: true, preserveFocus: true });
  assert.deepEqual(g.w.posted.filter((m) => m.type === "activeFile").at(-1), { type: "activeFile", sha: key, path: "a.txt" });
});

test("a file whose revisions are not full shas opens nothing", async () => {
  const g = graph();
  await kit.until(() => g.w.posted.find((m) => m.type === "graphInit"), "graphInit");
  const key = "selection:2:x:y";
  for (const [from, to] of [
    ["HEAD~1", g.c3],
    [g.base, "--output=/tmp/x"],
    [g.base, "0".repeat(40)],
    [g.base, g.c3.slice(0, 7)],
  ]) {
    g.w.send({ type: "openCombinedFile", key, path: "a.txt", status: "M", from, to });
  }
  g.w.send({ type: "openCombinedFile", key, path: "", status: "M", from: g.base, to: g.c3 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(diffs().length, 0);
});
