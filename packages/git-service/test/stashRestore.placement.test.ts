// Putting a dropped stash back where it was (stashRestore.ts) — the refusals
// and the half-way failures, each with the stack it leaves behind.
//
// Undo of "Drop stash@{1}" lifts the entries above, stores the dropped one and
// stores the lifted ones back. Every step can fail; what matters is that the
// stack the user is left with is the one the answer describes, and that a
// failure names the `git stash store <sha>` that brings a stash back by hand.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { makeRepo, type Repo } from "./opRepo";
import { GitProcess } from "../src/GitProcess";
import { placeHolds, restoreStash, stashStack, type StashSlot } from "../src/stashRestore";
import { cmd, fail, ok, tap } from "./stashProvider.kit";

const repos: Repo[] = [];
const procs: { dispose(): void }[] = [];
after(() => {
  for (const p of procs.splice(0)) p.dispose();
  for (const r of repos.splice(0)) r.cleanup();
});

/** A repo with three stashes: "one" (bottom), "two", "three" (top). */
function threeStashes(): { r: Repo; proc: GitProcess } {
  const r = makeRepo("restore");
  repos.push(r);
  r.write("f.txt", "base\n");
  r.commitAll("base");
  for (const word of ["one", "two", "three"]) {
    r.write("f.txt", `${word}\n`);
    r.git("stash", "push", "-q", "-m", word);
  }
  const proc = new GitProcess({ cwd: r.root });
  procs.push(proc);
  return { r, proc };
}

const messages = (stack: StashSlot[]): string[] => stack.map((s) => s.message.replace(/^On master: /, ""));

/** Drop stash@{1} ("two") the way the app does, and hand back what Undo gets. */
async function dropMiddle(r: Repo, proc: GitProcess): Promise<{ entry: StashSlot; above: string[] }> {
  const stack = await stashStack(proc);
  const entry = stack[1];
  r.git("stash", "drop", "-q", "stash@{1}");
  return { entry, above: [stack[0].sha] };
}

test("stashStack reads the stack newest first, with each entry's message", async () => {
  const { proc } = threeStashes();
  const stack = await stashStack(proc);
  assert.deepEqual(messages(stack), ["three", "two", "one"]);
  for (const s of stack) assert.match(s.sha, /^[0-9a-f]{40}$/);
});

test("stashStack is empty when git can't list the stashes, and skips lines that are not entries", async () => {
  const broken = tap(undefined, () => fail("fatal: not a git repository", 128));
  assert.deepEqual(await stashStack(broken.proc), []);

  const sha = "a".repeat(40);
  const odd = tap(undefined, () => ok(`${sha}\n\nnot-a-sha\x1fOn main: junk\n${"b".repeat(40)}\x1fOn main: kept\n`));
  assert.deepEqual(await stashStack(odd.proc), [
    { sha, message: "" }, // no separator: the whole line is the sha, and there is no message
    { sha: "b".repeat(40), message: "On main: kept" },
  ]);
});

test("placeHolds only while the entries above are exactly the ones that were there", () => {
  const stack: StashSlot[] = ["1", "2", "3"].map((c) => ({ sha: c.repeat(40), message: c }));
  assert.equal(placeHolds(stack, undefined), false, "no place recorded");
  assert.equal(placeHolds(stack, { index: 0, above: [] }), false, "the top needs no placing");
  assert.equal(placeHolds(stack, { index: 2, above: ["1".repeat(40)] }), false, "a place whose record is short");
  assert.equal(placeHolds(stack, { index: 4, above: stack.map((s) => s.sha).concat("4".repeat(40)) }), false, "deeper than the stack");
  assert.equal(placeHolds(stack, { index: 2, above: ["1".repeat(40), "9".repeat(40)] }), false, "a different entry above");
  assert.equal(placeHolds(stack, { index: 2, above: ["1".repeat(40), "2".repeat(40)] }), true);
});

test("a dropped stash comes back at its old place, under the one that was above it", async () => {
  const { r, proc } = threeStashes();
  const { entry, above } = await dropMiddle(r, proc);
  const back = await restoreStash(proc, entry, { index: 1, above });
  assert.deepEqual(back, { ok: true, index: 1 });
  assert.deepEqual(messages(await stashStack(proc)), ["three", "two", "one"]);
});

test("when the stack changed since the drop, the stash goes on top, and the answer says index 0", async () => {
  const { r, proc } = threeStashes();
  const { entry } = await dropMiddle(r, proc);
  const back = await restoreStash(proc, entry, { index: 1, above: ["f".repeat(40)] });
  assert.deepEqual(back, { ok: true, index: 0 });
  assert.deepEqual(messages(await stashStack(proc)), ["two", "three", "one"]);
});

test("a sha that is already a stash is left alone, and the answer says where it is", async () => {
  const { proc } = threeStashes();
  const before = await stashStack(proc);
  const back = await restoreStash(proc, before[2], { index: 2, above: [before[0].sha, before[1].sha] });
  assert.deepEqual(back, { ok: true, index: 2, already: true });
  assert.deepEqual(await stashStack(proc), before, "nothing was stored twice");
});

test("a name that is not a sha is refused before git is asked anything", async () => {
  const t = tap(undefined, () => ok());
  const back = await restoreStash(t.proc, { sha: "stash@{0}", message: "x" });
  assert.equal(back.ok, false);
  assert.match(back.ok ? "" : back.message, /isn't a stash this app recorded/);
  assert.deepEqual(t.ran, [], "git never ran");
});

test("a sha that is not a commit in the repository is an expected refusal, and nothing is stored", async () => {
  const { r, proc } = threeStashes();
  const before = await stashStack(proc);
  const blob = r.git("hash-object", "-w", "--stdin").trim(); // empty stdin: the empty blob
  for (const sha of [blob, "0123456789".repeat(4)]) {
    const back = await restoreStash(proc, { sha, message: "On master: ghost" });
    assert.deepEqual(back, { ok: false, expected: true, message: "That stash is no longer in the repository." });
  }
  assert.deepEqual(await stashStack(proc), before);
});

test("a stash with no message is stored without -m", async () => {
  const { r, proc } = threeStashes();
  const [top] = await stashStack(proc);
  r.git("stash", "drop", "-q", "stash@{0}");
  const t = tap(r.root, () => undefined);
  procs.push(t);
  const back = await restoreStash(t.proc, { sha: top.sha, message: "" });
  assert.deepEqual(back, { ok: true, index: 0 });
  assert.ok(t.ran.some((a) => cmd(a) === `stash store ${top.sha}`), "stored bare");
  assert.equal((await stashStack(proc))[0].sha, top.sha);
});

test("when room can't be made at the old place, what was lifted goes back and nothing else changes", async () => {
  const r = makeRepo("restore-deep");
  repos.push(r);
  r.write("f.txt", "base\n");
  r.commitAll("base");
  for (const word of ["one", "two", "three", "four"]) {
    r.write("f.txt", `${word}\n`);
    r.git("stash", "push", "-q", "-m", word);
  }
  const real = new GitProcess({ cwd: r.root });
  procs.push(real);
  const stack = await stashStack(real);
  const entry = stack[2]; // "two"
  r.git("stash", "drop", "-q", "stash@{2}");
  const before = await stashStack(real);

  let drops = 0;
  const t = tap(r.root, (args) => {
    if (cmd(args).startsWith("stash drop")) {
      drops++;
      if (drops === 2) return fail("error: cannot lock ref 'refs/stash'");
    }
    return undefined;
  });
  procs.push(t);
  const back = await restoreStash(t.proc, entry, { index: 2, above: [stack[0].sha, stack[1].sha] });
  assert.equal(back.ok, false);
  const msg = back.ok ? "" : back.message;
  assert.match(msg, /Couldn't make room for the stash at stash@\{2\} \(error: cannot lock ref 'refs\/stash'\)/);
  assert.doesNotMatch(msg, /may need putting back/, "the one lifted entry was put back");
  assert.deepEqual(await stashStack(real), before, "the stack is as it was");
  assert.equal((await stashStack(real)).some((s) => s.sha === entry.sha), false, "and the dropped stash is still out");
});

test("a failed lift whose put-back fails too names the stores that bring the lifted stashes back", async () => {
  const deep = makeRepo("restore-deep2");
  repos.push(deep);
  deep.write("f.txt", "base\n");
  deep.commitAll("base");
  for (const word of ["one", "two", "three", "four"]) {
    deep.write("f.txt", `${word}\n`);
    deep.git("stash", "push", "-q", "-m", word);
  }
  const real = new GitProcess({ cwd: deep.root });
  procs.push(real);
  const stack = await stashStack(real);
  deep.git("stash", "drop", "-q", "stash@{2}");
  let n = 0;
  const t2 = tap(deep.root, (args) => {
    const c = cmd(args);
    if (c.startsWith("stash drop") && ++n === 2) return fail("");
    if (c.startsWith("stash store")) return fail("");
    return undefined;
  });
  procs.push(t2);
  const back2 = await restoreStash(t2.proc, stack[2], { index: 2, above: [stack[0].sha, stack[1].sha] });
  assert.equal(back2.ok, false);
  const msg = back2.ok ? "" : back2.message;
  assert.match(msg, /\(git stash drop failed\)/, "git said nothing, so the step is named");
  assert.match(msg, new RegExp(`Some stashes may need putting back: git stash store ${stack[0].sha}\\.`));
});

test("when the stash itself can't be stored, the lifted ones still go back, and the answer names its sha", async () => {
  const { r, proc } = threeStashes();
  const { entry, above } = await dropMiddle(r, proc);
  const before = await stashStack(proc);
  const t = tap(r.root, (args) => (cmd(args).startsWith("stash store") && args.includes(entry.sha) ? fail("") : undefined));
  procs.push(t);
  const back = await restoreStash(t.proc, entry, { index: 1, above });
  assert.deepEqual(back, {
    ok: false,
    message: `Couldn't put the stash back. \`git stash store ${entry.sha}\` brings it back by hand.`,
  });
  assert.deepEqual(
    (await stashStack(proc)).map((s) => s.sha),
    before.map((s) => s.sha),
    "the one above it is back on top",
  );
});

test("when the ones above can't be put back on top, the stash is back and the answer names their stores", async () => {
  const { r, proc } = threeStashes();
  const { entry, above } = await dropMiddle(r, proc);
  const t = tap(r.root, (args) => (cmd(args).startsWith("stash store") && !args.includes(entry.sha) ? fail("") : undefined));
  procs.push(t);
  const back = await restoreStash(t.proc, entry, { index: 1, above });
  assert.equal(back.ok, false);
  assert.match(back.ok ? "" : back.message, new RegExp(`^The stash is back, but .*git stash store ${above[0]} brings them back\\.$`));
  const now = await stashStack(proc);
  assert.equal(now[0].sha, entry.sha, "the restored stash is on the stack");
  assert.equal(now.some((s) => s.sha === above[0]), false, "and the lifted one is the one the message names");
});
