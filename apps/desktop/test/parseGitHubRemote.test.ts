import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGitHubRemote } from "../src/main/githubBridge";

// The remote-URL parser behind "is this a GitHub repo?". The old regex refused
// SSH host aliases (the standard multi-account setup), mis-parsed ssh:// URLs
// with ports (owner="22" → every API call 404'd), accepted non-GitHub hosts
// containing "github.com", and choked on trailing slashes. Each case below is
// one of those real setups.

const CASES: Array<[string, { owner: string; repo: string } | undefined]> = [
  ["https://github.com/GitStudioHQ/gitstudio.git", { owner: "GitStudioHQ", repo: "gitstudio" }],
  ["https://github.com/GitStudioHQ/gitstudio", { owner: "GitStudioHQ", repo: "gitstudio" }],
  ["https://github.com/org/repo/", { owner: "org", repo: "repo" }],
  ["git@github.com:org/repo.git", { owner: "org", repo: "repo" }],
  // SSH host aliases — the multi-account ~/.ssh/config pattern.
  ["git@github.com-work:org/repo.git", { owner: "org", repo: "repo" }],
  ["git@github.com-personal:me/dotfiles.git", { owner: "me", repo: "dotfiles" }],
  // ssh:// with an explicit port — used to parse owner as "22".
  ["ssh://git@github.com:22/org/repo.git", { owner: "org", repo: "repo" }],
  ["ssh://git@github.com/org/repo.git", { owner: "org", repo: "repo" }],
  ["git://github.com/org/repo.git", { owner: "org", repo: "repo" }],
  // Not GitHub — must all be rejected.
  ["https://evilnotgithub.com/a/b", undefined],
  ["https://github.mycorp.com/org/repo.git", undefined],
  ["git@gitlab.com:org/repo.git", undefined],
  ["", undefined],
  ["https://github.com/onlyowner", undefined],
  ["https://github.com/o/r/extra", undefined],
];

test("parseGitHubRemote handles every real-world remote URL form", () => {
  for (const [url, expected] of CASES) {
    assert.deepEqual(parseGitHubRemote(url), expected, `for ${JSON.stringify(url)}`);
  }
});
