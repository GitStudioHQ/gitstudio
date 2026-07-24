import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as os from "node:os";
import { scrub, scrubExtra, safeShort, randomId } from "../src/scrub";

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
