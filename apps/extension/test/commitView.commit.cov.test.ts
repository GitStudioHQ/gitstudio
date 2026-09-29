// The Changes view's commit box, host side, against real repositories: what a
// Commit (and Amend, Commit & Push, Generate) asks, what it runs in git, what
// it posts back to the page, and what it tells the user.

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  answerWith,
  asked,
  committedRepo,
  covHost,
  resetRecorders,
  said,
  settings,
  withRemote,
  type Host,
} from "./commitViewCovKit";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));
beforeEach(() => {
  resetRecorders();
  settings.clear();
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
const subjects = (r: { git: (...a: string[]) => string }) =>
  r.git("log", "--format=%s").trim().split("\n");

test("a commit with no message is refused before git runs, and the page's spinner is released", async () => {
  const r = repo("commit-empty");
  r.write("a.txt", "changed\n");
  r.git("add", "a.txt");
  const h = host(r.dir);
  await h.send({ type: "commit", message: "   " });
  assert.deepEqual(subjects(r), ["base"], "nothing was committed");
  assert.deepEqual(said("warning"), ["GitStudio: enter a commit message."]);
  assert.deepEqual(h.last("commitDone"), { type: "commitDone", ok: false });
});

test("a commit with something staged commits exactly that, clears the box and tells the page it went through", async () => {
  const r = repo("commit-staged");
  r.write("a.txt", "changed\n");
  r.write("b.txt", "also changed\n");
  r.git("add", "a.txt");
  const h = host(r.dir);
  await h.send({ type: "commit", message: "  change a  " });
  assert.deepEqual(subjects(r), ["change a", "base"]);
  assert.equal(r.git("show", "--name-only", "--format=", "HEAD").trim(), "a.txt", "only the staged file went in");
  assert.equal(asked.length, 0, "nothing was asked: something was staged");
  assert.ok(h.all("clear").length === 1, "the box is cleared");
  assert.deepEqual(h.last("commitDone"), { type: "commitDone", ok: true });
  assert.ok(said("status").includes("$(check) Committed"));
  assert.ok(h.committed.count >= 1, "the other views are told");
});

test("with nothing staged, Commit asks to commit everything — new files too — and confirming commits all of it", async () => {
  const r = repo("commit-all");
  r.write("a.txt", "changed\n");
  r.write("new.txt", "brand new\n");
  const h = host(r.dir);
  await h.send({ type: "commit", message: "everything" });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, "Commit all 2 changed files?");
  assert.equal((asked[0] as { confirmLabel?: string }).confirmLabel, "Commit all 2");
  assert.deepEqual(subjects(r), ["everything", "base"]);
  assert.deepEqual(
    r.git("show", "--name-only", "--format=", "HEAD").trim().split("\n").sort(),
    ["a.txt", "new.txt"],
  );
});

test("with nothing staged, declining the commit-all question commits and stages nothing", async () => {
  const r = repo("commit-all-no");
  r.write("a.txt", "changed\n");
  const h = host(r.dir);
  answerWith(() => undefined);
  await h.send({ type: "commit", message: "nope" });
  assert.deepEqual(subjects(r), ["base"]);
  assert.equal(r.git("diff", "--cached", "--name-only").trim(), "", "nothing was staged either");
  assert.deepEqual(h.last("commitDone"), { type: "commitDone", ok: false });
});

test("a single changed file is asked about in the singular", async () => {
  const r = repo("commit-all-one");
  r.write("a.txt", "changed\n");
  const h = host(r.dir);
  answerWith(() => undefined);
  await h.send({ type: "commit", message: "one" });
  assert.equal(asked[0].title, "Commit all 1 changed file?");
});

test("with conflicts left and nothing staged, Commit says so and touches nothing", async () => {
  const r = repo("commit-conflicts");
  r.git("checkout", "-q", "-b", "topic");
  r.write("a.txt", "theirs\n");
  r.git("commit", "-qam", "topic");
  r.git("checkout", "-q", "main");
  r.write("a.txt", "ours\n");
  r.git("commit", "-qam", "ours");
  try {
    r.git("merge", "-q", "--no-edit", "refs/heads/topic");
  } catch {
    /* stops on the conflict */
  }
  const h = host(r.dir);
  await h.send({ type: "commit", message: "merge it" });
  assert.equal(asked.length, 0);
  assert.deepEqual(said("warning"), [
    "GitStudio: a.txt still has conflicts. Resolve and stage them first — git can't commit while files are unmerged.",
  ]);
  assert.deepEqual(h.last("commitDone"), { type: "commitDone", ok: false });
  assert.equal(r.git("diff", "--name-only", "--diff-filter=U").trim(), "a.txt", "still unmerged");
});

test("Commit on a clean tree is information, not an error, and says the tree is clean", async () => {
  const r = repo("commit-clean");
  const h = host(r.dir);
  await h.send({ type: "commit", message: "nothing" });
  assert.deepEqual(said("error"), []);
  assert.deepEqual(said("info"), ["GitStudio: Nothing to commit — the working tree is clean."]);
  assert.deepEqual(h.last("commitDone"), {
    type: "commitDone",
    ok: false,
    error: "Nothing to commit — the working tree is clean.",
  });
});

test("a pre-commit hook that refuses in silence is named as the likely reason", async () => {
  const r = repo("commit-hook-silent");
  const hook = join(r.dir, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  r.write("a.txt", "changed\n");
  r.git("add", "a.txt");
  const h = host(r.dir);
  await h.send({ type: "commit", message: "blocked" });
  assert.deepEqual(subjects(r), ["base"]);
  const detail =
    "git refused the commit without saying why. If this repository has a pre-commit hook, check its output.";
  assert.deepEqual(said("error"), [`GitStudio: Commit failed — ${detail}`]);
  assert.deepEqual(h.last("commitDone"), { type: "commitDone", ok: false, error: detail });
});

test("a pre-commit hook's own words are what the user reads when it refuses", async () => {
  const r = repo("commit-hook-says");
  const hook = join(r.dir, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'lint failed in a.txt' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  r.write("a.txt", "changed\n");
  r.git("add", "a.txt");
  const h = host(r.dir);
  await h.send({ type: "commit", message: "blocked" });
  assert.deepEqual(said("error"), ["GitStudio: Commit failed — lint failed in a.txt."]);
  assert.equal(h.last("commitDone")?.error, "lint failed in a.txt");
});

test("sign-off and an author override reach the commit git makes", async () => {
  const r = repo("commit-signoff");
  r.write("a.txt", "changed\n");
  r.git("add", "a.txt");
  const h = host(r.dir);
  await h.send({ type: "commit", message: "signed", signoff: true, author: " Ada <ada@example.com> " });
  assert.equal(r.git("log", "-1", "--format=%an <%ae>").trim(), "Ada <ada@example.com>");
  assert.match(r.git("log", "-1", "--format=%B"), /Signed-off-by: t <t@example\.com>/);
});

test("Amend rewrites HEAD through the Undo envelope, keeping the message when none is typed", async () => {
  const r = repo("commit-amend");
  r.write("a.txt", "fixup\n");
  r.git("add", "a.txt");
  const before = r.git("rev-parse", "HEAD").trim();
  const labels: string[] = [];
  const h = host(r.dir, {
    ledger: {
      runWithUndo: async (_repo, label, fn) => {
        labels.push(label);
        return fn();
      },
    },
  });
  await h.send({ type: "commit", message: "", amend: true });
  assert.deepEqual(labels, ["Amend commit"]);
  assert.deepEqual(subjects(r), ["base"], "still one commit, same subject");
  assert.notEqual(r.git("rev-parse", "HEAD").trim(), before, "HEAD was rewritten");
  assert.equal(r.git("show", "HEAD:a.txt"), "fixup\n", "the staged change went into it");
  assert.equal(asked.length, 0, "an amend never asks to commit everything");
});

test("toggling Amend prefills the last commit's full message, subject and body", async () => {
  const r = repo("commit-amend-prefill");
  r.write("a.txt", "x\n");
  r.git("commit", "-qam", "Subject line", "-m", "The body\nsecond line");
  const h = host(r.dir);
  await h.idle();
  await h.send({ type: "amendToggled", amend: true });
  const state = h.last("state");
  assert.equal(state?.lastMessage, "Subject line\n\nThe body\nsecond line");
});

test("Commit & Push opens the push review for what was just committed, never pushing on its own", async () => {
  const r = repo("commit-push");
  const remote = withRemote(r);
  cleanups.push(remote.done);
  r.write("a.txt", "to push\n");
  r.git("add", "a.txt");
  const h = host(r.dir);
  await h.send({ type: "commit", message: "ship it", push: true });
  const preview = h.last("pushPreview");
  assert.ok(preview, "the review opened");
  assert.equal(preview.target, "origin/main");
  assert.equal(preview.ahead, 1);
  assert.deepEqual(
    (preview.commits as { subject: string }[]).map((c) => c.subject),
    ["ship it"],
  );
  assert.equal(r.git("rev-parse", "origin/main").trim(), r.git("rev-parse", "HEAD~1").trim(), "nothing was pushed yet");
});

test("Generate fills the box with GitBrain's draft and releases the button", async () => {
  const r = repo("generate");
  const drafted: string[] = [];
  const h = host(r.dir, {
    generator: {
      isEnabled: async () => true,
      draft: async (entry) => {
        drafted.push(entry.root);
        return "feat: drafted";
      },
    },
  });
  await h.send({ type: "generateMessage" });
  assert.deepEqual(drafted, [r.dir]);
  assert.deepEqual(h.last("setMessage"), { type: "setMessage", text: "feat: drafted" });
  assert.ok(h.last("generateDone"));
});

test("Generate with nothing to draft says so in the status bar, and a failing provider stays silent", async () => {
  const r = repo("generate-empty");
  let fail = false;
  const h = host(r.dir, {
    generator: {
      isEnabled: async () => true,
      draft: async () => {
        if (fail) throw new Error("provider down");
        return "   ";
      },
    },
  });
  await h.send({ type: "generateMessage" });
  assert.equal(h.all("setMessage").length, 0);
  assert.ok(said("status").includes("$(sparkle) GitBrain: nothing to draft (stage changes first)"));
  fail = true;
  resetRecorders();
  const doneBefore = h.all("generateDone").length;
  await h.send({ type: "generateMessage" });
  assert.deepEqual(said("error"), [], "AI never breaks the commit box");
  assert.equal(h.all("generateDone").length, doneBefore + 1, "the button is released anyway");
});

test("Generate with no provider wired just releases the button", async () => {
  const r = repo("generate-none");
  const h = host(r.dir);
  await h.send({ type: "generateMessage" });
  assert.equal(h.all("setMessage").length, 0);
  assert.ok(h.last("generateDone"));
});

test("the state carries whether AI is on, once the generator has answered", async () => {
  const r = repo("ai-enabled");
  const h = host(r.dir, { generator: { isEnabled: async () => true, draft: async () => null } });
  await h.send({ type: "ready" });
  assert.equal(h.last("state")?.aiEnabled, true);
});

test("Commit with no repository open says there is none", async () => {
  const r = repo("commit-norepo");
  const h = host(r.dir, { noRepo: true });
  await h.send({ type: "commit", message: "x" });
  assert.deepEqual(said("info"), ["GitStudio: No repository is open."]);
});
