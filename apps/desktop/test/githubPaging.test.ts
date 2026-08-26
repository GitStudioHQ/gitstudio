import { test } from "node:test";
import assert from "node:assert/strict";
import { nextPagePath } from "../src/main/githubPaging";

const API = "https://api.github.com";

test("parses rel=next into an API-relative path", () => {
  const link =
    '<https://api.github.com/repos/o/r/issues?state=open&page=2>; rel="next", ' +
    '<https://api.github.com/repos/o/r/issues?state=open&page=9>; rel="last"';
  assert.equal(nextPagePath(link, API), "/repos/o/r/issues?state=open&page=2");
});

test("last page (no rel=next) returns undefined", () => {
  const link = '<https://api.github.com/repos/o/r/issues?page=8>; rel="prev", ' +
    '<https://api.github.com/repos/o/r/issues?page=1>; rel="first"';
  assert.equal(nextPagePath(link, API), undefined);
});

test("missing / empty header returns undefined", () => {
  assert.equal(nextPagePath(null, API), undefined);
  assert.equal(nextPagePath(undefined, API), undefined);
  assert.equal(nextPagePath("", API), undefined);
});

test("rel=next appearing after other params in the same segment still matches", () => {
  const link = '<https://api.github.com/notifications?page=2>; per_page="50"; rel="next"';
  assert.equal(nextPagePath(link, API), "/notifications?page=2");
});

test("order of relations does not matter", () => {
  const link =
    '<https://api.github.com/x?page=1>; rel="first", <https://api.github.com/x?page=3>; rel="next"';
  assert.equal(nextPagePath(link, API), "/x?page=3");
});

test("a rel=next on a foreign host is refused", () => {
  const link = '<https://evil.example.com/steal?page=2>; rel="next"';
  assert.equal(nextPagePath(link, API), undefined);
});

test("a relative rel=next path is passed through", () => {
  const link = '</repos/o/r/issues?page=2>; rel="next"';
  assert.equal(nextPagePath(link, API), "/repos/o/r/issues?page=2");
});
