// repoContext (src/pr/repoContext.ts): which of a clone's remotes name a
// github.com repository, the context the PR commands act in, and — when there
// is none — the sentence the Pull Requests view says, for each reason.

import { entryFor, vscode } from "./prTestKit";
import { test } from "node:test";
import assert from "node:assert/strict";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports -- the stand-in's objects, loaded after it */
const { listGitHubRemotes, resolveGitHubContext, whyNoGitHub, LOOKING_FOR_A_REPOSITORY } = require("../src/pr/repoContext") as typeof import("../src/pr/repoContext");
/* eslint-enable @typescript-eslint/no-require-imports */

void vscode;
const remote = (name: string, url: string, pushUrl = url) => ({ name, fetchUrl: url, pushUrl });
const repos = (entry: any, discovering?: boolean): any => ({ getActive: () => entry, ...(discovering !== undefined ? { isDiscovering: () => discovering } : {}) });
const broken = (): any => ({ root: "/w", ctx: { root: "/w", remotes: { list: async () => Promise.reject(new Error("not a git repository")) } } });

test("GitHub remotes are listed origin first, by fetch URL or else push URL; others are left out", async () => {
  const entry = entryFor("/w", [
    remote("upstream", "https://github.com/acme/app.git"),
    remote("gitlab", "git@gitlab.com:me/app.git"),
    remote("origin", "git@github.com:me/app.git"),
    remote("mirror", "https://example.com/app.git", "https://github.com/me/mirror"),
  ]);
  assert.deepEqual(await listGitHubRemotes(entry as any), [
    { name: "origin", owner: "me", repo: "app" },
    { name: "upstream", owner: "acme", repo: "app" },
    { name: "mirror", owner: "me", repo: "mirror" },
  ]);
});

test("a clone whose remotes can't be read has no GitHub remotes, rather than failing", async () => {
  assert.deepEqual(await listGitHubRemotes(broken()), []);
});

test("the context is the first GitHub remote's repository; none without a repository or a GitHub remote", async () => {
  const entry = entryFor("/w", [remote("upstream", "https://github.com/acme/app.git"), remote("origin", "https://github.com/me/app.git")]);
  const ctx = await resolveGitHubContext(repos(entry));
  assert.deepEqual({ ...ctx, entry: undefined }, { owner: "me", repo: "app", remoteName: "origin", entry: undefined });
  assert.equal(ctx!.entry, entry);
  assert.equal(await resolveGitHubContext(repos(undefined)), null);
  assert.equal(await resolveGitHubContext(repos(entryFor("/w", [remote("origin", "https://gitlab.com/me/app.git")]))), null);
});

test("why there are no pull requests, in each case's own words", async () => {
  assert.equal(await whyNoGitHub(repos(undefined, true)), LOOKING_FOR_A_REPOSITORY);
  assert.equal(await whyNoGitHub(repos(undefined, false)), "Open a Git repository to see its pull requests.");
  assert.equal(await whyNoGitHub(repos(undefined)), "Open a Git repository to see its pull requests.");
  const none = "This repository has no remotes. Pull requests show here once a remote points at github.com.";
  assert.equal(await whyNoGitHub(repos(entryFor("/w", []))), none);
  assert.equal(await whyNoGitHub(repos(broken())), none, "unreadable remotes read as none");
  assert.equal(
    await whyNoGitHub(repos(entryFor("/w", [remote("origin", "git@gitlab.com:me/app.git"), remote("backup", "/srv/app.git"), remote("mirror", "", "https://bitbucket.org/me/app.git")]))),
    "None of this repository's remotes is on github.com: origin (gitlab.com), backup, mirror (bitbucket.org). Pull requests are available for github.com repositories.",
  );
});
