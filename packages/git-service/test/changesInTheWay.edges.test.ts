// runApplying at its edges: the refusals that are NOT the user's changes in
// the way (a name git can't resolve, a parent the merge doesn't have, git's
// autostash), the stash that left the list while git was stopped, a root
// commit, several commits whose touch can't be read, and the moments git can't
// say what the tree holds — where nothing is ever claimed.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, type Repo } from "./opRepo";
import { GitProcess } from "../src/GitProcess";
import {
  changesInTheWayMessage,
  checkoutOp,
  runApplying,
  type ApplyOp,
} from "../src/changesInTheWay";
import { cmd, fail, tap, type Rule } from "./stashProvider.kit";

const repos: Repo[] = [];
const procs: { dispose(): void }[] = [];
after(() => {
  for (const p of procs.splice(0)) p.dispose();
  for (const r of repos.splice(0)) r.cleanup();
});

const signal = new AbortController().signal;

const LINES = (tag: string, at: number): string =>
  Array.from({ length: 9 }, (_, i) => (i === at ? `${tag}\n` : `line ${i}\n`)).join("");

/**
 * master:  base (a.txt, b.txt) → "master changes b"
 * feature: base → "feature changes a" → "feature adds c"
 * master checked out.
 */
function repo(name: string): Repo {
  const r = makeRepo(name);
  repos.push(r);
  r.write("a.txt", LINES("line 0", 0));
  r.write("b.txt", LINES("line 0", 0));
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "feature");
  r.write("a.txt", LINES("feature", 0));
  r.commitAll("feature changes a");
  r.write("c.txt", "new\n");
  r.commitAll("feature adds c");
  r.git("checkout", "-q", "master");
  r.write("b.txt", LINES("master", 0));
  r.commitAll("master changes b");
  return r;
}

function procOf(r: Repo, rule?: Rule): GitProcess {
  if (!rule) {
    const p = new GitProcess({ cwd: r.root });
    procs.push(p);
    return p;
  }
  const t = tap(r.root, rule);
  procs.push(t);
  return t.proc;
}

const status = (r: Repo): string => r.git("status", "--porcelain").trim();
const pickOf = (r: Repo, ref: string, extra: string[] = []): ApplyOp => {
  const commit = r.sha(ref);
  return { kind: "cherry-pick", commit, args: ["cherry-pick", ...extra, commit] };
};

// ── Words ──────────────────────────────────────────────────────────────────

test("checkoutOp's target is the argv's last word, HEAD for none", () => {
  assert.deepEqual(checkoutOp(["checkout", "feature"]), { kind: "checkout", target: "feature", args: ["checkout", "feature"] });
  assert.deepEqual(checkoutOp([]), { kind: "checkout", target: "HEAD", args: [] });
});

test("the sentence counts the files it doesn't name, one or many", () => {
  assert.match(
    changesInTheWayMessage({ kind: "merge", paths: ["a", "b", "c"], untracked: [] }),
    /^Your uncommitted changes to a, b and 1 other file are in the way of the merge — git won't overwrite them\. Stash them/,
  );
  assert.match(
    changesInTheWayMessage({ kind: "checkout", paths: ["a", "b", "c", "d"], untracked: [] }),
    /to a, b and 2 other files are in the way of switching to it/,
  );
  assert.equal(
    changesInTheWayMessage({ kind: "stash", paths: ["x.txt"], untracked: [], branch: "rescue" }),
    "Your uncommitted changes to x.txt are in the way of creating the branch “rescue” from the stash, which first " +
      "switches to where the stash was made. Stash it and try again, or commit it first.",
  );
  assert.match(
    changesInTheWayMessage({ kind: "pull", paths: ["a", "b"], untracked: [], rebase: true }),
    /^Pulling with rebase needs a clean working tree, and your uncommitted changes to a and b are in the way\. Stash them/,
  );
});

// ── Over a stop ────────────────────────────────────────────────────────────

test("a stash named by a sha that has left the list, over a stopped merge, is not run: gone", async () => {
  const r = repo("stop-gone");
  r.git("checkout", "-q", "-b", "clash", "master~1");
  r.write("b.txt", LINES("clash", 0));
  r.commitAll("clash changes b");
  r.git("checkout", "-q", "master");
  assert.notEqual(r.tryGit("merge", "clash"), 0, "the merge stops on b.txt");
  const before = r.git("ls-files", "-u");
  const t = tap(r.root, () => undefined);
  procs.push(t);
  const out = await runApplying(t.proc, { kind: "stash", stash: "e".repeat(40) }, { signal });
  assert.equal(out.stashGone, true);
  assert.equal(out.result.code, 1);
  assert.equal(t.ran.some((a) => a[0] === "stash" && a[1] !== "list"), false, "no stash command ran");
  assert.equal(r.git("ls-files", "-u"), before, "the stop is as it was");
});

// ── Refusals that are the user's edits ────────────────────────────────────

test("a revert of the ROOT commit over an edit to a file it added: the edit is in the way", async () => {
  const r = repo("root-revert");
  const root = r.git("rev-list", "--max-parents=0", "HEAD").trim();
  r.write("a.txt", "my edit\n");
  const head = r.sha("HEAD");
  const out = await runApplying(procOf(r), { kind: "revert", commit: root, args: ["revert", "--no-edit", root] });
  assert.notEqual(out.result.code, 0);
  assert.deepEqual(out.inTheWay, { kind: "revert", paths: ["a.txt"], untracked: [] });
  assert.equal(r.sha("HEAD"), head);
  assert.equal(r.read("a.txt"), "my edit\n");
});

test("several commits whose touch git can't read: only the staged changes are claimed", async () => {
  const r = repo("many-unknown");
  const commits = [r.sha("feature~1"), r.sha("feature")];
  const op: ApplyOp = { kind: "cherry-pick", commit: commits[0], commits, args: ["cherry-pick", ...commits] };
  r.write("b.txt", LINES("staged", 5));
  r.git("add", "b.txt");
  r.write("a.txt", LINES("mine", 3)); // feature~1 changes a.txt

  const known = await runApplying(procOf(r), op);
  assert.deepEqual(known.inTheWay?.paths, ["a.txt", "b.txt"], "read: the staged file and the edit a commit touches");

  const blind = await runApplying(
    procOf(r, (a) => (a[0] === "rev-list" && a[4] === commits[1] ? fail("fatal: bad") : undefined)),
    op,
  );
  assert.deepEqual(blind.inTheWay, { kind: "cherry-pick", paths: ["b.txt"], untracked: [] });
  assert.equal(blind.result.code, 1, "asked before git ran: nothing was picked");
  assert.equal(r.git("rev-parse", "HEAD").trim(), r.sha("master"));
});

// ── Refusals that are NOT the user's edits ────────────────────────────────

test("a merge of a name git can't resolve is git's own failure, never the edits' — merge.autoStash off or not", async () => {
  const r = repo("merge-unknown");
  r.git("config", "merge.autoStash", "false");
  r.write("a.txt", "edit\n");
  const out = await runApplying(procOf(r), { kind: "merge", target: "no-such-branch", args: ["merge", "no-such-branch"] }, { signal });
  assert.notEqual(out.result.code, 0);
  assert.equal(out.inTheWay, undefined);
  assert.equal(r.read("a.txt"), "edit\n");
});

test("a pick with a mainline the merge commit doesn't have is git's failure, not the edit's", async () => {
  const r = repo("mainline");
  r.git("checkout", "-q", "-b", "merged", "master");
  r.git("merge", "-q", "--no-edit", "feature");
  const merge = r.sha("HEAD");
  r.git("checkout", "-q", "master");
  r.write("a.txt", "edit the merge touches\n");
  const out = await runApplying(procOf(r), { kind: "cherry-pick", commit: merge, mainline: 3, args: ["cherry-pick", "-m", "3", merge] });
  assert.notEqual(out.result.code, 0);
  assert.equal(out.inTheWay, undefined);
});

test("a pick of a commit git can't find, over an unstaged edit, claims nothing", async () => {
  const r = repo("pick-unknown");
  r.write("a.txt", "edit\n");
  const ghost = "f".repeat(40);
  const out = await runApplying(procOf(r), { kind: "cherry-pick", commit: ghost, args: ["cherry-pick", ghost] });
  assert.notEqual(out.result.code, 0);
  assert.equal(out.inTheWay, undefined);
});

test("with rebase.autoStash git stashes by itself, so a failed rebase is never the edits'", async () => {
  const r = repo("rebase-autostash");
  r.git("config", "rebase.autoStash", "true");
  r.write("a.txt", "edit\n");
  const out = await runApplying(procOf(r), { kind: "rebase", onto: "no-such-base", args: ["rebase", "no-such-base"] });
  assert.notEqual(out.result.code, 0);
  assert.equal(out.inTheWay, undefined);
});

// touchedBy returns null for an unresolvable ref ("then the failure was
// something else"), but the rebase branch of changesInTheWay used to add every
// staged and unstaged change regardless — so `git rebase no-such-base` over any
// edit was reported as the edit being in the way, and Stash & Retry stashed it
// for a command that can never run.
test("a rebase onto a name git can't resolve is git's failure ('invalid upstream'), not the edits in the way", async () => {
  const r = repo("rebase-unknown");
  r.write("a.txt", "edit\n");
  const out = await runApplying(procOf(r), { kind: "rebase", onto: "no-such-base", args: ["rebase", "no-such-base"] });
  assert.equal(out.result.code, 128);
  assert.equal(out.inTheWay, undefined, "git refused the name before it looked at the tree");
});

// The twin: a pick or revert claimed every STAGED change whatever it touched,
// and git refuses a commit it cannot find ("bad revision") before the index.
test("a pick or revert of a commit git can't find, over a STAGED edit, claims nothing", async () => {
  for (const kind of ["cherry-pick", "revert"] as const) {
    const r = repo(`${kind}-unknown-staged`);
    r.write("a.txt", "edit\n");
    r.git("add", "a.txt");
    const ghost = "f".repeat(40);
    const out = await runApplying(procOf(r), { kind, commit: ghost, args: [kind, ghost] });
    assert.equal(out.result.code, 128, kind);
    assert.equal(out.inTheWay, undefined, `${kind}: git refused the name before it looked at the index`);
    assert.equal(status(r), "M  a.txt", `${kind}: the staging is untouched`);
  }
});

test("several commits, one git can't find, over a staged edit: git refuses the run by name, and nothing is asked", async () => {
  const r = repo("many-unknown-staged");
  r.write("b.txt", "edit\n");
  r.git("add", "b.txt");
  const one = r.sha("feature~1");
  const ghost = "f".repeat(40);
  const out = await runApplying(procOf(r), {
    kind: "cherry-pick",
    commit: one,
    commits: [one, ghost],
    args: ["cherry-pick", one, ghost],
  });
  assert.equal(out.result.code, 128);
  assert.equal(out.inTheWay, undefined);
  assert.equal(r.sha("HEAD"), r.sha("master"), "nothing was picked");
  assert.equal(status(r), "M  b.txt");
});

// ── When git can't say ─────────────────────────────────────────────────────

test("when git can't read the status, a refused pick is handed back as git's, and nothing is claimed", async () => {
  const r = repo("status-unknown");
  r.write("a.txt", "edit the pick touches\n");
  const out = await runApplying(procOf(r, (a) => (a[0] === "status" ? fail("fatal: bad") : undefined)), pickOf(r, "feature~1"));
  assert.notEqual(out.result.code, 0);
  assert.equal(out.inTheWay, undefined);
  assert.equal(r.read("a.txt"), "edit the pick touches\n");
});

/** A -u stash of an edit to a.txt and an untracked u.txt; the tree clean afterwards. */
function uStash(r: Repo): string {
  r.write("a.txt", LINES("stashed", 4));
  r.write("u.txt", "untracked\n");
  r.git("stash", "push", "-q", "-u");
  return r.git("rev-parse", "refs/stash").trim();
}

test("a -u stash asked about when git can't read the status or the stash's own changes: git decides, nothing is claimed", async () => {
  for (const blind of ["status", "own-diff"] as const) {
    const r = repo(`u-${blind}`);
    const sha = uStash(r);
    const rule: Rule =
      blind === "status"
        ? (a) => (a[0] === "status" ? fail("fatal: bad") : undefined)
        : (a) => (cmd(a) === `diff --name-only -z --no-renames ${sha}^1 ${sha} --` ? fail("fatal: bad") : undefined);
    const out = await runApplying(procOf(r, rule), { kind: "stash", stash: sha });
    assert.equal(out.result.code, 0, `${blind}: nothing in the way, so git applied it`);
    assert.equal(out.inTheWay, undefined);
    assert.equal(r.read("u.txt"), "untracked\n");
  }
});

test("--index on a -u stash, over a clean tree: the staged half comes back staged, the untracked file too", async () => {
  const r = repo("u-index");
  r.write("b.txt", LINES("staged", 6));
  r.git("add", "b.txt");
  r.write("u.txt", "untracked\n");
  r.git("stash", "push", "-q", "-u");
  const sha = r.git("rev-parse", "refs/stash").trim();
  const out = await runApplying(procOf(r), { kind: "stash", stash: sha, index: true });
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.equal(status(r), "M  b.txt\n?? u.txt");
});

test("--index whose apply stops on conflicts of its own is git's outcome, not a refused staged half", async () => {
  const r = repo("index-conflict");
  // The stash: b.txt staged (applies cleanly later), a.txt edited on line 0.
  r.write("b.txt", LINES("staged", 7));
  r.git("add", "b.txt");
  r.write("a.txt", LINES("stash's line", 0));
  r.git("stash", "push", "-q");
  const sha = r.git("rev-parse", "refs/stash").trim();
  // HEAD then changes a.txt's line 0 its own way.
  r.write("a.txt", LINES("head's line", 0));
  r.commitAll("head changes a");
  const out = await runApplying(procOf(r), { kind: "stash", stash: sha, index: true });
  assert.notEqual(out.result.code, 0);
  assert.equal(out.indexRefused, undefined, "something happened: a.txt is unmerged");
  assert.equal(out.inTheWay, undefined);
  assert.match(r.git("ls-files", "-u"), /\ta\.txt$/m);
});

test("stash branch when git can't say what the switch touches: git runs it, and a clean tree takes it", async () => {
  const r = repo("branch-blind");
  r.write("a.txt", LINES("stashed", 2));
  r.git("stash", "push", "-q");
  const sha = r.git("rev-parse", "refs/stash").trim();
  const out = await runApplying(
    procOf(r, (a) => (cmd(a).startsWith("diff --name-only -z --no-renames HEAD ") ? fail("fatal: bad") : undefined)),
    { kind: "stash", stash: sha, branch: "rescued" },
  );
  assert.equal(out.result.code, 0, out.result.stderr);
  assert.equal(r.git("symbolic-ref", "--short", "HEAD").trim(), "rescued");
  assert.equal(r.read("a.txt"), LINES("stashed", 2));
});
