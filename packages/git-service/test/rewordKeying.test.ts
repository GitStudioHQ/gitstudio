import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { removeTempRepo } from "./tmpRepo";
import { tmpdir } from "node:os";
import { buildRebasePlan } from "../src/rebasePlan";
import { runRebasePlan, continueRebase } from "../src/RebaseRunner";

/**
 * Reword messages are selected BY COMMIT, and an unkeyed entry matches nothing.
 *
 * The installer looks a message up by the sha in git's own `rebase-merge/done`.
 * A compatibility shim once minted `{ sha: "", message }` for callers still on
 * the positional shape — and `anySha.startsWith("")` is true, so slot 0 matched
 * EVERY commit: every reword got the first message and commits nobody reworded
 * were renamed. Measured on the extension's shape at the time:
 *
 *   desktop (keyed)      LOG: RENAMED-C | B | RENAMED-A     (correct)
 *   extension (unkeyed)  LOG: RENAMED-A | B | RENAMED-A     (wrong)
 *
 * `RebasePlan.rewords` is required now, so the compiler finds a caller left
 * behind — and this pins the other half: an entry without a real key is inert
 * rather than universal.
 */
function repo(): { root: string; git: (...a: string[]) => string } {
  const root = mkdtempSync(`${tmpdir()}/gs-rewordkey-`);
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "gc.auto", "0");
  for (const n of ["m1", "A", "B", "C"]) {
    writeFileSync(`${root}/${n}.txt`, `${n}\n`);
    git("add", "-A");
    git("commit", "-qm", n);
    if (n === "m1") git("branch", "trunk");
  }
  return { root, git };
}

const shas = (root: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of execFileSync("git", ["log", "--format=%H %s", "trunk..HEAD"], { cwd: root })
    .toString()
    .trim()
    .split("\n")) {
    const [sha, ...rest] = line.split(" ");
    out[rest.join(" ")] = sha;
  }
  return out;
};

test("two rewords land on their own commits, not both on the first", async () => {
  const { root, git } = repo();
  try {
    const s = shas(root);
    // Display order is newest-first.
    const built = buildRebasePlan([
      { sha: s.C, action: "reword", subject: "C", message: "RENAMED-C" },
      { sha: s.B, action: "pick", subject: "B" },
      { sha: s.A, action: "reword", subject: "A", message: "RENAMED-A" },
    ]);
    assert.ok(built.ok, built.ok ? "" : built.message);

    const out = await runRebasePlan(root, { base: "trunk", todo: built.todo, rewords: built.rewords });
    assert.equal(out.status, "done", out.status === "done" ? "" : out.message);
    assert.deepEqual(
      git("log", "--format=%s", "trunk..HEAD").trim().split("\n"),
      ["RENAMED-C", "B", "RENAMED-A"],
      "each message on its own commit, and B untouched",
    );
  } finally {
    removeTempRepo(root);
  }
});

test("an entry with no real key renames nothing — not even a conflicted pick", async () => {
  // The editor only runs for a `reword`… and for whatever commit a rebase
  // STOPS on, when the user continues. That is the shape the wildcard hit: a
  // plain `pick` that conflicted, continued, and came back renamed.
  const root = mkdtempSync(`${tmpdir()}/gs-rewordkey2-`);
  try {
    const git = (...a: string[]): string => execFileSync("git", a, { cwd: root }).toString();
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("config", "gc.auto", "0");
    writeFileSync(`${root}/shared.txt`, "base\n");
    git("add", "-A");
    git("commit", "-qm", "m1");
    git("branch", "trunk");
    git("checkout", "-qb", "feature");
    writeFileSync(`${root}/shared.txt`, "feature\n");
    git("commit", "-qam", "MY-REAL-MESSAGE");
    git("checkout", "-q", "trunk");
    writeFileSync(`${root}/shared.txt`, "trunk\n");
    git("commit", "-qam", "m2");
    git("checkout", "-q", "feature");

    const sha = git("rev-parse", "HEAD").trim();
    const built = buildRebasePlan([{ sha, action: "pick", subject: "MY-REAL-MESSAGE" }]);
    assert.ok(built.ok, built.ok ? "" : built.message);

    // The shape the compatibility shim used to produce.
    const out = await runRebasePlan(root, {
      base: "trunk",
      todo: built.todo,
      rewords: [{ sha: "", message: "WILDCARD" }],
    });
    assert.equal(out.status, "stopped", "it conflicts");

    writeFileSync(`${root}/shared.txt`, "resolved\n");
    git("add", "shared.txt");
    const cont = await continueRebase(root);
    assert.equal(cont.status, "done", cont.status === "done" ? "" : cont.message);

    assert.equal(
      git("log", "-1", "--format=%s", "HEAD").trim(),
      "MY-REAL-MESSAGE",
      "an unkeyed message is inert — the commit keeps its own",
    );
  } finally {
    removeTempRepo(root);
  }
});
