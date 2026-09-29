// The pull request commands (src/pr/prFeature.ts) run from the palette —
// with no row to act on — through the REAL feature (prTestKit): what each
// says when there is nothing to act on, and how it asks which pull request
// when there is. prFeature.test.ts and prListView.test.ts cover the commands
// run from a row or a page.

import { acmeRoutes, dialogs, fakeRepos, github, mount, onTeardown, ORIGIN, pagePanel, pr, PULLS, rowArg, settled, until, vscode } from "./prTestKit";
import { test } from "node:test";
import assert from "node:assert/strict";

/* eslint-disable @typescript-eslint/no-explicit-any -- the stand-in's objects */

const settledNow = (m: any) => {
  const s = m.view.state();
  return !!s && (s.status === "message" || (s.status === "list" && !s.refreshing));
};
const said = (kind: string): string[] => pr.said.filter((s: any) => s.kind === kind).map((s: any) => s.message);
const pullsAsked = (gh: any) => gh.requests.filter((r: any) => /^\/repos\/acme\/app\/pulls\?state=open/.test(r.path)).length;

test("from the palette in a repository with no GitHub remote: each command says so, and GitHub is asked nothing about it", async () => {
  const gh = github(acmeRoutes());
  mount(fakeRepos([{ name: "origin", fetchUrl: "git@gitlab.com:acme/app.git", pushUrl: "git@gitlab.com:acme/app.git" }]));
  for (const id of ["gitstudio.pr.openDescription", "gitstudio.pr.checkout", "gitstudio.pr.startReview", "gitstudio.pr.merge", "gitstudio.pr.copyUrl", "gitstudio.pr.openOnGitHub"]) {
    await vscode.commands.executeCommand(id);
  }
  assert.deepEqual(said("info"), Array(6).fill("This repository isn't connected to GitHub."));
  assert.equal(pullsAsked(gh), 0);
  assert.equal(pr.opened.length, 0);
});

test("New pull request with no repository open says to open one — and opens no form", async () => {
  github(acmeRoutes());
  const repos = fakeRepos(ORIGIN);
  mount(repos);
  repos.switchTo(undefined);
  await vscode.commands.executeCommand("gitstudio.pr.create");
  assert.deepEqual(said("info"), ["Open a Git repository to open a pull request from it."]);
  assert.equal(pr.panels.filter((p: any) => p.viewType === "gitstudio.newPullRequest").length, 0);
});

test("signed out, and the sign-in declined: a palette command does nothing, and asks GitHub nothing", async () => {
  const gh = github(acmeRoutes());
  const original = vscode.authentication.getSession;
  const asked: any[] = [];
  vscode.authentication.getSession = async (_id: string, _s: string[], opts: any) => (asked.push(opts), undefined);
  onTeardown(() => (vscode.authentication.getSession = original));
  mount(fakeRepos(ORIGIN));
  await vscode.commands.executeCommand("gitstudio.pr.openDescription");
  assert.ok(asked.some((o) => o?.createIfNone === true), "it asked to sign in");
  assert.equal(pullsAsked(gh), 0);
  assert.deepEqual([...said("info"), ...said("warning"), ...said("error")], []);
  assert.equal(pr.panels.length, 0);
});

test("from the palette, with no open pull request: says so", async () => {
  github([["GET", /^\/repos\/acme\/app\/pulls\?state=open/, () => ({ body: [] })], ...acmeRoutes()]);
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  await vscode.commands.executeCommand("gitstudio.pr.checkout");
  assert.deepEqual(said("info"), ["No open pull requests."]);
  assert.equal(dialogs.asked.length, 0, "nothing to pick from");
});

test("from the palette: a pick of the open pull requests — drafts marked — and the one picked opens", async () => {
  const gh = github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  dialogs.answer = (spec) => (spec.kind === "pick" ? "36" : undefined);
  await vscode.commands.executeCommand("gitstudio.pr.openDescription");
  const q = dialogs.asked.find((a) => a.title === "Open pull requests");
  assert.deepEqual(
    q.choices.map((c: any) => [c.id, c.icon, c.detail, c.description]),
    PULLS().map((p: any) => [String(p.number), p.draft ? "git-pull-request-draft" : "git-pull-request", `#${p.number}`, p.user.login]),
  );
  assert.ok(pagePanel(36), "#36's page");
  assert.equal(pullsAsked(gh), 1);
});

test("from the palette, when GitHub won't list the open pull requests: its reason, as a warning", async () => {
  github([["GET", /^\/repos\/acme\/app\/pulls\?state=open/, () => ({ status: 403, body: { message: "Resource not accessible by integration" } })], ...acmeRoutes()]);
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  await vscode.commands.executeCommand("gitstudio.pr.copyUrl");
  assert.deepEqual(said("warning"), ["Resource not accessible by integration"]);
  assert.equal(pr.clipboard === "https://github.com/acme/app/pull/37", false);
});

test("Open on GitHub from a row opens that pull request's page on github.com", async () => {
  github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  await vscode.commands.executeCommand("gitstudio.pr.openOnGitHub", await rowArg(m, 3));
  await until(() => pr.opened.length === 1, "GitHub's page");
  assert.deepEqual(pr.opened, ["https://github.com/acme/app/pull/3"]);
});

test("Submit Review and Discard Review with no review under way say how to start one", async () => {
  github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  await vscode.commands.executeCommand("gitstudio.pr.submitReview");
  await vscode.commands.executeCommand("gitstudio.pr.cancelReview");
  assert.deepEqual(said("info"), Array(2).fill("No review is under way. Start one from a pull request's page."));
});

test("Start Review from a row, signed out and the sign-in declined: no page opens", async () => {
  github(acmeRoutes());
  const m = mount(fakeRepos(ORIGIN));
  const row = await rowArg(m, 37);
  const original = vscode.authentication.getSession;
  vscode.authentication.getSession = async () => undefined;
  onTeardown(() => (vscode.authentication.getSession = original));
  await vscode.commands.executeCommand("gitstudio.pr.startReview", row);
  assert.equal(pagePanel(37), undefined);
  // Signed out now: the list says so (and asks GitHub nothing more).
  await until(() => settledNow(m) && m.view.state().status === "message", "the list to say it is signed out");
  assert.equal(m.view.state().message.title, "Sign in to GitHub to see pull requests");
});
