import { strict as assert } from "node:assert";
import { test } from "node:test";
import { redactCredentials, safeHome, scrub, scrubExtra, scrubGitMessage } from "../src/scrub";

// Hardening pins for the crash-report scrubber, beyond the per-shape cases in
// scrub.test.ts: the home directory is read from the ENVIRONMENT (HOME, then
// USERPROFILE), so each OS's spelling of it is exercised here by swapping the
// env for one call; scrubbing twice must never change a report (the desktop
// app and the extension both scrub, and a report can pass through both); and a
// whole pasted file, many secrets deep, must come out clean.

/** Run `fn` with HOME / USERPROFILE replaced, restoring them afterwards. */
function withHome<T>(env: { HOME?: string; USERPROFILE?: string }, fn: () => T): T {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const put = (k: "HOME" | "USERPROFILE", v: string | undefined) => {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  };
  put("HOME", env.HOME);
  put("USERPROFILE", env.USERPROFILE);
  try {
    return fn();
  } finally {
    put("HOME", saved.HOME);
    put("USERPROFILE", saved.USERPROFILE);
  }
}

test("safeHome prefers HOME, falls back to USERPROFILE, and is empty when neither is set", () => {
  withHome({ HOME: "/home/zed", USERPROFILE: "C:\\Users\\Zed" }, () => assert.equal(safeHome(), "/home/zed"));
  withHome({ USERPROFILE: "C:\\Users\\Zed" }, () => assert.equal(safeHome(), "C:\\Users\\Zed"));
  withHome({}, () => assert.equal(safeHome(), ""));
});

test("a macOS home with a space in the user name collapses to ~ and loses the tail", () => {
  const out = withHome({ HOME: "/Users/Jane Q Public" }, () =>
    scrub("Error: ENOENT at /Users/Jane Q Public/Code/acme-billing/src/pay.ts:12:3"),
  );
  assert.equal(out, "Error: ENOENT at ~/<path>:12:3");
  for (const leak of ["Jane", "Public", "acme-billing", "pay.ts"]) {
    assert.ok(!out.includes(leak), `leaked ${leak}: ${out}`);
  }
});

test("a Linux home is collapsed even when it is not under /home", () => {
  const out = withHome({ HOME: "/var/lib/jenkins-agent" }, () =>
    scrub("cannot open /var/lib/jenkins-agent/workspace/secret-job/build.log"),
  );
  assert.equal(out, "cannot open ~/<path>");
});

test("a Windows home from USERPROFILE collapses, backslash tail and all", () => {
  const out = withHome({ USERPROFILE: "C:\\Users\\Mallory" }, () =>
    scrub("at Object.<anonymous> (C:\\Users\\Mallory\\src\\acme\\index.js:7:1)"),
  );
  assert.equal(out, "at Object.<anonymous> (~/<path>:7:1)");
  assert.ok(!out.includes("Mallory"));
  assert.ok(!out.includes("acme"));
});

test("with no home in the environment, absolute paths are still redacted by shape", () => {
  const out = withHome({}, () => scrub("/Users/pat/p/x.ts\n/home/pat/p/y.ts\nC:\\Users\\pat\\z.ts"));
  assert.equal(out, "/Users/<user>/<path>\n/home/<user>/<path>\n<path>");
});

test("a pasted file full of secrets comes out with none of them", () => {
  const file = [
    "# .env from /Users/sam/work/acme-portal",
    "DATABASE_URL=postgres://admin:hunter2@10.0.0.12:5432/acme",
    "GITHUB_TOKEN=ghp_" + "Q".repeat(36),
    "AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP",
    "OWNER=sam.smith@acme-corp.io",
    "REMOTE=https://sam:tok@github.com/acme-corp/portal.git",
    "SSH=git@gitlab.com:acme-corp/portal.git",
    "HOST6=fe80::1ff:fe23:4567:890a",
  ].join("\n");
  const out = withHome({ HOME: "/nonexistent-home-for-test" }, () => scrub(file));
  for (const leak of [
    "sam", "acme-portal", "hunter2", "10.0.0.12", "QQQQ", "AKIAABCDEFGHIJKLMNOP",
    "acme-corp", "portal.git", "fe80::1ff",
  ]) {
    assert.ok(!out.includes(leak), `leaked ${leak}:\n${out}`);
  }
  // The shape of the file (its keys and line structure) survives, so the
  // report is still diagnosable.
  assert.equal(out.split("\n").length, 8);
  assert.match(out, /^GITHUB_TOKEN=<token>$/m);
  assert.match(out, /^AWS_ACCESS_KEY_ID=<token>$/m);
  assert.match(out, /^OWNER=<email>$/m);
  assert.match(out, /^REMOTE=https:\/\/github\.com\/<path>$/m);
  assert.match(out, /^HOST6=<ip>$/m);
});

const CORPUS = [
  "fatal: unable to access 'https://alice:tok@github.com/acme/private.git/': 403",
  "git@github.com:acme-corp/private-repo.git",
  "committer john.doe+work@example.co.uk failed",
  "/Users/notarealuser/proj/y.ts:10:2",
  "/home/notarealuser/proj/c.ts",
  "/Users/John Smith/x/y.ts",
  "C:\\Users\\John Smith\\Projects\\Acme\\x.ts:4:5",
  "\\\\FS01\\Team Share\\repo\\file",
  "%APPDATA%\\Code\\User\\settings.json",
  "connect ECONNREFUSED 192.168.1.42:22 and [2001:db8::1]:443",
  `Bearer ${["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0In0", "c2lnbmF0dXJlLXZhbHVl"].join(".")}`,
  "commit a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 landed",
  `export GH=ghp_${"A".repeat(36)} key=${"z".repeat(48)}`,
  "Could not resolve to a Repository with the name 'acme-private/billing-pipeline'.",
  "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
  "rebase failed: could not apply 2 commits (conflict in file) at 01:23:45",
];

test("scrub is idempotent: a scrubbed report scrubs to itself", () => {
  withHome({ HOME: "/nonexistent-home-for-test" }, () => {
    for (const input of CORPUS) {
      const once = scrub(input);
      assert.equal(scrub(once), once, `not idempotent for: ${input}`);
    }
  });
});

// A POSIX or home path whose TAIL contains a space used to scrub to
// "~/<path>/<path>" on the first pass (the path rule stopped at the space, then
// the spaced-path rule appended a second "/<path>"), and to "~/<path>" on the
// second. Nothing leaked, but the output was not a fixed point, so the same
// crash scrubbed by the extension and again by the desktop app produced two
// different fingerprints.
test("a path with a space in its tail scrubs to a fixed point", () => {
  withHome({ HOME: "/nonexistent-home-for-test" }, () => {
    for (const input of ["/home/notarealuser/a b/c.ts", "~/a b/c", "https://example.com/a b/c", "C:\\a b\\c d\\e.ts:3:4"]) {
      const once = scrub(input);
      assert.equal(scrub(once), once, input);
      assert.doesNotMatch(once, /\bb\b|\bc\b|\bd\b|\be\.ts/, `nothing of the tail survives: ${once}`);
    }
    assert.equal(scrub("~/a b/c"), "~/<path>");
    assert.equal(scrub("/home/notarealuser/a b/c.ts"), "/home/<user>/<path>");
  });
});

test("scrubGitMessage is idempotent too", () => {
  const msgs = [
    "error: Your local changes to the following files would be overwritten by merge:\n\tsrc/a.ts\n\tdocs/b.md",
    "fatal: couldn't find remote ref 'feature/acme-migration'",
    'error: pathspec "secret/file.txt" did not match any file(s) known to git',
    "CONFLICT (content): Merge conflict in apps/web/checkout.tsx",
  ];
  for (const m of msgs) {
    const once = scrubGitMessage(m);
    assert.equal(scrubGitMessage(once), once, `not idempotent for: ${m}`);
  }
});

test("scrubGitMessage redacts a double-quoted pathspec and a bare file name", () => {
  const out = scrubGitMessage('error: pathspec "secret/plan.txt" did not match; see roadmap.md');
  assert.ok(!out.includes("secret"), out);
  assert.ok(!out.includes("roadmap"), out);
  assert.match(out, /did not match/);
  assert.match(out, /<file>/);
});

test("redactCredentials is empty-safe and idempotent", () => {
  assert.equal(redactCredentials(""), "");
  const cmd = `git remote add origin https://x-access-token:ghs_${"B".repeat(30)}@github.com/o/r.git`;
  const once = redactCredentials(cmd);
  assert.equal(once, "git remote add origin https://x-access-token:***@github.com/o/r.git");
  assert.equal(redactCredentials(once), once);
});

test("redactCredentials catches fine-grained github_pat_ tokens", () => {
  const pat = `github_pat_${"1".repeat(22)}_${"a".repeat(59)}`;
  const out = redactCredentials(`curl -H "Authorization: token ${pat}"`);
  assert.equal(out, 'curl -H "Authorization: token <token>"');
});

test("redactCredentials keeps an ssh:// user (no password) readable only when it is not a secret-bearing userinfo", () => {
  // A bare userinfo is treated as the secret, whatever the scheme.
  assert.equal(redactCredentials("ssh://deploy@host.example/x"), "ssh://***@host.example/x");
});

test("scrubExtra bounds key length to 40 and value length to 200, scrubbing both", () => {
  const longKey = "k".repeat(60);
  const out = scrubExtra({ [longKey]: "v".repeat(10) + " " + "w ".repeat(300), "multi\nline": "x@y.org" });
  const keys = Object.keys(out);
  assert.ok(keys.includes("k".repeat(40)), keys.join(","));
  assert.equal(out["k".repeat(40)].length, 200);
  assert.equal(out["multi line"], "<email>");
});
