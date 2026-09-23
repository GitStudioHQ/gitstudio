// Which failed rebase runs are ours to hear about, and which are the user's.
//
// The rebase workspace — the desktop's Rebase view, the extension's rebase
// panel, the extension's drag-to-reorder — ends in a RebaseOutcome, and a
// `failed` one was never crash-reported by either product: the desktop's
// `rebase:apply` answers `{status}`, which the IPC wrapper's report rule never
// reads, and the extension's panel posted it to the webview and stopped. So a
// genuine failure — the runner's own editor shim not starting, a request
// naming a base that does not exist — went unheard.
//
// Routing every failure to the reporter would be the opposite mistake, so the
// runner now says which failures are the USER's state (`expected`), and both
// hosts apply one rule, `reportableRebaseFailure`:
//
//   · a rebase already under way — refused before anything is written;
//   · uncommitted changes to tracked files — git refuses them too ("cannot
//     rebase: You have unstaged changes"), but only after the runner has
//     written the reword queue, and in git's words; the runner now refuses
//     first, in the app's, from `git status` rather than git's English.
//
// Everything else that fails is reported.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { buildRebasePlan } from "../src/rebasePlan";
import { reportableRebaseFailure, runRebasePlan, type RebaseOutcome } from "../src/RebaseRunner";

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

function repo(): { dir: string; git: (...a: string[]) => string; plan: () => Parameters<typeof runRebasePlan>[1] } {
  const dir = mkdtempSync(join(tmpdir(), "gs-rebase-verdict-"));
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: ENV }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: ENV });
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  for (const name of ["base", "one", "two"]) {
    writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", name);
  }
  const plan = () => {
    // Reword the newest commit — a plan that writes the reword queue, so the
    // up-front refusal can be seen to have written nothing.
    const rows = git("log", "--format=%H%x1f%s", "HEAD~2..HEAD")
      .split("\n")
      .map((l) => {
        const [sha, subject] = l.split("\x1f");
        return { sha, subject, action: "pick" };
      });
    rows[0] = { ...rows[0], action: "reword", message: "two, reworded" } as (typeof rows)[number];
    const built = buildRebasePlan(rows);
    assert.ok(built.ok, built.ok ? "" : built.message);
    return { base: "HEAD~2", todo: built.todo, rewords: built.rewords };
  };
  return { dir, git, plan };
}

function rebaseDirs(dir: string): boolean {
  return existsSync(join(dir, ".git", "rebase-merge")) || existsSync(join(dir, ".git", "rebase-apply"));
}

test("uncommitted changes are refused up front, in the app's words, and are not a report", async () => {
  const { dir, git, plan } = repo();
  try {
    for (const stage of [false, true]) {
      writeFileSync(join(dir, "one.txt"), "one, edited\n");
      if (stage) git("add", "one.txt");
      const out = await runRebasePlan(dir, plan());
      const label = stage ? "staged" : "unstaged";
      assert.equal(out.status, "failed", label);
      assert.equal(out.status === "failed" && out.expected, true, `${label}: a state of the user's repository`);
      assert.equal(reportableRebaseFailure(out), undefined, `${label}: not crash-report material`);
      const message = out.status === "failed" ? out.message : "";
      assert.match(message, /uncommitted changes/i, label);
      assert.match(message, /commit or stash/i, label);
      assert.doesNotMatch(message, /^(error|fatal):/i, `${label}: not git's terminal line`);
      assert.equal(rebaseDirs(dir), false, `${label}: nothing started`);
      assert.equal(existsSync(join(dir, ".git", "gitstudio-reword-queue.json")), false, `${label}: no reword queue left`);
      assert.equal(git("log", "-1", "--format=%s"), "two", `${label}: history untouched`);
      git("reset", "-q", "--hard");
    }
  } finally {
    removeTempRepo(dir);
  }
});

test("untracked files alone do not stop a rebase — git does not refuse them either", async () => {
  const { dir, git, plan } = repo();
  try {
    writeFileSync(join(dir, "scratch.txt"), "not tracked\n");
    const out = await runRebasePlan(dir, plan());
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.equal(git("log", "-1", "--format=%s"), "two, reworded");
  } finally {
    removeTempRepo(dir);
  }
});

test("with rebase.autoStash, uncommitted changes are git's to stash — the run is not refused", async () => {
  // git stashes around the rebase and puts the edit back. The run worked for
  // these users before the up-front refusal existed; refusing them now would
  // be the app saying "commit or stash first" about changes git was about to
  // stash itself.
  const { dir, git, plan } = repo();
  try {
    git("config", "rebase.autoStash", "true");
    writeFileSync(join(dir, "one.txt"), "one, edited\n");
    const out = await runRebasePlan(dir, plan());
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.equal(git("log", "-1", "--format=%s"), "two, reworded", "the plan ran");
    assert.equal(git("diff", "--name-only"), "one.txt", "…and the edit is back where it was");
  } finally {
    removeTempRepo(dir);
  }
});

test("a rebase already under way is refused as the user's state", async () => {
  const { dir, git, plan } = repo();
  try {
    // A paused rebase: an `edit` stop is the cleanest way to leave one live.
    execFileSync("git", ["rebase", "-i", "HEAD~1"], {
      cwd: dir,
      env: { ...ENV, GIT_SEQUENCE_EDITOR: "sed -i.bak 's/^pick/edit/'" },
      stdio: "ignore",
    });
    assert.ok(rebaseDirs(dir), "precondition: a rebase is paused");
    const out = await runRebasePlan(dir, plan());
    assert.equal(out.status, "failed");
    assert.equal(out.status === "failed" && out.expected, true);
    assert.equal(reportableRebaseFailure(out), undefined);
    git("rebase", "--abort");
  } finally {
    removeTempRepo(dir);
  }
});

test("a failure that is nobody's state is reported — a base that does not exist", async () => {
  const { dir, plan } = repo();
  try {
    const out = await runRebasePlan(dir, { ...plan(), base: "no-such-base" });
    assert.equal(out.status, "failed");
    assert.notEqual(out.status === "failed" && out.expected, true);
    assert.match(reportableRebaseFailure(out) ?? "", /no-such-base/);
    assert.equal(rebaseDirs(dir), false);
  } finally {
    removeTempRepo(dir);
  }
});

test("…and so is the runner's own editor shim failing to start", async () => {
  const { dir, git, plan } = repo();
  try {
    const out = await runRebasePlan(dir, plan(), { nodePath: join(dir, "no-such-node") });
    assert.equal(out.status, "failed", JSON.stringify(out));
    assert.ok(reportableRebaseFailure(out), "ours to hear about");
    assert.equal(rebaseDirs(dir), false, "git gave the rebase up");
    assert.equal(git("log", "-1", "--format=%s"), "two");
  } finally {
    removeTempRepo(dir);
  }
});

test("only a failure is ever reported", () => {
  const outcomes: RebaseOutcome[] = [
    { status: "done" },
    { status: "stopped", reason: "conflict", message: "CONFLICT (content): Merge conflict in a.txt" },
    { status: "stopped", reason: "edit", message: "Rebase paused for editing." },
  ];
  for (const o of outcomes) assert.equal(reportableRebaseFailure(o), undefined, o.status);
  assert.equal(reportableRebaseFailure({ status: "failed", message: "" }), "Rebase failed.", "never a blank report");
});
