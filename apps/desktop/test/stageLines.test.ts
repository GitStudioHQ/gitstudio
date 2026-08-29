import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import { removeTempRepo } from "./tmpRepo";
import { tmpdir } from "node:os";
import { RepoStore } from "../src/main/repoStore";
import { GitBridge } from "../src/main/gitBridge";

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
