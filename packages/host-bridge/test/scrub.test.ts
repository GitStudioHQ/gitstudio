import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as os from "node:os";
import { randomId, safeShort, scrub, scrubExtra, scrubGitMessage, redactCredentials } from "../src/scrub";

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

test("https remote: credentials AND org/repo are stripped, host kept", () => {
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
