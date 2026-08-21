import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRebasePlan } from "../src/rebasePlan";

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

// The whole path, against real git: display rows -> buildRebasePlan -> a todo
// git actually runs -> branches that followed the rewrite.
//
// The unit tests pin the todo TEXT; this pins that git agrees with our reading
// of it. Worth having separately, because the first hand-written attempt at
// this produced a todo git accepted and then moved a branch onto the commit
// BEFORE the range — a silent wrong answer, not an error.
test("end to end: the plan builder's todo really moves the branches", () => {
  const d = mkdtempSync(join(tmpdir(), "gs-e2e-"));
  const g = (a: string[]) => execFileSync("git", a, { cwd: d, encoding: "utf8", env: ENV }).trim();
  try {
    execFileSync("git", ["init", "-q", "-b", "main", d], { env: ENV });
    g(["config", "user.email", "d@e.com"]); g(["config", "user.name", "D"]);
    g(["config", "commit.gpgsign", "false"]);
    const c = (m: string) => { writeFileSync(join(d, `${m}.txt`), m); g(["add", "-A"]); g(["commit", "-q", "-m", m]); };
    c("base"); c("A"); g(["branch", "feat-1"]); c("B"); g(["branch", "feat-2"]); c("C");

    const sha = (r: string) => g(["rev-parse", r]);
    // Reorder on screen: B above A (newest first is C, B, A -> C, A, B swapped).
    const plan = buildRebasePlan([
      { sha: sha("main"), subject: "C", action: "pick" },
      { sha: sha("main~2"), subject: "A", action: "pick", branches: ["feat-1"] },
      { sha: sha("main~1"), subject: "B", action: "pick", branches: ["feat-2"] },
    ], { updateRefs: true });
    assert.ok(plan.ok, "plan must build");

    const seq = join(d, "seq.sh");
    writeFileSync(seq, `#!/bin/sh\ncat > "$1" <<'EOF'\n${plan.todo}EOF\n`, { mode: 0o755 });
    execFileSync("git", ["rebase", "-i", "main~3"], {
      cwd: d, env: { ...ENV, GIT_SEQUENCE_EDITOR: seq }, encoding: "utf8",
    });

    // Display order passed above was C, A, B — A moved ABOVE B — so git applies
    // B then A then C, and main reads back newest-first as C, A, B, base.
    assert.deepEqual(g(["log", "--format=%s", "main"]).split("\n"), ["C", "A", "B", "base"],
      "main is reordered exactly as the display order asked");
    assert.equal(g(["log", "-1", "--format=%s", "feat-1"]), "A");
    assert.equal(g(["log", "-1", "--format=%s", "feat-2"]), "B");
    for (const b of ["feat-1", "feat-2"]) {
      execFileSync("git", ["merge-base", "--is-ancestor", b, "main"], { cwd: d, env: ENV });
    }
    console.log("  main:", g(["log", "--format=%s", "main"]).split("\n").join(" "));
    console.log("  feat-1 and feat-2 both followed onto the rewritten commits");
  } finally {
    try { rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 120 }); }
    catch { /* git background processes still holding the dir; the temp dir is disposable */ }
  }
});
