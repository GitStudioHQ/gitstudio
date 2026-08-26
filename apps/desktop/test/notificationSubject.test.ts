import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapNotification,
  subjectHtmlUrl,
  subjectRef,
  type RawNotification,
} from "../src/main/github/maps";

// The Inbox can only open a notification IN-APP if it knows what the thread is
// about. GitHub's subject carries no number and no html_url — only an API url
// whose tail is the number (or the sha). Every form it emits is pinned here.

test("a pull-request subject yields kind + number", () => {
  assert.deepEqual(
    subjectRef("PullRequest", "https://api.github.com/repos/acme/widgets/pulls/42"),
    { kind: "pull", number: 42 },
  );
});

test("an issue subject yields kind + number", () => {
  assert.deepEqual(
    subjectRef("Issue", "https://api.github.com/repos/acme/widgets/issues/7"),
    { kind: "issue", number: 7 },
  );
});

test("a release subject yields kind + number (the release ID)", () => {
  assert.deepEqual(
    subjectRef("Release", "https://api.github.com/repos/acme/widgets/releases/98765"),
    { kind: "release", number: 98765 },
  );
});

test("a commit subject yields the sha", () => {
  assert.deepEqual(
    subjectRef("Commit", "https://api.github.com/repos/acme/widgets/commits/9f8e7d6c5b4a3928"),
    { kind: "commit", sha: "9f8e7d6c5b4a3928" },
  );
});

test("a query string or fragment after the number doesn't break parsing", () => {
  assert.deepEqual(
    subjectRef("Issue", "https://api.github.com/repos/acme/widgets/issues/7?foo=1"),
    { kind: "issue", number: 7 },
  );
});

test("a repo whose NAME contains digits doesn't confuse the parse", () => {
  assert.deepEqual(
    subjectRef("Issue", "https://api.github.com/repos/acme/repo123/issues/5"),
    { kind: "issue", number: 5 },
  );
});

test("a null url falls back to the declared subject type", () => {
  assert.deepEqual(subjectRef("Discussion", null), { kind: "discussion" });
  assert.deepEqual(subjectRef("Release", undefined), { kind: "release" });
  assert.deepEqual(subjectRef("PullRequest", ""), { kind: "pull" });
});

test("an unknown subject type is 'other', never a crash", () => {
  assert.deepEqual(subjectRef("CheckSuite", null), { kind: "other" });
  assert.deepEqual(subjectRef(undefined, undefined), { kind: "other" });
});

// ── html urls ────────────────────────────────────────────────────────────────

function notif(over: Partial<RawNotification> = {}): RawNotification {
  return {
    id: "1",
    unread: true,
    reason: "mention",
    updated_at: "2026-08-20T10:00:00Z",
    subject: { title: "Something", type: "Issue", url: "https://api.github.com/repos/acme/w/issues/3" },
    repository: { full_name: "acme/w", html_url: "https://github.com/acme/w" },
    ...over,
  };
}

test("issue/PR/release subjects get exact web urls", () => {
  assert.equal(subjectHtmlUrl(notif()), "https://github.com/acme/w/issues/3");
  assert.equal(
    subjectHtmlUrl(
      notif({ subject: { type: "PullRequest", url: "https://api.github.com/repos/acme/w/pulls/9" } }),
    ),
    "https://github.com/acme/w/pull/9",
  );
  assert.equal(
    subjectHtmlUrl(
      notif({ subject: { type: "Release", url: "https://api.github.com/repos/acme/w/releases/12" } }),
    ),
    "https://github.com/acme/w/releases/12",
  );
});

test("a commit subject gets a /commit/<sha> url instead of the bare repo", () => {
  assert.equal(
    subjectHtmlUrl(
      notif({ subject: { type: "Commit", url: "https://api.github.com/repos/acme/w/commits/abc1234" } }),
    ),
    "https://github.com/acme/w/commit/abc1234",
  );
});

test("an unparseable subject falls back to the repository", () => {
  assert.equal(
    subjectHtmlUrl(notif({ subject: { type: "Discussion", url: null } })),
    "https://github.com/acme/w",
  );
});

// ── the mapper ───────────────────────────────────────────────────────────────

test("mapNotification carries the parsed subject + last-read through", () => {
  const t = mapNotification(
    notif({
      last_read_at: "2026-08-19T09:00:00Z",
      subject: { title: "Fix it", type: "PullRequest", url: "https://api.github.com/repos/acme/w/pulls/31" },
    }),
  );
  assert.equal(t.subjectKind, "pull");
  assert.equal(t.subjectNumber, 31);
  assert.equal(t.subjectSha, undefined);
  assert.equal(t.lastReadAt, "2026-08-19T09:00:00Z");
  assert.equal(t.htmlUrl, "https://github.com/acme/w/pull/31");
});

test("mapNotification tolerates a missing subject and repository", () => {
  const t = mapNotification({
    id: "9",
    unread: false,
    reason: "subscribed",
    updated_at: "",
    subject: null,
    repository: null,
  });
  assert.equal(t.title, "(untitled)");
  assert.equal(t.repo, "");
  assert.equal(t.subjectKind, "other");
  assert.equal(t.htmlUrl, "");
});
