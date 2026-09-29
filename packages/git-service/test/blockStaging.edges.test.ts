import { test, after } from "node:test";
import assert from "node:assert/strict";
import { listChangeBlocks, setBlockStaged, type ChangeBlock } from "../src/blockStaging";
import { makeRepo, type Repo } from "./opRepo";

// The tick beside a change, at its edges: a file whose committed or staged
// version is binary can only be staged whole, and ticking a block into the
// state it is already in changes nothing and reports success.

const repos: Repo[] = [];
after(() => {
  for (const r of repos.splice(0)) r.cleanup();
});

function repo(name: string): Repo {
  const r = makeRepo(`blocks-${name}`);
  repos.push(r);
  return r;
}

test("a file that was binary at HEAD lists no blocks and refuses a tick as expected, not as a bug", async () => {
  const r = repo("binary-head");
  r.write("f.dat", Buffer.from("bin\0ary\n"));
  r.commitAll("binary");
  r.write("f.dat", "now it is text\n");
  const ctx = r.ctx();
  assert.deepEqual(await listChangeBlocks(ctx, "f.dat", "now it is text\n"), []);
  // The block a text view of the file would show: line 0 replaced.
  const block: ChangeBlock = { head: { start: 0, end: 0 }, working: { start: 0, end: 0 }, state: "unstaged" };
  const res = await setBlockStaged(ctx, "f.dat", "now it is text\n", block, true);
  assert.equal(res.ok, false);
  assert.equal(res.expected, true);
  assert.match(res.stderr, /can only be staged whole/);
  assert.equal(r.git("diff", "--cached", "--name-only").trim(), "", "nothing was staged");
});

test("ticking a block that is already staged, or unticking one that is not, is a quiet no-op", async () => {
  const r = repo("noop");
  r.write("f.txt", "one\ntwo\nthree\n");
  r.commitAll("base");
  const working = "one\nTWO\nthree\n";
  r.write("f.txt", working);
  const ctx = r.ctx();

  const [unstaged] = await listChangeBlocks(ctx, "f.txt", working);
  assert.ok(unstaged, "one block");
  assert.equal(unstaged.state, "unstaged");
  // Unticking an unstaged block: nothing to take out of the index.
  assert.deepEqual(await setBlockStaged(ctx, "f.txt", working, unstaged, false), { ok: true, stderr: "" });
  assert.equal(r.git("diff", "--cached", "--name-only").trim(), "");

  r.git("add", "f.txt");
  const [staged] = await listChangeBlocks(ctx, "f.txt", working);
  assert.equal(staged.state, "staged");
  const indexBefore = r.git("ls-files", "-s", "f.txt");
  // Ticking a staged block: the index already agrees.
  assert.deepEqual(await setBlockStaged(ctx, "f.txt", working, staged, true), { ok: true, stderr: "" });
  assert.equal(r.git("ls-files", "-s", "f.txt"), indexBefore, "the index entry is untouched");
});
