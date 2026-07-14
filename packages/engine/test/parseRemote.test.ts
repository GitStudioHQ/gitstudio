import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRemote,
  isGitHubRemote,
} from "../src/forge/parseRemote";

test("parses scp-like ssh remotes (git@github.com:OWNER/REPO.git)", () => {
  assert.deepEqual(parseRemote("git@github.com:GitStudioHQ/gitstudio.git"), {
    host: "github.com",
    owner: "GitStudioHQ",
    repo: "gitstudio",
  });
});

test("parses https remotes (https://github.com/OWNER/REPO.git)", () => {
  assert.deepEqual(parseRemote("https://github.com/GitStudioHQ/gitstudio.git"), {
    host: "github.com",
    owner: "GitStudioHQ",
    repo: "gitstudio",
  });
});

test("parses explicit ssh remotes (ssh://git@github.com/OWNER/REPO.git)", () => {
  assert.deepEqual(
    parseRemote("ssh://git@github.com/GitStudioHQ/gitstudio.git"),
    { host: "github.com", owner: "GitStudioHQ", repo: "gitstudio" },
  );
});

test("strips a trailing .git (and tolerates its absence)", () => {
  assert.equal(parseRemote("git@github.com:o/repo.git")?.repo, "repo");
  assert.equal(parseRemote("git@github.com:o/repo")?.repo, "repo");
  assert.equal(
    parseRemote("https://github.com/o/repo")?.repo,
    "repo",
  );
  // Only a trailing .git is stripped, not one mid-name.
  assert.equal(parseRemote("git@github.com:o/my.git.repo.git")?.repo, "my.git.repo");
});

test("lowercases the host but preserves owner/repo case", () => {
  const r = parseRemote("git@GitHub.com:My-Org/My-Repo.git");
  assert.equal(r?.host, "github.com");
  assert.equal(r?.owner, "My-Org");
  assert.equal(r?.repo, "My-Repo");
});

test("tolerates https with userinfo, ports, and trailing slash", () => {
  assert.deepEqual(parseRemote("https://x:y@github.com:443/o/repo.git/"), {
    host: "github.com",
    owner: "o",
    repo: "repo",
  });
});

test("handles ssh:// with a port", () => {
  assert.deepEqual(parseRemote("ssh://git@github.com:22/o/repo.git"), {
    host: "github.com",
    owner: "o",
    repo: "repo",
  });
});

test("parses non-github hosts (host is reported, not forced)", () => {
  assert.deepEqual(parseRemote("git@gitlab.com:o/repo.git"), {
    host: "gitlab.com",
    owner: "o",
    repo: "repo",
  });
  assert.deepEqual(parseRemote("https://git.example.org/o/repo.git"), {
    host: "git.example.org",
    owner: "o",
    repo: "repo",
  });
});

test("returns null for garbage / non-owner-repo remotes", () => {
  assert.equal(parseRemote(""), null);
  assert.equal(parseRemote("   "), null);
  assert.equal(parseRemote("not a url"), null);
  // Missing the repo segment.
  assert.equal(parseRemote("git@github.com:owner"), null);
  assert.equal(parseRemote("https://github.com/owner"), null);
  // A bare local path is not a remote.
  assert.equal(parseRemote("/home/me/repo.git"), null);
});

test("isGitHubRemote gates on github.com only", () => {
  assert.equal(isGitHubRemote(parseRemote("git@github.com:o/r.git")), true);
  assert.equal(isGitHubRemote(parseRemote("https://github.com/o/r")), true);
  assert.equal(isGitHubRemote(parseRemote("git@gitlab.com:o/r.git")), false);
  assert.equal(isGitHubRemote(null), false);
});
