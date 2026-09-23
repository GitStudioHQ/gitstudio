import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { makeRepo, FIVE, edit, type Repo } from "./opRepo";
import { ConflictOps, xyFromStages, shapeOfStages, badgeFor, parseUnmergedStages } from "../src/ConflictOps";
import { GitProcess } from "../src/GitProcess";
import type { OperationView } from "@gitstudio/host-bridge/conflictsProtocol";

// W4 (PLAN §3.4): whole-file resolution in ROLE terms, and the facts every
// dashboard row is drawn from. Real git throughout; each guard here is one a
// destroyed file paid for.

/** base → master and side, then `git merge side`; `each(side)` writes each side's version. */
function merged(name: string, each: (r: Repo, side: "base" | "master" | "side") => void): Repo {
  const r = makeRepo(name);
  each(r, "base");
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "side");
  each(r, "side");
  r.commitAll("side");
  r.git("checkout", "-q", "master");
  each(r, "master");
  r.commitAll("master");
  r.tryGit("merge", "side");
  return r;
}

const nul = (tag: number): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, tag]), Buffer.alloc(64, tag)]);

/** One merge conflicting in every content shape. */
function manyShapes(): Repo {
  return merged("shapes", (r, side) => {
    // rmSync removes a (dangling) symlink itself; existsSync would follow it.
    const rm = (p: string): void => rmSync(join(r.root, p), { force: true });
    if (side === "base") {
      r.write("both.txt", FIVE);
      r.write("keep.txt", "keep\n");
      r.write("drop.txt", "drop\n");
      r.write("art.bin", nul(0));
      r.write("big.txt", "base line of ordinary text\n".repeat(22_000));
      symlinkSync("target-base", join(r.root, "link"));
      return;
    }
    r.write("both.txt", edit(FIVE, { three: `three-${side}` }));
    r.write("new.txt", `added on ${side}\n`);
    r.write("art.bin", nul(side === "master" ? 1 : 2));
    r.write("big.txt", `${side} line of ordinary text\n`.repeat(22_000));
    rm("link");
    symlinkSync(`target-${side}`, join(r.root, "link"));
    if (side === "master") {
      r.write("keep.txt", "keep, edited on master\n");
      rm("drop.txt");
    } else {
      rm("keep.txt");
      r.write("drop.txt", "drop, edited on side\n");
    }
  });
}

/** Both sides rename the same file differently: DD on the original, AU and UA on the new names. */
function renameRename(): Repo {
  const r = makeRepo("rename-rename");
  r.write("doomed.txt", "contents\n");
  r.write("other.txt", "x\n");
  r.commitAll("base");
  r.git("checkout", "-q", "-b", "side");
  r.git("mv", "doomed.txt", "theirs.txt");
  r.commitAll("they rename it");
  r.git("checkout", "-q", "master");
  r.git("mv", "doomed.txt", "ours.txt");
  r.commitAll("we rename it");
  r.tryGit("merge", "side");
  return r;
}

/** The porcelain v2 XY git itself reports for each unmerged path. */
function porcelainXY(r: Repo): Map<string, string> {
  const out = new Map<string, string>();
  for (const rec of r.git("status", "--porcelain=v2", "-z").split("\0")) {
    const m = /^u (\S\S) (?:\S+ ){8}([\s\S]+)$/.exec(rec);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

// ── Facts ───────────────────────────────────────────────────────────────────

test("every content shape of a merge, with XY exactly as git reports it and badges in role terms", async () => {
  const r = manyShapes();
  try {
    const ctx = r.ctx();
    const facts = await ctx.conflictOps.conflictFiles();
    const by = new Map(facts.map((f) => [f.path, f]));
    const xy = porcelainXY(r);
    assert.deepEqual([...by.keys()].sort(), [...xy.keys()].sort(), "the same paths git lists");
    for (const [path, code] of xy) assert.equal(by.get(path)!.xy, code, `${path}: XY matches porcelain v2`);

    assert.equal(by.get("both.txt")!.shape, "text");
    assert.equal(by.get("both.txt")!.badge, "");
    assert.equal(by.get("new.txt")!.shape, "added-both");
    assert.equal(by.get("new.txt")!.badge, "added in both");
    assert.equal(by.get("new.txt")!.hasBase, false);

    // keep.txt: master edited, side deleted — the THEIRS side has no file.
    assert.equal(by.get("keep.txt")!.xy, "UD");
    assert.equal(by.get("keep.txt")!.shape, "modify-delete");
    assert.equal(by.get("keep.txt")!.missingRole, "theirs");
    assert.equal(by.get("keep.txt")!.badge, "deleted in theirs (side)");
    // drop.txt: master deleted — in a merge that is YOURS.
    assert.equal(by.get("drop.txt")!.xy, "DU");
    assert.equal(by.get("drop.txt")!.missingRole, "yours");
    assert.equal(by.get("drop.txt")!.badge, "deleted in yours (master)");

    assert.equal(by.get("art.bin")!.shape, "binary", "git's own numstat says '-\\t-'");
    assert.equal(by.get("big.txt")!.shape, "too-large");
    assert.equal(by.get("link")!.shape, "binary", "a symlink has no line merge — take a side");

    // fileFacts agrees with the list.
    assert.deepEqual(await ctx.conflictOps.fileFacts("keep.txt"), by.get("keep.txt"));
    assert.equal(await ctx.conflictOps.fileFacts("not-conflicted.txt"), undefined);
  } finally {
    r.cleanup();
  }
});

test("rename/rename: DD, AU and UA, each with its shape and missing role", async () => {
  const r = renameRename();
  try {
    const ctx = r.ctx();
    const by = new Map((await ctx.conflictOps.conflictFiles()).map((f) => [f.path, f]));
    const xy = porcelainXY(r);
    for (const [path, code] of xy) assert.equal(by.get(path)!.xy, code, path);
    assert.equal(by.get("doomed.txt")!.shape, "both-deleted");
    assert.equal(by.get("doomed.txt")!.badge, "deleted in both");
    assert.equal(by.get("doomed.txt")!.missingRole, undefined);
    assert.equal(by.get("ours.txt")!.shape, "added-one-side");
    assert.equal(by.get("ours.txt")!.missingRole, "theirs");
    assert.equal(by.get("ours.txt")!.badge, "added in yours (master)");
    assert.equal(by.get("theirs.txt")!.missingRole, "yours");
    assert.equal(by.get("theirs.txt")!.badge, "added in theirs (side)");
  } finally {
    r.cleanup();
  }
});

test("a rebase states the same XY in the other roles", async () => {
  // master deleted d.txt, test modified it; test is rebased onto master.
  const r = makeRepo("rebase-md");
  try {
    r.write("d.txt", "d\n");
    r.write("e.txt", "e\n");
    r.commitAll("base");
    r.git("checkout", "-q", "-b", "test");
    r.write("d.txt", "d, edited on test\n");
    rmSync(join(r.root, "e.txt"));
    r.commitAll("test: edit d, delete e");
    r.git("checkout", "-q", "master");
    rmSync(join(r.root, "d.txt"));
    r.write("e.txt", "e, edited on master\n");
    r.commitAll("master: delete d, edit e");
    r.git("checkout", "-q", "test");
    r.tryGit("rebase", "master");
    const ctx = r.ctx();
    const op = await ctx.operation.view();
    assert.equal(op.yours.stage, 3);
    const by = new Map((await ctx.conflictOps.conflictFiles({ op })).map((f) => [f.path, f]));
    // d.txt: stage 2 (master's side) has no file — DU, "deleted by us" in git's words.
    assert.equal(by.get("d.txt")!.xy, "DU");
    assert.equal(by.get("d.txt")!.missingRole, "theirs");
    assert.equal(by.get("d.txt")!.badge, "deleted in theirs (master)", "the SAME XY as a merge's DU, the other role");
    // e.txt: stage 3 (test's commit) deleted it.
    assert.equal(by.get("e.txt")!.xy, "UD");
    assert.equal(by.get("e.txt")!.missingRole, "yours");
    assert.equal(by.get("e.txt")!.badge, "deleted in yours (test)");

    // Accept Yours keeps test's edit of d.txt; Accept Theirs on e.txt keeps master's.
    assert.equal((await ctx.conflictOps.takeRole("d.txt", "yours", { op })).ok, true);
    assert.equal(r.read("d.txt"), "d, edited on test\n");
    assert.equal((await ctx.conflictOps.takeRole("e.txt", "yours", { op })).ok, true, "yours deleted it");
    assert.equal(r.exists("e.txt"), false);
    assert.equal(r.git("ls-files", "-u").trim(), "");
  } finally {
    r.cleanup();
  }
});

test("readSides maps a missing side and names the shape", async () => {
  const r = manyShapes();
  try {
    const ctx = r.ctx();
    const keep = await ctx.conflictOps.readSides("keep.txt");
    assert.equal(keep.shape, "modify-delete");
    assert.equal(keep.missingRole, "theirs");
    assert.equal(keep.yours, "keep, edited on master\n");
    assert.equal(keep.theirs, "");
    assert.equal(keep.hasBase, true);
    const bin = await ctx.conflictOps.readSides("art.bin");
    assert.equal(bin.shape, "binary");
  } finally {
    r.cleanup();
  }
});

test("readSides of a both-deleted file still carries its base", async () => {
  const r = renameRename();
  try {
    const sides = await r.ctx().conflictOps.readSides("doomed.txt");
    assert.equal(sides.shape, "both-deleted");
    assert.equal(sides.hasBase, true);
    assert.equal(sides.base, "contents\n", "hasBase and base agree");
    assert.equal(sides.yours, "");
    assert.equal(sides.theirs, "");
  } finally {
    r.cleanup();
  }
});

// ── takeRole / takeStage ────────────────────────────────────────────────────

test("modify/delete: the side that kept the file keeps it; the side that deleted it deletes it", async () => {
  const r = manyShapes();
  try {
    const ctx = r.ctx();
    assert.equal((await ctx.conflictOps.takeRole("keep.txt", "yours")).ok, true);
    assert.equal(r.read("keep.txt"), "keep, edited on master\n");
    assert.equal((await ctx.conflictOps.takeRole("drop.txt", "yours")).ok, true, "yours (master) deleted it");
    assert.equal(r.exists("drop.txt"), false);
    assert.equal(porcelainXY(r).has("keep.txt") || porcelainXY(r).has("drop.txt"), false);
  } finally {
    r.cleanup();
  }
});

test("a binary side is taken byte for byte — git moves the bytes", async () => {
  const r = manyShapes();
  try {
    const ctx = r.ctx();
    assert.equal((await ctx.conflictOps.takeRole("art.bin", "theirs")).ok, true);
    assert.deepEqual(readFileSync(join(r.root, "art.bin")), nul(2));
  } finally {
    r.cleanup();
  }
});

test("both-deleted: taking a side is refused; deleteFile settles it", async () => {
  const r = renameRename();
  try {
    const ctx = r.ctx();
    const took = await ctx.conflictOps.takeRole("doomed.txt", "yours");
    assert.equal(took.ok, false);
    assert.equal(took.expected, true);
    assert.match(took.message ?? "", /Both sides deleted doomed\.txt/);
    const wrong = await ctx.conflictOps.deleteFile("ours.txt");
    assert.equal(wrong.ok, false, "deleteFile is only for a file deleted on both sides");
    assert.equal(r.exists("ours.txt"), true);
    const del = await ctx.conflictOps.deleteFile("doomed.txt");
    assert.equal(del.ok, true, del.message);
    assert.equal(porcelainXY(r).has("doomed.txt"), false);
    assert.equal(r.exists("doomed.txt"), false, "not resurrected");
  } finally {
    r.cleanup();
  }
});

test("a file that is no longer conflicted is refused, not overwritten", async () => {
  const r = manyShapes();
  try {
    const ctx = r.ctx();
    r.write("both.txt", "resolved elsewhere\n");
    r.git("add", "both.txt");
    const out = await ctx.conflictOps.takeRole("both.txt", "theirs");
    assert.equal(out.ok, false);
    assert.equal(out.expected, true);
    assert.match(out.message ?? "", /no longer conflicted/);
    assert.equal(r.read("both.txt"), "resolved elsewhere\n");
  } finally {
    r.cleanup();
  }
});

test("a checkout that fails must not delete the file (never `rm` on an error)", async () => {
  // Merge Studio ran `git rm -f` whenever `checkout --theirs` failed for ANY
  // reason. Here the checkout fails the way a held lock makes it fail — before
  // touching anything — while every other command is real git. The side is
  // present in the index, so the only correct outcome is: nothing changes.
  const r = manyShapes();
  try {
    const real = new GitProcess({ cwd: r.root });
    const ran: string[][] = [];
    const locked = {
      run: (args: string[], opts?: { signal?: AbortSignal; input?: string }) => {
        ran.push(args);
        if (args.includes("checkout")) {
          return Promise.resolve({
            code: 128,
            stdout: "",
            stderr: `fatal: Unable to create '${join(r.root, ".git", "index.lock")}': File exists.`,
          });
        }
        return real.run(args, opts);
      },
    } as unknown as GitProcess;
    const ctx = r.ctx();
    const ops = new ConflictOps(locked, r.root, ctx.conflict, ctx.operation);
    const before = r.read("both.txt");
    const out = await ops.takeRole("both.txt", "theirs");
    assert.equal(out.ok, false, "the checkout failed");
    assert.match(out.message ?? "", /index\.lock/, "with git's own reason");
    assert.equal(ran.some((a) => a.includes("rm")), false, "and no `git rm` was ever run");
    assert.equal(r.read("both.txt"), before, "the file is still there, untouched");
    assert.equal(r.git("ls-files", "-u", "--", "both.txt").trim().split("\n").length, 3, "and still conflicted");
    real.dispose();
  } finally {
    r.cleanup();
  }
});

test("with a real held index.lock nothing is written and nothing is deleted", async () => {
  const r = manyShapes();
  try {
    writeFileSync(join(r.root, ".git", "index.lock"), "");
    const ctx = r.ctx();
    const before = r.read("both.txt");
    for (const role of ["yours", "theirs"] as const) {
      assert.equal((await ctx.conflictOps.takeRole("both.txt", role)).ok, false);
      assert.equal((await ctx.conflictOps.takeRole("drop.txt", role)).ok, false);
    }
    assert.equal(r.read("both.txt"), before);
    assert.equal(r.exists("drop.txt"), true);
    rmSync(join(r.root, ".git", "index.lock"));
  } finally {
    r.cleanup();
  }
});

test("non-ASCII paths resolve and are never deleted", async () => {
  const names = ["café.txt", "日本語.md", "sub dir/ünï.ts", "emoji🎉.md"];
  const r = merged("unicode", (repo, side) => {
    for (const n of names) repo.write(n, `${side} ${n}\n`);
  });
  try {
    const ctx = r.ctx();
    assert.deepEqual((await ctx.conflictOps.conflictFiles()).map((f) => f.path).sort(), [...names].sort());
    for (const n of names) {
      const out = await ctx.conflictOps.takeRole(n, "yours");
      assert.equal(out.ok, true, `${n}: ${out.message ?? ""}`);
      assert.equal(r.read(n), `master ${n}\n`);
    }
    assert.equal(r.git("diff", "--cached", "--name-only", "--diff-filter=D").trim(), "");
  } finally {
    r.cleanup();
  }
});

test("a glob-shaped file name touches only itself (pathspecs are literal)", async () => {
  const r = merged("glob", (repo, side) => {
    repo.write("[ab].txt", `${side} brackets\n`);
    repo.write("a.txt", `${side} a\n`);
  });
  try {
    const ctx = r.ctx();
    const out = await ctx.conflictOps.takeRole("[ab].txt", "theirs");
    assert.equal(out.ok, true, out.message);
    assert.equal(r.read("[ab].txt"), "side brackets\n");
    assert.equal(porcelainXY(r).get("a.txt"), "UU", "a.txt is still conflicted — the pattern did not reach it");
    assert.match(r.read("a.txt"), /^<{7} /m);
  } finally {
    r.cleanup();
  }
});

test("a glob-shaped name the index no longer holds (a race) still reaches no other file", async () => {
  // git reads a pathspec literally only while the index has that exact path;
  // once it is gone (resolved or removed between our listing and the write),
  // `checkout --theirs -- '[ab].txt'` globs and resolves a.txt and b.txt
  // instead (verified, scratchpad p2/exp5.sh). The listing below claims
  // '[ab].txt' is conflicted while the index has no such entry.
  const r = merged("glob-race", (repo, side) => {
    repo.write("a.txt", `${side} a\n`);
    repo.write("b.txt", `${side} b\n`);
  });
  try {
    const real = new GitProcess({ cwd: r.root });
    const stale = {
      run: async (args: string[], opts?: { signal?: AbortSignal; input?: string }) => {
        const res = await real.run(args, opts);
        if (args.join(" ") === "ls-files -u -z") {
          const fake = ["1", "2", "3"].map((s) => `100644 ${"e".repeat(40)} ${s}\t[ab].txt`).join("\u0000");
          return { ...res, stdout: `${fake}\u0000${res.stdout}` };
        }
        return res;
      },
    } as unknown as GitProcess;
    const ctx = r.ctx();
    const ops = new ConflictOps(stale, r.root, ctx.conflict, ctx.operation);
    await ops.takeStage("[ab].txt", 3);
    assert.equal(porcelainXY(r).get("a.txt"), "UU", "a.txt was not resolved by a pattern");
    assert.equal(porcelainXY(r).get("b.txt"), "UU");
    assert.match(r.read("a.txt"), /^<{7} /m, "and its markers are still there");
    real.dispose();
  } finally {
    r.cleanup();
  }
});

test("a path that escapes the repository, or reaches outside through a symlinked folder, is refused", async () => {
  const r = manyShapes();
  const outside = mkdtempSync(join(tmpdir(), "gs-op-outside-"));
  try {
    writeFileSync(join(outside, "x.txt"), "OUTSIDE\n");
    symlinkSync(outside, join(r.root, "dir"));
    const ctx = r.ctx();
    for (const p of ["../x.txt", "dir/x.txt", ""]) {
      const a = await ctx.conflictOps.takeStage(p, 2);
      assert.equal(a.ok, false, `takeStage ${p}`);
      const b = await ctx.conflictOps.writeResolution(p, "PWNED\n");
      assert.equal(b.ok, false, `writeResolution ${p}`);
    }
    assert.equal(readFileSync(join(outside, "x.txt"), "utf8"), "OUTSIDE\n");
  } finally {
    r.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the symlinked-folder guard holds even when the conflict listing is wrong", async () => {
  // git never lists a path beyond a symlink, so the listing check alone would
  // refuse dir/x.txt — until the listing is stale or unreadable (writeResolution
  // proceeds on an unreadable one, so a hand merge can still be saved). The
  // realpath guard is what stops the write landing outside the repository.
  const r = manyShapes();
  const outside = mkdtempSync(join(tmpdir(), "gs-op-outside2-"));
  try {
    writeFileSync(join(outside, "x.txt"), "OUTSIDE\n");
    symlinkSync(outside, join(r.root, "dir"));
    const real = new GitProcess({ cwd: r.root });
    const lying = {
      run: async (args: string[], opts?: { signal?: AbortSignal; input?: string }) => {
        const res = await real.run(args, opts);
        if (args.join(" ") === "ls-files -u -z") {
          const fake = ["1", "2", "3"].map((s) => `100644 ${"e".repeat(40)} ${s}\tdir/x.txt`).join("\u0000");
          return { ...res, stdout: `${fake}\u0000${res.stdout}` };
        }
        return res;
      },
    } as unknown as GitProcess;
    const ctx = r.ctx();
    const ops = new ConflictOps(lying, r.root, ctx.conflict, ctx.operation);
    const out = await ops.writeResolution("dir/x.txt", "PWNED\n");
    assert.equal(out.ok, false);
    assert.match(out.message ?? "", /resolves outside the repository/);
    assert.equal(readFileSync(join(outside, "x.txt"), "utf8"), "OUTSIDE\n", "nothing was written outside");
    real.dispose();
  } finally {
    r.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

// ── restore (hold-to-undo) ──────────────────────────────────────────────────

test("restore brings a text conflict back with its markers", async () => {
  const r = manyShapes();
  try {
    const ctx = r.ctx();
    await ctx.conflictOps.takeRole("both.txt", "theirs");
    assert.equal(porcelainXY(r).has("both.txt"), false);
    const out = await ctx.conflictOps.restore("both.txt");
    assert.equal(out.ok, true, out.message);
    assert.equal(porcelainXY(r).get("both.txt"), "UU");
    assert.match(r.read("both.txt"), /^<{7} ours$/m, "git rewrites the labels as ours/theirs (products.out)");
  } finally {
    r.cleanup();
  }
});

test("restore brings a modify/delete back — which `checkout -m` alone refuses", async () => {
  const r = manyShapes();
  try {
    const ctx = r.ctx();
    await ctx.conflictOps.takeRole("keep.txt", "theirs"); // theirs deleted it
    assert.equal(r.exists("keep.txt"), false);
    const out = await ctx.conflictOps.restore("keep.txt");
    assert.equal(out.ok, true, out.message);
    assert.equal(porcelainXY(r).get("keep.txt"), "UD", "conflicted again, the same way");
    assert.equal(r.read("keep.txt"), "keep, edited on master\n", "with the surviving side back on disk");
  } finally {
    r.cleanup();
  }
});

test("restore brings a both-deleted conflict back", async () => {
  const r = renameRename();
  try {
    const ctx = r.ctx();
    await ctx.conflictOps.deleteFile("doomed.txt");
    const out = await ctx.conflictOps.restore("doomed.txt");
    assert.equal(out.ok, true, out.message);
    assert.equal(porcelainXY(r).get("doomed.txt"), "DD");
  } finally {
    r.cleanup();
  }
});

test("restore refuses a path git holds no conflict for — and leaves its edits alone", async () => {
  // `git checkout -m -- <never-conflicted>` exits 0 and overwrites the working
  // copy with the index. The resolve-undo record is the precondition.
  const r = manyShapes();
  try {
    const ctx = r.ctx();
    r.write("other.txt", "tracked\n");
    r.git("add", "other.txt");
    r.write("other.txt", "tracked, with unsaved work\n");
    const out = await ctx.conflictOps.restore("other.txt");
    assert.equal(out.ok, false);
    assert.equal(out.expected, true);
    assert.equal(r.read("other.txt"), "tracked, with unsaved work\n");
    const still = await ctx.conflictOps.restore("both.txt");
    assert.equal(still.ok, false, "still conflicted: nothing to undo");
    assert.match(still.message ?? "", /still conflicted/);
  } finally {
    r.cleanup();
  }
});

test("restore refuses once the operation is over — a committed merge gets no conflict back", async () => {
  // git keeps the resolve-undo record after the merge commit, and
  // `checkout -m` then re-creates the conflict in a finished repository —
  // what an Undo of "Apply" pressed after Continue would do.
  const r = merged("restore-after-commit", (repo, side) =>
    repo.write("f.txt", side === "base" ? FIVE : edit(FIVE, { three: `three-${side}` })),
  );
  try {
    const ctx = r.ctx();
    assert.equal((await ctx.conflictOps.takeRole("f.txt", "yours")).ok, true);
    const before = await ctx.conflictOps.restore("f.txt");
    assert.equal(before.ok, true, "while the merge is stopped, the undo works");
    assert.equal((await ctx.conflictOps.takeRole("f.txt", "yours")).ok, true);
    assert.equal((await ctx.operation.continue()).ok, true);
    const committed = r.sha("HEAD");

    const out = await ctx.conflictOps.restore("f.txt");
    assert.equal(out.ok, false);
    assert.equal(out.expected, true);
    assert.match(out.message ?? "", /has finished/);
    assert.equal(r.git("status", "--porcelain=v2").trim(), "", "no unmerged stages, no markers");
    assert.equal(r.read("f.txt"), edit(FIVE, { three: "three-master" }));
    assert.equal(r.sha("HEAD"), committed);
  } finally {
    r.cleanup();
  }
});

// ── writeResolution (the Apply) ─────────────────────────────────────────────

test("writeResolution saves and stages a hand merge, and the row remembers it", async () => {
  const r = manyShapes();
  try {
    const ctx = r.ctx();
    const out = await ctx.conflictOps.writeResolution("both.txt", "merged by hand\n");
    assert.equal(out.ok, true, out.message);
    assert.equal(r.git("show", ":both.txt"), "merged by hand\n");
    const snap = await ctx.conflictOps.snapshot();
    assert.deepEqual(snap.files.find((f) => f.path === "both.txt"), {
      path: "both.txt",
      status: "resolved",
      choice: "merged",
      shape: "text",
    });
  } finally {
    r.cleanup();
  }
});

test("writeResolution refuses a symlink, a binary, a both-deleted path and a resolved one", async () => {
  const r = manyShapes();
  try {
    const ctx = r.ctx();
    const link = await ctx.conflictOps.writeResolution("link", "PWNED\n", { takeSideAdvice: "use Take ours or Take theirs" });
    assert.equal(link.ok, false);
    assert.match(link.message ?? "", /symbolic link.*use Take ours or Take theirs\.$/);
    assert.equal(lstatSync(join(r.root, "link")).isSymbolicLink(), true);

    const before = readFileSync(join(r.root, "art.bin"));
    const bin = await ctx.conflictOps.writeResolution("art.bin", before.toString("utf8"));
    assert.equal(bin.ok, false);
    assert.match(bin.message ?? "", /UTF-8.*accept one side instead\.$/);
    assert.deepEqual(readFileSync(join(r.root, "art.bin")), before);

    r.write("both.txt", "settled\n");
    r.git("add", "both.txt");
    const done = await ctx.conflictOps.writeResolution("both.txt", "overwrite?\n");
    assert.equal(done.ok, false);
    assert.equal(r.read("both.txt"), "settled\n");
  } finally {
    r.cleanup();
  }
  const dd = renameRename();
  try {
    const out = await dd.ctx().conflictOps.writeResolution("doomed.txt", "resurrected\n");
    assert.equal(out.ok, false);
    assert.match(out.message ?? "", /Both sides deleted/);
    assert.equal(existsSync(join(dd.root, "doomed.txt")), false);
  } finally {
    dd.cleanup();
  }
});

// ── snapshot ────────────────────────────────────────────────────────────────

test("snapshot: pending and resolved rows, choice pills, counts, repo name", async () => {
  const r = manyShapes();
  try {
    const ctx = r.ctx();
    ctx.conflictOps.noteChoice("both.txt", "merged"); // noted before any snapshot
    let snap = await ctx.conflictOps.snapshot();
    assert.equal(snap.repoName, basename(r.root));
    assert.equal(snap.op.kind, "merge");
    assert.equal(snap.total, snap.files.length);
    assert.equal(snap.resolved, 0, "noted, but still conflicted — no pill yet");
    await ctx.conflictOps.takeRole("keep.txt", "yours");
    await ctx.conflictOps.takeRole("drop.txt", "theirs");
    snap = await ctx.conflictOps.snapshot();
    const keep = snap.files.find((f) => f.path === "keep.txt")!;
    assert.deepEqual(keep, {
      path: "keep.txt",
      status: "resolved",
      choice: "yours",
      badge: "deleted in theirs (side)",
      shape: "modify-delete",
      missingRole: "theirs",
    });
    assert.equal(snap.files.find((f) => f.path === "drop.txt")!.choice, "theirs");
    assert.equal(snap.resolved, 2);
    assert.equal(snap.files.length, 7, "resolved rows stay in the list for the episode");

    // Resolved outside the app: still a resolved row, just without a pill.
    r.git("add", "new.txt");
    snap = await ctx.conflictOps.snapshot();
    assert.deepEqual(snap.files.find((f) => f.path === "new.txt")!.status, "resolved");
    assert.equal(snap.files.find((f) => f.path === "new.txt")!.choice, undefined);

    // The operation ends: a new episode, no rows.
    r.git("merge", "--abort");
    snap = await ctx.conflictOps.snapshot();
    assert.equal(snap.op.kind, "none");
    assert.deepEqual(snap.files, []);
  } finally {
    r.cleanup();
  }
});

// ── Pure parts ──────────────────────────────────────────────────────────────

test("xyFromStages and shapeOfStages: git's seven unmerged codes", () => {
  const cases: Array<[number[], string, string, 2 | 3 | undefined]> = [
    [[1, 2, 3], "UU", "text", undefined],
    [[2, 3], "AA", "added-both", undefined],
    [[1], "DD", "both-deleted", undefined],
    [[1, 2], "UD", "modify-delete", 3],
    [[1, 3], "DU", "modify-delete", 2],
    [[2], "AU", "added-one-side", 3],
    [[3], "UA", "added-one-side", 2],
  ];
  for (const [stages, xy, shape, missing] of cases) {
    assert.equal(xyFromStages(stages), xy, stages.join());
    assert.deepEqual(shapeOfStages(new Set(stages)), missing ? { shape, missing } : { shape }, stages.join());
  }
});

test("badgeFor names the role AND the side's name, and nothing for both-modified", () => {
  const side = (role: "yours" | "theirs", stage: 2 | 3, name: string) => ({
    role,
    stage,
    name,
    paneTitle: "",
    description: "",
  });
  const rebase = { kind: "rebase", yours: side("yours", 3, "test"), theirs: side("theirs", 2, "master") } as Pick<
    OperationView,
    "kind" | "yours" | "theirs"
  >;
  assert.equal(badgeFor("DU", rebase), "deleted in theirs (master)");
  assert.equal(badgeFor("UD", rebase), "deleted in yours (test)");
  assert.equal(badgeFor("AU", rebase), "added in theirs (master)");
  assert.equal(badgeFor("UU", rebase), "");
  const none = { ...rebase, kind: "none", yours: side("yours", 2, "master"), theirs: side("theirs", 3, "incoming") } as typeof rebase;
  assert.equal(badgeFor("DU", none), "deleted in yours", "no invented names when nothing is stopped");
});

test("parseUnmergedStages keeps raw paths, including a newline in the name", () => {
  const out = parseUnmergedStages(
    ["100644 aaaa 1\tweird\nname.txt", "100644 bbbb 2\tweird\nname.txt", "100755 cccc 3\tx", ""].join("\u0000"),
  );
  assert.deepEqual([...out.keys()], ["weird\nname.txt", "x"]);
  assert.deepEqual([...out.get("weird\nname.txt")!.keys()], [1, 2]);
  assert.equal(out.get("x")!.get(3)!.mode, "100755");
});
