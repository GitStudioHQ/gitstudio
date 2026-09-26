import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseRemote,
  isGitHubRemote,
  parseGitHubRemote,
  sshConfigHostName,
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

// The Pull Requests view gates on this: a github.com remote under another
// name — an SSH host alias (the multi-account ~/.ssh/config setup), SSH over
// port 443, or the www. address a browser gives — turned the whole feature
// off without a word.
test("isGitHubRemote accepts github.com under every name a real remote uses", () => {
  for (const url of [
    "git@github.com-work:acme/app.git",
    "git@github.com-personal.2:me/dotfiles.git",
    "ssh://git@ssh.github.com:443/acme/app.git",
    "https://www.github.com/acme/app",
    "git@GitHub.com-Work:acme/app.git",
  ]) {
    assert.equal(isGitHubRemote(parseRemote(url)), true, url);
  }
  for (const url of [
    "https://evilnotgithub.com/a/b",
    "https://github.com.evil.io/a/b",
    "https://github.mycorp.com/org/repo.git",
    "git@githubXcom:a/b.git",
    "git@gitlab.com:org/repo.git",
  ]) {
    assert.equal(isGitHubRemote(parseRemote(url)), false, url);
  }
});

test("parseGitHubRemote: exactly owner/repo on github.com, aliases included", () => {
  const cases: Array<[string, { owner: string; repo: string } | undefined]> = [
    ["https://github.com/GitStudioHQ/gitstudio.git", { owner: "GitStudioHQ", repo: "gitstudio" }],
    ["https://github.com/org/repo/", { owner: "org", repo: "repo" }],
    ["git@github.com:org/repo.git", { owner: "org", repo: "repo" }],
    ["git@github.com-work:org/repo.git", { owner: "org", repo: "repo" }],
    ["ssh://git@github.com:22/org/repo.git", { owner: "org", repo: "repo" }],
    ["ssh://git@ssh.github.com:443/org/repo.git", { owner: "org", repo: "repo" }],
    ["https://www.github.com/org/repo", { owner: "org", repo: "repo" }],
    ["git://github.com/org/repo.git", { owner: "org", repo: "repo" }],
    ["git+ssh://git@github.com/org/repo.git", { owner: "org", repo: "repo" }],
    ["https://evilnotgithub.com/a/b", undefined],
    ["https://github.mycorp.com/org/repo.git", undefined],
    ["git@gitlab.com:org/repo.git", undefined],
    ["", undefined],
    ["https://github.com/onlyowner", undefined],
    ["https://github.com/o/r/extra", undefined],
  ];
  for (const [url, expected] of cases) {
    assert.deepEqual(parseGitHubRemote(url), expected, url);
  }
});

test("an ~/.ssh/config alias whose HostName is github.com resolves to it", () => {
  const config = [
    "# work account",
    "Host work gh-work",
    "  HostName github.com",
    "  IdentityFile ~/.ssh/work",
    "",
    "Host corp",
    "  HostName github.mycorp.com",
    "",
    "Host *.internal !secret.internal",
    "  HostName=ssh.github.com",
    "",
    "Match host other",
    "  HostName github.com",
  ].join("\n");
  const resolve = (h: string) => sshConfigHostName(config, h);
  assert.equal(sshConfigHostName(config, "work"), "github.com");
  assert.equal(sshConfigHostName(config, "gh-work"), "github.com");
  assert.equal(sshConfigHostName(config, "box.internal"), "ssh.github.com");
  assert.equal(sshConfigHostName(config, "secret.internal"), undefined, "negated pattern");
  assert.equal(sshConfigHostName(config, "other"), undefined, "Match blocks are not followed");
  assert.deepEqual(parseGitHubRemote("git@work:acme/app.git", resolve), { owner: "acme", repo: "app" });
  assert.deepEqual(parseGitHubRemote("ssh://git@gh-work/acme/app.git", resolve), { owner: "acme", repo: "app" });
  assert.equal(parseGitHubRemote("git@corp:acme/app.git", resolve), undefined, "an Enterprise host is not github.com");
  assert.equal(parseGitHubRemote("git@work:acme/app.git"), undefined, "without the config, an alias is unknown");
});
