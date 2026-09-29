// The Issues section's GitHub calls (main/github/issues.ts) over a fake
// api.github.com: the request each one sends, what the detail page is built
// from (comments, timeline events, which reactions are yours), and the
// mutation contract — never throw, say what went wrong, and mark the failures
// that are the user's state rather than our defect as `expected`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeGitHub, page, reply } from "./ghFakeApi";
import {
  commentIssue,
  createIssue,
  createLabel,
  deleteIssueComment,
  deleteLabel,
  editIssue,
  editIssueComment,
  getIssueDetail,
  listIssues,
  listLabels,
  milestones,
  reactTo,
  searchIssues,
  setIssueAssignees,
  setIssueLabels,
  setIssueLocked,
  setIssueState,
  setMilestone,
  updateLabel,
} from "../src/main/github/issues";
import { issueSearchPath } from "../src/main/github/searchQuery";

const R = "/repos/o/r";

const rawIssue = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `Issue ${n}`,
  body: "body",
  state: "open",
  html_url: `https://github.com/o/r/issues/${n}`,
  user: { login: "bob", avatar_url: "https://a/bob" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  comments: 0,
  assignees: [{ login: "ann" }, { login: "cat" }],
  ...extra,
});

// ── Reads ──

test("listIssues asks for the state newest-updated first and leaves out pull requests", async (t) => {
  const gh = fakeGitHub(t, {
    [`GET ${R}/issues?state=all&sort=updated&direction=desc&per_page=100`]: () =>
      page([rawIssue(1), rawIssue(2, { pull_request: {} }), rawIssue(3, { milestone: { number: 4, title: "v1" } })]),
  });
  const list = await listIssues(gh.client, "o", "r", "all");
  assert.deepEqual(list.map((i) => i.number), [1, 3]);
  assert.deepEqual(list[1].milestone, { number: 4, title: "v1" });
});

test("listIssues defaults to open issues and throws a failed read at the caller", async (t) => {
  const gh = fakeGitHub(t, {
    [`GET ${R}/issues?state=open&sort=updated&direction=desc&per_page=100`]: () => reply(500, { message: "down" }),
  });
  await assert.rejects(listIssues(gh.client, "o", "r"), /down/);
});

test("searchIssues sends the repo-scoped query and returns issues only, with GitHub's totals", async (t) => {
  const path = issueSearchPath("o/r", "crash author:@me", { state: "closed" });
  const gh = fakeGitHub(t, {
    [`GET ${path}`]: {
      total_count: 42,
      incomplete_results: true,
      items: [rawIssue(5), rawIssue(6, { pull_request: {} })],
    },
  });
  const r = await searchIssues(gh.client, "o", "r", { query: "crash author:@me", state: "closed" });
  assert.deepEqual(gh.unmatched, []);
  assert.match(decodeURIComponent(gh.calls[0].path), /repo:o\/r/);
  assert.deepEqual(r.items.map((i) => i.number), [5]);
  assert.equal(r.totalCount, 42);
  assert.equal(r.incomplete, true);
});

test("searchIssues with an empty answer is an empty, complete result", async (t) => {
  const path = issueSearchPath("o/r", "nothing", {});
  const gh = fakeGitHub(t, { [`GET ${path}`]: {} });
  assert.deepEqual(await searchIssues(gh.client, "o", "r", { query: "nothing" }), {
    items: [],
    totalCount: 0,
    incomplete: false,
  });
});

/** The routes for issue 9's detail page. */
function detailRoutes(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [`GET ${R}/issues/9`]: rawIssue(9, { reactions: { total_count: 2, "+1": 1, heart: 1 } }),
    [`GET ${R}/issues/9/comments?per_page=100`]: () =>
      page([
        { id: 101, user: { login: "ann" }, body: "first", created_at: "2026-01-03T00:00:00Z", reactions: { total_count: 1, rocket: 1 } },
        { id: 102, user: null, body: null, created_at: "2026-01-04T00:00:00Z" },
      ]),
    [`GET ${R}/issues/9/timeline?per_page=100`]: () =>
      page([
        { event: "commented", created_at: "2026-01-03T00:00:00Z" },
        { event: "labeled", created_at: "2026-01-02T00:00:00Z", actor: { login: "ann" }, label: { name: "bug", color: "ff0000" } },
        { event: "unlabeled", created_at: "2026-01-02T00:00:01Z", actor: null, label: { name: "old" } },
        { event: "assigned", created_at: "2026-01-02T00:00:02Z", actor: { login: "ann" }, assignee: { login: "cat" } },
        { event: "unassigned", created_at: "2026-01-02T00:00:03Z", actor: { login: "ann" }, assignee: null },
        { event: "renamed", created_at: "2026-01-02T00:00:04Z", actor: { login: "bob" }, rename: { from: "Old", to: "New" } },
        { event: "milestoned", created_at: "2026-01-02T00:00:05Z", milestone: { title: "v2" } },
        { event: "closed", created_at: "2026-01-05T00:00:00Z", actor: { login: "bob" }, state_reason: "not_planned" },
        { event: "referenced", created_at: "2026-01-05T00:00:01Z", commit_id: "0123456789abcdef" },
        {
          event: "cross_referenced",
          created_at: "2026-01-06T00:00:00Z",
          actor: { login: "dee" },
          source: {
            type: "issue",
            issue: {
              number: 12,
              title: "Fix it",
              html_url: "https://github.com/other/proj/pull/12",
              state: "closed",
              pull_request: { merged_at: "2026-01-07T00:00:00Z" },
            },
          },
        },
        {
          event: "cross_referenced",
          created_at: "2026-01-06T00:00:01Z",
          source: {
            issue: {
              number: 3,
              title: "Related",
              html_url: "https://github.com/o/r/issues/3",
              state: "open",
              repository: { full_name: "o/r" },
            },
          },
        },
        { event: "reopened" }, // no timestamp: not drawable
      ]),
    "GET /user": { login: "ann" },
    [`GET ${R}/issues/9/reactions?per_page=100`]: [
      { content: "+1", user: { login: "ann" } },
      { content: "heart", user: { login: "someone" } },
    ],
    [`GET ${R}/issues/comments/101/reactions?per_page=100`]: [{ content: "rocket", user: { login: "ann" } }],
    ...over,
  };
}

test("an issue's detail carries its comments, assignees, events and which reactions are yours", async (t) => {
  const gh = fakeGitHub(t, detailRoutes());
  const d = await getIssueDetail(gh.client, "o", "r", 9);
  assert.equal(d.issue.number, 9);
  assert.deepEqual(d.assignees, ["ann", "cat"]);
  assert.deepEqual(d.comments.map((c) => [c.id, c.author?.login ?? null, c.body]), [
    [101, "ann", "first"],
    [102, null, ""],
  ]);
  assert.deepEqual(d.issue.reactions?.mine, ["+1"], "only YOUR reaction, not a stranger's heart");
  assert.deepEqual(d.comments[0].reactions?.mine, ["rocket"]);
  assert.equal(d.comments[1].reactions, undefined, "a comment nobody reacted to is not asked about");
  assert.equal(
    gh.calls.filter((c) => c.path.includes("/reactions")).length,
    2,
    "one reaction read per subject that HAS reactions",
  );

  const ev = d.events ?? [];
  const at = (i: number) => {
    const e = ev[i];
    assert.ok(e, `event ${i}`);
    return e;
  };
  assert.deepEqual(ev.map((e) => e.kind), [
    "labeled",
    "unlabeled",
    "assigned",
    "unassigned",
    "renamed",
    "milestoned",
    "closed",
    "referenced",
    "cross-referenced",
    "cross-referenced",
  ]);
  assert.deepEqual(at(0), { kind: "labeled", actor: "ann", createdAt: "2026-01-02T00:00:00Z", label: { name: "bug", color: "ff0000" } });
  assert.deepEqual(at(1).label, { name: "old", color: "888888" }, "a label with no colour gets the neutral one");
  assert.equal(at(1).actor, null);
  assert.equal(at(2).assignee, "cat");
  assert.equal(at(3).assignee, null);
  assert.deepEqual(at(4).rename, { from: "Old", to: "New" });
  assert.equal(at(5).milestone, "v2");
  assert.equal(at(6).reason, "not_planned");
  assert.deepEqual(at(7).source, { kind: "commit", ref: "0123456" });
  assert.deepEqual(at(8).source, {
    repo: "other/proj",
    kind: "pr",
    ref: "#12",
    title: "Fix it",
    url: "https://github.com/other/proj/pull/12",
    state: "closed",
    merged: true,
  });
  assert.equal(at(9).source?.repo, "o/r");
  assert.equal(at(9).source?.kind, "issue");
  assert.equal(at(9).source?.merged, false);
});

test("the detail survives failed comment, timeline and reaction reads — they are decoration", async (t) => {
  const gh = fakeGitHub(
    t,
    detailRoutes({
      [`GET ${R}/issues/9/comments?per_page=100`]: () => reply(500, {}),
      [`GET ${R}/issues/9/timeline?per_page=100`]: () => reply(500, {}),
      [`GET ${R}/issues/9/reactions?per_page=100`]: () => reply(500, {}),
    }),
  );
  const d = await getIssueDetail(gh.client, "o", "r", 9);
  assert.equal(d.issue.number, 9);
  assert.deepEqual(d.comments, []);
  assert.deepEqual(d.events, []);
  assert.equal(d.issue.reactions?.mine, undefined, "unknown, not 'you have not reacted'");
});

test("without knowing who you are, no reaction is claimed as yours and none are looked up", async (t) => {
  const gh = fakeGitHub(t, detailRoutes({ "GET /user": () => reply(401, {}) }));
  const d = await getIssueDetail(gh.client, "o", "r", 9);
  assert.equal(d.issue.reactions?.mine, undefined);
  assert.equal(gh.calls.filter((c) => c.path.includes("/reactions")).length, 0);
});

test("the issue read itself failing fails the detail", async (t) => {
  const gh = fakeGitHub(t, { [`GET ${R}/issues/9`]: () => reply(404, { message: "Not Found" }) });
  await assert.rejects(getIssueDetail(gh.client, "o", "r", 9), /Not Found/);
});

// ── Reactions ──

test("adding a reaction posts its content to the issue or the comment", async (t) => {
  const gh = fakeGitHub(t, {
    [`POST ${R}/issues/4/reactions`]: () => reply(201, {}),
    [`POST ${R}/issues/comments/55/reactions`]: () => reply(201, {}),
  });
  assert.deepEqual(await reactTo(gh.client, "o", "r", { subject: "issue", id: 4, content: "heart", on: true }), { ok: true, changed: true });
  assert.deepEqual(await reactTo(gh.client, "o", "r", { subject: "comment", id: 55, content: "eyes", on: true }), { ok: true, changed: true });
  assert.deepEqual(gh.sent("POST", `${R}/issues/4/reactions`)[0].body, { content: "heart" });
  assert.deepEqual(gh.sent("POST", `${R}/issues/comments/55/reactions`)[0].body, { content: "eyes" });
});

test("removing a reaction deletes YOURS by its id — never a stranger's with the same emoji", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /user": { login: "ann" },
    [`GET ${R}/issues/comments/55/reactions?per_page=100`]: [
      { id: 1, content: "heart", user: { login: "someone" } },
      { id: 2, content: "+1", user: { login: "ann" } },
      { id: 3, content: "heart", user: { login: "ann" } },
    ],
    [`DELETE ${R}/issues/comments/55/reactions/3`]: () => reply(204),
  });
  const r = await reactTo(gh.client, "o", "r", { subject: "comment", id: 55, content: "heart", on: false });
  assert.deepEqual(r, { ok: true, changed: true });
  assert.equal(gh.calls.filter((c) => c.method === "DELETE").length, 1);
  assert.deepEqual(gh.unmatched, []);
});

test("removing a reaction you never made changes nothing", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /user": { login: "ann" },
    [`GET ${R}/issues/4/reactions?per_page=100`]: [{ id: 1, content: "heart", user: { login: "someone" } }],
  });
  const r = await reactTo(gh.client, "o", "r", { subject: "issue", id: 4, content: "heart", on: false });
  assert.deepEqual(r, { ok: true, changed: false });
  assert.equal(gh.calls.some((c) => c.method === "DELETE"), false);
});

test("a reaction GitHub refuses comes back as a result, not a throw", async (t) => {
  const gh = fakeGitHub(t, { [`POST ${R}/issues/4/reactions`]: () => reply(403, { message: "Resource not accessible" }) });
  const r = await reactTo(gh.client, "o", "r", { subject: "issue", id: 4, content: "heart", on: true });
  assert.deepEqual(r, { ok: false, changed: false, message: "Resource not accessible", expected: true });
});

// ── Labels + milestones ──

test("listLabels maps the repo's labels, a missing description as null", async (t) => {
  const gh = fakeGitHub(t, {
    [`GET ${R}/labels?per_page=100`]: () =>
      page([
        { name: "bug", color: "d73a4a", description: "Something broke" },
        { name: "chore", color: "cccccc" },
      ]),
  });
  assert.deepEqual(await listLabels(gh.client, "o", "r"), [
    { name: "bug", color: "d73a4a", description: "Something broke" },
    { name: "chore", color: "cccccc", description: null },
  ]);
});

test("creating a label strips the # from its colour and sends an empty description when none", async (t) => {
  const gh = fakeGitHub(t, { [`POST ${R}/labels`]: () => reply(201, {}) });
  assert.deepEqual(await createLabel(gh.client, "o", "r", { name: "ui", color: "#00ff00" }), { ok: true, changed: true });
  assert.deepEqual(gh.calls[0].body, { name: "ui", color: "00ff00", description: "" });
});

test("a label that already exists is GitHub's 422, returned as a message", async (t) => {
  const gh = fakeGitHub(t, { [`POST ${R}/labels`]: () => reply(422, { message: "Validation Failed" }) });
  assert.deepEqual(await createLabel(gh.client, "o", "r", { name: "ui", color: "fff", description: "x" }), {
    ok: false,
    changed: false,
    message: "Validation Failed",
  });
});

test("updating a label sends only what changed, under the label's encoded name", async (t) => {
  const gh = fakeGitHub(t, {
    [`PATCH ${R}/labels/good%20first%20issue`]: {},
    [`PATCH ${R}/labels/bug`]: {},
  });
  await updateLabel(gh.client, "o", "r", { name: "good first issue", newName: "starter", color: "#abcdef", description: "" });
  assert.deepEqual(gh.calls[0].body, { new_name: "starter", color: "abcdef", description: "" });
  await updateLabel(gh.client, "o", "r", { name: "bug", color: "ff0000" });
  assert.deepEqual(gh.calls[1].body, { color: "ff0000" }, "no rename and no description sent when not asked");
});

test("a failed label update is a result", async (t) => {
  const gh = fakeGitHub(t, { [`PATCH ${R}/labels/bug`]: () => reply(404, { message: "Not Found" }) });
  const r = await updateLabel(gh.client, "o", "r", { name: "bug", newName: "b" });
  assert.deepEqual(r, { ok: false, changed: false, message: "Not Found" });
});

test("deleting a label DELETEs it by encoded name and reports failure as a result", async (t) => {
  const gh = fakeGitHub(t, {
    [`DELETE ${R}/labels/needs%2Ftriage`]: () => reply(204),
    [`DELETE ${R}/labels/gone`]: () => reply(404, { message: "Not Found" }),
  });
  assert.deepEqual(await deleteLabel(gh.client, "o", "r", "needs/triage"), { ok: true, changed: true });
  assert.deepEqual(await deleteLabel(gh.client, "o", "r", "gone"), { ok: false, changed: false, message: "Not Found" });
});

test("milestones reads open AND closed ones and normalises their state", async (t) => {
  const gh = fakeGitHub(t, {
    [`GET ${R}/milestones?state=all&per_page=100`]: [
      { number: 1, title: "v1", state: "closed", due_on: "2026-01-01T00:00:00Z", open_issues: 0, closed_issues: 5 },
      { number: 2, title: "v2", state: "open", open_issues: 3, closed_issues: 1 },
    ],
  });
  assert.deepEqual(await milestones(gh.client, "o", "r"), [
    { number: 1, title: "v1", state: "closed", dueOn: "2026-01-01T00:00:00Z", openIssues: 0, closedIssues: 5 },
    { number: 2, title: "v2", state: "open", dueOn: null, openIssues: 3, closedIssues: 1 },
  ]);
});

// ── Mutations ──

test("a new issue is created with its title trimmed and its labels, assignees and milestone in ONE request", async (t) => {
  const gh = fakeGitHub(t, { [`POST ${R}/issues`]: () => reply(201, rawIssue(77)) });
  const r = await createIssue(gh.client, "o", "r", {
    title: "  Crash on open  ",
    body: "steps",
    labels: ["bug"],
    assignees: ["ann"],
    milestone: 2,
  });
  assert.deepEqual(r, { ok: true, number: 77 });
  assert.equal(gh.calls.length, 1);
  assert.deepEqual(gh.calls[0].body, { title: "Crash on open", body: "steps", labels: ["bug"], assignees: ["ann"], milestone: 2 });
});

test("an issue with no title is refused before anything is sent — the user mid-compose", async (t) => {
  const gh = fakeGitHub(t);
  assert.deepEqual(await createIssue(gh.client, "o", "r", { title: "   " }), {
    ok: false,
    expected: true,
    message: "An issue needs a title.",
  });
  assert.equal(gh.calls.length, 0);
});

test("a create GitHub refuses comes back as a result", async (t) => {
  const gh = fakeGitHub(t, { [`POST ${R}/issues`]: () => reply(410, { message: "Issues are disabled for this repo" }) });
  assert.deepEqual(await createIssue(gh.client, "o", "r", { title: "x" }), {
    ok: false,
    message: "Issues are disabled for this repo",
  });
});

test("commenting posts the trimmed body; an empty comment is refused locally", async (t) => {
  const gh = fakeGitHub(t, { [`POST ${R}/issues/3/comments`]: () => reply(201, {}) });
  assert.deepEqual(await commentIssue(gh.client, "o", "r", { number: 3, body: "  thanks!\n" }), { ok: true, changed: true });
  assert.deepEqual(gh.calls[0].body, { body: "thanks!" });
  assert.deepEqual(await commentIssue(gh.client, "o", "r", { number: 3, body: " \n " }), {
    ok: false,
    changed: false,
    expected: true,
    message: "Write a comment first.",
  });
  assert.equal(gh.calls.length, 1);
});

test("a comment on a locked issue fails as a result", async (t) => {
  const gh = fakeGitHub(t, { [`POST ${R}/issues/3/comments`]: () => reply(403, { message: "Issue is locked" }) });
  assert.deepEqual(await commentIssue(gh.client, "o", "r", { number: 3, body: "hi" }), {
    ok: false,
    changed: false,
    message: "Issue is locked",
    expected: true,
  });
});

test("editing and deleting a comment address it by id", async (t) => {
  const gh = fakeGitHub(t, {
    [`PATCH ${R}/issues/comments/88`]: {},
    [`DELETE ${R}/issues/comments/88`]: () => reply(204),
    [`PATCH ${R}/issues/comments/89`]: () => reply(404, { message: "Not Found" }),
    [`DELETE ${R}/issues/comments/89`]: () => reply(404, { message: "Not Found" }),
  });
  assert.deepEqual(await editIssueComment(gh.client, "o", "r", { id: 88, body: "fixed typo" }), { ok: true, changed: true });
  assert.deepEqual(gh.calls[0].body, { body: "fixed typo" });
  assert.deepEqual(await deleteIssueComment(gh.client, "o", "r", 88), { ok: true, changed: true });
  assert.equal((await editIssueComment(gh.client, "o", "r", { id: 89, body: "x" })).ok, false);
  assert.deepEqual(await deleteIssueComment(gh.client, "o", "r", 89), { ok: false, changed: false, message: "Not Found" });
});

test("locking PUTs the reason when given, an empty body when not, and unlocking DELETEs", async (t) => {
  const gh = fakeGitHub(t, {
    [`PUT ${R}/issues/6/lock`]: () => reply(204),
    [`DELETE ${R}/issues/6/lock`]: () => reply(204),
  });
  await setIssueLocked(gh.client, "o", "r", { number: 6, locked: true, reason: "too heated" });
  await setIssueLocked(gh.client, "o", "r", { number: 6, locked: true });
  const off = await setIssueLocked(gh.client, "o", "r", { number: 6, locked: false });
  assert.deepEqual(off, { ok: true, changed: true });
  assert.deepEqual(gh.calls.map((c) => [c.method, c.body]), [
    ["PUT", { lock_reason: "too heated" }],
    ["PUT", {}],
    ["DELETE", undefined],
  ]);
});

test("a lock GitHub refuses is a result", async (t) => {
  const gh = fakeGitHub(t, { [`PUT ${R}/issues/6/lock`]: () => reply(403, { message: "Must have admin rights" }) });
  const r = await setIssueLocked(gh.client, "o", "r", { number: 6, locked: true });
  assert.equal(r.ok, false);
  assert.equal(r.message, "Must have admin rights");
});

test("closing sends the reason; reopening never sends one", async (t) => {
  const gh = fakeGitHub(t, { [`PATCH ${R}/issues/2`]: {} });
  await setIssueState(gh.client, "o", "r", { number: 2, state: "closed", reason: "not_planned" });
  await setIssueState(gh.client, "o", "r", { number: 2, state: "closed" });
  await setIssueState(gh.client, "o", "r", { number: 2, state: "open", reason: "completed" });
  assert.deepEqual(gh.calls.map((c) => c.body), [
    { state: "closed", state_reason: "not_planned" },
    { state: "closed" },
    { state: "open" },
  ]);
});

test("a state change GitHub refuses is a result", async (t) => {
  const gh = fakeGitHub(t, { [`PATCH ${R}/issues/2`]: () => reply(500, { message: "oops" }) });
  assert.deepEqual(await setIssueState(gh.client, "o", "r", { number: 2, state: "closed" }), {
    ok: false,
    changed: false,
    message: "oops",
    expected: true,
  });
});

test("editing an issue sends only the fields given, with the title trimmed", async (t) => {
  const gh = fakeGitHub(t, { [`PATCH ${R}/issues/2`]: {} });
  assert.deepEqual(await editIssue(gh.client, "o", "r", { number: 2, title: " New title " }), { ok: true, changed: true });
  assert.deepEqual(await editIssue(gh.client, "o", "r", { number: 2, body: "" }), { ok: true, changed: true });
  assert.deepEqual(gh.calls.map((c) => c.body), [{ title: "New title" }, { body: "" }]);
});

test("an edit that blanks the title, or changes nothing, is refused before sending", async (t) => {
  const gh = fakeGitHub(t);
  assert.deepEqual(await editIssue(gh.client, "o", "r", { number: 2, title: "  ", body: "x" }), {
    ok: false,
    changed: false,
    expected: true,
    message: "An issue needs a title.",
  });
  assert.deepEqual(await editIssue(gh.client, "o", "r", { number: 2 }), {
    ok: false,
    changed: false,
    expected: true,
    message: "Nothing to update.",
  });
  assert.equal(gh.calls.length, 0);
});

test("an edit GitHub refuses is a result", async (t) => {
  const gh = fakeGitHub(t, { [`PATCH ${R}/issues/2`]: () => reply(422, { message: "Validation Failed" }) });
  assert.deepEqual(await editIssue(gh.client, "o", "r", { number: 2, title: "x" }), {
    ok: false,
    changed: false,
    message: "Validation Failed",
  });
});

test("labels, assignees and the milestone are each replaced in one request", async (t) => {
  const gh = fakeGitHub(t, {
    [`PUT ${R}/issues/5/labels`]: [],
    [`PATCH ${R}/issues/5`]: {},
  });
  assert.equal((await setIssueLabels(gh.client, "o", "r", { number: 5, labels: ["bug", "ui"] })).ok, true);
  assert.equal((await setIssueAssignees(gh.client, "o", "r", { number: 5, assignees: [] })).ok, true);
  assert.equal((await setMilestone(gh.client, "o", "r", { number: 5, milestone: null })).ok, true);
  assert.equal((await setMilestone(gh.client, "o", "r", { number: 5, milestone: 3 })).ok, true);
  assert.deepEqual(gh.calls.map((c) => [c.method, c.body]), [
    ["PUT", { labels: ["bug", "ui"] }],
    ["PATCH", { assignees: [] }],
    ["PATCH", { milestone: null }],
    ["PATCH", { milestone: 3 }],
  ]);
});

test("label, assignee and milestone changes GitHub refuses are results", async (t) => {
  const gh = fakeGitHub(t, {
    [`PUT ${R}/issues/5/labels`]: () => reply(422, { message: "bad label" }),
    [`PATCH ${R}/issues/5`]: () => reply(422, { message: "bad field" }),
  });
  assert.deepEqual(await setIssueLabels(gh.client, "o", "r", { number: 5, labels: ["x"] }), {
    ok: false,
    changed: false,
    message: "bad label",
  });
  assert.deepEqual(await setIssueAssignees(gh.client, "o", "r", { number: 5, assignees: ["x"] }), {
    ok: false,
    changed: false,
    message: "bad field",
  });
  assert.deepEqual(await setMilestone(gh.client, "o", "r", { number: 5, milestone: 99 }), {
    ok: false,
    changed: false,
    message: "bad field",
  });
});
