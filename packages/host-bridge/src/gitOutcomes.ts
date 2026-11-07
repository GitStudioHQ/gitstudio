/**
 * Git failures that are the user's situation, not a defect — shared by both
 * crash reporters so they agree on what is worth filing.
 *
 * Both apps report a git command that exited non-zero: the extension from
 * showGitError, the desktop from its IPC wrapper. That is how we hear about a
 * command the app built wrong. But most failures are answers about the user's
 * remote, credentials, network, setup or working tree, and those filled the
 * crash tracker (48 open reports in Nov 2026, nearly all of this kind): a push
 * the remote refused because it moved on, a password it did not accept, a
 * rebase that stopped on a conflict, a branch name that already exists. The
 * user already sees git's words for each; a report of one tells us nothing we
 * can fix.
 *
 * What the app itself BUILDS keeps reporting, deliberately absent here: a
 * refspec ("src refspec … does not match any"), a revision ("ambiguous
 * argument", "bad revision", "nonexistent object"), a pathspec ("did not match
 * any files"), a remote name ("does not appear to be a git repository"), an
 * option, a cherry-pick of a merge without -m, an operation continued that is
 * not in progress. Those are ours.
 *
 * Matched on git's English, because a reporter only ever has the words — plus
 * the Simplified Chinese forms reports have actually arrived in (git speaks
 * the user's language). Any other language reports as before: the side to err
 * on.
 *
 * Moved here from the desktop's expectedError.ts (REMOTE_OUTCOMES), whose
 * classes and comments it keeps.
 */

const OUTCOMES: ReadonlyArray<{ name: string; re: RegExp }> = [
  // ── The remote said no ──────────────────────────────────────────────────
  {
    // "! [rejected] main -> main (fetch first)" / "(non-fast-forward)", with
    // git's "Updates were rejected because …" hint. NOT "(stale info)": that is
    // a --force-with-lease refused, and the lease's expected sha is ours
    // (SyncOps.push) — a wrong one looks exactly like that, so it reports.
    name: "the remote branch moved on",
    re: /\bUpdates were rejected because (?:the tip of your current branch is behind|the remote contains work|a pushed branch tip is behind|the tag already exists)|\[rejected\][^\n]*\((?:fetch first|non-fast-forward|already exists)\)/,
  },
  {
    // The server's own policy: a protected branch (GitHub's GH006, a ruleset's
    // GH013, GitLab's), a pre-receive or update hook. Not every
    // "[remote rejected]": "(funny refname)" or "(deny updating a hidden ref)"
    // is about a ref the app may have spelled, and reports.
    name: "the remote's own rules refused it",
    re: /\[remote rejected\][^\n]*\((?:pre-receive|update|protected branch) hook declined\)|\bGH006\b|\bGH013\b|\bProtected branch update failed\b|push declined due to repository rule violations|not allowed to push code to protected branches/i,
  },
  {
    name: "no credentials, or not these ones",
    re: /could not read (?:Username|Password) for|\bAuthentication failed for\b|Permission denied \(publickey|Host key verification failed|The requested URL returned error: (?:401|403)\b|Invalid username or (?:password|token)|Support for password authentication was removed|HTTP Basic: Access denied|has enabled or enforced SAML SSO|鉴权失败|身份验证失败|认证失败/i,
  },
  {
    // GitHub's answer for a repository you cannot see (both its SSH and its
    // HTTPS words), and a repo with no remote. "Could not read from remote
    // repository" is ssh's closing line after any refusal — and also after
    // "'origin' does not appear to be a git repository", a remote NAME the app
    // passed, which must keep reporting: so not when that line is there.
    name: "nowhere to push, or no access to it",
    re: /\bremote: Repository not found\b|\bERROR: Repository not found\b|\brepository '[^'\n]*' not found\b|\bNo configured push destination\b|^(?![\s\S]*does not appear to be a git repository)[\s\S]*Could not read from remote repository|仓库[^\n]*未找到/i,
  },
  {
    name: "the network",
    re: /Could not resolve host|Could not resolve hostname|Failed to connect to|Connection (?:timed out|refused|reset|closed)|Operation timed out|Operation too slow|Network is unreachable|No route to host|\bRPC failed\b|schannel: failed to receive handshake|\bSSL[_ ](?:ERROR|connect error)|SSL certificate problem|gnutls_handshake\(\) failed|Bad packet length|The remote end hung up unexpectedly|early EOF|unexpected disconnect while reading sideband packet|无法解析主机|连接超时/i,
  },
  {
    // A local pre-push hook that said no: git ends with "failed to push some
    // refs" and names no ref it refused, no refspec and no remote reason —
    // the hook's own output is all there is above it.
    name: "a pre-push hook refused it",
    re: /^(?![\s\S]*(?:\[rejected\]|\[remote rejected\]|Updates were rejected|src refspec|does not match any|unable to access))[\s\S]*error: failed to push some refs to\b/,
  },

  // ── The user's own setup ────────────────────────────────────────────────
  {
    name: "who the commit is by is not set",
    re: /Please tell me who you are|Author identity unknown|Committer identity unknown|unable to auto-detect email address|作者身份未知|提交者身份未知/i,
  },
  {
    name: "Git LFS is not installed",
    re: /configured for Git LFS but '[^'\n]*' was not found on your path|git-lfs[^\n]*: command not found/i,
  },
  {
    // Another git — very often the editor's own — holds the index.
    name: "another git process holds the lock",
    re: /Unable to create '[^'\n]*\.lock': File exists/i,
  },

  // ── The repository is in a state git will not act in ───────────────────
  {
    name: "it stopped on a conflict",
    re: /^CONFLICT \(|\bMerge conflict in\b|\bcould not apply [0-9a-f]{7,}|Resolve all conflicts manually|after resolving the conflicts|you need to resolve your current index first|冲突（内容）|合并冲突于/m,
  },
  {
    name: "uncommitted changes are in the way",
    re: /Your local changes to the following files would be overwritten|Please commit your changes or stash them|cannot (?:rebase|pull with rebase): You have unstaged changes|untracked working tree files would be (?:overwritten|removed)|您对下列文件的本地修改将被(?:合并|检出)操作覆盖/,
  },
  {
    name: "that name is taken",
    re: /\ba branch named '[^'\n]*' already exists|\btag '[^'\n]*' already exists|已经存在/,
  },
  {
    name: "the branch is not merged",
    re: /\bis not fully merged\b|未完全合并/,
  },
  {
    name: "the branch has no upstream to pull from",
    re: /There is no tracking information for the current branch|当前分支没有跟踪信息/,
  },
  {
    name: "not on a branch",
    re: /You are not currently on a branch|您当前不在一个分支上/,
  },
  {
    // GitStudio's own refusals of a push that would re-create a deleted
    // branch (git-service SyncOps) — said to the user, never a fault.
    name: "the branch it tracks is gone",
    re: /which no longer exists on the remote\. Choose the branch it tracks now/,
  },
];

/**
 * The kind of user situation `message` describes (see OUTCOMES), or undefined
 * when it may be the app's own doing and should be reported.
 */
export function userStateOutcome(message: string): string | undefined {
  return OUTCOMES.find((c) => c.re.test(message))?.name;
}

/** The names of every class, for tests and documentation. */
export const USER_STATE_OUTCOMES: readonly string[] = OUTCOMES.map((c) => c.name);
