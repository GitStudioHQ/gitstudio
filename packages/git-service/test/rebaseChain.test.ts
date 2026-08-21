import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { readRewritableChain } from "../src/rebaseChain";

// The chain against REAL git, not a hand-built fixture.
//
// engine/rebase/chain.ts decides what the answer means; this pins that the
// question we ask git actually returns what that reasoning assumes — first
// parent only, unpushed only, in newest-first order.

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
let bare: string;
let clone: string;
let ctx: GitContext;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: ENV });
}
const c = (msg: string) => {
  writeFileSync(join(clone, `${msg}.txt`), `${msg}\n`);
  git(clone, ["add", "-A"]);
  git(clone, ["commit", "-q", "-m", msg]);
};
const subjectsOf = (shas: string[]) =>
  shas.map((s) => git(clone, ["log", "-1", "--format=%s", s]).trim());

before(() => {
  bare = mkdtempSync(join(tmpdir(), "gs-chain-bare-"));
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { env: ENV });
  clone = mkdtempSync(join(tmpdir(), "gs-chain-"));
  execFileSync("git", ["init", "-b", "main", clone], { env: ENV });
  git(clone, ["config", "user.email", "d@e.com"]);
  git(clone, ["config", "user.name", "D"]);
  git(clone, ["config", "commit.gpgsign", "false"]);
  git(clone, ["remote", "add", "origin", bare]);
  ctx = new GitContext({ root: clone });
});

after(() => {
  ctx?.dispose();
  for (const d of [bare, clone]) {
    if (d) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("with no remote branch yet, the whole history is rewritable to the root", async () => {
  c("base");
  c("one");
  const chain = await readRewritableChain(ctx.process);
  assert.deepEqual(subjectsOf(chain.shas), ["one", "base"]);
  assert.equal(chain.stop, "root");
  assert.equal(chain.base, undefined, "a rebase here needs --root");
});

test("pushing draws the line — published commits drop out of the chain", async () => {
  git(clone, ["push", "-q", "-u", "origin", "main"]);
  c("local-1");
  c("local-2");

  const chain = await readRewritableChain(ctx.process);
  assert.deepEqual(subjectsOf(chain.shas), ["local-2", "local-1"]);
  assert.equal(chain.stop, "published");
  assert.equal(
    subjectsOf([chain.base!])[0],
    "one",
    "the rebase runs onto the newest published commit",
  );
});

test("a merge ends the chain, and the merge itself is not in it", async () => {
  git(clone, ["checkout", "-q", "-b", "side"]);
  c("side-1");
  git(clone, ["checkout", "-q", "main"]);
  git(clone, ["merge", "-q", "--no-ff", "side", "-m", "merge side"]);
  c("after-merge");

  const chain = await readRewritableChain(ctx.process);
  assert.deepEqual(
    subjectsOf(chain.shas),
    ["after-merge"],
    "everything below the merge is out of reach",
  );
  assert.equal(chain.stop, "merge");
  assert.equal(subjectsOf([chain.base!])[0], "merge side");
});

test("the chain follows FIRST parent only — the side branch never appears", async () => {
  const chain = await readRewritableChain(ctx.process);
  assert.ok(
    !subjectsOf(chain.shas).includes("side-1"),
    "a commit merged in from another branch is not part of this branch's chain",
  );
});

test("a clean, fully pushed branch has nothing to reorder", async () => {
  git(clone, ["push", "-q", "--force", "origin", "main"]);
  const chain = await readRewritableChain(ctx.process);
  assert.deepEqual(chain.shas, []);
});

test("a max-count cap only ever shortens the chain", async () => {
  c("x1");
  c("x2");
  c("x3");
  const full = await readRewritableChain(ctx.process);
  const capped = await readRewritableChain(ctx.process, { maxCount: 2 });
  assert.equal(full.shas.length, 3);
  assert.equal(capped.shas.length, 2);
  assert.deepEqual(
    capped.shas,
    full.shas.slice(0, 2),
    "the cap takes the newest, never a different set",
  );
});
