import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as os from "node:os";
import { clipForScrub, MAX_SCRUB_INPUT, randomId, safeShort, scrub, scrubExtra, scrubGitMessage, redactCredentials } from "../src/scrub";

// The scrubber is the last line of defense before an anonymous crash report
// leaves a user's machine, so every identifying shape it must catch is pinned
// here. Pure + `vscode`-free, so it runs under plain tsx.

// Match scrub's own home source (env, with os.homedir as a fallback) so the two
// can never diverge and make this test flaky.
const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();

test("home paths: user, project, and file names are all redacted (line:col kept)", () => {
  // The privacy promise is "never file names" — the path TAIL must go too, not
  // just the home prefix. A trailing :line:col is preserved for debuggability.
  assert.equal(scrub(`${HOME}/dev/secret-project/index.ts`), "~/<path>");
  assert.equal(scrub(`at run (${HOME}/.vscode/extensions/gitstudio/dist/extension.js:42:9)`),
    "at run (~/<path>:42:9)");
  assert.equal(scrub("~"), "~"); // a bare ~ is not a path
});

test("absolute paths on any OS are redacted, tail included", () => {
  // Usernames chosen so they can never equal the test runner's home dir.
  assert.equal(scrub("/Users/notarealuser/proj/y.ts"), "/Users/<user>/<path>");
  assert.equal(scrub("/home/notarealuser/proj/y.ts"), "/home/<user>/<path>");
  assert.equal(scrub("C:\\Users\\Bob\\proj\\file.txt"), "<path>");
  assert.equal(scrub("D:\\work\\secret-project\\main.rs:10:2"), "<path>:10:2");
  assert.equal(scrub("\\\\fileserver\\share\\repo\\x"), "<path>");
  // No project/file name survives in any of the above.
  for (const leak of ["secret-project", "fileserver", "main.rs", "y.ts"]) {
    const probed = scrub("D:\\work\\secret-project\\main.rs and /Users/u/y.ts and \\\\fileserver\\s");
    assert.ok(!probed.includes(leak), `leaked: ${leak}`);
  }
});

test("emails are redacted", () => {
  assert.equal(scrub("committer john.doe+work@example.co.uk failed"), "committer <email> failed");
});

test("https remote: credentials AND org/repo are stripped, a public host kept", () => {
  const out = scrub(
    "fatal: unable to access https://alice:ghp_abcDEF123456@github.com/acme-corp/private-repo.git/",
  );
  assert.equal(out, "fatal: unable to access https://github.com/<path>");
  for (const leak of ["alice", "ghp_abcDEF123456", "acme-corp", "private-repo"]) {
    assert.ok(!out.includes(leak), `leaked: ${leak}`);
  }
});

test("scp-style git remote: org/repo path is stripped", () => {
  const out = scrub("git@github.com:acme-corp/private-repo.git");
  assert.ok(!out.includes("acme-corp"), "leaked org");
  assert.ok(!out.includes("private-repo"), "leaked repo");
  assert.ok(out.includes("<path>"), "path not redacted");
});

test("full commit SHAs shorten to 7 (not tokenized)", () => {
  const sha = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"; // 40 hex
  assert.equal(scrub(`commit ${sha} landed`), "commit a1b2c3d landed");
});

test("access tokens, cloud keys, JWTs, and long secrets are redacted", () => {
  assert.equal(scrub(`export GH=ghp_${"A".repeat(36)}`), "export GH=<token>");
  assert.equal(scrub(`key=${"z".repeat(48)}`), "key=<token>");
  assert.equal(scrub("id AKIAIOSFODNN7EXAMPLE here"), "id <token> here");
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  assert.equal(scrub(`Authorization: Bearer ${jwt}`), "Authorization: Bearer <jwt>");
});

test("IPv4 addresses are redacted", () => {
  assert.equal(scrub("connect ECONNREFUSED 192.168.1.42:22"), "connect ECONNREFUSED <ip>:22");
});

test("private key blocks are removed whole", () => {
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
  assert.equal(scrub(`loaded ${key} ok`), "loaded <private-key> ok");
});

test("benign diagnostic text is left untouched", () => {
  const msg = "rebase failed: could not apply 2 commits (conflict in file)";
  assert.equal(scrub(msg), msg);
  assert.equal(scrub(""), "");
});

test("safeShort strips newlines and truncates", () => {
  assert.equal(safeShort("line one\nline two\r\nthree", 100), "line one line two three");
  assert.equal(safeShort("abcdefghij", 3), "abc");
});

test("scrubExtra scrubs values and bounds keys", () => {
  const out = scrubExtra({ cwd: `${HOME}/repo`, note: "hi", user: "a@b.com" });
  assert.equal(out.cwd, "~/<path>");
  assert.equal(out.note, "hi");
  assert.equal(out.user, "<email>");
  assert.deepEqual(scrubExtra(undefined), {});
});

test("randomId is 32 hex chars and non-repeating", () => {
  const a = randomId();
  const b = randomId();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

// PRIVACY.md promises crash reports "**Never**" carry file names, commit
// messages or branch names. Git stderr names all three, and plain scrub() does
// not touch them because they are repo-RELATIVE.
test("scrubGitMessage redacts file lists from git stderr", () => {
  const msg =
    "error: Your local changes to the following files would be overwritten by merge:" +
    "\n\tsrc/billing/secret-project.ts\n\tdocs/roadmap.md";
  const out = scrubGitMessage(msg);
  assert.ok(!out.includes("secret-project"), out);
  assert.ok(!out.includes("roadmap"), out);
  // The diagnostic sentence survives — that is the whole point of reporting it.
  assert.match(out, /would be overwritten by merge/);
});

test("scrubGitMessage redacts quoted refs but keeps the sentence", () => {
  const out = scrubGitMessage("fatal: couldn't find remote ref 'feature/acme-migration'");
  assert.ok(!out.includes("acme"), out);
  assert.match(out, /couldn't find remote ref/); // apostrophe must not open a span
});

test("scrubGitMessage redacts a conflicted path", () => {
  const out = scrubGitMessage("CONFLICT (content): Merge conflict in apps/web/checkout.tsx");
  assert.ok(!out.includes("checkout.tsx"), out);
  assert.match(out, /Merge conflict in/);
});

test("scrubGitMessage takes out the commit subject git prints when an operation stops", () => {
  for (const [input, expected] of [
    ["error: could not apply 1a2b3c4... Add billing for Acme Corp\nhint: Resolve all conflicts manually", "error: could not apply 1a2b3c4... <subject>\nhint: Resolve all conflicts manually"],
    ["Could not apply 9f8e7d6c5b... Rename the secret project", "Could not apply 9f8e7d6c5b... <subject>"],
    ["error: could not revert 1a2b3c4... Revert \"Launch Acme pricing\"", "error: could not revert 1a2b3c4... <subject>"],
    // (The quoted hint goes too — every quoted span does, by the rule below.)
    // git's own suggested command stays (gitsOwnWords); one naming a branch does not
    ["Patch failed at 0003 Wire the Acme billing webhook\nhint: Use 'git am --show-current-patch=diff'", "Patch failed at 0003 <subject>\nhint: Use 'git am --show-current-patch=diff'"],
    ["hint: use 'git push --set-upstream origin acme-billing'", "hint: use '<ref>'"],
    ["hint: use \"git restore --staged <file>\"", "hint: use \"<ref>\""],
    // git am names every patch it applies, the one that failed included.
    [
      "Applying: Wire the Acme billing webhook\nerror: patch failed: src/billing.ts:12\nPatch failed at 0001 Wire the Acme billing webhook",
      "Applying: <subject>\nerror: patch failed: <path>:12\nPatch failed at 0001 <subject>",
    ],
    // An edit or break stop names the commit the same way.
    ["Stopped at 1a2b3c4...  Add billing for Acme Corp", "Stopped at 1a2b3c4... <subject>"],
  ] as const) {
    const out = scrubGitMessage(input);
    assert.equal(out, expected, JSON.stringify(input));
    assert.doesNotMatch(out, /Acme|billing|secret/i);
  }
});

test("scrubGitMessage takes out the branch names git prints without quotes", () => {
  for (const [input, expected] of [
    ["fatal: couldn't find remote ref acme-billing", "fatal: couldn't find remote ref <ref>"],
    ["error: src refspec acme-billing does not match any", "error: src refspec <ref> does not match any"],
    [
      "fatal: The current branch acme-billing has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push --set-upstream origin acme-billing\n",
      "fatal: The current branch <ref> has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n\t<path>",
    ],
    ["fatal: invalid reference: acme-billing", "fatal: invalid reference: <ref>"],
    ["On branch acme-billing\nnothing to commit, working tree clean", "On branch <ref>\nnothing to commit, working tree clean"],
  ] as const) {
    const out = scrubGitMessage(input);
    assert.equal(out, expected, JSON.stringify(input));
    assert.doesNotMatch(out, /acme|billing/i);
  }
  // The sentence around a name is kept: it is what says which failure this is.
  assert.equal(scrubGitMessage("hint: Updates were rejected because the tip of your current branch is behind"), "hint: Updates were rejected because the tip of your current branch is behind");
});

test("scrubGitMessage is empty-safe", () => {
  assert.equal(scrubGitMessage(""), "");
});

// ── paths that contain spaces, and the Windows tail ──────────────────────────
//
// The contract above the function says it removes absolute paths "INCLUDING the
// file/project names in the tail". It did not, in the two places real users
// actually live: Windows, and any path with a space in it.

test("a Windows crash stack from the user's own machine keeps nothing but the line", () => {
  // safeHome() collapses the home directory to `~` first, and on Windows what
  // follows it is a BACKSLASH. The tail rule only accepted a forward slash, so
  // every Windows report shipped the project and file names intact.
  const home = process.env.USERPROFILE;
  process.env.USERPROFILE = "C:\\Users\\John Smith";
  const prevHome = process.env.HOME;
  delete process.env.HOME;
  try {
    const out = scrub(
      "at load (C:\\Users\\John Smith\\Projects\\acme-secret\\src\\billing.ts:42:11)",
    );
    assert.equal(out.includes("acme-secret"), false, "the project name must not survive");
    assert.equal(out.includes("billing"), false, "nor the file name");
    assert.equal(out.includes("John"), false, "nor the user");
    assert.match(out, /:42:11/, "but the line and column stay, so the crash is locatable");
  } finally {
    if (home === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = home;
    if (prevHome !== undefined) process.env.HOME = prevHome;
  }
});

test("a space in a path does not end the redaction", () => {
  for (const input of [
    "at x (C:\\Users\\John Smith\\projects\\acme-secret\\index.ts:12:5)",
    "/Users/John Smith/Work/AcmeCorp/secret.ts",
    "\\\\CORP-FS01\\Team Share\\acme\\plan.docx",
  ]) {
    const out = scrub(input);
    for (const secret of ["Smith", "acme", "Acme", "AcmeCorp", "secret", "plan"]) {
      assert.equal(
        out.includes(secret),
        false,
        `"${secret}" survived scrubbing of ${JSON.stringify(input)} -> ${JSON.stringify(out)}`,
      );
    }
  }
});

test("but a sentence after a path keeps its words", () => {
  // The space rule must only swallow a trailing run that is actually a path —
  // otherwise diagnostics turn into "<user>/<path>" and say nothing.
  const out = scrub("/Users/bob is not a repository");
  assert.match(out, /is not a repository/);
});

test("an env-var-rooted Windows path redacts everything after the variable", () => {
  const out = scrub("%USERPROFILE%\\Documents\\AcmeSecret");
  assert.equal(out.includes("AcmeSecret"), false);
  assert.match(out, /%USERPROFILE%/, "the variable name itself identifies nobody");
});

// ── IPv6 ─────────────────────────────────────────────────────────────────────

test("IPv6 addresses are redacted, in both forms", () => {
  assert.match(scrub("connect to 2001:0db8:85a3:0000:0000:8a2e:0370:7334 failed"), /<ip>/);
  assert.match(scrub("bound ::1"), /<ip>/);
  assert.match(scrub("host fe80::1 unreachable"), /<ip>/);
});

test("IPv6 redaction does not eat timestamps or line:col", () => {
  // The loose "colon-separated hex groups" reading of IPv6 destroys both, and
  // line:col is the one thing a crash report has to keep.
  assert.match(scrub("at 01:23:45 the build failed"), /01:23:45/);
  assert.match(scrub("~/x/y.ts:42:5"), /:42:5/);
  assert.match(scrub("took 1:30:00"), /1:30:00/);
});

// ── redactCredentials: the git-command log ───────────────────────────────────
//
// A different job from scrub(). That log is shown to the user, so it has to
// stay readable; only the secret comes out.

test("a password in a remote URL is redacted, the rest of the command survives", () => {
  const out = redactCredentials(
    "git remote add origin https://oauth2:ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/Acme/repo.git",
  );
  assert.equal(out.includes("ghp_"), false, "the token must not survive");
  assert.match(out, /oauth2:\*\*\*@github\.com/, "but WHICH user, and which host, still read");
  assert.match(out, /Acme\/repo\.git/, "and the repo, or the log says nothing useful");
  assert.match(out, /^git remote add origin/, "and the command itself");
});

test("userinfo with no colon is treated as the secret", () => {
  const out = redactCredentials("fetch https://ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB@github.com/x/y");
  assert.equal(out.includes("ghp_"), false);
  assert.match(out, /https:\/\/\*\*\*@github\.com\/x\/y/);
});

test("a bare token anywhere is redacted", () => {
  for (const t of [
    "ghp_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    "gho_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
    "github_pat_EEEEEEEEEEEEEEEEEEEEEE",
  ]) {
    const out = redactCredentials(`remote: bad credentials for ${t}`);
    assert.equal(out.includes(t), false, `${t} survived`);
    assert.match(out, /<token>/);
  }
});

test("an API that NAMES a repository does not carry it off the machine", () => {
  // Crash reports #14 and #17 were GitHub GraphQL answers, and both titles in
  // the maintainer tracker read "Could not resolve to a Repository with the
  // name '<a private org>/<its repo>'." Every rule in scrub() redacted org and
  // repo inside a URL — the spelling PRIVACY.md had in mind — and none of them
  // touched the API simply saying the name out loud.
  const out = scrub("Could not resolve to a Repository with the name 'acme-private/billing-pipeline'.");
  assert.equal(out.includes("acme-private"), false, "the organization must not survive");
  assert.equal(out.includes("billing-pipeline"), false, "nor the repository");
  assert.match(out, /^Could not resolve to a Repository with the name '<path>'\.$/, out);
});

test("quoted identifiers with a slash go, quoted words stay", () => {
  for (const [input, expected] of [
    [`fatal: couldn't find remote ref 'feature/acme-migration'`, `fatal: couldn't find remote ref '<ref>'`],
    [`pathspec "src/billing/secret.ts" did not match`, `pathspec "<ref>" did not match`],
    // A quoted word with no slash is diagnosis, not identity — and the
    // apostrophe in "doesn't" must not open a span that eats the sentence.
    [`Field 'nope' doesn't exist on type 'Repository'`, `Field 'nope' doesn't exist on type 'Repository'`],
  ] as const) {
    const out = scrub(input);
    const want = expected.replace(/<ref>/g, "<path>");
    assert.equal(out, want, `scrub(${JSON.stringify(input)})`);
  }
});

test("an ordinary command is left completely alone", () => {
  for (const cmd of [
    "git status --porcelain=v1 -z",
    "git log --format=%H -n 50 main",
    "git remote add origin https://github.com/Acme/repo.git",
    "git push origin feature/x",
    "git clone git@github.com:Acme/repo.git",
  ]) {
    assert.equal(redactCredentials(cmd), cmd, `${cmd} was altered`);
  }
});

// ── host names ───────────────────────────────────────────────────────────────
//
// Report #105 carried a company's internal proxy name into the tracker: "Could
// not resolve proxy: proxy.<office>.<company>.corp". A server's name says who
// the user works for, so only a PUBLIC service's leaves the machine. (Every
// name below is invented.)

test("a server or proxy name that could name an employer becomes <host>", () => {
  for (const [input, expected] of [
    // #105's shape, through the git path
    [
      "fatal: unable to access 'https://git.acme.example/widgets.git/': Could not resolve proxy: proxy.emea.acme.corp",
      "fatal: unable to access '<ref>': Could not resolve proxy: <host>",
    ],
    // git:// (#95, #96): a user@host is an email already; an address with a
    // name after the colon keeps neither
    [
      "fatal: unable to look up someone@git.acme.example (port 9418) (Name or service not known)",
      "fatal: unable to look up <email> (port 9418) (Name or service not known)",
    ],
    [
      "fatal: unable to look up 192.0.2.7:Widgets (port 9418) (Name or service not known)",
      "fatal: unable to look up <ip>:<path> (port 9418) (Name or service not known)",
    ],
    // ssh and curl, wherever they name the host
    [
      "ssh: connect to host git.acme.example port 22: Connection timed out",
      "ssh: connect to host <host> port 22: Connection timed out",
    ],
    [
      "ssh: Could not resolve hostname gitserver: nodename nor servname provided, or not known",
      "ssh: Could not resolve hostname <host>: nodename nor servname provided, or not known",
    ],
    [
      "fatal: unable to access '<ref>': Failed to connect to proxy.acme.example port 8080 after 21 ms: Couldn't connect to server",
      "fatal: unable to access '<ref>': Failed to connect to <host> port 8080 after 21 ms: Couldn't connect to server",
    ],
    ["Connection closed by git.acme.example port 22", "Connection closed by <host> port 22"],
  ] as const) {
    const out = scrubGitMessage(input);
    assert.equal(out, expected, JSON.stringify(input));
    assert.doesNotMatch(out, /acme|emea|gitserver|Widgets/i);
  }
  for (const [input, expected] of [
    // a URL's authority, in any network scheme — and ssh's user goes with it
    ["fatal: unable to access https://git.acme.example/widgets.git/", "fatal: unable to access https://<host>/<path>"],
    ["ssh://deploy@git.acme.example:2222/acme/widgets.git", "ssh://<host>:2222/<path>"],
    ["git://git.acme.example/widgets.git", "git://<host>/<path>"],
    // a single label, where an error names a host
    ["Could not resolve host: gitserver", "Could not resolve host: <host>"],
    ["getaddrinfo ENOTFOUND github.acme.example", "getaddrinfo ENOTFOUND <host>"],
    // anything else shaped like a host under a common or private TLD
    ["pushing to git.acme.example failed", "pushing to <host> failed"],
    ["acme.corp refused the connection", "<host> refused the connection"],
    // a subdomain of a public service is usually the organisation itself
    ["https://acme.visualstudio.com/widgets/_git/widgets", "https://<host>/<path>"],
    ["https://acme.ghe.com/acme/widgets", "https://<host>/<path>"],
  ] as const) {
    assert.equal(scrub(input), expected, JSON.stringify(input));
  }
});

test("a public service's name stays, so a report still says which forge refused", () => {
  for (const msg of [
    "Could not resolve host: github.com",
    "Failed to connect to gitlab.com port 443 after 21 ms: Couldn't connect to server",
    "ssh: connect to host ssh.dev.azure.com port 22: Connection refused",
    "fatal: unable to access https://gitee.com/<path>",
  ]) {
    assert.equal(scrub(msg), msg);
  }
  assert.equal(scrub("https://bitbucket.org/acme/widgets.git"), "https://bitbucket.org/<path>");
});

test("JavaScript names and stack frames are not host names", () => {
  // Dotted like a host, but a host's last label is a TLD; and a frame's
  // function names are left alone whatever they end in.
  for (const msg of [
    "TypeError: this.ctx.process.run is not a function",
    "TypeError: e.repo.root is not a function\n    at s.init (~/<path>:1:2)\n    at e.exports.com (~/<path>:3:4)",
    "Cannot find module 'vue.config.js'",
    "git version 2.45.1.windows.1",
  ]) {
    assert.equal(scrub(msg), msg);
  }
});

test("two users behind two proxies file the same report", () => {
  // The collector groups by the scrubbed first line: the host must not split it.
  const a = scrubGitMessage("fatal: unable to access 'https://git.acme.example/a.git/': Could not resolve proxy: proxy.acme.corp");
  const b = scrubGitMessage("fatal: unable to access 'https://code.widgets.example/b.git/': Could not resolve proxy: gw.widgets.internal");
  assert.equal(a, b);
  for (const once of [a, scrub("ssh://deploy@git.acme.example:2222/x"), scrub("Could not resolve host: gitserver")]) {
    assert.equal(scrub(once), once, "a fixed point");
    assert.equal(scrubGitMessage(once), once, "a fixed point");
  }
});

// ── push and fetch status lines ──────────────────────────────────────────────
//
// Report #104 arrived as "To https://github.com/<path> error: failed to push
// some refs to '<ref>'": the line that said WHY was indented, so the file-list
// rule ate it and the <path> collapse folded it into the URL.

test("a refused push keeps the line that says why, without the names", () => {
  for (const [input, expected] of [
    [
      "To https://github.com/acme/widget.git\n ! [rejected]        main -> main (stale info)\nerror: failed to push some refs to 'https://github.com/acme/widget.git'",
      "! [rejected] <ref> -> <ref> (stale info)\nerror: failed to push some refs to '<ref>'",
    ],
    [
      "To git.acme.example:acme/widget.git\n ! [remote rejected] feature/acme-billing -> feature/acme-billing (shallow update not allowed)\nerror: failed to push some refs to 'git.acme.example:acme/widget.git'",
      "! [remote rejected] <ref> -> <ref> (shallow update not allowed)\nerror: failed to push some refs to '<ref>'",
    ],
    // a server's own words may name the branch: they go
    [
      " ! [remote rejected] acme-billing -> acme-billing (Not allowed to push to protected branch acme-billing)",
      "! [remote rejected] <ref> -> <ref> (<reason>)",
    ],
    [" ! [remote rejected] acme-billing (deletion of the current branch prohibited)", "! [remote rejected] <ref> (deletion of the current branch prohibited)"],
  ] as const) {
    const out = scrubGitMessage(input);
    assert.equal(out, expected, JSON.stringify(input));
    assert.doesNotMatch(out, /acme|billing|widget/);
    assert.equal(scrubGitMessage(out), out, "a fixed point");
  }
});

test("what went right, and the remote's banner, leave the failure as the first line", () => {
  // #107's shape: the fetch line and "From <remote>" said nothing about it.
  assert.equal(
    scrubGitMessage("From gitee.com:acme/widget\n * branch            main       -> FETCH_HEAD\nfatal: refusing to merge unrelated histories"),
    "fatal: refusing to merge unrelated histories",
  );
  assert.equal(
    scrubGitMessage(
      "To https://github.com/acme/widget.git\n   1a2b3c4..5d6e7f8  main -> main\n = [up to date]      v1 -> v1\n ! [rejected]        v2 -> v2 (already exists)",
    ),
    "! [rejected] <ref> -> <ref> (already exists)",
  );
  // "To push …" is a sentence, not a banner.
  assert.match(scrubGitMessage("To push the current branch and set the remote as upstream, use"), /^To push the current branch/);
});

// ── the review's probes (Nov 2026) ───────────────────────────────────────────
//
// A reviewer's corpus against the host rules above. Every name is invented.

const HOSTS_ANY_SPELLING: Array<[string, string]> = [
  // 1. a host with an underscore or a non-ASCII letter is redacted WHOLE
  ["Could not resolve host: git_server.acme.corp", "Could not resolve host: <host>"],
  ["Error: getaddrinfo ENOTFOUND llm_gateway.acme.ai", "Error: getaddrinfo ENOTFOUND <host>"],
  ["Could not resolve host: bücher.acme.ai", "Could not resolve host: <host>"],
  ["ssh: connect to host git_server port 22: Connection refused", "ssh: connect to host <host> port 22: Connection refused"],
  ["push to bücher.acme.com failed", "push to <host> failed"],
  // 2. mixed case is a host under a country's, a common or a private TLD
  ["push to Git.AcmeCorp.com failed", "push to <host> failed"],
  ["FS01.AcmeCorp.local is offline", "<host> is offline"],
  ["GitLab.acme.com refused", "<host> refused"],
  // 3. ssh's, OpenSSL's, GCM's, schannel's and curl's other wordings
  ["Unable to negotiate with gitbox port 22: no matching host key type found.", "Unable to negotiate with <host> port 22: no matching host key type found."],
  ["No ED25519 host key is known for gitbox.acme.ai and you have requested strict checking.", "No ED25519 host key is known for <host> and you have requested strict checking."],
  ["Received disconnect from gitbox port 22:2: Too many authentication failures", "Received disconnect from <host> port 22:2: Too many authentication failures"],
  ["Disconnected from user bob gitbox port 22", "Disconnected from user <user> <host> port 22"],
  ["Timeout, server gitbox not responding.", "Timeout, server <host> not responding."],
  ["Warning: Permanently added '[gitbox.acme.ai]:2222' (ED25519) to the list of known hosts.", "Warning: Permanently added '[<host>]:2222' (ED25519) to the list of known hosts."],
  ["Host key for [gitbox]:2222 has changed and you have requested strict checking.", "Host key for [<host>]:2222 has changed and you have requested strict checking."],
  ["The authenticity of host '[gitbox]:2222 ([10.1.2.3]:2222)' can't be established.", "The authenticity of host '[<host>]:2222 ([<ip>]:2222)' can't be established."],
  ["fatal: unable to connect to gitbox:\ngitbox[0: 10.1.2.3]: errno=Connection refused", "fatal: unable to connect to <host>:\n<host>[0: <ip>]: errno=Connection refused"],
  ["OpenSSL SSL_read: SSL_ERROR_SYSCALL, errno 0 in connection to gitbox:443", "OpenSSL SSL_read: SSL_ERROR_SYSCALL, errno 0 in connection to <host>:443"],
  ["fatal: An error occurred while sending the request. No such host is known. (gitbox.acme.ai:443)", "fatal: An error occurred while sending the request. No such host is known. (<host>:443)"],
  ["schannel: CertGetNameString() failed to match connection hostname (gitbox) against server certificate names", "schannel: CertGetNameString() failed to match connection hostname (<host>) against server certificate names"],
  ["SSL: certificate subject name (gitbox.acme.ai) does not match target host name 'gitbox'", "SSL: certificate subject name (<host>) does not match target host name '<host>'"],
  ["fatal: 无法查找 gitbox（端口 9418）（未知的名称或服务）", "fatal: 无法查找 <host>（端口 9418）（未知的名称或服务）"],
  ["fatal: Konnte gitbox nicht nachschlagen (Port 9418) (Name or service not known)", "fatal: Konnte <host> nicht nachschlagen (Port 9418) (Name or service not known)"],
  ["Ollama at llm-box:11434 is unreachable", "Ollama at <host>:11434 is unreachable"],
  ["using proxy gitproxy:3128", "using proxy <host>:3128"],
  // …and the TLDs that are words or extensions, with two dots or a hyphen
  ...["ai", "me", "us", "in", "it", "pl", "at", "be", "no", "sh", "gg", "ly", "systems", "company", "office", "vpn"].map(
    (tld): [string, string] => [`push to git.acme.${tld} failed`, "push to <host> failed"],
  ),
  ["Could not connect: acme-nas.local", "Could not connect: <host>"],
  // 6. a remote with no user in front of it keeps neither its host nor its path
  ["To git.acme.example:team/widgets.git", "To <host>:<path>"],
  ["fatal: 'github-acme:acme-corp/widgets.git' does not appear to be a git repository", "fatal: '<host>:<path>' does not appear to be a git repository"],
  ["Error: git fetch failed: github-acme:acme-corp/widgets.git", "Error: git fetch failed: <host>:<path>"],
  ["bob@gitbox: Permission denied (publickey).", "<email>: Permission denied (publickey)."],
  ["bob@gitbox:team/repo.git", "<email>:<path>"],
  ["gitlab.acme.example/acme/widgets", "<host>/<path>"],
  ["github.com/acme/widgets", "github.com/<path>"],
  ["smb://fileserver.acme.example/share", "smb://<host>/<path>"],
  ["file://fileserver/share/repo.git", "file://<host>/<path>"],
];

test("review: a host is redacted whatever it is spelled with, and wherever an error names it", () => {
  for (const [input, expected] of HOSTS_ANY_SPELLING) {
    assert.equal(scrub(input), expected, JSON.stringify(input));
    assert.doesNotMatch(scrub(input), /acme|gitbox|git_server|llm|bücher|gitproxy|fileserver|bob\b/i, input);
  }
});

test("review: what only looks like a host is left alone", () => {
  for (const msg of [
    // 4. JavaScript names, and macOS app bundles
    "TypeError: logger.info is not a function",
    "TypeError: pattern.test is not a function",
    "TypeError: this.local is undefined",
    "TypeError: electron.app is undefined",
    "TypeError: process.env.HOME is undefined",
    "TypeError: e.int is not a function",
    // …and where only the place it stands says so: a member chain ending in
    // what is also a TLD, before "is undefined" or a call.
    "TypeError: config.env.dev is undefined",
    "TypeError: Cannot read properties of null (reading 'x') at client.api.io(1)",
    "Error: Cannot open Cursor.app",
    "Error: Unable to find Visual Studio Code.app",
    "Error: spawn /Applications/Cursor.app/Contents/Resources/app/bin/cursor ENOENT",
    "x.y.z(1)",
    // not remotes: a refspec, a scheme, a drive, a port
    "    at Module._compile (node:internal/modules/cjs/loader:1)",
    "listening on localhost:8080",
    "README.md and index.d.ts",
  ]) {
    assert.equal(scrub(msg), msg);
  }
});

test("review: forges' own words name no account, organization or file", () => {
  for (const [input, expected] of [
    // 9.
    ["remote: Permission to acme-org/widgets.git denied to bob-smith.", "remote: Permission to <path> denied to <user>."],
    ["ERROR: The `acme-org' organization has enabled or enforced SAML SSO.", "ERROR: The `<org>' organization has enabled or enforced SAML SSO."],
    [
      "remote: error: File acme-q3-report.zip is 120.00 MB; this exceeds GitHub's file size limit of 100.00 MB",
      "remote: error: File <file> is 120.00 MB; this exceeds GitHub's file size limit of 100.00 MB",
    ],
    ["fatal: not a git repository: D:/Work/AcmeCorp/widgets", "fatal: not a git repository: <path>"],
    ["fatal: '//fileserver/share/repo' does not appear to be a git repository", "fatal: '<path>' does not appear to be a git repository"],
    ["fatal: cannot chdir to /Volumes/AcmeShare/widgets", "fatal: cannot chdir to <path>"],
    ["fatal: cannot chdir to /mnt/d/acme/widgets", "fatal: cannot chdir to <path>"],
    ["fatal: cannot chdir to /srv/git/acme.git", "fatal: cannot chdir to <path>"],
    ["file:///Volumes/AcmeShare/repo.git", "file://<path>"],
    [
      "'<path>' is owned by:\n\tBUILTIN/Administrators (S-1-5-32-544)\nbut the current user is:\n\tACMECORP/bob.smith (S-1-5-21-1111-2222-3333-1001)",
      "'<path>' is owned by:\n\t<user> (S-1-5-32-544)\nbut the current user is:\n\t<user> (<sid>)",
    ],
  ] as const) {
    assert.equal(scrub(input), expected, JSON.stringify(input));
  }
});

test("review: a status line keeps git's words only", () => {
  // 8. a ref named with parentheses, a reason with its own, a hook's own summary
  assert.equal(
    scrubGitMessage(" ! [rejected]        feat(x) -> feat(x) (fetch first)"),
    "! [rejected] <ref> -> <ref> (fetch first)",
  );
  assert.equal(
    scrubGitMessage(" ! [remote rejected] main -> main (n/a (unpacker error))"),
    "! [remote rejected] <ref> -> <ref> (unpacker error)",
  );
  assert.equal(scrubGitMessage(" ! [ACME-123] main -> main (see the ticket)"), "! [<summary>] <ref> -> <ref> (<reason>)");
});

test("review: idempotence and the same report from every machine", () => {
  // scrub∘scrub = scrub, scrubGitMessage∘scrubGitMessage = scrubGitMessage,
  // and scrub∘scrubGitMessage = scrubGitMessage (the collector re-scrubs).
  for (const [input] of HOSTS_ANY_SPELLING) {
    const s1 = scrub(input);
    const g1 = scrubGitMessage(input);
    assert.equal(scrub(s1), s1, `scrub of ${JSON.stringify(input)}`);
    assert.equal(scrubGitMessage(g1), g1, `scrubGitMessage of ${JSON.stringify(input)}`);
    assert.equal(scrub(g1), g1, `scrub after scrubGitMessage of ${JSON.stringify(input)}`);
  }
  // Text a rule turns into a tag is never read as an address afterwards.
  for (const s of ["https://<host>::8080", "/Users/<user>::1", "unable to look up <host>:// (fetch first)/Users/<user>"]) {
    assert.equal(scrub(s), s);
  }
  assert.equal(
    scrubGitMessage("Could not resolve host: git_server.acme.corp"),
    scrubGitMessage("Could not resolve host: gw.widgets.internal"),
  );
});

test("review: a huge message is clipped, and the worst shapes scrub in linear time", () => {
  const rep = (s: string, n: number): string => s.repeat(Math.ceil(n / s.length)).slice(0, n);
  // Each was quadratic in one of the rules (seconds at 64k).
  const worst = ["a.", "a-", "ab.", "a1-b2.", "a:a/", "a@a", " '" + "a/", "(", "x.y.com ", "a_b.", "ü."].map((u) => rep(u, 64_000));
  worst.push(" ! [rejected] main -> main " + rep("(", 64_000));
  const t0 = performance.now();
  for (const s of worst) {
    assert.ok(scrub(s).length <= MAX_SCRUB_INPUT + 64);
    scrubGitMessage(s);
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 2_000, `the worst shapes took ${ms.toFixed(0)} ms`);
  // The clip cuts at a space when there is one, never through a token.
  assert.equal(clipForScrub("aaaa bbbb cccc", 12), "aaaa bbbb");
  assert.equal(clipForScrub("short", 12), "short");
});

// ── the resweep (Nov 2026) ───────────────────────────────────────────────────
//
// A second review's probes. Every name is invented.

test("resweep: what the previous round broke stays fixed", () => {
  for (const [input, expected] of [
    // 1(a) an IPv6 literal with its port
    ["Error: connect ECONNREFUSED ::1:11434", "Error: connect ECONNREFUSED <ip>:11434"],
    ["Error: connect ECONNREFUSED fd00::1:8443", "Error: connect ECONNREFUSED <ip>:8443"],
    ["SSL_ERROR_SYSCALL in connection to ::1:11434", "SSL_ERROR_SYSCALL in connection to <ip>:11434"],
    // 1(b) nothing after the code
    ["Error: connect ECONNREFUSED", "Error: connect ECONNREFUSED"],
    ["Error: getaddrinfo ENOTFOUND", "Error: getaddrinfo ENOTFOUND"],
    ["Error: getaddrinfo EAI_AGAIN", "Error: getaddrinfo EAI_AGAIN"],
    // 1(c) a VS Code webview frame keeps its line and column
    ["    at e (vscode-file://vscode-app/x/workbench.desktop.main.js:1:2)", "    at e (vscode-file://vscode-app/x/workbench.desktop.main.js:1:2)"],
    // 1(f) file names and bundle ids with word-like extensions, the apps' own hosts
    ["release-notes.md run-checks.sh libssl-3.so pre-commit.py Android-Studio.app", "release-notes.md run-checks.sh libssl-3.so pre-commit.py Android-Studio.app"],
    ["bundle id com.jetbrains.intellij.ce not found", "bundle id com.jetbrains.intellij.ce not found"],
    ...[
      "release-assets.githubusercontent.com", "objects-origin.githubusercontent.com", "avatars.githubusercontent.com",
      "www.gravatar.com", "gh.io", "support.github.com", "ollama.com",
    ].map((h): [string, string] => [`Error: getaddrinfo ENOTFOUND ${h}`, `Error: getaddrinfo ENOTFOUND ${h}`]),
  ] as const) {
    assert.equal(scrub(input), expected, JSON.stringify(input));
  }
});

test("resweep: scrub() knows full refs and git's made-up address", () => {
  // 2. (The thrown-git-failure half of this case moved to reportShape.test.ts.)
  // …and scrub() itself now knows full refs and git's made-up address.
  assert.equal(scrub("error: refs/heads/acme-billing does not point to a valid object"), "error: <ref> does not point to a valid object");
  assert.equal(scrub("fatal: unable to auto-detect email address (got 'bob@HAL9000.(none)')"), "fatal: unable to auto-detect email address (got '<email>')");
  assert.equal(scrub("Committer: Bob <bob@HAL9000>"), "Committer: Bob <<email>>");
});

test("resweep: conflict and patch lines name no file or branch, and keep the conflict's kind", () => {
  // 3.
  for (const [input, expected] of [
    ["CONFLICT (content): Merge conflict in acme-pricing.sql", "CONFLICT (content): Merge conflict in <path>"],
    ["CONFLICT (content): Merge conflict in AcmeBilling", "CONFLICT (content): Merge conflict in <path>"],
    [
      "CONFLICT (modify/delete): acme-billing deleted in HEAD and modified in topic. Version topic of acme-billing left in tree.",
      "CONFLICT (modify/delete): <path>",
    ],
    ["CONFLICT (rename/delete): Billing.csproj renamed to Acme.csproj in HEAD, but deleted in topic.", "CONFLICT (rename/delete): <path>"],
    ["Auto-merging acme-pricing.sql", "Auto-merging <path>"],
    ["error: unable to create file acme-pricing.sql: Permission denied", "error: unable to create file <path>: Permission denied"],
    ["error: patch failed: acme-pricing.sql:12\nerror: acme-pricing.sql: patch does not apply", "error: patch failed: <path>:12\nerror: <path>: patch does not apply"],
    ["error: acme-pricing.sql: does not exist in index", "error: <path>: does not exist in index"],
  ] as const) {
    const out = scrubGitMessage(input);
    assert.equal(out, expected, JSON.stringify(input));
    assert.equal(scrubGitMessage(out), out, "a fixed point");
  }
});

test("resweep: an AI endpoint the user configured is never named", () => {
  // 4. packages/ai's openaiCompat wordings, and the adjacent-lead-word shapes.
  for (const [input, expected] of [
    ["Couldn't reach llmbox:11434 (ECONNREFUSED) — is the endpoint reachable?", "Couldn't reach <host>:11434 (ECONNREFUSED) — is the endpoint reachable?"],
    ["Couldn't reach llmbox (ENOTFOUND) — is the endpoint reachable?", "Couldn't reach <host> (ENOTFOUND) — is the endpoint reachable?"],
    ["Couldn't reach GitHub (ENOTFOUND) — check your network.", "Couldn't reach GitHub (ENOTFOUND) — check your network."],
    ["llmbox:1234 returned 404 — check the base URL and model id.", "<host>:1234 returned 404 — check the base URL and model id."],
    ["llmbox:1234 rejected the API key (HTTP 401).", "<host>:1234 rejected the API key (HTTP 401)."],
    ["llmbox request failed (HTTP 500).", "<host> request failed (HTTP 500)."],
    ["acme.ai request failed (HTTP 502).", "<host> request failed (HTTP 502)."],
    ["Stream from llmbox:1234 failed.", "Stream from <host>:1234 failed."],
    ["Stream from acme.ai failed.", "Stream from <host> failed."],
    ["an error (llmbox:11434)", "an error (<host>:11434)"],
    ["Could not reach the server at llmbox:11434.", "Could not reach the server at <host>:11434."],
    ["Connecting to host gitbox:22 via proxy gitproxy:3128", "Connecting to host <host>:22 via proxy <host>:3128"],
    ["Couldn't reach zorg.home:1234 — is the endpoint reachable?", "Couldn't reach <host>:1234 — is the endpoint reachable?"],
    ["Could not resolve host: hal9000.local", "Could not resolve host: <host>"],
  ] as const) {
    assert.equal(scrub(input), expected, JSON.stringify(input));
  }
  // …and a word before a number is not a host.
  for (const msg of ["at line:12 col:5", "retry attempt:3 of 5", "localhost:8080", "12:30:45"]) {
    assert.equal(scrub(msg), msg);
  }
});

test("resweep: the cheap ones", () => {
  // 6. a translated "could not apply", the quotes translations use, the
  // owner's name with a space, a quoted path with a space
  for (const [input, expected] of [
    ["Fehler: Konnte 1a2b3c4... (Add Acme billing) nicht anwenden", "Fehler: Konnte 1a2b3c4... <subject>"],
    ["error: 无法应用 1a2b3c4... Add Acme billing", "error: 无法应用 1a2b3c4... <subject>"],
    ["fatal : une branche nommée « acme-billing » existe déjà", "fatal : une branche nommée «<ref>» existe déjà"],
    ["fatal: ブランチ「acme-billing」は既に存在します", "fatal: ブランチ「<ref>」は既に存在します"],
    ["fatal: 分支“acme-billing”已存在", "fatal: 分支“<ref>”已存在"],
  ] as const) {
    assert.equal(scrubGitMessage(input), expected, JSON.stringify(input));
  }
  assert.equal(
    scrub("'<path>' is owned by:\n\tACME\\Bob Smith (S-1-5-21-1004336348-1177238915-682003330-1001)"),
    "'<path>' is owned by:\n\t<user> (<sid>)",
  );
  assert.equal(scrub("fatal: cannot open '/Users/bob/Acme Billing'"), "fatal: cannot open '<path>'");
});

/** Does `f` grow linearly between n and 4n? A quadratic rule grows ~16x, a
 *  linear one ~4x; the best of three runs keeps the timer's noise out, and
 *  anything under 5 ms is too small to judge and passes. */
function growsLinearly(f: (s: string) => unknown, make: (n: number) => string, n: number): boolean {
  const best = (s: string): number => {
    let t = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      f(s);
      t = Math.min(t, performance.now() - t0);
    }
    return t;
  };
  const small = best(make(n));
  const large = best(make(4 * n));
  return large < 5 || large / Math.max(small, 0.5) < 9;
}

test("resweep: the rules that were quadratic grow linearly", () => {
  const rep = (u: string) => (n: number): string => u.repeat(Math.ceil(n / u.length)).slice(0, n);
  // (scrub clips at 16k, so the growth is measured below it.)
  for (const unit of ["./", " ", "<path>" + " ", "to a:1 ", "a.", "a@a", " '" + "a/"]) {
    assert.ok(growsLinearly(scrubGitMessage, rep(unit), 3_000), `scrubGitMessage on ${JSON.stringify(unit)}`);
    assert.ok(growsLinearly(scrub, rep(unit), 3_000), `scrub on ${JSON.stringify(unit)}`);
  }
});

test("resweep: still linear — a run of blanks, and the classifier on unclipped text", async () => {
  const rep = (u: string, n: number): string => u.repeat(Math.ceil(n / u.length)).slice(0, n);
  const t0 = performance.now();
  for (const s of ["<path>" + rep(" ", 64_000), rep(" ", 64_000), rep("./", 64_000), rep("to a:1 ", 64_000), rep("x:12 ", 64_000)]) {
    scrub(s);
    scrubGitMessage(s);
  }
  const ms = performance.now() - t0;
  assert.ok(ms < 2_000, `took ${ms.toFixed(0)} ms`);
});
