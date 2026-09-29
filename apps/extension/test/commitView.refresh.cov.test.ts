// The Changes view's repaint is best-effort around vscode.git: a re-scan that
// fails never stops the view from repainting or a stash door from running, and
// a stash row that has left the list is said and re-read.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  answerWith,
  commandsRun,
  committedRepo,
  covHost,
  installUris,
  resetRecorders,
  said,
  type FakeGitRepoState,
  type Host,
} from "./commitViewCovKit";

installUris();

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));
beforeEach(() => {
  resetRecorders();
  answerWith(() => "ok");
});

function host(root: string, opts?: Parameters<typeof covHost>[1]): Host {
  const h = covHost(root, opts);
  cleanups.push(h.dispose);
  return h;
}
function repo(prefix: string) {
  const r = committedRepo(prefix);
  cleanups.push(r.done);
  return r;
}
/** A vscode.git Repository whose status() always fails. */
function failingScan(): { state: FakeGitRepoState; status: () => Promise<void>; scans: { n: number } } {
  const scans = { n: 0 };
  return {
    scans,
    state: { HEAD: { name: "main" }, indexChanges: [], workingTreeChanges: [], mergeChanges: [] },
    status: async () => {
      scans.n++;
      throw new Error("vscode.git is busy");
    },
  };
}

test("Refresh with a re-scan that fails still repaints, and says nothing", async () => {
  const r = repo("refresh-scan-fails");
  const gitRepo = failingScan();
  const h = host(r.dir, { gitRepo });
  await h.idle();
  const n = h.all("state").length;
  await h.send({ type: "ready" });
  assert.equal(gitRepo.scans.n, 1, "it asked for the re-scan");
  assert.ok(h.all("state").length > n, "and repainted anyway");
  assert.deepEqual(said("error"), []);
});

test("the stash doors run their command even when the re-scan after it fails", async () => {
  const r = repo("refresh-stash-scan-fails");
  const gitRepo = failingScan();
  const h = host(r.dir, { gitRepo });
  await h.send({ type: "stash" });
  await h.send({ type: "stashStaged" });
  await h.send({ type: "stashPaths", paths: ["a.txt"] });
  assert.deepEqual(
    commandsRun.map((c) => c.id),
    ["gitstudio.stash.save", "gitstudio.stash.staged", "gitstudio.stash.paths"],
  );
  assert.equal(gitRepo.scans.n, 3);
  assert.deepEqual(said("error"), []);
});

test("a stash file opened from a stash that has left the list is said, and the list is read again", async () => {
  const r = repo("refresh-stash-gone");
  const h = host(r.dir);
  await h.idle();
  const n = h.all("state").length;
  await h.send({ type: "stashOpenFile", sha: "0123456789abcdef0123456789abcdef01234567", path: "a.txt" });
  assert.deepEqual(said("info"), ["GitStudio: That stash is no longer in the list."]);
  assert.equal(commandsRun.filter((c) => c.id === "vscode.diff").length, 0);
  assert.ok(h.all("state").length > n, "re-read");
});

test("a stash file that is no longer in its stash is said, and nothing opens", async () => {
  const r = repo("refresh-stash-file-gone");
  r.write("a.txt", "stashed\n");
  r.git("stash", "push", "-q", "-m", "one");
  const sha = r.git("rev-parse", "stash@{0}").trim();
  const h = host(r.dir);
  await h.send({ type: "stashOpenFile", sha, path: "b.txt" });
  assert.deepEqual(said("info"), ["GitStudio: “b.txt” is no longer in that stash."]);
  assert.equal(commandsRun.filter((c) => c.id === "vscode.diff").length, 0);
});
