// A GitHub sign-in without read:org, end to end (#82): the extension asks VS
// Code's GitHub account for `repo` alone, and GitHub refused every question
// that named a requested team — so for such a token the Pull Requests view
// never listed anything, and told the user to edit a token at
// github.com/settings/tokens that VS Code's sign-in doesn't use. Here the
// fake api.github.com refuses a team's fields as GitHub does for the token's
// scopes (fakeGitHub.ts's `scopes`), and the REAL list, page and sign-in
// (prTestKit.ts) are driven through it.

import { acmeRoutes, fakeRepos, gql, github, LIST_QUERY, mount, numbers, openPage, ORIGIN, pr, settled, state, until, vscode, world } from "./prTestKit";
import { test } from "node:test";
import assert from "node:assert/strict";
import { graphqlWorld, type FakeRequest } from "./fakeGitHub";

/* eslint-disable @typescript-eslint/no-explicit-any -- the stand-in's objects */
const { pageFailure } = require("../src/pr/prPage") as typeof import("../src/pr/prPage"); // eslint-disable-line @typescript-eslint/no-require-imports

const askedTeamNames = (r: FakeRequest) => /\.\.\. on Team \{/.test(String((r.body as any)?.query ?? ""));
const isPageQuery = (r: FakeRequest) => r.path === "/graphql" && /pullRequest\(number: \$n\)/.test(String((r.body as any)?.query ?? ""));
/** acme/app, with the team `core` asked to review #3. */
const repos = () => world({ "acme/app": { ...world()["acme/app"], teams: { 3: ["core"] } } });

test("a sign-in without read:org lists the pull requests — refused once, asked again without team names — and the page says a team was asked", async () => {
  const gh = github(acmeRoutes([["POST", /^\/graphql$/, graphqlWorld(repos(), { scopes: ["repo"] })]], repos()));
  const m = mount(fakeRepos(ORIGIN));
  const s = await settled(m);
  assert.equal(s.status, "list", `the list loads (said: ${JSON.stringify(s.message)})`);
  assert.deepEqual(numbers(m), [37, 36, 3]);
  const asked = gql(gh, LIST_QUERY);
  assert.equal(asked.length, 2, "refused once, then answered");
  assert.deepEqual(asked.map(askedTeamNames), [true, false]);

  // Remembered for the sign-in: a refresh asks once, without names.
  await vscode.commands.executeCommand("gitstudio.pr.refresh");
  await until(() => gql(gh, LIST_QUERY).length === 3, "the refresh");
  assert.equal(askedTeamNames(gql(gh, LIST_QUERY)[2]), false);

  // The page: one question, without names; the team is a row that says so.
  const page = await openPage(m, 3);
  const pageAsked = gh.requests.filter(isPageQuery);
  assert.equal(pageAsked.length, 1);
  assert.equal(askedTeamNames(pageAsked[0]), false);
  const reviewers = page.state().pr.reviewers;
  assert.deepEqual(reviewers.at(-1), { unnamedTeams: 1, requested: true }, `reviewers: ${JSON.stringify(reviewers)}`);
  assert.ok(reviewers.some((r: any) => r.login === "me" && r.requested), "the people asked are still named");

  // Another sign-in may have been granted more: it is asked with names again.
  pr.sessionsChanged.fire({ provider: { id: "github" } });
  await until(() => gql(gh, LIST_QUERY).some((r, i) => i >= 3 && askedTeamNames(r)), "a new sign-in's first question, with names");
});

test("a sign-in with read:org is asked for team names, once, and the page names the team", async () => {
  const gh = github(acmeRoutes([["POST", /^\/graphql$/, graphqlWorld(repos(), { scopes: ["repo", "read:org"] })]], repos()));
  const m = mount(fakeRepos(ORIGIN));
  await settled(m);
  assert.deepEqual(numbers(m), [37, 36, 3]);
  assert.deepEqual(gql(gh, LIST_QUERY).map(askedTeamNames), [true]);
  const page = await openPage(m, 3);
  assert.deepEqual(gh.requests.filter(isPageQuery).map(askedTeamNames), [true]);
  assert.deepEqual(page.state().pr.reviewers[0], { team: "core", requested: true });
});

test("a scope refusal that asking without team names can't help: why, without GitHub's 'modify your token' — and the way out is a report, GitHub, or Retry", async () => {
  const answer = graphqlWorld(world());
  const refused = {
    body: {
      errors: [
        {
          type: "INSUFFICIENT_SCOPES",
          locations: [{ line: 1, column: 1 }],
          message:
            "Your token has not been granted the required scopes to execute this query. The 'title' field requires one of the following scopes: ['read:project'], but your token has only been granted the: ['repo'] scopes. Please modify your token's scopes at: https://github.com/settings/tokens.",
        },
      ],
    },
  };
  let refuse = true;
  const gh = github([["POST", /^\/graphql$/, (req) => (refuse && /list: /.test((req.body as any).query) ? refused : answer(req))]]);
  const m = mount(fakeRepos(ORIGIN));
  const s = await settled(m);
  assert.equal(s.status, "message");
  assert.equal(s.message.title, "GitHub wants a permission this sign-in doesn't have");
  assert.equal(
    s.message.detail,
    "GitHub won't answer without the read:project permission, which GitStudio doesn't ask VS Code's GitHub sign-in for, so signing in again won't help. This is GitStudio's to fix: please report it.",
  );
  assert.ok(!JSON.stringify(s.message).includes("settings/tokens"), "no token of the user's to edit");
  assert.deepEqual(
    s.message.buttons.map((b: any) => [b.label, b.action.kind]),
    [
      ["Report the problem", "openUrl"],
      ["Open on GitHub", "openUrl"],
      ["Retry", "retry"],
    ],
  );
  assert.match(s.message.buttons[0].action.url, /^https:\/\/github\.com\/GitStudioHQ\/gitstudio\/issues\/new\?title=GitHub%20asks%20for%20read%3Aproject%20/);
  assert.equal(s.message.buttons[1].action.url, "https://github.com/acme/app/pulls");
  assert.equal(gql(gh, LIST_QUERY).length, 1, "a project's scope isn't the team fields': not asked again");
  refuse = false;
  m.view.receive({ type: "action", action: { kind: "retry" } });
  await until(() => numbers(m).length === 3, "Retry, once GitHub answers");
  assert.equal(state(m).status, "list");
});

test("the page says a scope refusal the same way, with its own pull request on GitHub", () => {
  const m = pageFailure({ message: "GitHub won't answer without the read:org permission, which this sign-in wasn't given.", kind: "scope", scopes: ["read:org"] }, "acme/app", 3);
  assert.equal(m.title, "GitHub wants a permission this sign-in doesn't have");
  assert.match(m.detail ?? "", /^GitHub won't answer without the read:org permission, which GitStudio doesn't ask VS Code's GitHub sign-in for/);
  assert.deepEqual(
    m.buttons.map((b: any) => b.action.url ?? b.action.kind),
    ["https://github.com/GitStudioHQ/gitstudio/issues/new?title=GitHub%20asks%20for%20read%3Aorg%20the%20VS%20Code%20sign-in%20doesn't%20have", "https://github.com/acme/app/pull/3", "retry"],
  );
  const unnamed = pageFailure({ message: "", kind: "scope" }, "acme/app", 3);
  assert.match(unnamed.detail ?? "", /^GitHub won't answer without a permission GitStudio doesn't ask/);
});
