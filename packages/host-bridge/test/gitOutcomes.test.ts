import { test } from "node:test";
import assert from "node:assert/strict";
import { userStateOutcome } from "../src/gitOutcomes";

// What both crash reporters skip, and what they must keep filing. Every
// "skips" row is the shape of a report that reached the tracker as a crash
// (names invented); every "reports" row is a failure the app can cause itself.

const SKIPS: Array<[string, string]> = [
  [
    "To https://github.com/acme/widget.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'https://github.com/acme/widget.git'\nhint: Updates were rejected because the remote contains work that you do not\nhint: have locally.",
    "the remote branch moved on",
  ],
  ["remote: HTTP Basic: Access denied. The provided password or token is incorrect or your account has 2FA enabled", "no credentials, or not these ones"],
  ["ERROR: The 'acme' organization has enabled or enforced SAML SSO. To access this repository, you must re-authorize", "no credentials, or not these ones"],
  ["remote: 鉴权失败\nfatal: 'https://example.com/acme/widget.git/' 鉴权失败", "no credentials, or not these ones"],
  ["remote: Repository not found.\nfatal: repository 'https://github.com/acme/widget.git/' not found", "nowhere to push, or no access to it"],
  ["git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", "no credentials, or not these ones"],
  ["fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights", "nowhere to push, or no access to it"],
  ["ssh: connect to host 192.0.2.1 port 22: No route to host", "the network"],
  ["error: RPC failed; curl 28 Operation too slow. Less than 1000 bytes/sec transferred the last 60 seconds", "the network"],
  ["fatal: unable to access 'https://github.com/acme/widget.git/': schannel: failed to receive handshake, SSL/TLS connection failed", "the network"],
  ["Bad packet length 376342927.\nssh_dispatch_run_fatal: Connection to 192.0.2.1 port 22: message authentication code incorrect", "the network"],
  ["$ npm test\n> widget@1.0.0 test\n1 failing\nerror: failed to push some refs to 'https://github.com/acme/widget.git'", "a pre-push hook refused it"],
  ["Committer identity unknown\n\n*** Please tell me who you are.", "who the commit is by is not set"],
  ["提交者身份未知\n\n*** 请告诉我您是谁。", "who the commit is by is not set"],
  ["This repository is configured for Git LFS but 'git-lfs' was not found on your path. If you no longer wish to use Git LFS, remove this hook", "Git LFS is not installed"],
  ["fatal: Unable to create '/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running", "another git process holds the lock"],
  ["Auto-merging src/app.ts\nCONFLICT (content): Merge conflict in src/app.ts\nerror: could not apply 4ef53ae... add thing", "it stopped on a conflict"],
  ["error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/app.ts\nPlease commit your changes or stash them", "uncommitted changes are in the way"],
  ["fatal: a branch named 'feature/x' already exists", "that name is taken"],
  ["fatal: tag 'v1.0.0' already exists", "that name is taken"],
  ["error: the branch 'feature/x' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D feature/x'.", "the branch is not merged"],
  ["There is no tracking information for the current branch.\nPlease specify which branch you want to merge with.", "the branch has no upstream to pull from"],
  ["fatal: You are not currently on a branch.\nTo push the history leading to the current (detached HEAD)", "not on a branch"],
  ["'feature/x' tracks origin/feature/x, which no longer exists on the remote. Choose the branch it tracks now, then push.", "the branch it tracks is gone"],
];

const REPORTS: string[] = [
  // A refspec, a revision, a pathspec, a remote name, an object: the app's own.
  "error: src refspec feature/x does not match any\nerror: failed to push some refs to 'https://github.com/acme/widget.git'",
  "fatal: ambiguous argument 'abc123': unknown revision or path not in the working tree.",
  "fatal: pathspec 'src/gone.ts' did not match any files",
  "fatal: 'upstream' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights",
  "fatal: cannot update ref 'refs/tags/v1': trying to write ref 'refs/tags/v1' with nonexistent object 559cc31",
  "error: commit 3c950ab is a merge but no -m option was given.\nfatal: cherry-pick failed",
  "fatal: no rebase in progress",
  "error: unknown option `force-if-includes'",
  // A lease refused: its expected sha is ours, and a wrong one reads like this.
  " ! [rejected]        main -> main (stale info)\nerror: failed to push some refs to 'https://github.com/acme/widget.git'",
  "",
];

test("a user's situation is named, and not filed", () => {
  for (const [stderr, name] of SKIPS) {
    assert.equal(userStateOutcome(stderr), name, stderr.split("\n")[0]);
  }
});

test("what the app builds keeps reporting", () => {
  for (const stderr of REPORTS) {
    assert.equal(userStateOutcome(stderr), undefined, stderr.split("\n")[0]);
  }
});
