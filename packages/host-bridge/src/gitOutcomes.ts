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
 * Except where the operation says otherwise. A CLONE is handed the address the
 * user typed, so there "does not appear to be a git repository" is about their
 * path or URL, not a remote name of ours: the caller names the operation
 * (`userStateOutcome(message, "clone")`) and gets its classes too (FOR_OP).
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
    re: /\bUpdates were rejected because (?:the tip of your current branch is behind|the remote contains work|a pushed branch tip is behind|the tag already exists)|\[rejected\][^\n]{0,256}\((?:fetch first|non-fast-forward|already exists)\)/,
  },
  {
    // The server's own policy: a protected branch (GitHub's GH006, a ruleset's
    // GH013, GitLab's), a pre-receive or update hook. Not every
    // "[remote rejected]": "(funny refname)" or "(deny updating a hidden ref)"
    // is about a ref the app may have spelled, and reports.
    name: "the remote's own rules refused it",
    re: /\[remote rejected\][^\n]{0,256}\((?:pre-receive|update|protected branch) hook declined\)|\bGH006\b|\bGH013\b|\bProtected branch update failed\b|push declined due to repository rule violations|not allowed to push code to protected branches|\bdoes not have write permission\b/i,
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
    re: /\bremote: Repository not found\b|\bERROR: Repository not found\b|\brepository '[^'\n]{0,512}' not found\b|\bNo configured push destination\b|^(?![\s\S]*does not appear to be a git repository)[\s\S]*Could not read from remote repository|仓库[^\n]{0,256}未找到/i,
  },
  {
    // curl's words for the host or the proxy it could not find or reach, ssh's,
    // and git's own for a git:// address ("unable to look up <host> (port
    // 9418)"). The app builds no address of any of these kinds: a URL is the
    // user's — typed into Clone, or in their remote's config.
    name: "the network",
    re: /Could not resolve (?:host|proxy)|Could not resolve hostname|\bunable to look up [^\n(]{0,256} \(port \d+\)|from proxy after CONNECT|Proxy CONNECT aborted|Failed to connect to|Connection (?:timed out|refused|reset|closed)|Operation timed out|Operation too slow|Network is unreachable|No route to host|\bRPC failed\b|schannel: failed to receive handshake|\bSSL[_ ](?:ERROR|connect error)|SSL certificate problem|gnutls_handshake\(\) failed|Bad packet length|The remote end hung up unexpectedly|early EOF|unexpected disconnect while reading sideband packet|无法解析主机|连接超时/i,
  },
  {
    // A local pre-push hook that said no: git ends with "failed to push some
    // refs" and names no ref it refused, no refspec and no remote reason —
    // the hook's own output is all there is above it. Not when git refused
    // the refspec the app BUILT ("dst refspec main matches more than one",
    // "is not a full refname", "unqualified destination"): that is ours, the
    // ambiguous-short-ref class that has bitten before, and must report.
    name: "a pre-push hook refused it",
    re: /^(?![\s\S]*(?:\[rejected\]|\[remote rejected\]|Updates were rejected|refspec|does not match any|unable to access|not a full refname|unqualified destination|matches more than one))[\s\S]*error: failed to push some refs to\b/,
  },

  // ── The user's own setup ────────────────────────────────────────────────
  {
    name: "who the commit is by is not set",
    re: /Please tell me who you are|Author identity unknown|Committer identity unknown|unable to auto-detect email address|作者身份未知|提交者身份未知/i,
  },
  {
    // A local hook that said no to a merge, or to a rebase: the user's hook.
    name: "a local hook refused it",
    re: /\bNot committing merge; use 'git commit' to complete the merge\b|\bThe pre-rebase hook refused to rebase\b/,
  },
  {
    // git-lfs could not download a file: its server, the network, a
    // certificate ("x509: certificate signed by unknown authority"), a
    // quota. The repository's LFS store, not anything the app asked for.
    name: "Git LFS could not fetch a file",
    re: /\bError downloading object\b|\bsmudge filter lfs failed\b|\bx509: certificate\b/i,
  },
  {
    name: "Git LFS is not installed",
    re: /configured for Git LFS but '[^'\n]{0,512}' was not found on your path|git-lfs[^\n]{0,256}: command not found/i,
  },
  {
    // Another git — very often the editor's own — holds the index.
    name: "another git process holds the lock",
    re: /Unable to create '[^'\n]{0,512}\.lock': File exists/i,
  },

  // ── The repository is in a state git will not act in ───────────────────
  {
    name: "it stopped on a conflict",
    re: /^CONFLICT \(|\bMerge conflict in\b|\bcould not apply [0-9a-f]{7,}|Resolve all conflicts manually|after resolving the conflicts|you need to resolve your current index first|冲突（内容）|合并冲突于/m,
  },
  {
    // Plus the sequencer's own form, for a cherry-pick or revert refused over a
    // STAGED change (the index must match HEAD): "error: your local changes
    // would be overwritten by cherry-pick. hint: commit your changes or stash
    // them to proceed."
    name: "uncommitted changes are in the way",
    re: /Your local changes to the following files would be overwritten|\byour local changes would be overwritten by (?:cherry-pick|revert|rebase)\b|\bcommit your changes or stash them to proceed\b|Please commit your changes or stash them|cannot (?:rebase|pull with rebase): You have unstaged changes|untracked working tree files would be (?:overwritten|removed)|您对下列文件的本地修改将被(?:合并|检出)操作覆盖/,
  },
  {
    name: "that name is taken",
    re: /\ba branch named '[^'\n]{0,512}' already exists|\btag '[^'\n]{0,512}' already exists|已经存在/,
  },
  {
    name: "the branch is not merged",
    re: /\bis not fully merged\b|未完全合并/,
  },
  {
    // A pull or merge of a branch that shares no commit with this one — most
    // often a repository made locally, then pointed at a remote that was
    // created with its own first commit.
    name: "the histories are unrelated",
    re: /\brefusing to merge unrelated histories\b/,
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

/** An operation whose git failures are judged with classes of its own. */
export type GitOutcomeOp = "clone";

/**
 * Words that are the user's situation for ONE operation only, because what the
 * app hands git there is what the user typed.
 */
const FOR_OP: Readonly<Record<GitOutcomeOp, ReadonlyArray<{ name: string; re: RegExp }>>> = {
  clone: [
    {
      // The address in the clone sheet is the user's (or GitHub's own clone
      // URL, when picked from the list). A path that is no repository, or
      // ssh's server saying so ("fatal: 'acme/widgets.git' does not appear to
      // be a git repository"); clone's own word for a local path that is not
      // there ("repository '…' does not exist"); and a git:// address with no
      // repository in it ("no path specified").
      name: "the address is not a repository",
      re: /does not appear to be a git repository|\brepository '[^'\n]{0,512}' does not exist\b|\bno path specified; see 'git help pull' for valid url syntax/,
    },
  ],
};

/**
 * The kind of user situation `message` describes (see OUTCOMES), or undefined
 * when it may be the app's own doing and should be reported. `op` adds the
 * classes that are the user's only for that operation (FOR_OP).
 */
export function userStateOutcome(message: string, op?: GitOutcomeOp): string | undefined {
  // The classifier reads git's whole output, unclipped (the reporters clip
  // only what they send): every pattern above is bounded, and so is the text.
  const text = message.length > MAX_CLASSIFIED ? message.slice(0, MAX_CLASSIFIED) : message;
  const general = OUTCOMES.find((c) => c.re.test(text))?.name;
  if (general || !op) return general;
  return FOR_OP[op].find((c) => c.re.test(text))?.name;
}

/** How much of a message is classified: git says what failed early. */
const MAX_CLASSIFIED = 64_000;

/** The names of every class, for tests and documentation. */
export const USER_STATE_OUTCOMES: readonly string[] = [
  ...OUTCOMES.map((c) => c.name),
  ...Object.values(FOR_OP).flatMap((list) => list.map((c) => c.name)),
];
