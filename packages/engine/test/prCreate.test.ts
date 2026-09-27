import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PR_CREATE_QUERY,
  canSetMetadata,
  commitList,
  createProblem,
  defaultTemplate,
  fetchCreateData,
  headForGitHub,
  proposedBody,
  proposedTitle,
  pushWords,
  statusOfLetter,
} from "../src/forge/prCreate";
import { PrListError } from "../src/forge/prList";

// A new pull request's rules, as a table: what is proposed from the commits
// and the templates, what GitHub is sent as the head, who may set reviewers
// and labels, and every reason Create can't run — each cell one call. The
// wizard this replaces proposed the NEWEST commit's subject for a branch of
// several, never read the repository's template, and offered no reason at all.

test("title: the only commit's subject, else the branch in words — never the newest of several", () => {
  assert.equal(proposedTitle([{ subject: "Add b" }], "feature"), "Add b");
  assert.equal(proposedTitle([{ subject: "Fix a typo" }, { subject: "Add b" }], "fix-login_page"), "Fix login page");
  assert.equal(proposedTitle([{ subject: "x" }, { subject: "y" }], "feature/sso-login"), "Sso login", "the folder is dropped");
  assert.equal(proposedTitle([], "main"), "Main");
});

test("description: the template, else the only commit's body, else the commits oldest first, else nothing", () => {
  const templates = [
    { filename: "pull_request_template.md", body: "## What\r\n\r\n## Why\r\n" },
    { filename: "PULL_REQUEST_TEMPLATE/bug.md", body: "Bug:" },
  ];
  assert.deepEqual(proposedBody([{ subject: "a" }], templates, "pull_request_template.md"), { body: "## What\n\n## Why\n", from: "template" });
  assert.deepEqual(proposedBody([{ subject: "a" }], templates, "PULL_REQUEST_TEMPLATE/bug.md"), { body: "Bug:", from: "template" });
  assert.deepEqual(proposedBody([{ subject: "Add b", body: "Because.\n" }], [], undefined), { body: "Because.", from: "commit" });
  assert.deepEqual(proposedBody([{ subject: "Add b" }], [], undefined), { body: "", from: "empty" });
  assert.deepEqual(proposedBody([{ subject: "second" }, { subject: "first" }], [], undefined), { body: "- first\n- second", from: "commits" });
  assert.deepEqual(proposedBody([], [], undefined), { body: "", from: "empty" });
  assert.equal(commitList([{ subject: "c" }, { subject: "b" }, { subject: "a" }]), "- a\n- b\n- c");
});

test("template: the only one, or pull_request_template.md among several, else none", () => {
  assert.equal(defaultTemplate([{ filename: "docs/pull_request_template.md" }]), "docs/pull_request_template.md");
  assert.equal(defaultTemplate([{ filename: "PULL_REQUEST_TEMPLATE/a.md" }, { filename: "PULL_REQUEST_TEMPLATE/b.md" }]), undefined);
  assert.equal(defaultTemplate([{ filename: "PULL_REQUEST_TEMPLATE/a.md" }, { filename: ".github/PULL_REQUEST_TEMPLATE.md" }]), ".github/PULL_REQUEST_TEMPLATE.md");
  assert.equal(defaultTemplate([]), undefined);
});

test("head: owner:branch from a fork (GitHub reads a bare name as the target's branch)", () => {
  assert.equal(headForGitHub("feature", "me", "acme"), "me:feature");
  assert.equal(headForGitHub("feature", "ACME", "acme"), "feature");
  assert.equal(headForGitHub("feature", undefined, "acme"), "feature");
});

test("who may set reviewers, labels and assignees: triage and up", () => {
  assert.equal(canSetMetadata("READ"), false);
  for (const p of ["TRIAGE", "WRITE", "MAINTAIN", "ADMIN"] as const) assert.equal(canSetMetadata(p), true, p);
});

test("why Create can't run — every cell, and nothing when it can", () => {
  const ok = { branch: "feature", base: "main", sameRepository: true, compareReady: true, commits: 2, push: "pushed" as const, remote: "origin" };
  assert.equal(createProblem(ok), undefined);
  assert.equal(createProblem({ ...ok, push: "new" }), undefined, "a branch not pushed yet is pushed first");
  assert.equal(createProblem({ ...ok, push: "ahead" }), undefined);
  assert.match(createProblem({ ...ok, branch: undefined }) ?? "", /Pick the branch to open it from/);
  assert.match(createProblem({ ...ok, base: undefined }) ?? "", /Pick the branch it goes into/);
  assert.match(createProblem({ ...ok, base: "feature" }) ?? "", /can't go into itself/);
  assert.equal(createProblem({ ...ok, base: "feature", sameRepository: false }), undefined, "a fork's main may go into the parent's main");
  assert.match(createProblem({ ...ok, existing: { number: 44 } }) ?? "", /already has an open pull request, #44/);
  assert.match(createProblem({ ...ok, push: "diverged" }) ?? "", /have both moved on: pull, then create it/);
  assert.match(createProblem({ ...ok, push: "unknown" }) ?? "", /no GitHub remote/);
  assert.match(createProblem({ ...ok, commits: 0 }) ?? "", /Nothing to compare: feature has no commits that main doesn't/);
  assert.equal(createProblem({ ...ok, commits: 0, compareReady: false }), undefined, "not known yet is no reason");
});

test("the push, in words", () => {
  assert.equal(pushWords({ branch: "feature", remote: "mine", push: "new", ahead: 2 }), "feature isn't on mine yet: it is pushed there first.");
  assert.equal(pushWords({ branch: "feature", remote: "mine", push: "ahead", ahead: 1 }), "1 commit isn't on mine/feature yet: it is pushed first.");
  assert.equal(pushWords({ branch: "feature", remote: "mine", push: "ahead", ahead: 3 }), "3 commits aren't on mine/feature yet: they are pushed first.");
  assert.equal(pushWords({ branch: "feature", remote: "mine", push: "pushed", ahead: 0 }), undefined);
  assert.equal(statusOfLetter("R100"), "renamed");
  assert.equal(statusOfLetter("D"), "removed");
});

test("the question: GitHub's answer mapped; a repository it doesn't know, and its rate limit, in the list's terms", async () => {
  let asked: { query: string; variables: Record<string, unknown> } | undefined;
  const answer = {
    data: {
      viewer: { login: "me", avatarUrl: "https://avatars.githubusercontent.com/u/1" },
      repository: {
        nameWithOwner: "acme/app",
        viewerPermission: "WRITE",
        defaultBranchRef: { name: "main" },
        pullRequestTemplates: [{ filename: "pull_request_template.md", body: "## What" }],
        refs: { totalCount: 150, nodes: [{ name: "develop" }, { name: "main" }] },
        labels: { totalCount: 2, nodes: [{ name: "bug", color: "d73a4a", description: "Broken" }, { name: "odd", color: "nope" }] },
        assignableUsers: { totalCount: 1, nodes: [{ login: "alice", avatarUrl: null }] },
      },
    },
  };
  const d = await fetchCreateData(async (query, variables) => {
    asked = { query, variables };
    return answer;
  }, "acme", "app");
  assert.equal(asked?.query, PR_CREATE_QUERY);
  assert.deepEqual(asked?.variables, { owner: "acme", name: "app" });
  assert.equal(d.permission, "WRITE");
  assert.equal(d.defaultBranch, "main");
  assert.deepEqual(d.branches, ["develop", "main"]);
  assert.equal(d.branchesTotal, 150);
  assert.deepEqual(d.labels, [{ name: "bug", color: "d73a4a", description: "Broken" }, { name: "odd", color: "888888" }]);
  assert.deepEqual(d.people, [{ login: "alice", avatarUrl: null }]);
  assert.equal(d.truncated, false);
  assert.equal(d.viewer?.login, "me");

  await assert.rejects(fetchCreateData(async () => ({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] }), "acme", "gone"), (e: unknown) => e instanceof PrListError && e.kind === "not-found");
  await assert.rejects(fetchCreateData(async () => ({ errors: [{ type: "RATE_LIMITED", message: "slow down" }] }), "acme", "app"), (e: unknown) => e instanceof PrListError && e.kind === "rate-limit");
  await assert.rejects(fetchCreateData(async () => answer, "acme", "app/../x"), (e: unknown) => e instanceof PrListError && e.kind === "query");
});
