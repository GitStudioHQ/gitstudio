import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localNameFor, planRemoteCheckout } from "../src/checkoutRemote";

// "Check out origin/fix/1.0.1-quality" used to open a rename prompt pre-filled
// with the name it had already worked out. It goes straight to the branch now.
//
// These tests run the planned argv against real git, because the whole point of
// planning instead of leaning on `git checkout <short>` DWIM is that DWIM is
// conditional — off under `checkout.guess=false`, refused when two remotes
// carry the same branch name. Both of those are pinned below.

// Hermetic git, for the reason the extension's opInProgress test spells out:
// a developer's global config brings LFS filters, hooks, and a trace2 listener
// that writes to the repo after the command exits and races teardown.
const HERMETIC_CFG = join(mkdtempSync(join(tmpdir(), "gs-co-cfg-")), "config");
writeFileSync(HERMETIC_CFG, "");

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: HERMETIC_CFG,
  GIT_CONFIG_SYSTEM: HERMETIC_CFG,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TRACE2: undefined,
  GIT_TRACE2_EVENT: undefined,
  GIT_TRACE2_PERF: undefined,
};

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: GIT_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number };
    return { code: err.status ?? 1, out: "" };
  }
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* the OS tmpdir gets swept anyway */
  }
}

function init(dir: string): void {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "T");
}

/**
 * A clone whose `origin` carries `main`, `release/1.5` (a slash IN the branch
 * name) and `fix/1.0.1-quality`. Returns the clone; the upstream is a sibling.
 */
function cloneWithRemoteBranches(): { dir: string; upstream: string } {
  const upstream = mkdtempSync(join(tmpdir(), "gs-co-up-"));
  init(upstream);
  writeFileSync(join(upstream, "f.txt"), "base\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "base");
  for (const b of ["release/1.5", "fix/1.0.1-quality"]) {
    git(upstream, "branch", b);
  }

  const dir = mkdtempSync(join(tmpdir(), "gs-co-"));
  init(dir);
  git(dir, "remote", "add", "origin", upstream);
  git(dir, "fetch", "-q", "origin");
  git(dir, "checkout", "-q", "-B", "main", "origin/main");
  return { dir, upstream };
}

/** Drive the shipped planner against a real repo, then run what it planned. */
async function checkout(dir: string, remoteRef: string) {
  const plan = await planRemoteCheckout(
    { run: async (args) => git(dir, ...args) },
    remoteRef,
  );
  return { plan, result: git(dir, ...plan.args) };
}

const head = (dir: string): string =>
  git(dir, "rev-parse", "--abbrev-ref", "HEAD").out.trim();
const upstreamOf = (dir: string, branch: string): string =>
  git(dir, "rev-parse", "--abbrev-ref", `${branch}@{upstream}`).out.trim();

test("a remote branch checks out onto a tracking local branch, no questions", async () => {
  const { dir, upstream } = cloneWithRemoteBranches();
  try {
    const { plan, result } = await checkout(dir, "origin/fix/1.0.1-quality");

    assert.equal(result.code, 0, "the planned argv must actually work");
    assert.equal(plan.local, "fix/1.0.1-quality");
    assert.equal(head(dir), "fix/1.0.1-quality", "and we are ON it, not detached");
    assert.equal(
      upstreamOf(dir, "fix/1.0.1-quality"),
      "origin/fix/1.0.1-quality",
      "tracking is the whole reason this is not a plain checkout",
    );
    assert.match(plan.success, /tracking origin\/fix\/1\.0\.1-quality/);
  } finally {
    cleanup(dir);
    cleanup(upstream);
  }
});

test("only the REMOTE is stripped — a branch name may contain slashes", () => {
  // Slicing at the last slash would check out "1.5".
  assert.equal(localNameFor("origin/release/1.5"), "release/1.5");
  assert.equal(localNameFor("origin/main"), "main");
  assert.equal(localNameFor("upstream/fix/1.0.1-quality"), "fix/1.0.1-quality");
  // A bare name (no remote prefix at all) is left alone rather than emptied.
  assert.equal(localNameFor("main"), "main");
});

test("a slash-bearing branch lands on the full name", async () => {
  const { dir, upstream } = cloneWithRemoteBranches();
  try {
    const { result } = await checkout(dir, "origin/release/1.5");
    assert.equal(result.code, 0);
    assert.equal(head(dir), "release/1.5");
    assert.equal(upstreamOf(dir, "release/1.5"), "origin/release/1.5");
  } finally {
    cleanup(dir);
    cleanup(upstream);
  }
});

test("an existing local branch is switched to, not re-created", async () => {
  // `checkout -b` fails outright here ("branch already exists"), which is why
  // the planner asks before choosing.
  const { dir, upstream } = cloneWithRemoteBranches();
  try {
    git(dir, "checkout", "-q", "-b", "fix/1.0.1-quality", "origin/fix/1.0.1-quality");
    git(dir, "checkout", "-q", "main");

    const { plan, result } = await checkout(dir, "origin/fix/1.0.1-quality");
    assert.equal(result.code, 0, "must not fail on an existing branch");
    assert.equal(head(dir), "fix/1.0.1-quality");
    assert.equal(plan.success, "Switched to fix/1.0.1-quality");
  } finally {
    cleanup(dir);
    cleanup(upstream);
  }
});

test("tracking is set even where autoSetupMerge is off", async () => {
  // `--track` is explicit for this reason: a user who turned the default off
  // would otherwise get a local branch with no upstream, and every later
  // push/pull would ask them to name one.
  const { dir, upstream } = cloneWithRemoteBranches();
  try {
    git(dir, "config", "branch.autoSetupMerge", "false");
    const { result } = await checkout(dir, "origin/release/1.5");
    assert.equal(result.code, 0);
    assert.equal(upstreamOf(dir, "release/1.5"), "origin/release/1.5");
  } finally {
    cleanup(dir);
    cleanup(upstream);
  }
});

test("works where `git checkout <short>` DWIM would not", async () => {
  const { dir, upstream } = cloneWithRemoteBranches();
  try {
    // 1. DWIM disabled by config — the plan is explicit, so it does not care.
    git(dir, "config", "checkout.guess", "false");
    assert.equal(
      git(dir, "checkout", "-q", "release/1.5").code,
      1,
      "precondition: bare DWIM is refused under checkout.guess=false",
    );
    assert.equal((await checkout(dir, "origin/release/1.5")).result.code, 0);
    git(dir, "checkout", "-q", "main");
    git(dir, "config", "--unset", "checkout.guess");

    // 2. Two remotes carrying the same branch name — git refuses to guess, and
    //    rightly so. Naming the ref says which one the user clicked.
    git(dir, "remote", "add", "mirror", upstream);
    git(dir, "fetch", "-q", "mirror");
    assert.equal(
      git(dir, "checkout", "-q", "fix/1.0.1-quality").code,
      128,
      "precondition: bare DWIM is ambiguous across two remotes",
    );

    const { result } = await checkout(dir, "mirror/fix/1.0.1-quality");
    assert.equal(result.code, 0);
    assert.equal(head(dir), "fix/1.0.1-quality");
    assert.equal(upstreamOf(dir, "fix/1.0.1-quality"), "mirror/fix/1.0.1-quality");
  } finally {
    cleanup(dir);
    cleanup(upstream);
  }
});
