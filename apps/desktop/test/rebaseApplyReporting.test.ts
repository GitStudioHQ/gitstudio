// `rebase:apply` — the Rebase view's Start rebase — through the report rule.
//
// Every other mutation answers `{ ok, message, expected? }`, and main.ts's
// `handle()` files an `ok:false` result unless it is `expected`. The rebase
// workspace answered `{ status: "failed", message }` instead: no `ok` at all,
// so `reportableResultMessage` never saw a failure, and a rebase that failed
// for a reason nobody could name — the runner's editor shim not starting, a
// commit range the app could not read — was never filed.
//
// A failed outcome now carries `ok: false`, and `expected` exactly when the
// refusal is the user's state (the runner's and the plan builder's own
// verdicts, plus the two the bridge makes itself: no repository, and a branch
// that moved under the plan). `filed()` is `handle()`'s decision for a result.

import "./hermeticGit";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { RepoStore } from "../src/main/repoStore";
import { RebaseBridge } from "../src/main/rebaseBridge";
import { reportableResultMessage } from "../src/main/expectedError";
import type { RebaseApplyRequest } from "../src/shared/ipc";

const filed = (result: unknown): string | undefined => reportableResultMessage(result);

async function workspace(): Promise<{
  dir: string;
  repos: RepoStore;
  bridge: RebaseBridge;
  plan: (over?: Partial<RebaseApplyRequest>) => RebaseApplyRequest;
  git: (...a: string[]) => string;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), "gs-rebase-apply-"));
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  for (const name of ["base", "one", "two"]) {
    writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", name);
  }
  const repos = new RepoStore([]);
  await repos.open(dir);
  const rows = git("log", "--format=%H%x1f%s", "HEAD~2..HEAD")
    .split("\n")
    .map((l) => {
      const [sha, subject] = l.split("\x1f");
      return { sha, subject, action: "pick" as const };
    });
  rows[0] = { ...rows[0], action: "reword" as never, message: "two, reworded" } as (typeof rows)[number];
  const headSha = git("rev-parse", "HEAD");
  return {
    dir,
    repos,
    bridge: new RebaseBridge(repos),
    plan: (over = {}) => ({ base: "HEAD~2", rows, headSha, ...over }),
    git,
    cleanup: () => removeTempRepo(dir),
  };
}

test("a rebase run that fails for a reason nobody can name is filed", async () => {
  const w = await workspace();
  try {
    // The runner's editor shim cannot start — in a shipped build, a broken
    // ELECTRON_RUN_AS_NODE or a missing binary. git gives the rebase up.
    const real = w.repos.runnerOptions.bind(w.repos);
    (w.repos as { runnerOptions: () => unknown }).runnerOptions = () => ({
      ...real(),
      nodePath: join(w.dir, "no-such-node"),
    });
    const out = await w.bridge.apply(w.plan());
    assert.equal(out.status, "failed", JSON.stringify(out));
    assert.ok(filed(out), "the IPC wrapper files it");
    assert.equal(w.git("log", "-1", "--format=%s"), "two", "nothing was rewritten");
  } finally {
    w.cleanup();
  }
});

test("a commit range the app could not read is filed too", async () => {
  const w = await workspace();
  try {
    const out = await w.bridge.apply(w.plan({ base: "no-such-base", headSha: undefined }));
    assert.equal(out.status, "failed");
    assert.match(filed(out) ?? "", /full commit range/);
  } finally {
    w.cleanup();
  }
});

test("uncommitted changes, a moved branch and no repository are the user's — shown, not filed", async () => {
  const w = await workspace();
  try {
    writeFileSync(join(w.dir, "one.txt"), "edited\n");
    const dirty = await w.bridge.apply(w.plan());
    assert.equal(dirty.status, "failed");
    assert.equal(dirty.ok, false);
    assert.equal(dirty.expected, true, dirty.message);
    assert.equal(filed(dirty), undefined);
    assert.match(dirty.message ?? "", /uncommitted changes/i);
    w.git("checkout", "--", "one.txt");

    const moved = await w.bridge.apply(w.plan({ headSha: "0".repeat(40) }));
    assert.equal(moved.status, "failed");
    assert.equal(moved.ok, false);
    assert.equal(moved.expected, true);
    assert.equal(filed(moved), undefined);

    const none = await new RebaseBridge({ current: () => undefined, getContext: () => undefined } as unknown as RepoStore).apply(
      w.plan(),
    );
    assert.equal(none.expected, true);
    assert.equal(filed(none), undefined);
  } finally {
    w.cleanup();
  }
});

test("a plan the user composed that git cannot run is shown, not filed; rows nobody composed are filed", async () => {
  const w = await workspace();
  try {
    const all = w.plan();
    const dropAll = await w.bridge.apply({ ...all, rows: all.rows.map((r) => ({ ...r, action: "drop" as const })) });
    assert.equal(dropAll.status, "failed");
    assert.equal(filed(dropAll), undefined, dropAll.message);

    const empty = await w.bridge.apply({ ...all, rows: [] });
    assert.equal(empty.status, "failed");
    assert.ok(filed(empty), "the view never sends a plan with no rows");
  } finally {
    w.cleanup();
  }
});

test("a rebase that runs is still just done", async () => {
  const w = await workspace();
  try {
    const out = await w.bridge.apply(w.plan());
    assert.equal(out.status, "done", JSON.stringify(out));
    assert.equal(filed(out), undefined);
    assert.equal(w.git("log", "-1", "--format=%s"), "two, reworded");
  } finally {
    w.cleanup();
  }
});
