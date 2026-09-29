import { test } from "node:test";
import assert from "node:assert/strict";
import { headBranchName } from "../src/RefProvider";
import { makeRepo, type Repo } from "./opRepo";

// A branch and a tag with the same name (issue #30's follow-up): git's
// %(refname:short) disambiguates them to "heads/release" and "tags/release",
// and the bare word "release" resolves to the TAG. RefProvider must still hand
// out each ref as what it is — typed by its full name, on its own commit — and
// the plain branch name must be derivable exactly (never by guessing at the
// "heads/" prefix). The two refs point at DIFFERENT commits, so a mix-up shows
// as a wrong sha rather than passing by coincidence.

function collidingRepo(): { r: Repo; tagged: string; branchTip: string } {
  const r = makeRepo("refs-ambiguous");
  r.write("base.txt", "base\n");
  const tagged = r.commitAll("base");
  r.git("tag", "-a", "release", "-m", "the release tag");
  r.git("checkout", "-q", "-b", "release");
  r.write("r.txt", "release work\n");
  const branchTip = r.commitAll("release work");
  return { r, tagged, branchTip };
}

test("the fixture really is ambiguous: the bare name resolves to the tag", () => {
  const { r, tagged } = collidingRepo();
  try {
    assert.equal(r.sha("release"), tagged);
  } finally {
    r.cleanup();
  }
});

test("listRefs lists BOTH refs, each typed and placed by its full name", async () => {
  const { r, tagged, branchTip } = collidingRepo();
  try {
    const refs = await r.ctx().refs.listRefs();
    const named = refs.filter((x) => x.fullName.endsWith("/release"));
    assert.deepEqual(
      named.map((x) => [x.type, x.fullName, x.sha, x.isCurrent]).sort(),
      [
        ["head", "refs/heads/release", branchTip, true],
        ["tag", "refs/tags/release", tagged, false],
      ],
    );
    // `name` is git's disambiguated short form — the protocol documents that
    // consumers take the plain name from fullName. Pin that the short forms
    // are the unambiguous ones, never the bare word that means the tag.
    const branch = named.find((x) => x.type === "head")!;
    const tag = named.find((x) => x.type === "tag")!;
    assert.equal(branch.name, "heads/release");
    assert.equal(tag.name, "tags/release");
    assert.equal(r.sha(branch.name), branchTip, "handed back to git, the branch's short name names the branch");
    assert.equal(r.sha(tag.name), tagged);
    assert.equal(tag.objectType, "tag");
    assert.equal(branch.objectType, "commit");
  } finally {
    r.cleanup();
  }
});

test("getHead on the colliding branch gives the full name, and headBranchName the plain one", async () => {
  const { r, branchTip } = collidingRepo();
  try {
    const head = await r.ctx().refs.getHead();
    assert.equal(head.detached, false);
    assert.equal(head.sha, branchTip, "HEAD's commit, not the tag's");
    assert.equal(head.fullName, "refs/heads/release");
    assert.equal(head.branch, "heads/release", "git's short form, still a valid revision");
    assert.equal(headBranchName(head), "release", "what a person reads and a refs/heads/ refspec takes");
  } finally {
    r.cleanup();
  }
});

test("containingBranches names the colliding branch plainly and never lists the tag", async () => {
  const { r, tagged } = collidingRepo();
  try {
    const got = await r.ctx().refs.containingBranches(tagged);
    assert.deepEqual(got.branches, ["master", "release"]);
    assert.deepEqual(got.refs, ["refs/heads/master", "refs/heads/release"]);
  } finally {
    r.cleanup();
  }
});
