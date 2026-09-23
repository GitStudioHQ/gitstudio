import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitProcess, type GitRunEvent, type GitRunResult, type GitRunWithInputOptions } from "../src/GitProcess";
import { OperationProvider } from "../src/OperationProvider";
import { ConflictOps } from "../src/ConflictOps";
import { removeTempRepo } from "./tmpRepo";
import { makeRepo, FIVE, edit, type Repo } from "./opRepo";

// A git that dies to a SIGNAL — `dispose()` killing it mid-answer, the OS
// reaping it, a user's `kill` — has no exit code. `run()` used to resolve that
// as `code: code ?? 0` with whatever stdout had arrived (usually none), so every
// caller read a killed git as SUCCESS WITH NO OUTPUT: `rev-parse --git-path`
// answered "" (resolved to the repository root), `ls-files -u` answered "nothing
// is unmerged", `diff --quiet` answered "no difference". The contract that
// `run()` never throws on a non-zero exit stays; a signal death is simply not
// a zero exit.

const skip = process.platform === "win32" ? "the stand-in git is a shell script" : false;

/** A stand-in `git`: a shell script with the given body. */
function fakeGit(body: string): { bin: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "gs-fakegit-"));
  const bin = join(dir, "git");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return { bin, dir };
}

test("a git killed by a signal is a failure, not an empty success", { skip }, async () => {
  const { bin, dir } = fakeGit('printf "half an answer"\nkill -TERM $$');
  const events: GitRunEvent[] = [];
  try {
    const proc = new GitProcess({ cwd: dir, gitPath: bin, onRun: (e) => events.push(e) });
    const r = await proc.run(["ls-files", "-u", "-z"]);
    assert.notEqual(r.code, 0, "a signal death must not read as exit 0");
    assert.equal(r.code, 128 + 15, "the shell's convention: 128 + the signal number");
    assert.match(r.stderr, /SIGTERM/, "and stderr says what happened, for callers that show it");
    assert.equal(events.length, 1);
    assert.equal(events[0].failed, true, "the Output log records it as a failure");
  } finally {
    removeTempRepo(dir);
  }
});

test("dispose() mid-answer resolves the pending run as a failure", { skip }, async () => {
  const { bin, dir } = fakeGit("sleep 5\necho late");
  try {
    const proc = new GitProcess({ cwd: dir, gitPath: bin });
    const pending = proc.run(["rev-parse", "--git-path", "refs"]);
    await new Promise((r) => setTimeout(r, 150));
    proc.dispose();
    const r = await pending;
    assert.notEqual(r.code, 0, "the answer of a git we killed is not a success");
    assert.equal(r.stdout, "");
  } finally {
    removeTempRepo(dir);
  }
});

test("stream() fails when git is killed by a signal, rather than ending quietly", { skip }, async () => {
  const { bin, dir } = fakeGit('printf "a\\n"\nkill -TERM $$');
  try {
    const proc = new GitProcess({ cwd: dir, gitPath: bin });
    const got: string[] = [];
    await assert.rejects(
      (async () => {
        for await (const chunk of proc.stream(["log"])) got.push(chunk);
      })(),
      /SIGTERM/,
      "a truncated stream must not look like the whole history",
    );
  } finally {
    removeTempRepo(dir);
  }
});

// ── The callers that read a killed git as "nothing there" ───────────────────

/** A real git, except `ls-files -u` dies to a signal the way dispose() kills it. */
class KilledListing extends GitProcess {
  override async run(args: string[], opts?: GitRunWithInputOptions): Promise<GitRunResult> {
    if (args[0] === "ls-files" && args.includes("-u")) {
      return { code: 128 + 15, stdout: "", stderr: "git was stopped by SIGTERM before it finished." };
    }
    return super.run(args, opts);
  }
}

function conflicted(): Repo {
  const r = makeRepo("killed");
  r.write("f.txt", FIVE);
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "side");
  r.write("f.txt", edit(FIVE, { three: "three-side" }));
  r.commitAll("side");
  r.git("checkout", "-q", "master");
  r.write("f.txt", edit(FIVE, { three: "three-master" }));
  r.commitAll("master");
  r.tryGit("merge", "side");
  return r;
}

test("an unreadable conflict listing is an error, never 'nothing is conflicted'", async () => {
  const r = conflicted();
  try {
    const ctx = r.ctx();
    const proc = new KilledListing({ cwd: r.root });
    const provider = new OperationProvider(proc, r.root);
    await assert.rejects(provider.view(), /stopped|unmerged/, "the view must not report 0 unmerged files");
    const ops = new ConflictOps(proc, r.root, ctx.conflict, ctx.operation);
    await assert.rejects(ops.conflictFiles(), /stopped|conflict/, "the dashboard must not list no rows");
    await assert.rejects(ops.snapshot(), /stopped|conflict/);
    await assert.rejects(ops.fileFacts("f.txt"), /stopped|conflict/, "…nor call a conflicted file settled");
    // The real listing still answers, so this is the wrapper and not the repo.
    assert.equal((await ctx.conflictOps.conflictFiles()).length, 1);
  } finally {
    r.cleanup();
  }
});

/** A real git, except the one command matching `pick` dies to a signal. */
class KilledOne extends GitProcess {
  constructor(
    cwd: string,
    private readonly pick: (args: string[]) => boolean,
  ) {
    super({ cwd });
  }
  override async run(args: string[], opts?: GitRunWithInputOptions): Promise<GitRunResult> {
    if (this.pick(args)) return { code: 128 + 15, stdout: "", stderr: "git was stopped by SIGTERM before it finished." };
    return super.run(args, opts);
  }
}

test("a Continue gate whose check was killed fails closed, not open", async () => {
  const r = conflicted();
  try {
    // Resolved by `git add` with the markers still in the file: the staged-
    // marker gate is the only thing between this and a commit of markers.
    r.git("add", "f.txt");
    const real = await r.ctx().operation.view();
    assert.equal(real.canContinue, false, "precondition: the real gate blocks");
    for (const [what, pick] of [
      ["diff --cached --check", (a: string[]) => a.includes("--check")],
      ["ls-files --resolve-undo", (a: string[]) => a[0] === "ls-files" && a.includes("--resolve-undo")],
    ] as const) {
      const provider = new OperationProvider(new KilledOne(r.root, pick), r.root);
      const view = await provider.view().catch(() => undefined);
      assert.ok(!view || view.canContinue === false, `a killed ${what} must not open the gate`);
    }
  } finally {
    r.cleanup();
  }
});

test("an ordinary non-zero exit still resolves (run never throws on a refusal)", { skip }, async () => {
  const { bin, dir } = fakeGit('echo "fatal: no" >&2\nexit 1');
  try {
    const proc = new GitProcess({ cwd: dir, gitPath: bin });
    const r = await proc.run(["status"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /fatal: no/);
  } finally {
    removeTempRepo(dir);
  }
});
