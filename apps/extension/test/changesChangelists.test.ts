// Changelists in the Changes view (#122), host side, against a real repository.
//
// A file parked in a changelist — a local config that is always modified and
// never meant to be committed — is left out of every action that takes
// "everything": Stage All, the checkbox model's Check all, Commit all (with
// nothing staged) and Discard All. It is staged and committed only by hand,
// and a parked file committed or discarded clean leaves its changelist.
// Changelists are kept in the git-dir, never in the working tree.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { answerWith, asked, changesHost, scratchRepo, vscode } from "./changesHost";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));

/** a.txt, b.txt and config.json committed, then all three edited, plus an untracked new.txt. */
function edited(): ReturnType<typeof scratchRepo> {
  const repo = scratchRepo("changelists");
  cleanups.push(repo.done);
  const w = (n: string, t: string) => writeFileSync(join(repo.dir, n), t);
  w("a.txt", "a\n");
  w("b.txt", "b\n");
  w("config.json", '{"debug":false}\n');
  repo.git("add", ".");
  repo.git("commit", "-qm", "base");
  w("a.txt", "a, edited\n");
  w("b.txt", "b, edited\n");
  w("config.json", '{"debug":true}\n');
  w("new.txt", "new\n");
  return repo;
}

type Host = ReturnType<typeof changesHost>;

function host(repo: ReturnType<typeof scratchRepo>): Host {
  const h = changesHost(repo.dir);
  cleanups.push(h.dispose);
  return h;
}

/** The last state the host posted. */
async function lastState(h: Host): Promise<Record<string, unknown>> {
  await h.idle();
  const states = h.posted.filter((m) => m.type === "state");
  assert.ok(states.length > 0, "the host posted its state");
  return states[states.length - 1];
}

/** Park `paths` in a new changelist called `name`, the way the page asks for it. */
async function park(h: Host, name: string, paths: string[]): Promise<string> {
  answerWith((spec) => (spec.kind === "input" ? name : undefined));
  await h.send({ type: "newChangelist", paths });
  const st = await lastState(h);
  const list = (st.changelists as { id: string; name: string }[]).find((l) => l.name === name);
  assert.ok(list, `the changelist "${name}" is in the state`);
  return list.id;
}

const stagedNames = (repo: ReturnType<typeof scratchRepo>): string[] =>
  repo.git("diff", "--cached", "--name-only").split("\n").filter(Boolean).sort();

test("New Changelist… parks the files; the state says so; the file is in .git, not the tree", async () => {
  const repo = edited();
  const h = host(repo);
  asked.length = 0;
  const id = await park(h, "nocommit", ["config.json"]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, "input");
  const st = await lastState(h);
  assert.deepEqual(st.parked, { "config.json": id });
  assert.deepEqual(st.changelists, [{ id, name: "nocommit" }]);
  assert.ok(existsSync(join(repo.dir, ".git", "gitstudio-changelists.json")));
  assert.ok(
    !repo.git("status", "--porcelain", "--untracked-files=all").includes("changelists"),
    "nothing new in the working tree",
  );
});

test("Stage All and Check all leave a parked file where it is", async () => {
  const repo = edited();
  const h = host(repo);
  await park(h, "nocommit", ["config.json", "new.txt"]);
  await h.send({ type: "stageAll" });
  assert.deepEqual(stagedNames(repo), ["a.txt", "b.txt"]);
  repo.git("reset", "-q");
  await h.send({ type: "stageAllForCommit" });
  assert.deepEqual(stagedNames(repo), ["a.txt", "b.txt"]);
});

test("Commit all leaves a parked file out, and its confirm says so", async () => {
  const repo = edited();
  const h = host(repo);
  const id = await park(h, "nocommit", ["config.json"]);
  asked.length = 0;
  answerWith(() => "ok");
  await h.send({ type: "commit", message: "work" });
  const confirm = asked.find((a) => a.kind === "confirm");
  assert.ok(confirm && confirm.kind === "confirm");
  assert.equal(confirm.title, "Commit all 3 changed files?");
  assert.match(confirm.message, /1 file in a changelist is left out\.$/);
  assert.deepEqual(
    repo.git("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort(),
    ["a.txt", "b.txt", "new.txt"],
  );
  assert.match(repo.git("status", "--porcelain"), /^ M config\.json$/m, "config.json is still modified, unstaged");
  assert.deepEqual((await lastState(h)).parked, { "config.json": id }, "and still parked");
});

test("with only parked files changed and nothing staged, Commit commits nothing and says why", async () => {
  const repo = scratchRepo("changelists-only");
  cleanups.push(repo.done);
  writeFileSync(join(repo.dir, "config.json"), "1\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "base");
  writeFileSync(join(repo.dir, "config.json"), "2\n");
  const h = host(repo);
  await park(h, "nocommit", ["config.json"]);
  asked.length = 0;
  vscode.__said.length = 0;
  answerWith(() => "ok");
  const head = repo.git("rev-parse", "HEAD");
  await h.send({ type: "commit", message: "nope" });
  assert.equal(repo.git("rev-parse", "HEAD"), head, "no commit");
  assert.deepEqual(asked.filter((a) => a.kind === "confirm"), [], "nothing to confirm");
  assert.deepEqual(vscode.__said.filter((s) => s.kind === "info").map((s) => s.message), [
    "GitStudio: nothing to commit. The only changed file is in a changelist — stage it first to commit it.",
  ]);
  assert.deepEqual(h.posted.filter((m) => m.type === "commitDone").map((m) => m.ok), [false]);
});

test("Discard All never throws a parked file's changes away", async () => {
  const repo = edited();
  const h = host(repo);
  await park(h, "nocommit", ["config.json"]);
  asked.length = 0;
  answerWith(() => "ok");
  await h.send({ type: "discardAll", group: "unstaged" });
  const confirm = asked.find((a) => a.kind === "confirm");
  assert.ok(confirm && confirm.kind === "confirm");
  assert.equal(confirm.title, "Discard all 3 working-tree changes?");
  assert.equal(readFileSync(join(repo.dir, "config.json"), "utf8"), '{"debug":true}\n', "kept");
  assert.equal(readFileSync(join(repo.dir, "a.txt"), "utf8"), "a\n", "the rest is discarded");
});

test("a parked file staged by hand commits, and then leaves its changelist", async () => {
  const repo = edited();
  const h = host(repo);
  const id = await park(h, "nocommit", ["config.json", "b.txt"]);
  await h.send({ type: "stagePaths", paths: ["config.json"] });
  assert.deepEqual(stagedNames(repo), ["config.json"], "staged by hand: it stages");
  answerWith(() => "ok");
  await h.send({ type: "commit", message: "config, on purpose" });
  assert.deepEqual(repo.git("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean), ["config.json"]);
  const st = await lastState(h);
  assert.deepEqual(st.parked, { "b.txt": id }, "config.json is clean and forgotten; b.txt stays");
  const onDisk = JSON.parse(readFileSync(join(repo.dir, ".git", "gitstudio-changelists.json"), "utf8"));
  assert.deepEqual(onDisk.files, { "b.txt": id });
});

test("a parked file discarded by hand leaves its changelist", async () => {
  const repo = edited();
  const h = host(repo);
  await park(h, "nocommit", ["config.json"]);
  answerWith(() => "ok");
  await h.send({ type: "discardPaths", paths: ["config.json"] });
  assert.deepEqual((await lastState(h)).parked, {});
  const onDisk = JSON.parse(readFileSync(join(repo.dir, ".git", "gitstudio-changelists.json"), "utf8"));
  assert.deepEqual(onDisk.files, {});
});

test("Move to Changelist… asks where, offers the default list back, and a drop moves without asking", async () => {
  const repo = edited();
  const h = host(repo);
  const one = await park(h, "one", ["config.json"]);
  const two = await park(h, "two", []);
  asked.length = 0;
  answerWith((spec) => (spec.kind === "pick" ? two : undefined));
  await h.send({ type: "moveToChangelist", paths: ["config.json"] });
  const pick = asked[0];
  assert.ok(pick && pick.kind === "pick");
  assert.equal(pick.title, "Move config.json to Changelist");
  assert.deepEqual(pick.choices.map((c) => c.label), ["two", "Changes", "New Changelist…"], "not the one it is in");
  assert.deepEqual((await lastState(h)).parked, { "config.json": two });
  asked.length = 0;
  await h.send({ type: "moveToChangelist", paths: ["config.json", "a.txt"], list: one });
  assert.equal(asked.length, 0, "a drop names its target");
  assert.deepEqual((await lastState(h)).parked, { "config.json": one, "a.txt": one });
  await h.send({ type: "moveToChangelist", paths: ["a.txt"], list: "" });
  assert.deepEqual((await lastState(h)).parked, { "config.json": one });
});

test("a conflicted file is never parked", async () => {
  const repo = edited();
  repo.git("commit", "-qam", "edits");
  repo.git("checkout", "-q", "-b", "topic", "HEAD~1");
  writeFileSync(join(repo.dir, "a.txt"), "a, theirs\n");
  repo.git("commit", "-qam", "topic");
  repo.git("checkout", "-q", "main");
  try {
    repo.git("merge", "-q", "--no-edit", "refs/heads/topic");
  } catch {
    // stops on a.txt, as intended
  }
  const h = host(repo);
  const id = await park(h, "nocommit", []);
  await h.send({ type: "moveToChangelist", paths: ["a.txt"], list: id });
  assert.deepEqual((await lastState(h)).parked, {});
});

test("a name already used is asked again, with the reason; Rename and Delete keep the files", async () => {
  const repo = edited();
  const h = host(repo);
  const id = await park(h, "nocommit", ["config.json"]);
  asked.length = 0;
  const answers = ["NoCommit", "Unstaged", "local"];
  answerWith((spec) => (spec.kind === "input" ? answers.shift() : undefined));
  await h.send({ type: "newChangelist", paths: [] });
  assert.equal(asked.length, 3);
  assert.equal(asked[1].hint, "There is already a group called “NoCommit”. Choose another name.");
  assert.equal(asked[2].hint, "There is already a group called “Unstaged”. Choose another name.");
  assert.deepEqual(((await lastState(h)).changelists as { name: string }[]).map((l) => l.name), ["nocommit", "local"]);

  answerWith((spec) => (spec.kind === "input" ? "machine-local" : undefined));
  await h.send({ type: "renameChangelist", list: id });
  let st = await lastState(h);
  assert.deepEqual((st.changelists as { name: string }[]).map((l) => l.name), ["machine-local", "local"]);
  assert.deepEqual(st.parked, { "config.json": id }, "renamed, its files stay");

  vscode.__said.length = 0;
  await h.send({ type: "deleteChangelist", list: id });
  st = await lastState(h);
  assert.deepEqual((st.changelists as { name: string }[]).map((l) => l.name), ["local"]);
  assert.deepEqual(st.parked, {}, "its files are back in Changes");
  assert.equal(readFileSync(join(repo.dir, "config.json"), "utf8"), '{"debug":true}\n', "and untouched");
});

test("a changelists file someone broke reads as none, and the view still paints", async () => {
  const repo = edited();
  writeFileSync(join(repo.dir, ".git", "gitstudio-changelists.json"), "{ not json");
  const h = host(repo);
  await h.send({ type: "ready" });
  const st = await lastState(h);
  assert.deepEqual(st.changelists, []);
  assert.deepEqual(st.parked, {});
  assert.equal((st.unstaged as unknown[]).length, 4);
});
