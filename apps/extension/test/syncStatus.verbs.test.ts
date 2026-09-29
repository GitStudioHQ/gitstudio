// The status bar's branch item — what it paints for each state of the active
// repository, and what its verbs (the hover's Sync / Fetch / Pull / Push /
// Publish links, and the click) do to a real repository with a bare "origin"
// on disk beside it.
//
// vscodeStub.cjs stands in for VS Code and records every message; the status
// bar item, the registered commands and the hover's markdown are recorded
// here, and the dialog host answers each question by its title.

import Module from "node:module";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};

interface Item {
  args: unknown[];
  name?: string;
  text?: string;
  command?: string;
  tooltip?: { value: string };
  visible: boolean;
  shows: number;
  hides: number;
  show(): void;
  hide(): void;
  dispose(): void;
}
const created: Item[] = [];
const handlers = new Map<string, (...a: unknown[]) => unknown>();
const executed: string[] = [];

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as {
  __said: { kind: string; message: string }[];
  window: Record<string, unknown>;
  workspace: Record<string, unknown>;
  commands: Record<string, unknown>;
  MarkdownString: unknown;
};
vscode.window.createStatusBarItem = (...args: unknown[]): Item => {
  const item: Item = {
    args,
    visible: false,
    shows: 0,
    hides: 0,
    show() {
      this.visible = true;
      this.shows++;
    },
    hide() {
      this.visible = false;
      this.hides++;
    },
    dispose() {},
  };
  created.push(item);
  return item;
};
vscode.commands.registerCommand = (id: string, fn: (...a: unknown[]) => unknown) => {
  handlers.set(id, fn);
  return { dispose: () => handlers.delete(id) };
};
vscode.commands.executeCommand = async (id: string) => {
  executed.push(id);
  return undefined;
};
vscode.MarkdownString = class {
  value = "";
  isTrusted: unknown;
  supportThemeIcons = false;
  appendMarkdown(s: string) {
    this.value += s;
    return this;
  }
};
vscode.workspace.getConfiguration = () => ({ get: (_k: string, fallback?: unknown) => fallback });
const { registerDialogHost } = require("../src/ui/dialogs") as typeof import("../src/ui/dialogs");
const { SyncStatusItem } = require("../src/statusBar/syncStatus") as typeof import("../src/statusBar/syncStatus");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { DialogSpec } from "../src/ui/dialogs";

const scratch = mkdtempSync(join(tmpdir(), "gs-ext-syncstatus-"));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
let seq = 0;

let asked: DialogSpec[] = [];
let script: [RegExp, string][] = [];
registerDialogHost({
  show: async (spec) => {
    asked.push(spec);
    const hit = script.find(([re]) => re.test(spec.title));
    return hit ? { value: hit[1] } : undefined;
  },
});

const at =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function identify(g: (...a: string[]) => string): void {
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    g("config", k, v);
  }
}

type Git = (...a: string[]) => string;
interface World {
  dir: string;
  remote: string;
  git: Git;
  origin: Git;
  ctx: InstanceType<typeof GitContext>;
  entry: { ctx: InstanceType<typeof GitContext>; root: string };
}

const opened: { dispose(): void }[] = [];
after(() => {
  for (const c of opened) c.dispose();
});

/** main, published to "origin" (a bare repository on disk) and tracking it. */
function world(opts: { remote?: boolean } = {}): World {
  const base = join(scratch, `w${++seq}`);
  const remote = join(base, "remote.git");
  const dir = join(base, "work");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const git = at(dir);
  identify(git);
  writeFileSync(join(dir, "f.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "base");
  let origin: Git = () => {
    throw new Error("no remote in this world");
  };
  if (opts.remote !== false) {
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    origin = at(remote);
    identify(origin);
    git("remote", "add", "origin", remote);
    git("push", "-q", "-u", "origin", "main");
  }
  const ctx = new GitContext({ root: dir });
  opened.push(ctx);
  return { dir, remote, git, origin, ctx, entry: { ctx, root: dir } };
}

/** A commit lands on origin's `branch` behind the work repository's back. */
function remoteCommit(w: World, message = "theirs", branch = "main", file?: [string, string]): string {
  let tree = w.origin("rev-parse", `${branch}^{tree}`);
  if (file) {
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: w.remote, input: file[1], encoding: "utf8" }).trim();
    const entries = w.origin("ls-tree", tree).split("\n").filter((l) => !l.endsWith(`\t${file[0]}`));
    entries.push(`100644 blob ${blob}\t${file[0]}`);
    tree = execFileSync("git", ["mktree"], { cwd: w.remote, input: entries.join("\n") + "\n", encoding: "utf8" }).trim();
  }
  const sha = w.origin("commit-tree", tree, "-p", branch, "-m", message);
  w.origin("update-ref", `refs/heads/${branch}`, sha);
  return sha;
}

/** A commit made and pushed an hour ago, then amended (author date kept, committed now). */
function amendPushed(w: World): { pushed: string; amended: string } {
  const env = (committed: string) => ({
    ...process.env,
    GIT_AUTHOR_DATE: "1700000000 +0000",
    GIT_COMMITTER_DATE: committed,
  });
  const run = (committed: string, ...a: string[]) =>
    execFileSync("git", a, { cwd: w.dir, env: env(committed), stdio: ["ignore", "pipe", "pipe"] });
  run("1700000000 +0000", "commit", "-q", "--allow-empty", "-m", "pushed");
  w.git("push", "-q", "origin", "main");
  const pushed = w.git("rev-parse", "HEAD");
  run("1700003600 +0000", "commit", "-q", "--amend", "--allow-empty", "-m", "pushed, reworded");
  return { pushed, amended: w.git("rev-parse", "HEAD") };
}

function commit(w: World, message: string, file?: [string, string]): string {
  if (file) {
    writeFileSync(join(w.dir, file[0]), file[1]);
    w.git("add", file[0]);
    w.git("commit", "-qm", message);
  } else {
    w.git("commit", "-q", "--allow-empty", "-m", message);
  }
  return w.git("rev-parse", "HEAD");
}

interface Bar {
  item: Item;
  sync: InstanceType<typeof SyncStatusItem>;
  run(verb: string): Promise<void>;
  change(): void;
  opened: () => number;
}

/** The status item over `active` (a getter, so a cell can close the repo). */
function bar(active: () => { ctx: unknown; root: string } | undefined): Bar {
  created.length = 0;
  handlers.clear();
  const listeners: (() => void)[] = [];
  const repos = {
    getActive: active,
    getAll: () => [active()].filter(Boolean),
    onDidChange: (l: () => void) => {
      listeners.push(l);
      return { dispose() {} };
    },
  };
  let branchUi = 0;
  const sync = new SyncStatusItem(repos as never, async () => {
    branchUi++;
  });
  opened.push(sync);
  const item = created[0];
  return {
    item,
    sync,
    run: async (verb) => {
      const fn = handlers.get(verb.includes(".") ? verb : `gitstudio.sync.${verb}`);
      assert.ok(fn, `registered: ${verb}`);
      await fn();
    },
    change: () => {
      for (const l of listeners) l();
    },
    opened: () => branchUi,
  };
}

/** Wait (bounded) until the item paints something that passes `ok`. */
async function painted(item: Item, ok: (i: Item) => boolean): Promise<void> {
  for (let i = 0; i < 400 && !ok(item); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(item), `painted: ${JSON.stringify({ text: item.text, visible: item.visible })}`);
}

function reset(answers: [RegExp, string][] = []): void {
  asked = [];
  script = answers;
  vscode.__said.length = 0;
  executed.length = 0;
}
const said = (kind: string): string[] => vscode.__said.filter((m) => m.kind === kind).map((m) => m.message);
const titles = (): string[] => asked.map((s) => s.title);

// ── What it paints ───────────────────────────────────────────────────────────

test("a tracked branch 1 behind, 2 ahead with a changed file paints all three, and its hover links every verb", async () => {
  const w = world();
  remoteCommit(w);
  w.git("fetch", "-q", "origin");
  commit(w, "mine 1");
  commit(w, "mine 2");
  writeFileSync(join(w.dir, "f.txt"), "edited\n");
  const b = bar(() => w.entry);
  try {
    assert.equal(b.item.command, "gitstudio.syncStatus.menu");
    await painted(b.item, (i) => i.visible);
    assert.equal(b.item.text, "$(git-branch) main $(arrow-down)1 $(arrow-up)2 $(pencil)1");
    const hover = b.item.tooltip?.value ?? "";
    assert.match(hover, /\*\*main\*\*/);
    assert.match(hover, /tracking `origin\/main` · 1 in, 2 out/);
    for (const verb of ["sync", "fetch", "pull", "push"]) assert.ok(hover.includes(`(command:gitstudio.sync.${verb})`), verb);
    assert.ok(!hover.includes("gitstudio.sync.publish"), "a tracked branch offers no Publish");
  } finally {
    b.sync.dispose();
  }
});

test("an unpublished branch paints the publish cloud, and its hover offers Publish and Fetch", async () => {
  const w = world();
  w.git("checkout", "-q", "-b", "topic");
  const b = bar(() => w.entry);
  try {
    await painted(b.item, (i) => i.visible);
    assert.equal(b.item.text, "$(git-branch) topic $(cloud-upload)");
    const hover = b.item.tooltip?.value ?? "";
    assert.match(hover, /No upstream set/);
    assert.ok(hover.includes("(command:gitstudio.sync.publish)"));
    assert.ok(hover.includes("(command:gitstudio.sync.fetch)"));
    assert.ok(!hover.includes("gitstudio.sync.push"));
  } finally {
    b.sync.dispose();
  }
});

test("a detached HEAD paints no counts and no cloud; its hover offers Fetch alone", async () => {
  const w = world();
  w.git("checkout", "-q", "--detach");
  const b = bar(() => w.entry);
  try {
    await painted(b.item, (i) => i.visible);
    assert.ok(!/cloud-upload|arrow-/.test(b.item.text ?? ""), b.item.text);
    const hover = b.item.tooltip?.value ?? "";
    assert.match(hover, /Detached HEAD: commits made here are on no branch/);
    assert.ok(hover.includes("(command:gitstudio.sync.fetch)"));
    assert.ok(!/gitstudio\.sync\.(sync|pull|push|publish)/.test(hover));
  } finally {
    b.sync.dispose();
  }
});

test("the item follows the repository: repainted on a change, hidden when no repository is active or it cannot be read", async () => {
  const w = world();
  let active: { ctx: unknown; root: string } | undefined = w.entry;
  const b = bar(() => active);
  try {
    await painted(b.item, (i) => i.text === "$(git-branch) main");
    writeFileSync(join(w.dir, "new.txt"), "x\n");
    writeFileSync(join(w.dir, "f.txt"), "y\n");
    b.change();
    await painted(b.item, (i) => i.text === "$(git-branch) main $(pencil)2");
    active = undefined;
    b.change();
    await painted(b.item, (i) => !i.visible);
    // A repository whose head cannot be read: hidden rather than painted stale.
    active = { root: w.dir, ctx: { refs: { getHead: async () => Promise.reject(new Error("gone")) } } };
    b.item.visible = true;
    b.change();
    await painted(b.item, (i) => !i.visible);
  } finally {
    b.sync.dispose();
  }
});

test("a status that cannot be read counts as no changed files, not a hidden item", async () => {
  const w = world();
  const ctx = new Proxy(w.ctx, {
    get: (t, p) => (p === "status" ? { read: async () => Promise.reject(new Error("locked")) } : Reflect.get(t, p)),
  });
  const b = bar(() => ({ ctx, root: w.dir }));
  try {
    await painted(b.item, (i) => i.visible);
    assert.equal(b.item.text, "$(git-branch) main");
  } finally {
    b.sync.dispose();
  }
});

test("clicking opens the branch UI (when a repository is open), and does nothing without one", async () => {
  const w = world();
  let active: { ctx: unknown; root: string } | undefined = w.entry;
  const b = bar(() => active);
  try {
    await b.run("gitstudio.syncStatus.menu");
    assert.equal(b.opened(), 1);
    active = undefined;
    await b.run("gitstudio.syncStatus.menu");
    await b.run("sync");
    assert.equal(b.opened(), 1);
  } finally {
    b.sync.dispose();
  }
});

// ── Fetch ────────────────────────────────────────────────────────────────────

test("Fetch brings the remote's new commit into origin/main and says Fetched", async () => {
  const w = world();
  const theirs = remoteCommit(w);
  const b = bar(() => w.entry);
  try {
    reset();
    await b.run("fetch");
    assert.equal(w.git("rev-parse", "refs/remotes/origin/main"), theirs);
    assert.deepEqual(said("status"), ["$(check) Fetched"]);
    await painted(b.item, (i) => i.text === "$(git-branch) main $(arrow-down)1");
  } finally {
    b.sync.dispose();
  }
});

// ── Sync ─────────────────────────────────────────────────────────────────────

test("Sync on a branch behind and ahead of nobody else's rewrite: pulls, then pushes, and says Synced", async () => {
  const w = world();
  const theirs = remoteCommit(w, "theirs", "main", ["theirs.txt", "t\n"]);
  commit(w, "mine", ["mine.txt", "m\n"]);
  const b = bar(() => w.entry);
  try {
    reset([[/have diverged$/, "rebase"]]);
    await b.run("sync");
    assert.deepEqual(titles(), ["'main' and origin/main have diverged"]);
    assert.equal(w.git("rev-parse", "HEAD~1"), theirs, "rebased on theirs");
    assert.equal(w.origin("rev-parse", "main"), w.git("rev-parse", "HEAD"), "and pushed");
    assert.deepEqual(said("status"), ["$(check) Synced"]);
  } finally {
    b.sync.dispose();
  }
});

test("Sync only behind: fast-forwards without a question, and there is nothing to push", async () => {
  const w = world();
  const theirs = remoteCommit(w);
  const b = bar(() => w.entry);
  try {
    reset();
    await b.run("sync");
    assert.deepEqual(asked, []);
    assert.equal(w.git("rev-parse", "HEAD"), theirs);
    assert.deepEqual(said("status"), ["$(check) Synced"]);
  } finally {
    b.sync.dispose();
  }
});

test("Sync over a divergence, backed out of the question: nothing is pulled or pushed", async () => {
  const w = world();
  const theirs = remoteCommit(w);
  const mine = commit(w, "mine");
  const b = bar(() => w.entry);
  try {
    reset();
    await b.run("sync");
    assert.equal(w.git("rev-parse", "HEAD"), mine);
    assert.equal(w.origin("rev-parse", "main"), theirs);
    assert.deepEqual(vscode.__said, []);
  } finally {
    b.sync.dispose();
  }
});

test("Sync whose fetch fails says Fetch failed, and pulls nothing", async () => {
  const w = world();
  rmSync(w.remote, { recursive: true, force: true });
  const b = bar(() => w.entry);
  try {
    reset();
    await b.run("sync");
    assert.match(said("error")[0] ?? "", /^GitStudio: Fetch failed — /);
  } finally {
    b.sync.dispose();
  }
});

test("Sync after amending a pushed commit asks about the rewrite; Force push replaces it on the remote", async () => {
  const w = world();
  const { amended } = amendPushed(w);
  const b = bar(() => w.entry);
  try {
    reset([[/^This branch was rewritten$/, "force"]]);
    await b.run("sync");
    assert.deepEqual(titles(), ["This branch was rewritten"]);
    assert.match((asked[0] as { hint?: string }).hint ?? "", /^Your commit replaced the version the remote still has/);
    assert.equal(w.origin("rev-parse", "main"), amended);
    assert.deepEqual(said("status"), ["$(check) Pushed"]);
  } finally {
    b.sync.dispose();
  }
});

test("Sync after amending, Leave it alone: nothing is pushed and nothing is pulled", async () => {
  const w = world();
  const { pushed, amended } = amendPushed(w);
  const b = bar(() => w.entry);
  try {
    reset([[/^This branch was rewritten$/, "cancel"]]);
    await b.run("sync");
    assert.equal(w.origin("rev-parse", "main"), pushed);
    assert.equal(w.git("rev-parse", "HEAD"), amended);
    assert.deepEqual(said("status"), []);
  } finally {
    b.sync.dispose();
  }
});

test("Sync over a divergence that conflicts stops, says so, and pushes nothing", async () => {
  const w = world();
  const theirs = remoteCommit(w, "theirs", "main", ["f.txt", "theirs\n"]);
  commit(w, "mine", ["f.txt", "mine\n"]);
  const b = bar(() => w.entry);
  try {
    reset([[/have diverged$/, "merge"]]);
    await b.run("sync");
    assert.ok(has(w.git, "MERGE_HEAD"), "the merge is paused for the user");
    assert.equal(w.origin("rev-parse", "main"), theirs, "nothing pushed");
    assert.equal(said("warning").length, 1);
    assert.match(said("warning")[0], /conflict/i);
    assert.deepEqual(said("error"), []);
    assert.ok(executed.includes("gitstudio.commit.focus"), "Changes is revealed");
  } finally {
    b.sync.dispose();
  }
});

const has = (g: Git, ref: string): boolean => {
  try {
    g("rev-parse", "--verify", "-q", ref);
    return true;
  } catch {
    return false;
  }
};

/** topic, published and tracking origin/topic — which is then deleted on the remote. */
function goneUpstream(w: World): void {
  w.git("checkout", "-q", "-b", "topic");
  w.git("push", "-q", "-u", "origin", "topic");
  w.origin("update-ref", "-d", "refs/heads/topic");
}

test("Sync on a branch whose remote branch was deleted asks what to do; Republish recreates it", async () => {
  const w = world();
  goneUpstream(w);
  const b = bar(() => w.entry);
  try {
    reset([[/which no longer exists$/, "republish"]]);
    await b.run("sync");
    // The remote-tracking ref went with the fetch's prune, so the title used to
    // read `@{u}` and find nothing — "tracks its upstream". It reads the
    // configured upstream now, which survives the prune, and names it.
    assert.deepEqual(titles(), ['"topic" tracks origin/topic, which no longer exists']);
    assert.equal(w.origin("rev-parse", "refs/heads/topic"), w.git("rev-parse", "HEAD"));
    assert.deepEqual(said("status"), ["$(check) Published topic"]);
    assert.deepEqual(said("error"), [], "git's 'no such ref was fetched' is not shown");
  } finally {
    b.sync.dispose();
  }
});

test("Sync on a branch whose remote branch was deleted → Stop Tracking unsets the upstream", async () => {
  const w = world();
  goneUpstream(w);
  const b = bar(() => w.entry);
  try {
    reset([[/which no longer exists$/, "unset"]]);
    await b.run("sync");
    assert.throws(() => w.git("config", "--get", "branch.topic.merge"));
    assert.deepEqual(said("status"), ['$(check) "topic" no longer tracks a remote branch']);
  } finally {
    b.sync.dispose();
  }
});

test("Sync on a branch whose remote branch was deleted, question dismissed: nothing changes and git's words are not shown", async () => {
  const w = world();
  goneUpstream(w);
  const b = bar(() => w.entry);
  try {
    reset();
    await b.run("sync");
    assert.equal(titles().length, 1);
    assert.equal(w.git("config", "--get", "branch.topic.merge"), "refs/heads/topic");
    assert.ok(!has(w.origin, "refs/heads/topic"));
    assert.deepEqual(vscode.__said, []);
  } finally {
    b.sync.dispose();
  }
});

// ── Pull ─────────────────────────────────────────────────────────────────────

test("Pull on a branch only behind fast-forwards and says Pulled", async () => {
  const w = world();
  const theirs = remoteCommit(w);
  const b = bar(() => w.entry);
  try {
    reset();
    await b.run("pull");
    assert.deepEqual(asked, [], "nothing to combine, so nothing asked");
    assert.equal(w.git("rev-parse", "HEAD"), theirs);
    assert.deepEqual(said("status"), ["$(check) Pulled"]);
  } finally {
    b.sync.dispose();
  }
});

test("Pull over a divergence asks merge-or-rebase; Merge records a merge commit", async () => {
  const w = world();
  const theirs = remoteCommit(w, "theirs", "main", ["t.txt", "t\n"]);
  const mine = commit(w, "mine", ["m.txt", "m\n"]);
  const b = bar(() => w.entry);
  try {
    reset([[/have diverged$/, "merge"]]);
    await b.run("pull");
    assert.match((asked[0] as { hint?: string }).hint ?? "", /^You have 1 commit origin\/main doesn't, and it has 1 commit you don't\./);
    assert.deepEqual(w.git("rev-list", "--parents", "-1", "HEAD").split(" ").slice(1), [mine, theirs]);
    assert.deepEqual(said("status"), ["$(check) Pulled"]);
  } finally {
    b.sync.dispose();
  }
});

test("Pull over a divergence, backed out: nothing changes", async () => {
  const w = world();
  remoteCommit(w);
  const mine = commit(w, "mine");
  const b = bar(() => w.entry);
  try {
    reset();
    await b.run("pull");
    assert.equal(w.git("rev-parse", "HEAD"), mine);
    assert.deepEqual(vscode.__said, []);
  } finally {
    b.sync.dispose();
  }
});

test("Pull on a detached HEAD says there is no branch to pull into, and asks nothing", async () => {
  const w = world();
  remoteCommit(w);
  w.git("checkout", "-q", "--detach");
  const head = w.git("rev-parse", "HEAD");
  const b = bar(() => w.entry);
  try {
    reset([[/./, "merge"]]);
    await b.run("pull");
    assert.deepEqual(asked, []);
    assert.deepEqual(said("warning"), ["GitStudio: HEAD is detached, so there is no branch to pull into. Check out a branch first."]);
    assert.equal(w.git("rev-parse", "HEAD"), head);
  } finally {
    b.sync.dispose();
  }
});

test("Pull pressed again over a merge it left paused says so, instead of asking or failing", async () => {
  const w = world();
  remoteCommit(w, "theirs", "main", ["f.txt", "theirs\n"]);
  commit(w, "mine", ["f.txt", "mine\n"]);
  const b = bar(() => w.entry);
  try {
    reset([[/have diverged$/, "merge"]]);
    await b.run("pull");
    assert.ok(has(w.git, "MERGE_HEAD"));
    reset([[/./, "merge"]]);
    await b.run("pull");
    assert.deepEqual(asked, []);
    assert.equal(said("warning").length, 1);
    assert.deepEqual(said("error"), []);
    assert.ok(has(w.git, "MERGE_HEAD"), "still paused");
  } finally {
    b.sync.dispose();
  }
});

// ── Push ─────────────────────────────────────────────────────────────────────

test("Push asks plain-or-force; Push sends the commit and says Pushed", async () => {
  const w = world();
  const mine = commit(w, "mine");
  const b = bar(() => w.entry);
  try {
    reset([[/^Push to the upstream branch\?$/, "push"]]);
    await b.run("push");
    const offered = (asked[0] as { choices: { id: string; danger?: boolean }[] }).choices;
    assert.deepEqual(offered.map((c) => c.id), ["push", "force"]);
    assert.equal(offered[1].danger, true);
    assert.equal(w.origin("rev-parse", "main"), mine);
    assert.deepEqual(said("status"), ["$(check) Pushed"]);
  } finally {
    b.sync.dispose();
  }
});

test("Push, dismissed: nothing is pushed", async () => {
  const w = world();
  const before = w.origin("rev-parse", "main");
  commit(w, "mine");
  const b = bar(() => w.entry);
  try {
    reset();
    await b.run("push");
    assert.equal(w.origin("rev-parse", "main"), before);
  } finally {
    b.sync.dispose();
  }
});

test("Push refused because the remote moved on says Push failed with git's reason", async () => {
  const w = world();
  const theirs = remoteCommit(w);
  commit(w, "mine");
  const b = bar(() => w.entry);
  try {
    reset([[/^Push to the upstream branch\?$/, "push"]]);
    await b.run("push");
    assert.match(said("error")[0] ?? "", /^GitStudio: Push failed — /);
    assert.equal(w.origin("rev-parse", "main"), theirs);
  } finally {
    b.sync.dispose();
  }
});

test("Force push over commits this branch never had is refused before it runs, and says to pull first", async () => {
  const w = world();
  const theirs = remoteCommit(w);
  w.git("fetch", "-q", "origin"); // a background fetch: the lease alone would pass
  commit(w, "mine");
  const b = bar(() => w.entry);
  try {
    reset([[/^Push to the upstream branch\?$/, "force"]]);
    await b.run("push");
    assert.equal(w.origin("rev-parse", "main"), theirs, "their commit survives");
    assert.equal(said("warning").length, 1);
    assert.match(said("warning")[0], /never had/);
    assert.deepEqual(said("error"), []);
  } finally {
    b.sync.dispose();
  }
});

// ── Publish ──────────────────────────────────────────────────────────────────

test("Publish with one remote publishes the branch there, tracked, and says Published", async () => {
  const w = world();
  w.git("checkout", "-q", "-b", "topic");
  const b = bar(() => w.entry);
  try {
    reset();
    await b.run("publish");
    assert.deepEqual(asked, []);
    assert.equal(w.origin("rev-parse", "refs/heads/topic"), w.git("rev-parse", "HEAD"));
    assert.equal(w.git("config", "--get", "branch.topic.remote"), "origin");
    assert.deepEqual(said("status"), ["$(check) Published topic"]);
  } finally {
    b.sync.dispose();
  }
});

test("Publish with two remotes asks which, and publishes to the one picked", async () => {
  const w = world();
  const fork = join(w.dir, "..", "fork.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", fork]);
  w.git("remote", "add", "fork", fork);
  w.git("checkout", "-q", "-b", "topic");
  const b = bar(() => w.entry);
  try {
    reset([[/^Publish this branch to which remote\?$/, "fork"]]);
    await b.run("publish");
    assert.deepEqual(titles(), ["Publish this branch to which remote?"]);
    assert.ok(has(at(fork), "refs/heads/topic"));
    assert.ok(!has(w.origin, "refs/heads/topic"));
  } finally {
    b.sync.dispose();
  }
});

test("Publish on a detached HEAD, or with no remote, says why and pushes nothing", async () => {
  const w = world();
  w.git("checkout", "-q", "--detach");
  const lone = world({ remote: false });
  lone.git("checkout", "-q", "-b", "topic");
  let active = w.entry;
  const b = bar(() => active);
  try {
    reset();
    await b.run("publish");
    active = lone.entry;
    await b.run("publish");
    assert.deepEqual(said("info"), [
      "GitStudio: cannot publish a detached HEAD — check out a branch first.",
      "GitStudio: no remotes configured.",
    ]);
    assert.equal(w.origin("for-each-ref", "refs/heads/"), `${w.origin("rev-parse", "main")} commit\trefs/heads/main`);
  } finally {
    b.sync.dispose();
  }
});

test("dispose removes every verb it registered", () => {
  const w = world();
  const b = bar(() => w.entry);
  assert.ok(handlers.has("gitstudio.sync.push"));
  b.sync.dispose();
  for (const id of ["sync", "fetch", "pull", "push", "publish"]) assert.ok(!handlers.has(`gitstudio.sync.${id}`), id);
  assert.ok(!handlers.has("gitstudio.syncStatus.menu"));
});
