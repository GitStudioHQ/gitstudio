// What the two composers actually SEND.
//
// Both surfaces were rebuilt from modals into routed pages this round, and both
// gained fields the modal could never ask for: "Set as the latest release", and
// labels/assignees/milestone on a new issue. Each of those fields has a rule
// about ABSENCE that is invisible in the UI and destructive when wrong — GitHub
// reads a missing `make_latest` as "you decide" and an explicit `[]` as "clear
// these", so "the author did not choose" and "the author chose nothing" are not
// the same request.

import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseBody } from "../src/main/github/releases";
import { newIssueBody } from "../src/main/github/issues";

test("a release that never asked about Latest does not answer", () => {
  const body = releaseBody({ tagName: "v1.0.0" }, { forCreate: true });
  assert.equal("make_latest" in body, false);
});

test("Set as the latest release is sent as GitHub's string, both ways", () => {
  assert.equal(releaseBody({ tagName: "v1", makeLatest: true }, { forCreate: true }).make_latest, "true");
  assert.equal(releaseBody({ tagName: "v1", makeLatest: false }, { forCreate: true }).make_latest, "false");
});

test("a new release with no title falls back to its tag", () => {
  assert.equal(releaseBody({ tagName: "v2.1.0", name: "" }, { forCreate: true }).name, "v2.1.0");
});

test("an EDIT that empties the title clears it rather than restoring the tag", () => {
  // The other direction of the same rule: on an update, "" is a statement.
  assert.equal(releaseBody({ id: 5, tagName: "v2.1.0", name: "" }, { forCreate: false }).name, "");
});

test("an empty target is omitted so GitHub uses the default branch", () => {
  // Sent as "", GitHub errors instead of defaulting.
  assert.equal(releaseBody({ tagName: "v1", targetCommitish: "" }, { forCreate: true }).target_commitish, undefined);
});

test("draft and prerelease default to false rather than undefined", () => {
  const b = releaseBody({ tagName: "v1" }, { forCreate: true });
  assert.equal(b.draft, false);
  assert.equal(b.prerelease, false);
});

test("a new issue carries the labels its author chose, in one request", () => {
  const b = newIssueBody({ title: "Broken", labels: ["bug", "ui"], assignees: ["antonarnaudov"] });
  assert.deepEqual(b.labels, ["bug", "ui"]);
  assert.deepEqual(b.assignees, ["antonarnaudov"]);
});

test("choosing nothing omits the field instead of sending an empty array", () => {
  const b = newIssueBody({ title: "Broken", labels: [], assignees: [] });
  assert.equal("labels" in b, false);
  assert.equal("assignees" in b, false);
  assert.equal("milestone" in b, false);
});

test("milestone 0 would still be sent — absence is the only omission", () => {
  // `!req.milestone` would drop a legitimate 0; the rule is `undefined`.
  assert.equal(newIssueBody({ title: "x", milestone: 0 }).milestone, 0);
});

test("a body is always present, so an issue with none is not sent as undefined", () => {
  assert.equal(newIssueBody({ title: "x" }).body, "");
});
