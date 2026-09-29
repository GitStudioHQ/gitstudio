// Proposing a pull request (src/forge/prCreate.ts) — the corners
// test/prCreate.test.ts leaves: a sparse answer from GitHub, names that
// aren't a repository, every status letter, and the words for a note or a
// push that needs none.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commitList,
  createProblem,
  fetchCreateData,
  metadataNote,
  proposedBody,
  proposedTitle,
  pushWords,
  statusOfLetter,
} from "../src/forge/prCreate";
import { PrListError } from "../src/forge/prList";

/* eslint-disable @typescript-eslint/no-explicit-any -- GitHub's JSON */

test("the form's question is never asked for a name that isn't a repository", async () => {
  let asked = 0;
  const gql = async () => {
    asked++;
    return {};
  };
  await assert.rejects(fetchCreateData(gql, "acme", "app;rm"), (e: any) => e instanceof PrListError && e.kind === "query" && /isn't a GitHub repository name/.test(e.message));
  await assert.rejects(fetchCreateData(gql, "", "app"), (e: any) => e.kind === "query");
  assert.equal(asked, 0);
});

test("a sparse answer: the repository named as asked, no viewer, reader's permission, and nothing to pick", async () => {
  const d = await fetchCreateData(async () => ({ data: { repository: {} } }), "acme", "app");
  assert.deepEqual(d, { repo: "acme/app", permission: "READ", templates: [], branches: [], branchesTotal: 0, labels: [], people: [], truncated: false });
});

test("GitHub's answer, field by field: what isn't a name is dropped, a template without a name is GitHub's default", async () => {
  const d = await fetchCreateData(
    async () => ({
      data: {
        viewer: { login: "sam", avatarUrl: 3 },
        repository: {
          nameWithOwner: "Acme/App",
          viewerPermission: "MAINTAIN",
          defaultBranchRef: { name: "trunk" },
          pullRequestTemplates: [null, { filename: "", body: "## Why" }, { filename: "docs/t.md", body: 5 }, { body: "x" }],
          refs: { totalCount: 250, nodes: [{ name: "main" }, null, { name: 3 }, { name: "dev" }] },
          labels: { totalCount: 2, nodes: [null, { name: "bug", color: "D73A4A", description: "" }, { name: "ui", color: "nope", description: "Looks" }] },
          assignableUsers: { totalCount: 1, nodes: [{ login: "bob" }, { name: "no login" }] },
        },
      },
    }),
    "acme",
    "app",
  );
  assert.deepEqual(d.viewer, { login: "sam", avatarUrl: null });
  assert.equal(d.repo, "Acme/App");
  assert.equal(d.permission, "MAINTAIN");
  assert.equal(d.defaultBranch, "trunk");
  assert.deepEqual(d.templates, [
    { filename: "pull_request_template.md", body: "## Why" },
    { filename: "pull_request_template.md", body: "x" },
  ]);
  assert.deepEqual(d.branches, ["main", "dev"]);
  assert.equal(d.branchesTotal, 250);
  assert.deepEqual(d.labels, [{ name: "bug", color: "D73A4A" }, { name: "ui", color: "888888", description: "Looks" }]);
  assert.deepEqual(d.people, [{ login: "bob", avatarUrl: null }]);
  assert.equal(d.truncated, false);
});

test("more labels or people than were read is said", async () => {
  const labels = await fetchCreateData(async () => ({ data: { repository: { labels: { totalCount: 3, nodes: [] } } } }), "acme", "app");
  assert.equal(labels.truncated, true);
  const people = await fetchCreateData(async () => ({ data: { repository: { assignableUsers: { totalCount: 101, nodes: [{ login: "a" }] } } } }), "acme", "app");
  assert.equal(people.truncated, true);
});

test("GitHub's refusal without a message: the rate limit and the missing repository in the form's words", async () => {
  await assert.rejects(fetchCreateData(async () => ({ errors: [{ type: "RATE_LIMITED" }] }), "acme", "app"), (e: any) => e.kind === "rate-limit" && e.message === "GitHub's rate limit was reached.");
  await assert.rejects(fetchCreateData(async () => ({ errors: [{ type: "RATE_LIMITED", message: "Wait" }] }), "acme", "app"), (e: any) => e.kind === "rate-limit" && e.message === "Wait");
  await assert.rejects(fetchCreateData(async () => ({ data: null }), "acme", "app"), (e: any) => e.kind === "not-found" && e.message === "GitHub has no repository acme/app.");
});

test("title: a blank only-commit subject falls back to the branch; a branch that is only a folder stays as it is", () => {
  assert.equal(proposedTitle([{ subject: "   " }], "feature/add-login"), "Add login");
  assert.equal(proposedTitle([], "feature/"), "Feature/", "an empty leaf reads the whole name");
  assert.equal(proposedTitle([], "---"), "---", "nothing but separators stays the branch");
  assert.equal(proposedTitle([{ subject: "a" }, { subject: "b" }], "plain_name"), "Plain name");
});

test("description: a template asked for by name that isn't there falls back; a template's CRLF is LF", () => {
  const templates = [{ filename: "t.md", body: "a\r\nb" }];
  assert.deepEqual(proposedBody([{ subject: "s", body: "  body  " }], templates, "missing.md"), { body: "body", from: "commit" });
  assert.deepEqual(proposedBody([{ subject: "s" }], templates, "t.md"), { body: "a\nb", from: "template" });
  assert.deepEqual(proposedBody([{ subject: "s" }], templates, undefined), { body: "", from: "empty" });
  assert.deepEqual(proposedBody([], [], undefined), { body: "", from: "empty" });
  assert.equal(commitList([{ subject: " newest " }, { subject: "oldest" }]), "- oldest\n- newest");
  assert.equal(commitList([]), "");
});

test("why Create can't run: a diverged branch with no remote named, and a fork's same-named base is fine", () => {
  assert.equal(createProblem({ branch: "f", base: "main", sameRepository: true, compareReady: true, commits: 1, push: "diverged" }), "f and its remote/f have both moved on: pull, then create it.");
  assert.equal(createProblem({ branch: "main", base: "main", sameRepository: false, compareReady: true, commits: 2 }), undefined);
  assert.equal(createProblem({ branch: "f", base: "main", sameRepository: true, compareReady: false, commits: 0 }), undefined, "no answer yet on what differs is no problem yet");
});

test("the push, in words: nothing to say when it is pushed, or on no remote", () => {
  assert.equal(pushWords({ branch: "f", push: "new", ahead: 0 }), undefined);
  assert.equal(pushWords({ branch: "f", remote: "origin", push: "pushed", ahead: 0 }), undefined);
  assert.equal(pushWords({ branch: "f", remote: "origin", push: "ahead", ahead: 1 }), "1 commit isn't on origin/f yet: it is pushed first.");
  assert.equal(pushWords({ branch: "f", remote: "origin", push: "ahead", ahead: 4 }), "4 commits aren't on origin/f yet: they are pushed first.");
});

test("metadata note names the repository, and every name-status letter has a word", () => {
  assert.equal(metadataNote("acme/app"), "Reviewers, labels and assignees take triage access to acme/app. Its maintainers can add them.");
  assert.deepEqual(
    ["A", "D", "M", "R100", "C75", "T", "U", ""].map(statusOfLetter),
    ["added", "removed", "modified", "renamed", "copied", "changed", "changed", "changed"],
  );
});
