// Where a branch is checked out, asked before a checkout or a delete git would
// refuse — against real git. The doors that use it are pinned in both
// products (apps/extension/test/branchInAnotherWorktree.test.ts, and the
// desktop's worktreeRemoval.test.ts).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { GitContext } from "../src/GitContext";
import { checkedOutElsewhere, checkedOutElsewhereMessage } from "../src/branchElsewhere";
import { planRefCheckout } from "../src/checkoutRef";
import { removeTempRepo } from "./tmpRepo";

// Paths are made in os.tmpdir()'s own spelling — the 8.3 C:\Users\RUNNER~1\…
// on a Windows runner, /var/… on macOS — so every compare with git's
// (C:/Users/runneradmin/…, /private/var/…) is a compare of two spellings, on
// macOS as on Windows. An answer is expected in the disk's own spelling, as
// it is shown: realpathSync.native gives the long name, as git does, with the
// system's separators.
const scratch = mkdtempSync(join(tmpdir(), "gitstudio-elsewhere-"));
const shown = (p: string): string => realpathSync.native(p);
/** The shown spelling of a folder that is gone: its parent's, and its name. */
const shownGone = (p: string): string => join(realpathSync.native(dirname(p)), basename(p));
const contexts: GitContext[] = [];
after(() => {
  for (const c of contexts) c.dispose();
  removeTempRepo(scratch);
});

const at =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// main in app/; feat in wt/feat; feat-2 (a name feat is a prefix of) and
// free in no worktree; origin/feat and origin/only beside them.
const app = join(scratch, "app");
mkdirSync(app, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main", app]);
const git = at(app);
for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
  git("config", k, v);
}
writeFileSync(join(app, "a.txt"), "a\n");
git("add", ".");
git("commit", "-qm", "base");
const holder = join(scratch, "wt", "feat");
git("worktree", "add", "-q", "-b", "feat", holder);
git("branch", "feat-2");
git("branch", "free");
git("update-ref", "refs/remotes/origin/feat", "HEAD");
git("update-ref", "refs/remotes/origin/only", "HEAD");
git("tag", "v1");
const ctx = new GitContext({ root: app });
contexts.push(ctx);

test("checkedOutElsewhere names the OTHER worktree that has the branch, and nothing else", async () => {
  assert.equal(await checkedOutElsewhere(ctx.process, "refs/heads/feat"), shown(holder));
  assert.equal(await checkedOutElsewhere(ctx.process, "refs/heads/main"), undefined, "checked out HERE is not elsewhere");
  assert.equal(await checkedOutElsewhere(ctx.process, "refs/heads/free"), undefined);
  assert.equal(await checkedOutElsewhere(ctx.process, "refs/heads/feat-2"), undefined);
  assert.equal(await checkedOutElsewhere(ctx.process, "refs/heads/gone"), undefined);
  assert.equal(await checkedOutElsewhere(ctx.process, "refs/remotes/origin/feat"), undefined, "only a local branch is checked out");

  // From the linked worktree, it is main that is elsewhere.
  const inside = new GitContext({ root: holder });
  contexts.push(inside);
  assert.equal(await checkedOutElsewhere(inside.process, "refs/heads/main"), shown(app));
  assert.equal(await checkedOutElsewhere(inside.process, "refs/heads/feat"), undefined);
});

test("a window opened through a symlink still knows its own branch is here", async () => {
  const link = join(scratch, "link-to-app");
  symlinkSync(app, link);
  const viaLink = new GitContext({ root: link });
  contexts.push(viaLink);
  assert.equal(await checkedOutElsewhere(viaLink.process, "refs/heads/main"), undefined);
  assert.equal(await checkedOutElsewhere(viaLink.process, "refs/heads/feat"), shown(holder));
});

test("a checkout plan names the existing local branch it switches to — and none when it creates one or detaches", async () => {
  assert.equal((await planRefCheckout(ctx.process, "refs/heads/feat"))?.branch, "refs/heads/feat");
  assert.equal((await planRefCheckout(ctx.process, "refs/remotes/origin/feat"))?.branch, "refs/heads/feat", "switches to the local feat");
  assert.equal((await planRefCheckout(ctx.process, "refs/remotes/origin/only"))?.branch, undefined, "creates `only`");
  assert.equal((await planRefCheckout(ctx.process, "refs/tags/v1"))?.branch, undefined, "detaches");
});

test("the words: where it is, and what to do instead", () => {
  assert.equal(
    checkedOutElsewhereMessage("feat", "~/wt/feat", "checkout"),
    "'feat' is checked out in the worktree at ~/wt/feat, and a branch can be checked out in only one worktree at a time. Work on it there, or create a new branch from it here.",
  );
  assert.equal(
    checkedOutElsewhereMessage("feat", "~/wt/feat", "delete"),
    "'feat' is checked out in the worktree at ~/wt/feat, so it can't be deleted. Check out another branch in that worktree, or remove the worktree, first.",
  );
  // Its folder gone, git still holds the branch for it: forgetting the
  // worktree is the only way out.
  assert.equal(
    checkedOutElsewhereMessage("feat", "~/wt/feat", "delete", true),
    "'feat' is checked out in the worktree at ~/wt/feat, whose folder is gone — git still keeps the branch for it. Forget that worktree in Worktrees, then delete it.",
  );
  assert.match(checkedOutElsewhereMessage("feat", "~/wt/feat", "checkout", true), /Forget that worktree in Worktrees, then check it out\.$/);
});

test("a worktree whose folder is gone still holds its branch — git refuses both doors for it", async () => {
  const gone = join(scratch, "wt", "gone");
  git("worktree", "add", "-q", "-b", "gone", gone);
  rmSync(gone, { recursive: true, force: true });
  assert.equal(await checkedOutElsewhere(ctx.process, "refs/heads/gone"), shownGone(gone));
  assert.throws(() => git("branch", "-D", "gone"), "git refuses the delete too");
});
