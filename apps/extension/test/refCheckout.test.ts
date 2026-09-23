import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GitContext } from "@gitstudio/git-service/GitContext";
import { listedRefCheckout, planListedRefCheckout, resolveListedRef } from "../src/views/refCheckout";

// The Branches view's and the Changes view's branch-menu "Checkout" (issue
// #30's follow-up). They handed git `%(refname:short)`, and with a branch and a
// tag both called "release" the branch's is "heads/release" — which
// `git checkout` resolves as a REVISION: HEAD detached at the branch tip under
// a toast saying the branch was checked out. They plan from the FULL name now
// (git-service's planRefCheckout), looked up in the ref list when the door only
// knows a name and a type. Run against real git, because the claim is what git
// does with what it is handed.

// Hermetic git: a global config brings hooks, LFS filters and a trace2
// listener that races teardown (see git-service/test/hermetic.ts).
const CFG = join(mkdtempSync(join(tmpdir(), "gs-ext-co-cfg-")), "config");
writeFileSync(CFG, "");
process.env.GIT_CONFIG_GLOBAL = CFG;
process.env.GIT_CONFIG_SYSTEM = CFG;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";

let upstream: string;
let repo: string;
let ctx: GitContext;
let branchTip = "";
let tagTip = "";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
const symbolicHead = (): string => {
  try {
    return git(repo, "symbolic-ref", "-q", "HEAD");
  } catch {
    return "";
  }
};
const run = async (args: string[]) => ctx.process.run(args);

before(() => {
  // An upstream with `release` (a branch), `fix` (a branch you have no local
  // copy of), and a TAG `release` one commit ahead of the branch.
  upstream = mkdtempSync(join(tmpdir(), "gs-ext-co-up-"));
  git(upstream, "init", "-q", "-b", "main");
  git(upstream, "config", "user.email", "t@t.t");
  git(upstream, "config", "user.name", "T");
  writeFileSync(join(upstream, "f.txt"), "base\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "base");
  git(upstream, "branch", "release");
  git(upstream, "branch", "fix");
  writeFileSync(join(upstream, "f.txt"), "two\n");
  git(upstream, "commit", "-qam", "two");
  git(upstream, "tag", "release");

  repo = mkdtempSync(join(tmpdir(), "gs-ext-co-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "T");
  git(repo, "remote", "add", "origin", upstream);
  git(repo, "fetch", "-q", "--tags", "origin");
  git(repo, "checkout", "-q", "-B", "main", "origin/main");
  git(repo, "branch", "-q", "release", "origin/release");
  branchTip = git(repo, "rev-parse", "refs/heads/release");
  tagTip = git(repo, "rev-parse", "refs/tags/release");
  ctx = new GitContext({ root: repo });
});

after(() => {
  ctx?.dispose();
  for (const d of [repo, upstream]) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* scratch */
    }
  }
});

test("the collision is real: git lists the branch as heads/release, and checking THAT out detaches", async () => {
  const listed = await ctx.refs.listRefs();
  assert.ok(listed.some((r) => r.type === "head" && r.name === "heads/release" && r.fullName === "refs/heads/release"));
  assert.ok(listed.some((r) => r.type === "tag" && r.name === "tags/release" && r.fullName === "refs/tags/release"));
  // What checkoutBranch used to run: `git checkout <ref.name>`.
  git(repo, "checkout", "-q", "main");
  git(repo, "checkout", "-q", "heads/release");
  assert.equal(symbolicHead(), "", "HEAD is detached — the door's old outcome");
  assert.equal(git(repo, "rev-parse", "HEAD"), branchTip, "…at the branch tip, which is why it looked right");
  git(repo, "checkout", "-q", "main");
});

test("the Changes view's branch menu (a name and a type, no full name) checks out the BRANCH, attached", async () => {
  git(repo, "checkout", "-q", "main");
  // Exactly what handleBranchRefCommand hands gitstudio.branch.checkout.
  const plan = await planListedRefCheckout(ctx, { name: "heads/release", type: "head" });
  assert.ok(plan, "the menu's name was found in the ref list");
  assert.deepEqual(plan.args, ["checkout", "release"]);
  assert.equal(plan.success, "Switched to release", "the toast names the branch, not heads/release");
  const r = await run(plan.args);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(symbolicHead(), "refs/heads/release", "attached to the branch, the tag of the same name notwithstanding");
  assert.equal(git(repo, "rev-parse", "HEAD"), branchTip);
});

test("a Branches-view node (a full GitRef) goes by its fullName, without a second listing", async () => {
  git(repo, "checkout", "-q", "main");
  const node = (await ctx.refs.listRefs()).find((r) => r.fullName === "refs/heads/release")!;
  let listings = 0;
  const counting = { process: ctx.process, refs: { listRefs: async () => (listings++, ctx.refs.listRefs()) } };
  const plan = await planListedRefCheckout(counting, node);
  assert.equal(listings, 0, "a ref that carries its full name is not looked up again");
  assert.ok(plan);
  assert.equal((await run(plan.args)).code, 0);
  assert.equal(symbolicHead(), "refs/heads/release");
});

test("the tag door detaches at the TAG — by refs/tags/, never a name a branch could answer to", async () => {
  git(repo, "checkout", "-q", "main");
  const plan = await planListedRefCheckout(ctx, { name: "tags/release", type: "tag" });
  assert.ok(plan);
  assert.deepEqual(plan.args, ["checkout", "--detach", "refs/tags/release"]);
  assert.equal(plan.detaches, true);
  assert.equal((await run(plan.args)).code, 0);
  assert.equal(symbolicHead(), "", "detached — a tag is a fixed point");
  assert.equal(git(repo, "rev-parse", "HEAD"), tagTip, "at the tag, one commit past the branch");
  git(repo, "checkout", "-q", "main");
});

test("the remote door creates the local branch tracking it", async () => {
  git(repo, "checkout", "-q", "main");
  const plan = await planListedRefCheckout(ctx, { name: "origin/fix", type: "remote" });
  assert.ok(plan);
  assert.equal((await run(plan.args)).code, 0);
  assert.equal(symbolicHead(), "refs/heads/fix");
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "fix@{upstream}"), "origin/fix");
  git(repo, "checkout", "-q", "main");
});

test("a name the ref list does not have is refused — no full name is rebuilt from it", async () => {
  assert.equal(await planListedRefCheckout(ctx, { name: "heads/ghost", type: "head" }), undefined);
  // The right name under the wrong type is not a match either.
  assert.equal(await resolveListedRef(ctx, { name: "heads/release", type: "tag" }), undefined);
  // A listing that fails is not a list to guess against.
  const broken = { process: ctx.process, refs: { listRefs: async () => Promise.reject(new Error("fatal")) } };
  assert.equal(await planListedRefCheckout(broken, { name: "heads/release", type: "head" }), undefined);
});

test("every checkout door in the Branches view goes through the full-name planner", () => {
  // branchActions imports vscode and cannot run here; its doors are pinned at
  // source level, and what they call is exercised for real above.
  const src = readFileSync(fileURLToPath(new URL("../src/views/branchActions.ts", import.meta.url)), "utf8");
  for (const door of ["checkoutBranch", "checkoutRemoteBranch", "checkoutTag"]) {
    const body = src.slice(src.indexOf(`export async function ${door}(`));
    const end = body.indexOf("\nexport async function ", 10);
    const fn = end > 0 ? body.slice(0, end) : body;
    assert.match(fn, /await runRefCheckout\(a, ref, refresh\);/, `${door} checks out through runRefCheckout`);
  }
  assert.match(src, /const c = await listedRefCheckout\(a\.ctx, ref\);/, "runRefCheckout plans from the listed full name");
  assert.doesNotMatch(src, /branches\.checkout\(ref\.name/, "no door hands git the short name");
  assert.doesNotMatch(src, /planRemoteCheckout\(a\.ctx\.process, ref\.name\)/, "…not even the remote one");
});

test("a branch named like an option is refused for THAT reason — the ref is found, not 'missing'", async () => {
  // planListedRefCheckout answered undefined for it, and the Branches view
  // read undefined as "not in this repository any more — refresh and try
  // again". The branch is right there; refreshing changes nothing.
  git(repo, "checkout", "-q", "main");
  git(repo, "update-ref", "refs/heads/-f", "HEAD");
  try {
    const node = (await ctx.refs.listRefs()).find((r) => r.fullName === "refs/heads/-f")!;
    assert.ok(node, "git lists it");
    const c = await listedRefCheckout(ctx, node);
    assert.equal(c.kind, "optionLike");
    assert.equal(c.kind === "optionLike" && c.fullName, "refs/heads/-f");
    assert.equal(c.kind === "optionLike" && c.refusal.local, true, "a local branch — the rename is offered");
    // By name + type as the Changes view's menu sends it, too.
    const viaMenu = await listedRefCheckout(ctx, { name: node.name, type: "head" });
    assert.equal(viaMenu.kind, "optionLike");
    // Missing stays missing.
    assert.equal((await listedRefCheckout(ctx, { name: "ghost", type: "head" })).kind, "missing");
    // And an ordinary branch still plans.
    const ok = await listedRefCheckout(ctx, { name: "heads/release", type: "head" });
    assert.equal(ok.kind, "plan");
  } finally {
    git(repo, "update-ref", "-d", "refs/heads/-f");
  }
});

test("both extension checkout doors SAY why an option-like branch is refused, and offer the rename", () => {
  // Pinned at source level: both import vscode. What they call is exercised
  // above (listedRefCheckout) and in git-service (optionLikeCheckout,
  // renameArgs, run against real git).
  const branches = readFileSync(fileURLToPath(new URL("../src/views/branchActions.ts", import.meta.url)), "utf8");
  const run = branches.slice(branches.indexOf("async function runRefCheckout("), branches.indexOf("async function listedRef("));
  assert.match(run, /if \(c\.kind === "optionLike"\) \{[\s\S]*?await explainOptionLikeCheckout\(a\.ctx, c\.refusal, c\.fullName, refresh\);[\s\S]*?return;/,
    "the Branches view explains an option-like branch");
  assert.ok(run.indexOf('c.kind === "optionLike"') < run.indexOf("not in this repository any more"),
    "…before, and apart from, the 'refresh and try again' a MISSING ref gets");
  const graph = readFileSync(fileURLToPath(new URL("../src/graph/commitActions.ts", import.meta.url)), "utf8");
  const arm = graph.slice(graph.indexOf("async function checkoutRef("), graph.indexOf("async function checkout("));
  assert.match(arm, /const refusal = optionLikeCheckout\(fullName\);\s*if \(refusal\) \{\s*return explainOptionLikeCheckout\(ctx, refusal, fullName, /,
    "the graph's menus (row and chip) explain it too, instead of returning in silence");
  const glue = readFileSync(fileURLToPath(new URL("../src/views/optionLikeBranch.ts", import.meta.url)), "utf8");
  assert.match(glue, /const args = renameArgs\(fullName, neu\);/, "the rename goes by the FULL name");
});

test("every branch action hands git a name derived from the FULL name, never ref.name", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/views/branchActions.ts", import.meta.url)), "utf8");
  const body = (fn: string): string => {
    const at = src.indexOf(`export async function ${fn}(`);
    assert.ok(at >= 0, fn);
    const rest = src.slice(at);
    const end = rest.indexOf("\nexport async function ", 10);
    return end > 0 ? rest.slice(0, end) : rest;
  };
  assert.match(body("mergeBranchIntoCurrent"), /branches\.mergeArgs\(ref\.fullName\)[\s\S]*kind: "merge", target: ref\.fullName, args \}/);
  assert.match(body("rebaseCurrentOnto"), /kind: "rebase", onto: ref\.fullName, args: \["rebase", ref\.fullName\]/);
  assert.match(body("renameBranch"), /const old = ref && localName\(ref\);[\s\S]*branches\.rename\(old, neu\)/);
  assert.match(body("deleteBranch"), /const name = ref && localName\(ref\);[\s\S]*branches\.delete\(name\)[\s\S]*branches\.delete\(name, \{ force: true \}\)/);
  assert.match(body("pushBranch"), /branch: name,/);
  assert.match(body("setUpstream"), /branches\.setUpstream\(name, upstream\)/);
  assert.match(body("newBranchFrom"), /const startPoint = ref\?\.fullName;/);
  assert.match(body("deleteRemoteBranch"), /remoteBranchOf\(ref\.fullName\)/);
  assert.match(body("deleteTag"), /tags\.delete\(name\)/);
  assert.match(body("pushTag"), /tags\.push\(remote, name\)/);
  // …and none of them reaches git with the short name.
  for (const call of ["merge", "rebaseOnto", "rename", "delete", "setUpstream", "checkoutNew", "create"]) {
    assert.doesNotMatch(src, new RegExp(`branches\\.${call}\\(ref\\.name`), `branches.${call}(ref.name…)`);
  }
  assert.doesNotMatch(src, /tags\.(delete|push)\([^)]*ref\.name/);
  assert.doesNotMatch(src, /branch: ref\.name/);
});
