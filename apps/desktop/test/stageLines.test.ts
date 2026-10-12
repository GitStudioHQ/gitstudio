import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import { removeTempRepo } from "./tmpRepo";
import { tmpdir } from "node:os";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";
import { selectedBoundaries, selectedLineNumbers } from "../src/renderer/selectionLines";

/**
 * Line-level staging against a real repository.
 *
 * The selection the renderer sends is numbered in the pane the user clicked, and
 * that pane always shows `original` — the INDEX. Staging happened to work
 * because there `modified` is the working tree, whose numbering usually agrees.
 * Unstaging did not: there `modified` is HEAD, so any staged edit that inserts
 * or deletes lines shifts every later line, and the selection then names one
 * line in the index and a different one in HEAD.
 *
 * The visible symptom was "Nothing to apply in the selection." for a line
 * plainly sitting on screen.
 */
function repo(): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(`${tmpdir()}/gs-stagelines-`);
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0"); // no background gc racing the cleanup
  git("config", "core.autocrlf", "false"); // and no line-ending rewriting
  return { root, git };
}

test("unstaging a line works when a staged insertion has shifted the numbering", async () => {
  const { root, git } = repo();
  try {
    const base = Array.from({ length: 20 }, (_, i) => `X${i + 1}`);
    writeFileSync(`${root}/u.txt`, base.join("\n") + "\n");
    git("add", "u.txt");
    git("commit", "-qm", "base");

    // Stage TWO things: five inserted lines near the top, and an edit far below
    // it. The insertion pushes the edit five lines down in the index, so index
    // numbering and HEAD numbering no longer agree — which is the whole point.
    const staged: string[] = [];
    for (let i = 1; i <= 20; i++) {
      if (i === 3) for (const n of ["NEW-A", "NEW-B", "NEW-C", "NEW-D", "NEW-E"]) staged.push(n);
      staged.push(i === 15 ? "X15-EDIT" : `X${i}`);
    }
    writeFileSync(`${root}/u.txt`, staged.join("\n") + "\n");
    git("add", "u.txt");

    // The user clicks "X15-EDIT" where it appears in the index pane.
    const indexLines = git("show", ":u.txt").split("\n");
    const clicked = indexLines.indexOf("X15-EDIT") + 1;
    assert.equal(clicked, 20, "the staged edit sits five lines lower than in HEAD");

    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);
    const res = await bridge.stageLines({ path: "u.txt", lines: [clicked], reverse: true });
    assert.equal(res.ok, true, `unstaging that line succeeds (${res.message ?? ""})`);

    const after = git("show", ":u.txt").split("\n");
    assert.ok(after.includes("X15"), "the selected change is rolled back to HEAD");
    assert.ok(!after.includes("X15-EDIT"), "and is no longer staged");
    assert.ok(
      after.includes("NEW-A") && after.includes("NEW-E"),
      "while the OTHER staged change is untouched — only what was selected moves",
    );
  } finally {
    removeTempRepo(root);
  }
});

test("staging a line still applies the working-tree change it names", async () => {
  const { root, git } = repo();
  try {
    writeFileSync(`${root}/s.txt`, ["a", "b", "c", "d"].join("\n") + "\n");
    git("add", "s.txt");
    git("commit", "-qm", "base");
    // Two unstaged edits; stage only the second.
    writeFileSync(`${root}/s.txt`, ["a-EDIT", "b", "c-EDIT", "d"].join("\n") + "\n");

    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);
    const res = await bridge.stageLines({ path: "s.txt", lines: [3] });
    assert.equal(res.ok, true, `staging line 3 succeeds (${res.message ?? ""})`);

    const staged = git("show", ":s.txt").split("\n");
    assert.equal(staged[2], "c-EDIT", "the selected line is staged");
    assert.equal(staged[0], "a", "and the unselected one is not");
  } finally {
    removeTempRepo(root);
  }
});

/**
 * The mode a new file is staged with.
 *
 * `indexMode` returned whatever the index already recorded, and "100644" when
 * there was no index entry at all — which is exactly the brand-new-file case. So
 * staging a new executable script through LINE or HUNK staging recorded it
 * non-executable, and the commit shipped a script that will not run. The
 * ordinary Stage button was never affected: `git add` reads the working tree.
 */
test("a new executable script keeps its bit through line staging", async (t) => {
  if (process.platform === "win32") return t.skip("core.fileMode is off on Windows");
  const { root, git } = repo();
  try {
    writeFileSync(`${root}/seed`, "x\n");
    git("add", "seed");
    git("commit", "-qm", "seed");

    writeFileSync(`${root}/run.sh`, "#!/bin/sh\necho hello\n");
    chmodSync(`${root}/run.sh`, 0o755);

    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);
    const res = await bridge.stageLines({ path: "run.sh", lines: [1, 2] });
    assert.equal(res.ok, true, `staging the new script succeeds (${res.message ?? ""})`);

    const entry = git("ls-files", "-s", "--", "run.sh").trim();
    assert.match(entry, /^100755 /, `it is staged executable, not 100644 (${entry})`);
  } finally {
    removeTempRepo(root);
  }
});

/** A plain (non-executable) new file must not gain a bit it never had. */
test("line staging does not invent an executable bit", async () => {
  const { root, git } = repo();
  try {
    writeFileSync(`${root}/seed`, "x\n");
    git("add", "seed");
    git("commit", "-qm", "seed");
    writeFileSync(`${root}/notes.md`, "# notes\nbody\n");

    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);
    await bridge.stageLines({ path: "notes.md", lines: [1, 2] });

    const entry = git("ls-files", "-s", "--", "notes.md").trim();
    assert.match(entry, /^100644 /, `an ordinary file stays 100644 (${entry})`);
  } finally {
    removeTempRepo(root);
  }
});

/**
 * The coordinate space the selection actually arrives in.
 *
 * `fileDiff` builds EVERY working-tree diff as HEAD vs WORKING, whatever the
 * file's stage state, and `getSelectedLines` reads the RIGHT editor — so the
 * renderer always sends WORKING-tree line numbers. The unstage path matched
 * them against INDEX coordinates, and the comment in the source asserted the
 * opposite ("that pane always shows `original` — the index").
 *
 * The test above cannot catch it: it stages the file and writes nothing
 * afterwards, so the working tree is byte-identical to the index and the two
 * coordinate spaces coincide. It exercises the index↔HEAD shift, which is the
 * axis the old code got right. The broken axis is index↔WORKING, and the shape
 * that reaches it is a file that is staged AND dirty — git's `MM`.
 *
 * Measured on the shipping code before the fix: clicking "X5-STAGED" left it
 * staged and silently rolled back "X15-STAGED", returning ok:true.
 */
test("unstaging uses the WORKING line numbers the diff pane actually shows", async () => {
  const { root, git } = repo();
  try {
    const base = Array.from({ length: 20 }, (_, i) => `X${i + 1}`);
    writeFileSync(`${root}/f.txt`, base.join("\n") + "\n");
    git("add", "f.txt");
    git("commit", "-qm", "base");

    // Two STAGED edits.
    const staged = base.map((l, i) => (i === 4 ? "X5-STAGED" : i === 14 ? "X15-STAGED" : l));
    writeFileSync(`${root}/f.txt`, staged.join("\n") + "\n");
    git("add", "f.txt");

    // …then ten UNSTAGED lines pushed in above them, so working numbering runs
    // ten ahead of index numbering.
    const working = [...Array.from({ length: 10 }, (_, i) => `NEW-${i + 1}`), ...staged];
    writeFileSync(`${root}/f.txt`, working.join("\n") + "\n");
    assert.match(
      git("status", "--porcelain", "--", "f.txt"),
      /^MM /,
      "the file is staged AND dirty — the shape that reaches the broken axis",
    );

    const indexLines = git("show", ":f.txt").split("\n");
    const workingLines = working;
    assert.equal(indexLines.indexOf("X5-STAGED") + 1, 5, "X5-STAGED is index line 5");
    assert.equal(
      workingLines.indexOf("X5-STAGED") + 1,
      15,
      "…and WORKING line 15, which is the number the diff pane shows",
    );

    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);
    // The user clicks "X5-STAGED" where it appears on screen: working line 15.
    const res = await bridge.stageLines({ path: "f.txt", lines: [15], reverse: true });
    assert.equal(res.ok, true, `unstaging it succeeds (${res.message ?? ""})`);

    const after = git("show", ":f.txt");
    assert.ok(!after.includes("X5-STAGED"), "the change they CLICKED is unstaged");
    assert.ok(
      after.includes("X15-STAGED"),
      "and the one they did not click is untouched — this rolled back the wrong change",
    );
  } finally {
    removeTempRepo(root);
  }
});

/** The other symptom of the same cause: a refusal for a line that is right there. */
test("unstaging a lone staged change below an unstaged insertion is not refused", async () => {
  const { root, git } = repo();
  try {
    const base = Array.from({ length: 20 }, (_, i) => `X${i + 1}`);
    writeFileSync(`${root}/f.txt`, base.join("\n") + "\n");
    git("add", "f.txt");
    git("commit", "-qm", "base");

    const staged = base.map((l, i) => (i === 14 ? "X15-STAGED" : l));
    writeFileSync(`${root}/f.txt`, staged.join("\n") + "\n");
    git("add", "f.txt");
    const working = ["NEW-1", "NEW-2", "NEW-3", ...staged];
    writeFileSync(`${root}/f.txt`, working.join("\n") + "\n");

    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);
    // On screen it is line 18; in the index it is line 15.
    const res = await bridge.stageLines({ path: "f.txt", lines: [18], reverse: true });
    assert.equal(res.ok, true, `it is not refused (${res.message ?? ""})`);
    assert.ok(!git("show", ":f.txt").includes("X15-STAGED"), "and it is actually unstaged");
  } finally {
    removeTempRepo(root);
  }
});

/** A line that exists ONLY in the working tree has no staged change under it. */
test("a purely-unstaged line carries no staged change to unstage", async () => {
  const { root, git } = repo();
  try {
    writeFileSync(`${root}/f.txt`, "a\nb\nc\n");
    git("add", "f.txt");
    git("commit", "-qm", "base");
    writeFileSync(`${root}/f.txt`, "a\nB2\nc\n");
    git("add", "f.txt");
    writeFileSync(`${root}/f.txt`, "a\nB2\nc\nNEW\n");

    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);
    const res = await bridge.stageLines({ path: "f.txt", lines: [4], reverse: true });
    assert.equal(res.ok, false, "there is nothing staged there to unstage");
    assert.equal(git("show", ":f.txt"), "a\nB2\nc\n", "and nothing else is touched");
  } finally {
    removeTempRepo(root);
  }
});

/**
 * Line BOUNDARIES (#87, round 2). Select All in a file that ends in a line
 * break stops at column 1 of the empty last row; "Stage lines" sends that
 * row's edge, and a deletion anchored there — the file's last lines removed —
 * is staged with the rest instead of being left out of the commit. An edge
 * never takes a change on the line below it.
 */
test("a boundary stages the end-of-file deletion Select All reaches, and unstages it again", async () => {
  const { root, git } = repo();
  try {
    writeFileSync(`${root}/e.txt`, "a\nb\nc\n");
    git("add", "e.txt");
    git("commit", "-qm", "base");
    writeFileSync(`${root}/e.txt`, "A\nb\n"); // an edit, and 'c' deleted at the end

    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);
    // What the renderer sends for Select All: rows 1-2, the edges 3 and 4.
    const res = await bridge.stageLines({ path: "e.txt", lines: [1, 2], boundaries: [3, 4] });
    assert.equal(res.ok, true, `staging succeeds (${res.message ?? ""})`);
    assert.equal(git("show", ":e.txt"), "A\nb\n", "the edit AND the deletion are staged");

    const back = await bridge.stageLines({ path: "e.txt", lines: [1, 2], boundaries: [3, 4], reverse: true });
    assert.equal(back.ok, true, `unstaging succeeds (${back.message ?? ""})`);
    assert.equal(git("show", ":e.txt"), "a\nb\nc\n", "both are unstaged again");

    // Without the edges, as before: the deletion is not reached.
    await bridge.stageLines({ path: "e.txt", lines: [1, 2] });
    assert.equal(git("show", ":e.txt"), "A\nb\nc\n", "only the edit");
  } finally {
    removeTempRepo(root);
  }
});

test("a boundary in the middle takes the deletion above it, never the edit on its own line", async () => {
  const { root, git } = repo();
  try {
    writeFileSync(`${root}/m.txt`, "a\nb\nc\nd\ne\n");
    git("add", "m.txt");
    git("commit", "-qm", "base");
    writeFileSync(`${root}/m.txt`, "a\nb\nd\nE\n"); // 'c' deleted above 'd'; 'e' edited

    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);
    // Rows a-b dragged by their line numbers: lines 1-2, the edge above row 3.
    const res = await bridge.stageLines({ path: "m.txt", lines: [1, 2], boundaries: [3] });
    assert.equal(res.ok, true, `staging succeeds (${res.message ?? ""})`);
    assert.equal(git("show", ":m.txt"), "a\nb\nd\ne\n", "the deletion of 'c' is staged");
    // The edge above row 4 ('E') does not take the edit on row 4.
    const none = await bridge.stageLines({ path: "m.txt", lines: [3], boundaries: [4] });
    assert.equal(none.ok, false, "nothing to apply: the edit is on the row below the edge");
  } finally {
    removeTempRepo(root);
  }
});

/**
 * The final empty row (#87, round 3), through what the renderer sends for
 * Select All: adding the final line break, an edit plus the final line break,
 * and emptying the last line are changes on the empty row after the last line
 * break. Dropping that row answered "Nothing to apply in the selection." or
 * staged the edit without its line break.
 */
for (const [committed, working, what] of [
  ["foo\nbar", "foo\nbar\n", "adding the final line break"],
  ["foo\nbar", "FOO\nbar\n", "an edit and the final line break"],
  ["foo\nbar", "foo\n", "emptying the last line"],
] as const) {
  test(`Select All ▸ Stage lines stages ${what}, and unstages it again`, async () => {
    const { root, git } = repo();
    try {
      writeFileSync(`${root}/t.txt`, committed);
      git("add", "t.txt");
      git("commit", "-qm", "base");
      writeFileSync(`${root}/t.txt`, working);
      // Monaco's Select All over the working text, and its document end.
      const rows = working.split("\n");
      const end = { lineNumber: rows.length, column: rows[rows.length - 1].length + 1 };
      const all = [{ startLineNumber: 1, startColumn: 1, endLineNumber: end.lineNumber, endColumn: end.column }];
      const lines = selectedLineNumbers(all, end) ?? [];
      const boundaries = selectedBoundaries(all, end) ?? undefined;

      const repos = new RepoStore([]);
      await repos.open(root);
      const bridge = new GitBridge(repos);
      const res = await bridge.stageLines({ path: "t.txt", lines, boundaries });
      assert.equal(res.ok, true, `staging succeeds (${res.message ?? ""})`);
      assert.equal(git("show", ":t.txt"), working, "the whole change is staged");
      const back = await bridge.stageLines({ path: "t.txt", lines, boundaries, reverse: true });
      assert.equal(back.ok, true, `unstaging succeeds (${back.message ?? ""})`);
      assert.equal(git("show", ":t.txt"), committed, "and all of it unstaged");
    } finally {
      removeTempRepo(root);
    }
  });
}

test("a malformed selection from the renderer is no selection, never a TypeError", async () => {
  const { root, git } = repo();
  try {
    writeFileSync(`${root}/v.txt`, "a\nb\n");
    git("add", "v.txt");
    git("commit", "-qm", "base");
    writeFileSync(`${root}/v.txt`, "A\nb\n");
    const repos = new RepoStore([]);
    await repos.open(root);
    const bridge = new GitBridge(repos);
    const odd = await bridge.stageLines({ path: "v.txt", lines: [1], boundaries: "x" as never });
    assert.equal(odd.ok, true, `the boundaries are ignored, the line is staged (${odd.message ?? ""})`);
    assert.equal(git("show", ":v.txt"), "A\nb\n");
    const none = await bridge.stageLines({ path: "v.txt", lines: { length: 1 } as never, boundaries: {} as never });
    assert.equal(none.ok, false);
    assert.equal(none.expected, true, "an expected refusal, not a crash report");
    assert.doesNotMatch(none.message ?? "", /TypeError|is not a function/);
  } finally {
    removeTempRepo(root);
  }
});
