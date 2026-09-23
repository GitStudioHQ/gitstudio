import { test } from "node:test";
import assert from "node:assert/strict";
import { GitContext } from "../src/GitContext";
import type { GitRunEvent } from "../src/GitProcess";
import { makeRepo, type Repo } from "./opRepo";

// Which conflicts get a line merge (shape "text") and which only a whole-file
// choice (shape "binary"). Two defects in ConflictOps.isBinary:
//
// 1. It asked git with a blob-to-blob `diff --numstat`, which carries no path,
//    so .gitattributes never applied: a file the repository declares `binary`
//    (or `-merge`) — which git itself refuses to line-merge — was offered the
//    three-pane text merge anyway.
// 2. It ran one `diff --numstat` per text-capable file on EVERY dashboard
//    refresh: N processes for N conflicts, several times a second while an
//    operation is stopped.

function mergedWith(files: Record<string, [string, string, string]>, attributes?: string): Repo {
  const r = makeRepo("binattr");
  if (attributes) r.write(".gitattributes", attributes);
  for (const [p, [base]] of Object.entries(files)) r.write(p, base);
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "side");
  for (const [p, [, , side]] of Object.entries(files)) r.write(p, side);
  r.commitAll("side");
  r.git("checkout", "-q", "master");
  for (const [p, [, master]] of Object.entries(files)) r.write(p, master);
  r.commitAll("master");
  r.tryGit("merge", "side");
  return r;
}

const lines = (tag: string): [string, string, string] => [
  "a\nb\nc\n",
  `a\nb-${tag}-master\nc\n`,
  `a\nb-${tag}-side\nc\n`,
];

test("a file the repository declares binary is a binary conflict, whatever its bytes", async () => {
  const r = mergedWith(
    { "logo.svg": lines("svg"), "keep.txt": lines("txt"), "gen.lock": lines("lock") },
    "*.svg binary\n*.lock -merge\n",
  );
  try {
    const facts = await r.ctx().conflictOps.conflictFiles();
    const shape = Object.fromEntries(facts.map((f) => [f.path, f.shape]));
    assert.equal(shape["logo.svg"], "binary", "`binary` (= -diff -merge -text): git does not line-merge it");
    assert.equal(shape["gen.lock"], "binary", "`-merge`: git keeps one side and never writes markers");
    assert.equal(shape["keep.txt"], "text");
  } finally {
    r.cleanup();
  }
});

test("`-diff` alone is still a text merge — git line-merged it and left markers to resolve", async () => {
  const r = mergedWith({ "package-lock.json": lines("lock") }, "package-lock.json -diff\n");
  try {
    assert.match(r.read("package-lock.json"), /^<<<<<<< /m, "precondition: git wrote conflict markers");
    const [f] = await r.ctx().conflictOps.conflictFiles();
    assert.equal(f.shape, "text", "hiding a text diff is not declaring the content unmergeable");
  } finally {
    r.cleanup();
  }
});

test("a dashboard refresh costs no per-file diff for text conflicts", async () => {
  const files: Record<string, [string, string, string]> = {};
  for (let i = 0; i < 6; i++) files[`f${i}.txt`] = lines(String(i));
  files["art.bin"] = ["x\0base\n", "x\0master\n", "x\0side\n"];
  const r = mergedWith(files);
  const runs: GitRunEvent[] = [];
  const ctx = new GitContext({ root: r.root, onRun: (e) => runs.push(e) });
  try {
    const op = await ctx.operation.view();
    runs.length = 0;
    const snap = await ctx.conflictOps.snapshot({ op });
    assert.equal(snap.files.length, 7);
    assert.equal(snap.files.find((f) => f.path === "art.bin")?.shape, "binary", "a NUL-carrying file is still binary");
    assert.equal(snap.files.filter((f) => f.shape === "text").length, 6);
    const perFile = runs.filter((e) => e.args[0] === "diff" || (e.args[0] === "cat-file" && e.args[1] === "blob"));
    assert.ok(perFile.length <= 1, `at most the one binary-looking file is checked further, not every file (${perFile.length} runs)`);
    assert.ok(runs.length <= 5, `a refresh is a handful of processes, not one per file (${runs.length})`);
  } finally {
    ctx.dispose();
    r.cleanup();
  }
});
