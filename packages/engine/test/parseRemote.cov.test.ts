// Remote URLs (src/forge/parseRemote.ts) — the corners
// test/parseRemote.test.ts leaves: a repository name that is only ".git",
// URLs that aren't URLs, an alias nothing resolves, and ssh_config lines that
// carry no value.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGitHubRemote, parseRemote, sshConfigHostName } from "../src/forge/parseRemote";

test("a remote whose repository is only '.git' names no repository", () => {
  assert.equal(parseRemote("https://github.com/owner/.git"), null);
  assert.equal(parseRemote("git@github.com:owner/.git"), null);
  assert.equal(parseGitHubRemote("https://github.com/owner/.git"), undefined);
});

test("what isn't a remote at all: blank, a malformed URL, one path segment, a drive path", () => {
  assert.equal(parseRemote("   "), null);
  assert.equal(parseRemote("https://[not a host/o/r"), null);
  assert.equal(parseRemote("https://github.com/onlyowner"), null);
  assert.equal(parseRemote("C:\\repos\\app"), null);
  assert.equal(parseGitHubRemote(""), undefined);
});

test("an alias the resolver doesn't know stays itself, and so isn't github.com", () => {
  assert.equal(parseGitHubRemote("git@work:acme/app.git", () => undefined), undefined);
  assert.equal(parseGitHubRemote("git@work:acme/app.git"), undefined);
  assert.deepEqual(parseGitHubRemote("git@work:acme/app.git", (h) => (h === "work" ? "github.com" : undefined)), { owner: "acme", repo: "app" });
  // A github.com host is never sent to the resolver.
  assert.deepEqual(parseGitHubRemote("https://github.com/acme/app.git/", () => "gitlab.com"), { owner: "acme", repo: "app" });
});

test("ssh_config: a line with a key and no value is skipped", () => {
  const config = ["Host", "Host work", "  HostName", "  HostName=\"GitHub.com\"", "Host other", "  HostName elsewhere"].join("\r\n");
  assert.equal(sshConfigHostName(config, "work"), "github.com", "the first HostName with a value, unquoted and lowercased");
  assert.equal(sshConfigHostName(config, "WORK"), "github.com", "aliases match without regard to case");
  assert.equal(sshConfigHostName(config, "nobody"), undefined);
  assert.equal(sshConfigHostName("", "work"), undefined);
});

test("ssh_config patterns: ? is one character and regex characters are literal", () => {
  const config = "Host gh? a+b.c\n  HostName github.com\n";
  assert.equal(sshConfigHostName(config, "gh1"), "github.com");
  assert.equal(sshConfigHostName(config, "gh12"), undefined);
  assert.equal(sshConfigHostName(config, "a+b.c"), "github.com");
  assert.equal(sshConfigHostName(config, "aab.c"), undefined, "+ is not a regex quantifier here");
  assert.equal(sshConfigHostName(config, "a+bxc"), undefined, ". is not any character here");
});
