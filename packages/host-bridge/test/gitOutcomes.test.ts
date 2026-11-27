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
  // Reports #86-#107 (Nov 2026), names invented.
  ["Could not read from remote repository.", "nowhere to push, or no access to it"],
  [
    "** WARNING: connection is not using a post-quantum key exchange algorithm.\n** This session may be vulnerable to \"store now, decrypt later\" attacks.\n** The server may need to be upgraded. See https://openssh.com/pq.html\ngit@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    "no credentials, or not these ones",
  ],
  ["fatal: unable to access 'https://git.acme.example/widgets.git/': Could not resolve proxy: proxy.acme.example", "the network"],
  ["fatal: unable to access 'https://github.com/acme/widget.git/': Received HTTP code 407 from proxy after CONNECT", "the network"],
  ["fatal: unable to look up someone@git.acme.example (port 9418) (Name or service not known)", "the network"],
  ["fatal: unable to look up 192.0.2.7:Widgets (port 9418) (Name or service not known)", "the network"],
  [
    "error: your local changes would be overwritten by cherry-pick.\nhint: commit your changes or stash them to proceed.\nfatal: cherry-pick failed",
    "uncommitted changes are in the way",
  ],
  [
    "error: your local changes would be overwritten by revert.\nhint: commit your changes or stash them to proceed.\nfatal: revert failed",
    "uncommitted changes are in the way",
  ],
  [
    "From github.com:acme/widget\n * branch            main       -> FETCH_HEAD\nfatal: refusing to merge unrelated histories",
    "the histories are unrelated",
  ],
  [
    "error: the branch 'feature/x' is not fully merged\nhint: If you are sure you want to delete it, run 'git branch -D feature/x'\nhint: Disable this message with \"git config set advice.forceDeleteBranch false\"",
    "the branch is not merged",
  ],
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
  // Report #104's push, before the scrubber ate its status line: a refusal
  // that is no hook's, so not "a pre-push hook refused it".
  "To https://github.com/acme/widget.git\n ! [remote rejected] main -> main (failed to update ref)\nerror: failed to push some refs to 'https://github.com/acme/widget.git'",
  // The same families as the new classes, caused by what the app passes: a
  // request the server could not parse; a fetch into the checked-out branch
  // (a refspec); a cherry-pick refused for its argv, not the user's changes.
  "fatal: unable to access 'https://github.com/acme/widget.git/': The requested URL returned error: 400",
  "fatal: refusing to fetch into branch 'refs/heads/main' checked out at '/repo'",
  "error: commit 3c950ab is a merge but no -m option was given.\nfatal: cherry-pick failed",
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

// A clone is handed what the user typed: there, "does not appear to be a git
// repository" is their address, not a remote name of ours (#89, #98).
const CLONE_ONLY: string[] = [
  "'acme/widgets.git' does not appear to be a git repository",
  "fatal: '/srv/git/widgets' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights",
  "repository 'C:\\src\\widgets' does not exist",
  "fatal: no path specified; see 'git help pull' for valid url syntax",
];

test("for a clone, an address that is no repository is the user's", () => {
  for (const stderr of CLONE_ONLY) {
    assert.equal(userStateOutcome(stderr, "clone"), "the address is not a repository", stderr.split("\n")[0]);
    assert.equal(userStateOutcome(stderr), undefined, `…and only for a clone: ${stderr.split("\n")[0]}`);
  }
  // A clone still reports what only its argv could cause.
  for (const stderr of ["error: unknown option `depth'", "fatal: Too many arguments.", "fatal: ambiguous argument 'main'"]) {
    assert.equal(userStateOutcome(stderr, "clone"), undefined, stderr);
  }
  // The general classes still answer for a clone.
  assert.equal(userStateOutcome("fatal: Authentication failed for 'https://github.com/acme/widget.git/'", "clone"), "no credentials, or not these ones");
});

// The classifier reads git's output UNCLIPPED (the reporters clip only what
// they send), so no pattern may scan a line once per occurrence of its own
// words: "unable to look up [^\n]* \(port" took 423 ms on 64k of input.
test("the classifier is linear on any input", () => {
  const rep = (u: string, n: number): string => u.repeat(Math.ceil(n / u.length)).slice(0, n);
  const units = [
    "unable to look up ", "[rejected] ", "[remote rejected] ", "repository '", "a branch named '", "tag '",
    "Unable to create '", "git-lfs ", "configured for Git LFS but '", "a", " ", "(", "'", "error: failed to push some refs to ",
  ];
  const t0 = performance.now();
  for (const u of units) {
    const s = rep(u, 256_000);
    userStateOutcome(s);
    userStateOutcome(s, "clone");
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 2_000, `took ${ms.toFixed(0)} ms`);
});

test("the classifier grows linearly with its input", () => {
  const rep = (u: string, n: number): string => u.repeat(Math.ceil(n / u.length)).slice(0, n);
  const best = (s: string): number => {
    let t = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      userStateOutcome(s, "clone");
      t = Math.min(t, performance.now() - t0);
    }
    return t;
  };
  for (const u of ["unable to look up ", "[rejected] ", "repository '", "Unable to create '", "a branch named '"]) {
    const small = best(rep(u, 8_000));
    const large = best(rep(u, 32_000));
    assert.ok(large < 5 || large / Math.max(small, 0.5) < 9, `${JSON.stringify(u)}: ${small.toFixed(1)} -> ${large.toFixed(1)} ms`);
  }
});
