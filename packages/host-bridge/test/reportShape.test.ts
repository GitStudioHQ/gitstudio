import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  attachGitFailure,
  errorFacts,
  gitCommandShape,
  gitFailureInText,
  gitFailureOf,
  gitVerdict,
  isReportableThrown,
  stackFrames,
  thrownReport,
} from "../src/reportShape";
import { userStateOutcome } from "../src/gitOutcomes";

// A crash report carries only what helps fix the failure (reportShape.ts).
// The cases are the shapes reports #86–#107 arrived in, with made-up names.

const PRETTY = "--pretty=format:%H\x1f%P\x1f%an\x1f%ae\x1f%at\x1f%cn\x1f%ce\x1f%ct\x1f%s\x1f%b\x1e";

test("a git command keeps its subcommand and options, never its arguments", () => {
  for (const [args, expected] of [
    // report #97's walk: every option was ours, and they were the diagnosis
    [
      ["log", "--parents", "--date-order", PRETTY, "--max-count=500", "--skip=0", "--ignore-missing", "--branches", "--tags", "--remotes", "HEAD"],
      "log --parents --date-order --pretty=… --max-count=500 --skip=0 --ignore-missing --branches --tags --remotes HEAD",
    ],
    [["push", "--porcelain", "origin", "refs/heads/acme-billing:refs/heads/acme-billing"], "push --porcelain <args>"],
    [["checkout", "-b", "feature/acme", "HEAD~2"], "checkout -b <arg> HEAD~2"],
    [["commit", "-m", "Add Acme billing", "--author=Jane Roe <jane@acme.example>"], "commit -m <arg> --author=…"],
    [["log", "-Sacme-secret", "-n", "50", "--", "src/acme.ts", "lib/b.ts"], "log -S… -n 50 -- <paths>"],
    [["-c", "user.email=jane@acme.example", "-C", "/Users/jane/acme", "status", "--porcelain=v2"], "-c user.email=… -C <path> status --porcelain=…"],
    [["stash", "push", "-m", "wip acme"], "stash push -m <arg>"],
    [["stash", "acme"], "stash <arg>"],
    [["worktree", "add", "../acme-wt", "acme"], "worktree add <args>"],
    [["rev-parse", "--abbrev-ref", "@{u}"], "rev-parse --abbrev-ref @{u}"],
    [["reset", "--hard", "ORIG_HEAD"], "reset --hard ORIG_HEAD"],
    [["checkout", "@{-1}"], "checkout @{-1}"],
    [["show", "HEAD@{1}", "@", "~1"], "show HEAD@{1} @ ~1"],
    [["log", "main@{u}"], "log <arg>"],
    [["fetch", "--prune", "origin"], "fetch --prune <arg>"],
    [["ACME", "x"], "<args>"],
    [["clone", "--progress", "--", "https://git.acme.example/widgets.git", "acme-widgets"], "clone --progress -- <paths>"],
    [["merge", "--", ], "merge --"],
  ] as const) {
    assert.equal(gitCommandShape(args), expected, JSON.stringify(args));
  }
});

test("git's verdict is its fatal/error lines, not its progress, banners or advice", () => {
  for (const [output, expected] of [
    // #92: an error, git's advice, and the fatal line
    [
      "error: your local changes would be overwritten by cherry-pick.\nhint: commit your changes or stash them to proceed.\nfatal: cherry-pick failed",
      "error: your local changes would be overwritten by cherry-pick.\nfatal: cherry-pick failed",
    ],
    // #104: the banner goes, the rejected ref keeps git's reason
    [
      "To https://github.com/acme/widgets.git\n ! [remote rejected] acme-billing -> acme-billing (pre-receive hook declined)\nerror: failed to push some refs to 'https://github.com/acme/widgets.git'",
      "! [remote rejected] <ref> -> <ref> (pre-receive hook declined)\nerror: failed to push some refs to '<ref>'",
    ],
    // #101: ssh's banner and git's follow-on prose go
    [
      "** WARNING: connection is not using a post-quantum key exchange algorithm.\n** This session may be vulnerable to \"store now, decrypt later\" attacks.\ngit@git.acme.example: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.",
      "<email>: Permission denied (publickey).\nfatal: Could not read from remote repository.",
    ],
    // #107: the From banner goes
    ["From git.acme.example:acme/widgets\nfatal: refusing to merge unrelated histories", "fatal: refusing to merge unrelated histories"],
    // a fetch's progress and a merge's file list
    [
      "remote: Enumerating objects: 5, done.\nReceiving objects: 100% (5/5)\nUpdating 1a2b3c4..5d6e7f8\nerror: Your local changes to the following files would be overwritten by merge:\n\tsrc/acme/billing.ts\n\tsrc/acme/pricing.ts\nPlease commit your changes or stash them before you merge.\nAborting",
      "error: Your local changes to the following files would be overwritten by merge:",
    ],
    // #94: git said none of its prefixes — its first sentences stand in
    [
      "The previous cherry-pick is now empty, possibly due to conflict resolution.\nIf you wish to commit it anyway, use:\n\n    git commit --allow-empty\n\nOtherwise, please use 'git cherry-pick --skip'",
      "The previous cherry-pick is now empty, possibly due to conflict resolution.",
    ],
    // a message of ours (#99) is kept as it is
    ["The `claude` CLI isn't installed or not on PATH.", "The `claude` CLI isn't installed or not on PATH."],
    // a conflict keeps its kind, not its file
    ["Auto-merging acme.sql\nCONFLICT (content): Merge conflict in acme.sql\nAutomatic merge failed; fix conflicts and then commit the result.", "CONFLICT (content): Merge conflict in <path>"],
    // a remote's own error line, not its chatter
    ["remote: Resolving deltas: 100%\nremote: error: GH006: Protected branch update failed for refs/heads/main.\nTo https://github.com/acme/widgets.git", "remote: error: GH006: Protected branch update failed for <ref>"],
    ["", ""],
  ] as const) {
    assert.equal(gitVerdict(output), expected, JSON.stringify(output));
  }
});

test("git's own quoted words stay; a user's do not", () => {
  assert.equal(
    gitVerdict("fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree."),
    "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
  );
  assert.equal(gitVerdict("fatal: 'origin' does not appear to be a git repository"), "fatal: 'origin' does not appear to be a git repository");
  assert.equal(gitVerdict("fatal: 'acme-mirror' does not appear to be a git repository"), "fatal: '<ref>' does not appear to be a git repository");
  assert.equal(gitVerdict("error: pathspec 'acme/billing.ts' did not match any file(s) known to git"), "error: pathspec '<ref>' did not match any file(s) known to git");
  assert.equal(gitVerdict("fatal: A branch named 'acme' already exists."), "fatal: A branch named '<ref>' already exists.");
});

test("gitVerdict is idempotent, so the collector can apply it again", () => {
  for (const output of [
    "To https://github.com/acme/widgets.git\n ! [rejected] main -> main (fetch first)\nerror: failed to push some refs to 'x'\nhint: Updates were rejected",
    "The previous cherry-pick is now empty, possibly due to conflict resolution.\nIf you wish to commit it anyway, use:",
    "hint: only advice",
    "warning: redirecting to https://git.acme.example/x.git/\nfatal: Authentication failed for 'https://git.acme.example/x.git/'",
    "a\nb\nc\nd\ne",
  ]) {
    const once = gitVerdict(output);
    assert.equal(gitVerdict(once), once, JSON.stringify(output));
  }
});

test("gitVerdict keeps at most four short lines", () => {
  const many = Array.from({ length: 30 }, (_, i) => `error: failure number ${i} ${"x".repeat(300)}`).join("\n");
  const out = gitVerdict(many);
  assert.ok(out.split("\n").length <= 4);
  assert.ok(out.length <= 600);
});

test("call frames keep a function and a file name, never a folder or the message", () => {
  const stack = [
    "Error: git log --branches exited with code 128: fatal: ambiguous argument 'HEAD'",
    "Use '--' to separate paths from revisions",
    "    at n.stream (/tmp/.mount_gitstuAbC/resources/app.asar/dist/main/main.js:77:911)",
    "    at async td.readPage (/tmp/.mount_gitstuAbC/resources/app.asar/dist/main/main.js:190:3029)",
    "    at s.updateHasRepoContext (C:\\Users\\Jane Roe\\.vscode\\extensions\\gitstudio.gitstudio-1.47.0\\dist\\extension.js:119:27679)",
    "    at e (vscode-file://vscode-app/Applications/Visual%20Studio%20Code.app/out/vs/workbench/workbench.desktop.main.js:1:2)",
    "    at Object.<anonymous> (file:///Users/jane/acme-secret/scripts/acme%20tool.js:3:4)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)",
    "    at async Promise.all (index 0)",
    "    at /home/jane/acme/x.js:5:6",
    "    at new Acme (/Users/jane/proxy.acme.example/acme.js:7:8)",
    "    at eval (eval at <anonymous> (file:///Users/jane/acme/x.js:1:2), <anonymous>:1:1)",
  ].join("\n");
  assert.equal(
    stackFrames(stack),
    [
      "    at n.stream (main.js:77:911)",
      "    at async td.readPage (main.js:190:3029)",
      "    at s.updateHasRepoContext (extension.js:119:27679)",
      "    at e (workbench.desktop.main.js:1:2)",
      "    at Object.<anonymous> (<file>:3:4)",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)",
      "    at async Promise.all (index 0)",
      "    at x.js:5:6",
      "    at new Acme (acme.js:7:8)",
      "    at eval (<file>:1:1)",
    ].join("\n"),
  );
  assert.equal(stackFrames("Canceled: Canceled\n\tat new OC (file:///x/workbench.js:32:156544)"), "    at new OC (workbench.js:32:156544)");
  const deep = Array.from({ length: 40 }, (_, i) => `    at f${i} (main.js:${i}:1)`).join("\n");
  assert.equal(stackFrames(deep).split("\n").length, 15);
  assert.equal(stackFrames(""), "");
});

test("errorFacts reads Node's code and the system call, never the program", () => {
  const spawnErr = Object.assign(new Error("spawn /Users/jane/bin/acme-editor ENOENT"), {
    code: "ENOENT",
    syscall: "spawn /Users/jane/bin/acme-editor",
  });
  assert.deepEqual(errorFacts(spawnErr), { code: "ENOENT", syscall: "spawn" });
  const fetchErr = new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ENOTFOUND", syscall: "getaddrinfo" }) });
  assert.deepEqual(errorFacts(fetchErr), { code: "ENOTFOUND", syscall: "getaddrinfo" });
  assert.deepEqual(errorFacts(Object.assign(new Error("x"), { code: 128 })), {});
  assert.deepEqual(errorFacts(Object.assign(new Error("x"), { code: "acme corp" })), {});
  assert.deepEqual(errorFacts(null), {});
});

test("a thrown git failure is reported from its facts, in any language", () => {
  // A translated build: the message names the branch and is not English.
  const err = attachGitFailure(
    new Error("git log --branches refs/heads/acme-billing HEAD завершился с кодом 128: fatal: bad revision 'acme-billing'"),
    { args: ["log", "--branches", "refs/heads/acme-billing", "HEAD"], exitCode: 128, stderr: "fatal: bad revision 'acme-billing'" },
  );
  const r = thrownReport(err);
  assert.equal(r.message, "git log --branches <arg> HEAD exited with code 128: fatal: bad revision '<ref>'");
  assert.ok(!JSON.stringify(r).includes("acme"), JSON.stringify(r));
  // The facts do not serialise with the error.
  assert.ok(!JSON.stringify(err).includes("acme"));
  assert.deepEqual(Object.keys(err), []);
  // A signal stopped it.
  const killed = attachGitFailure(new Error("git log: killed"), { args: ["log", "HEAD"], exitCode: null, signal: "SIGKILL", stderr: "" });
  assert.equal(thrownReport(killed).message, "git log HEAD stopped by SIGKILL");
});

test("a thrown git failure that lost its facts is read back from its English text", () => {
  // report #97, as GitProcess threw it
  const message =
    `git log --parents --date-order ${PRETTY} --max-count=500 --skip=0 --branches --tags --remotes HEAD exited with code 128: fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`;
  const r = thrownReport(new Error(message));
  assert.equal(
    r.message,
    "git log --parents --date-order --pretty=… --max-count=500 --skip=0 --branches --tags --remotes HEAD exited with code 128: fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
  );
  // the old scrubThrown case: a clone's address and folder, a missing branch
  const clone = thrownReport(
    new Error(
      "git clone --progress -- https://git.acme.example/widgets.git acme-widgets exited with code 128: Cloning into 'acme-widgets'...\nfatal: couldn't find remote ref refs/heads/acme-billing",
    ),
  );
  assert.equal(clone.message, "git clone --progress -- <paths> exited with code 128: fatal: couldn't find remote ref <ref>");
  // SnapshotProvider's form
  assert.deepEqual(gitFailureInText("git stash apply acme failed: error: acme"), { args: ["stash", "apply", "acme"], exitCode: null, stderr: "error: acme" });
  assert.equal(thrownReport(new Error("git stash apply stash@{0} failed: error: conflicts in index")).message, "git stash apply <arg> failed: error: conflicts in index");
  assert.equal(gitFailureInText("git exited with code 1."), undefined);
  assert.equal(gitFailureInText("git rev-parse --git-path MERGE_HEAD failed (128)."), undefined);
  assert.equal(gitFailureOf(new Error("x")), undefined);
});

test("a thrown git failure's report reads back as itself, so the collector can shape it again", () => {
  for (const message of [
    `git log --parents ${PRETTY} --max-count=500 -Sacme --author=Jane -c user.name=Jane -- a.ts exited with code 128: fatal: bad revision 'acme'`,
    "git -c core.quotepath=false -C /Users/jane/acme push origin acme exited with code 1: error: src refspec acme does not match any",
    "git clone --progress -- https://git.acme.example/w.git w exited with code 128: Cloning into 'w'...",
    "git log <args> exited with code 128: fatal: <ref>",
  ]) {
    const once = thrownReport(new Error(message)).message;
    assert.equal(thrownReport(new Error(once)).message, once, message);
    assert.ok(!/acme|Jane/.test(once), once);
  }
  assert.equal(gitCommandShape(["log", "<args>"]), "log <args>");
  assert.equal(gitCommandShape(["log", "<arg>", "<args>", "<arg>"]), "log <args>");
});

test("a message of ours carrying git's words is cut to git's words", () => {
  // The words of ours in front interpolate names nothing can recognise.
  const r = thrownReport(
    new Error("Undo couldn't drop the stash “wip acme billing”: error: refs/stash@{0} is not a valid reference\nhint: acme"),
  );
  assert.equal(r.message, "error: <path>@{0} is not a valid reference");
  // review: the desktop's Undo of a drop names the branch unquoted
  assert.equal(
    gitVerdict("The dropped commit is back, but acme-billing isn't: Undo couldn't move 'refs/heads/acme-billing' back to 1a2b3c4: fatal: cannot lock ref 'refs/heads/acme-billing'"),
    "fatal: cannot lock ref '<ref>'",
  );
});

test("review: what is not git's — a hook's report, a rebase's exec, a todo line — stays home", () => {
  // a commitlint hook under a merge
  assert.equal(gitVerdict("⧗   input: Add billing for Acme\n✖   subject may not be empty [subject-empty]\n\n✖   found 1 problems, 0 warnings"), "");
  // a rebase `exec` the user wrote
  assert.equal(
    gitVerdict("Executing: npm test -- --grep acme-secret\nwarning: execution failed: npm test -- --grep acme-secret\nYou can fix the problem, and then run\n\n  git rebase --continue"),
    "warning: execution failed: <command>",
  );
  // a todo line carries a commit's subject
  assert.equal(
    gitVerdict("error: invalid line 3: pick 1a2b3c4 Add billing for Acme\nYou can fix this with 'git rebase --edit-todo' and then run 'git rebase --continue'."),
    "error: invalid line 3: <todo line>",
  );
  // names git prints bare
  assert.equal(gitVerdict("error: remote jane-fork already exists."), "error: remote <remote> already exists.");
  assert.equal(gitVerdict("fatal: Not a valid object name acme-billing"), "fatal: Not a valid object name <ref>");
  // a config key's middle is a branch's or a remote's
  assert.equal(gitCommandShape(["-c", "branch.acme-billing.merge=refs/heads/x", "pull"]), "-c branch.<sub>.merge=… pull");
  // git-lfs's own filter name is git's word; its download failure is the user's
  assert.equal(gitVerdict("error: external filter 'git-lfs filter-process' failed"), "error: external filter 'git-lfs filter-process' failed");
  assert.ok(userStateOutcome("Error downloading object: a.bin (1a2b3c4): Smudge error: x509: certificate signed by unknown authority\nfatal: a.bin: smudge filter lfs failed"));
});

test("review: a message's quoted values go unless JavaScript raised it", () => {
  assert.equal(thrownReport(new Error('Can\'t undo "Commit: Add billing for Acme": the branch moved')).message, 'Can\'t undo "<ref>": the branch moved');
  assert.equal(
    thrownReport(new Error("Rückgängig konnte den Stash „WIP acme billing“ nicht verwerfen")).message,
    "Rückgängig konnte den Stash „<ref>“ nicht verwerfen",
  );
  assert.equal(thrownReport(new Error("Nie można cofnąć ‚acme‘")).message, "Nie można cofnąć ‚<ref>‘");
  assert.equal(thrownReport(new TypeError("Cannot read properties of undefined (reading 'length')")).message, "Cannot read properties of undefined (reading 'length')");
});

test("review: a message that looks like frames is never read as frames", () => {
  const message = "git commit exited with code 1: error: hook failed\n    at AcmeBillingValidator.checkInvoiceForJaneDoe (/Users/jane/acme/scripts/validate-acme-invoices.js:12:5)";
  const err = new Error(message);
  err.stack = `Error: ${message}\n    at GitProcess.stream (/x/main.js:77:911)\n    at async run (/x/main.js:1:2)`;
  const r = thrownReport(err);
  assert.equal(r.stack, "    at GitProcess.stream (main.js:77:911)\n    at async run (main.js:1:2)");
  assert.ok(!JSON.stringify(r).includes("Acme") && !JSON.stringify(r).includes("acme"), JSON.stringify(r));
  // A stack whose header no longer matches the message (re-thrown, edited):
  // only the frames that end it.
  assert.equal(
    stackFrames("Error: x\nat Jane Doe (acme billing)\nat acme-billing-secret\nUse this\n    at f (/a/main.js:1:2)"),
    "    at f (main.js:1:2)",
  );
  // A function name with spaces is not one of V8's.
  assert.equal(stackFrames("    at Jane Doe (/a/x.js:1:2)\n    at f [as g] (/a/x.js:3:4)"), "    at <fn> (x.js:1:2)\n    at f [as g] (x.js:3:4)");
});

test("review: frames are cut whole, and a long one costs nothing", () => {
  const err = new Error("x");
  err.stack = "Error: x\n" + Array.from({ length: 15 }, (_, i) => `    at ${"ab.".repeat(30)}f${i} (/a/main.js:${i}:1)`).join("\n");
  const r = thrownReport(err);
  assert.ok(r.stack.length <= 1600);
  for (const line of r.stack.split("\n")) assert.match(line, /^ {4}at (?:ab\.)+f\d+ \(main\.js:\d+:1\)$/);
  const t = Date.now();
  assert.equal(stackFrames(`    at ${"a".repeat(15_000)}/`), "    at <frame>");
  assert.equal(stackFrames(`    at f (${"a".repeat(390)}`), "    at <file>");
  assert.ok(Date.now() - t < 50);
});

test("review: git's classes judge git's words only, and never our own refspec", () => {
  assert.equal(isReportableThrown(new Error("Connection closed before the model answered")), true);
  assert.equal(isReportableThrown(new TypeError("Cannot read properties of undefined (reading 'Merge conflict in')")), true);
  // the ambiguous short ref the app built
  for (const stderr of [
    "error: dst refspec main matches more than one\nerror: failed to push some refs to 'https://github.com/acme/w.git'",
    "error: The destination you provided is not a full refname (i.e.,\nstarting with \"refs/\").\nerror: failed to push some refs to 'x'",
    "error: unable to push to unqualified destination: main\nerror: failed to push some refs to 'x'",
  ]) {
    assert.equal(userStateOutcome(stderr), undefined, stderr);
  }
  // a pre-push hook's own refusal is still the user's
  assert.ok(userStateOutcome("running checks… 3 failed\nerror: failed to push some refs to 'x'"));
});

test("any other error keeps its first lines, scrubbed, and its frames", () => {
  const e = new TypeError("Cannot read properties of undefined (reading 'length')");
  e.stack = `TypeError: Cannot read properties of undefined (reading 'length')\n    at td.graphLoadInner (/Users/jane/x/main.js:190:2036)`;
  assert.deepEqual(thrownReport(e), {
    name: "TypeError",
    message: "Cannot read properties of undefined (reading 'length')",
    stack: "    at td.graphLoadInner (main.js:190:2036)",
  });
  const nodeErr = Object.assign(new Error("ENOENT: no such file or directory, open '/Users/jane/acme/.git/HEAD'"), {
    code: "ENOENT",
    syscall: "open",
  });
  const r = thrownReport(nodeErr);
  assert.equal(r.code, "ENOENT");
  assert.equal(r.syscall, "open");
  assert.ok(!r.message.includes("acme") && !r.message.includes("jane"), r.message);
});

test("the user's situation is not reportable, thrown or not; a defect is", () => {
  assert.equal(isReportableThrown(new Error("git fetch origin exited with code 128: fatal: unable to access 'https://x/': Could not resolve host: git.acme.example")), false);
  assert.equal(
    isReportableThrown(attachGitFailure(new Error("любое"), { args: ["pull"], exitCode: 1, stderr: "fatal: refusing to merge unrelated histories" })),
    false,
  );
  assert.equal(isReportableThrown(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) })), false);
  assert.equal(isReportableThrown(Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" })), false);
  // ours to fix
  assert.equal(isReportableThrown(new Error("git log HEAD exited with code 128: fatal: ambiguous argument 'HEAD'")), true);
  assert.equal(isReportableThrown(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT", syscall: "spawn git" })), true);
  assert.equal(isReportableThrown(new TypeError("x is not a function")), true);
  assert.equal(isReportableThrown("a string"), true);
});

test("review, round 2: a command that lost its facts, data in a parse error, names forges print", () => {
  // translated, and re-thrown without the facts
  assert.equal(thrownReport(new Error("git checkout acme-billing 以代码 1 退出：fatal: x")).message, "git checkout <args> failed: fatal: x");
  assert.equal(thrownReport(new Error("git stash push -m wip acme が失敗しました: ")).message, "git stash <args> failed");
  assert.equal(thrownReport(new Error("git log acme-billing: killed by SIGKILL")).message, "git log <args> failed");
  // our own "git … failed (N)." words are not a command line
  assert.equal(thrownReport(new Error("git exited with code 1.")).message, "git exited with code 1.");
  // JSON.parse quotes the text it was given
  assert.equal(thrownReport(new SyntaxError('Unexpected token \'a\', "acme-billing secret" is not valid JSON')).message, "Unexpected token '<ref>', \"<ref>\" is not valid JSON");
  // a message of ours: its first line only
  assert.equal(thrownReport(new Error("Couldn't apply the patch\nacme secret line 2\nline 3 Jane")).message, "Couldn't apply the patch");
  // the accounts and repositories forges name
  assert.equal(thrownReport(new Error("Could not resolve to a User with the login of jane-doe.")).message, "Could not resolve to a User with the login of <account>.");
  assert.equal(
    gitVerdict("remote: error: Gitea: User jane-doe does not have write permission to acme/w"),
    "remote: error: Gitea: User <account> does not have write permission to <path>",
  );
  assert.equal(
    gitVerdict("fatal: TF401019: The Git repository with name or identifier AcmeBilling does not exist or you do not have permissions"),
    "fatal: TF401019: The Git repository with name or identifier <repo> does not exist or you do not have permissions",
  );
  assert.equal(gitVerdict("error: pathspec acme-billing did not match any file(s) known to git"), "error: pathspec <path> did not match any file(s) known to git");
  assert.equal(gitVerdict("fatal: no such branch: acme-billing"), "fatal: no such branch: <ref>");
  assert.equal(gitVerdict("fatal: bad revision acme-billing"), "fatal: bad revision <ref>");
  assert.equal(gitVerdict("fatal: tag acme-v1 already exists"), "fatal: tag <ref> already exists");
  assert.equal(gitVerdict("error: No such remote: acme-private"), "error: No such remote: <remote>");
  assert.equal(gitVerdict("error: key does not contain a section: acmebilling"), "error: key does not contain a section: <key>");
  // the user's own hooks and a forge's permissions are the user's situation
  assert.ok(userStateOutcome("Commit message must reference a JIRA ticket\nNot committing merge; use 'git commit' to complete the merge."));
  assert.ok(userStateOutcome("remote: error: Gitea: User <account> does not have write permission to <path>"));
});
