import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { STASH_GONE_MESSAGE } from "@gitstudio/git-service/StashProvider";
import { GitBridge } from "../src/main/gitBridge";
import type { RepoStore } from "../src/main/repoStore";
import { removeTempRepo } from "./tmpRepo";

// A stash on the desktop is named by its sha, end to end.
//
// `stash@{n}` is a position: every push, pop or drop renumbers the list. The
// renderer checked, before its first request, that the row's `stash@{n}` was
// still the stash it drew — and then sent `stash@{n}`, and Stash & Retry sent
// the SAME `stash@{n}` again after the question. A stash pushed while the
// question was up (a terminal, a pull's autostash) made Pop pop, and drop, that
// newcomer. The request names the stash by sha now, and the engine finds it in
// the list just before git runs.
//
// And the stash page's "The commit it holds" opened a commit page whose files
// were the stash against its first parent — which leaves out the new files a
// stash made with -u keeps in its third parent: a stash of only new files
// looked empty, easy to drop believing there was nothing in it.

let repo: string;
let ctx: GitContext;
let bridge: GitBridge;

const git = (...a: string[]): string =>
  execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
const write = (f: string, s: string): void => writeFileSync(join(repo, f), s);
const read = (f: string): string => readFileSync(join(repo, f), "utf8");
const listed = (): string[] => git("stash", "list", "--format=%s").split("\n").filter((l) => l.length > 0);
const shaOf = (ref: string): string => git("rev-parse", ref).trim();

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-stashid-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  write("a.txt", "a0\n");
  write("b.txt", "b0\n");
  write("c.txt", "c0\n");
  git("add", ".");
  git("commit", "-q", "-m", "first");
  ctx = new GitContext({ root: repo });
  bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
});

afterEach(() => {
  ctx.dispose();
  removeTempRepo(repo);
});

// ── The renderer's own door (bridge.ts), answered by the real main side ──────

type Invoke = (channel: string, payload: unknown) => Promise<unknown>;
let answering: Invoke = async () => undefined;
(globalThis as { window?: unknown }).window = {
  gitstudio: { invoke: (c: string, p: unknown) => answering(c, p), on: () => () => {} },
};

async function rendererDoor(whileAsked: () => void): Promise<{ invoke: Invoke; notes: string[] }> {
  answering = async (channel, payload) => {
    if (channel === "stash:pop") return bridge.stashPop(payload as string);
    if (channel === "stash:apply") return bridge.stashApply(payload as string);
    throw new Error(`unexpected channel ${channel}`);
  };
  const mod = await import("../src/renderer/bridge");
  const notes: string[] = [];
  mod.answerInTheWayWith(
    async () => {
      whileAsked();
      return true; // Stash & Retry
    },
    (n) => notes.push(n),
  );
  return { invoke: mod.host.invoke as unknown as Invoke, notes };
}

for (const pop of [true, false]) {
  const verb = pop ? "Pop" : "Apply";
  test(`${verb} → Stash & Retry: a stash pushed while the question is up is not the one ${pop ? "popped" : "applied"}`, async () => {
    write("a.txt", "a-OLDER\n");
    git("stash", "push", "-q", "-m", "OLDER");
    write("b.txt", "b-TARGET\n");
    git("stash", "push", "-q", "-m", "TARGET");
    const target = shaOf("stash@{0}");
    write("b.txt", "b-mine\n"); // in the way of TARGET
    const door = await rendererDoor(() => {
      // A terminal, a pull's autostash: TARGET is stash@{1} now.
      write("c.txt", "c-NEW\n");
      git("stash", "push", "-q", "-m", "NEWCOMER");
    });
    // What the stash list and the stash page send: the row's sha.
    const r = (await door.invoke(pop ? "stash:pop" : "stash:apply", target)) as { ok: boolean; message?: string };
    assert.equal(r.ok, true, r.message);
    assert.equal(read("c.txt"), "c0\n", "NEWCOMER was not applied");
    assert.ok(listed().includes("On main: NEWCOMER"), `NEWCOMER is still listed: ${listed().join(" | ")}`);
    assert.ok(listed().includes("On main: OLDER"));
    assert.equal(listed().includes("On main: TARGET"), !pop, pop ? "TARGET, the stash picked, is the one popped" : "an apply keeps it");
    const tb = git("show", `${target}:b.txt`);
    assert.equal(tb, "b-TARGET\n");
  });
}

// ── A stash that has left the list is the user's state ───────────────────────

test("Apply, Pop and Drop of a stash that has left the list say so, expected — never a crash report", async () => {
  write("a.txt", "gone\n");
  git("stash", "push", "-q", "-m", "gone");
  const gone = shaOf("stash@{0}");
  git("stash", "drop", "-q");
  write("a.txt", "kept\n");
  git("stash", "push", "-q", "-m", "kept");
  for (const [name, run] of [
    ["apply", () => bridge.stashApply(gone)],
    ["pop", () => bridge.stashPop(gone)],
    ["drop", () => bridge.stashDrop(gone)],
  ] as const) {
    const r = await run();
    assert.equal(r.ok, false, name);
    assert.equal(r.expected, true, `${name}: said, not filed (${JSON.stringify(r)})`);
    assert.equal(r.message, STASH_GONE_MESSAGE, name);
  }
  assert.deepEqual(listed(), ["On main: kept"], "nothing else was touched");
  assert.equal(read("a.txt"), "a0\n");
});

// ── The commit a stash holds, shown whole ────────────────────────────────────

test("the commit page of a stash made with -u lists its new files, and each opens with its content", async () => {
  write("new.ts", "brand new\n");
  git("stash", "push", "-q", "-u", "-m", "only new files");
  const sha = shaOf("stash@{0}");
  const d = await bridge.commitDetails(sha);
  assert.deepEqual(
    d?.files.map((f) => [f.path, f.status]),
    [["new.ts", "A"]],
    "not an empty commit",
  );
  const diff = await bridge.fileDiff({ path: "new.ts", sha });
  assert.equal(diff?.leftText, "");
  assert.equal(diff?.rightText, "brand new\n");
});

test("a mixed -u stash: its edit and its new file, each once", async () => {
  write("a.txt", "a changed\n");
  write("fresh.ts", "fresh\n");
  git("stash", "push", "-q", "-u", "-m", "mixed");
  const sha = shaOf("stash@{0}");
  const d = await bridge.commitDetails(sha);
  assert.deepEqual(d?.files.map((f) => [f.path, f.status]).sort(), [["a.txt", "M"], ["fresh.ts", "A"]]);
  assert.equal((await bridge.fileDiff({ path: "a.txt", sha }))?.rightText, "a changed\n");
  assert.equal((await bridge.fileDiff({ path: "fresh.ts", sha }))?.rightText, "fresh\n");
});

test("an octopus merge's third parent is not read as a stash's new files", async () => {
  // y's own commit changes c.txt exactly as main does, so the merge — shown
  // against its first parent — has no c.txt; read as a stash's third parent,
  // it would.
  git("checkout", "-q", "-b", "y", "main");
  write("c.txt", "c-both\n");
  git("commit", "-q", "-am", "y");
  git("checkout", "-q", "-b", "x", "main");
  write("x.txt", "x\n");
  git("add", "x.txt");
  git("commit", "-q", "-m", "x");
  git("checkout", "-q", "main");
  write("c.txt", "c-both\n");
  git("commit", "-q", "-am", "main");
  git("merge", "-q", "--no-ff", "--no-edit", "x", "y");
  const sha = shaOf("HEAD");
  const d = await bridge.commitDetails(sha);
  assert.equal(d?.parents.length, 3);
  assert.deepEqual(d?.files.map((f) => f.path), ["x.txt"], "against its first parent, as every merge is shown");
});

// ── What the page is told ────────────────────────────────────────────────────

test("a Pop that could not restore the stash's staging keeps the stash, and the renderer's door says why", async () => {
  // util.ts staged as a = 2, working copy a = 3; the user's own staged change beside it.
  write("a.txt", "a = 2\n");
  git("add", "a.txt");
  write("a.txt", "a = 3\n");
  git("stash", "push", "-q", "-m", "staged and not");
  const sha = shaOf("stash@{0}");
  write("b.txt", "mine, staged\n");
  git("add", "b.txt");
  const door = await rendererDoor(() => assert.fail("nothing is in the way: no question"));
  const r = (await door.invoke("stash:pop", sha)) as { ok: boolean; stashKept?: true; message?: string };
  assert.equal(r.ok, true, r.message);
  assert.equal(r.stashKept, true);
  assert.deepEqual(listed(), ["On main: staged and not"], "kept");
  assert.equal(door.notes.length, 1, "said once, without a question asked");
  assert.match(door.notes[0], /staged changes came back unstaged/);
});
