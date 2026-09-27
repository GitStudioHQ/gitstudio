// The desktop's Undo, as a STATE TABLE — every git operation the app registers
// an undo for (renderer/undo.ts's didUndoable / push) × the starting states
// that change what that undo does.
//
// The desktop does not share the extension's ledger: each action records its
// OWN reversal. So each cell runs the main-process handler the renderer
// invokes for the action (GitBridge / RebaseBridge, real git), builds the undo
// exactly as renderer.ts builds it from that handler's answer — the same
// channel, the same fields — and runs it the way undo.ts's run() does: a
// string is a failure toast, `{ info }` an expected refusal, anything else
// success. Drop Commit goes through the renderer's own dropCommitFlow.
//
// The assertions are what a user expects the Undo to do. A failing cell is a
// repro. Nothing in src/ is changed by this file.
//
// UNDO_AUDIT_SCRATCH  — where the scratch repos go (default: the OS tmpdir)
// UNDO_AUDIT_OUT      — write every cell's measured states here as JSON

import "./hermeticGit";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitBridge } from "../src/main/gitBridge";
import { RebaseBridge } from "../src/main/rebaseBridge";
import { RepoStore } from "../src/main/repoStore";
import { dropCommitFlow } from "../src/renderer/dropCommit";
import { runManyAction } from "../src/renderer/multiCommit";
import type { Undoable, UndoResult } from "../src/renderer/undo";

const ROOT = process.env.UNDO_AUDIT_SCRATCH || tmpdir();
mkdirSync(ROOT, { recursive: true });
// os.tmpdir()'s own spelling, never resolved. RepoStore opens the repository
// by git's spelling (/private/var/… on macOS, C:/Users/runneradmin/… on a
// Windows runner), and the reset cells hand `root` back to main in this one
// (/var/…, C:\Users\RUNNER~1\…): main compares them as folders, not as text —
// compared as text they were refused as "another repository".
const scratch = mkdtempSync(join(ROOT, "desktop-undo-"));
let seq = 0;

// ── Fixture ──────────────────────────────────────────────────────────────────

interface Fx {
  dir: string;
  remote: string;
  git: (...a: string[]) => string;
  inRemote: (...a: string[]) => string;
  commit: (msg: string, file?: string, body?: string) => string;
  write: (file: string, body: string) => void;
  read: (file: string) => string | null;
  bridge: GitBridge;
  rebase: RebaseBridge;
  memo: Record<string, string>;
}

/** main: "base" (f.txt = "base\n"), pushed to origin/main. */
async function fx(): Promise<Fx> {
  const base = join(scratch, `c${++seq}`);
  mkdirSync(base, { recursive: true });
  const remote = join(base, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const dir = join(base, "work");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const run = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const git = (...a: string[]) => run(dir, ...a);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"], ["core.autocrlf", "false"]]) {
    git("config", k, v);
  }
  git("remote", "add", "origin", remote);
  const write = (file: string, body: string) => writeFileSync(join(dir, file), body);
  const read = (file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : null);
  const commit = (msg: string, file = `${msg}.txt`, body = `${msg}\n`) => {
    write(file, body);
    git("add", "-A");
    git("commit", "-qm", msg);
    return git("rev-parse", "HEAD");
  };
  commit("base", "f.txt", "base\n");
  git("push", "-q", "-u", "origin", "refs/heads/main:refs/heads/main");
  const repos = new RepoStore([]);
  await repos.open(dir);
  return {
    dir,
    remote,
    git,
    inRemote: (...a) => run(remote, ...a),
    commit,
    write,
    read,
    bridge: new GitBridge(repos),
    rebase: new RebaseBridge(repos),
    memo: {},
  };
}

// ── What the repository looks like ───────────────────────────────────────────

interface RepoState {
  head: string;
  refs: Record<string, string>;
  status: string[];
  stashes: string[];
  op: string;
}

function subjectOf(f: Fx, sha: string, cwd?: string): string {
  const g = (...a: string[]) => execFileSync("git", a, { cwd: cwd ?? f.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    const t = g("cat-file", "-t", sha);
    const s = t === "tag" ? `tag-object→${g("log", "-1", "--format=%s", `${sha}^{commit}`)}` : g("log", "-1", "--format=%s", sha);
    return `${s}(${sha.slice(0, 7)})`;
  } catch {
    return sha.slice(0, 7);
  }
}

function state(f: Fx): RepoState {
  let head: string;
  try {
    head = f.git("symbolic-ref", "-q", "HEAD").replace(/^refs\/heads\//, "");
  } catch {
    head = "(detached)";
  }
  const refs: Record<string, string> = {};
  for (const line of f.git("for-each-ref", "--format=%(refname) %(objectname) %(upstream:short)", "refs/heads", "refs/tags", "refs/remotes").split("\n").filter(Boolean)) {
    const [name, sha, up] = line.split(" ");
    if (name.endsWith("/HEAD")) continue;
    const key = name.replace(/^refs\/(heads|tags|remotes)\//, (_m, ns) => (ns === "heads" ? "" : ns === "tags" ? "tag:" : "remote:"));
    refs[key] = subjectOf(f, sha) + (up ? `→${up}` : "");
  }
  // The remote's own branches — what a delete/restore on origin changed.
  for (const line of f.inRemote("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads").split("\n").filter(Boolean)) {
    const [name, sha] = line.split(" ");
    refs[`origin.git:${name.replace(/^refs\/heads\//, "")}`] = subjectOf(f, sha, f.remote);
  }
  const status = execFileSync("git", ["status", "--porcelain=v1"], { cwd: f.dir, encoding: "utf8" }).split("\n").filter(Boolean).sort();
  const stashes = f.git("stash", "list", "--format=%gd %s").split("\n").filter(Boolean);
  const gitDir = join(f.dir, ".git");
  const op = [
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["rebase-merge", "rebase"],
  ]
    .filter(([p]) => existsSync(join(gitDir, p)))
    .map(([, n]) => n)
    .join(",");
  return { head: `${head} @ ${subjectOf(f, f.git("rev-parse", "HEAD"))}`, refs, status, stashes, op: op || "none" };
}

function describe(s: RepoState): string {
  const refs = Object.entries(s.refs).map(([k, v]) => `${k}=${v}`).join(", ");
  return (
    `HEAD=${s.head} | ${refs} | tree: ${s.status.length ? s.status.join("; ") : "clean"}` +
    ` | stash: ${s.stashes.length ? s.stashes.join("; ") : "none"}` +
    (s.op !== "none" ? ` | in progress: ${s.op}` : "")
  );
}

// ── Running an undo the way renderer/undo.ts's run() does ────────────────────

interface Ran {
  toast: string;
  kind: "success" | "error" | "info";
}
async function runUndo(action: Undoable): Promise<Ran> {
  let failure: UndoResult;
  try {
    failure = await action.undo();
  } catch (e) {
    return { kind: "error", toast: e instanceof Error ? e.message : "Couldn't undo that." };
  }
  if (typeof failure === "string" && failure) return { kind: "error", toast: failure };
  if (failure && typeof failure === "object" && failure.info) return { kind: "info", toast: failure.info };
  await action.after?.();
  return { kind: "success", toast: `Undone — ${action.label}.` };
}

// ── Recording ────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  operation: string;
  state: string;
  expected: string;
  before: string;
  afterOp: string;
  afterUndo: string;
  undoToast: string;
  undoOffered: boolean;
  failure?: string;
  extra?: Record<string, unknown>;
}
const rows: Row[] = [];
after(() => {
  if (process.env.UNDO_AUDIT_OUT) writeFileSync(process.env.UNDO_AUDIT_OUT, JSON.stringify(rows, null, 2));
});

interface CellSpec {
  id: string;
  operation: string;
  state: string;
  expected: string;
  setup: (f: Fx) => void | Promise<void>;
  /** Run the action; return the undo the renderer would register (or undefined: none offered). */
  op: (f: Fx) => Promise<Undoable | undefined>;
  between?: (f: Fx) => void | Promise<void>;
  expect: (f: Fx, s: RepoState, ctx: { ran: Ran | undefined; row: Row }) => void | Promise<void>;
}

function cell(spec: CellSpec): void {
  test(`${spec.id} ${spec.operation} — ${spec.state}`, async () => {
    const f = await fx();
    const row: Row = {
      id: spec.id,
      operation: spec.operation,
      state: spec.state,
      expected: spec.expected,
      before: "",
      afterOp: "",
      afterUndo: "",
      undoToast: "",
      undoOffered: false,
    };
    rows.push(row);
    await spec.setup(f);
    row.before = describe(state(f));
    const action = await spec.op(f);
    row.undoOffered = !!action;
    row.afterOp = describe(state(f)) + (action ? ` | undo offered: "${action.label}"` : " | no undo offered");
    if (spec.between) await spec.between(f);
    const ran = action ? await runUndo(action) : undefined;
    row.undoToast = ran ? `${ran.kind}: ${ran.toast}` : "(nothing on the undo stack)";
    const s = state(f);
    row.afterUndo = describe(s);
    try {
      await spec.expect(f, s, { ran, row });
    } catch (err) {
      row.failure = err instanceof Error ? err.message.split("\n")[0] : String(err);
      throw err;
    }
  });
}

const sha = (f: Fx, rev: string) => f.git("rev-parse", rev);
const hasRef = (f: Fx, ref: string): boolean => {
  try {
    f.git("rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
};

// ── The renderer's undo closures, as renderer.ts builds them ─────────────────

/** Branches view → Delete (renderer.ts deleteBranch): force on "not fully merged". */
async function deleteBranchLikeRenderer(f: Fx, name: string): Promise<Undoable | undefined> {
  const fullName = `refs/heads/${name}`;
  let r = await f.bridge.branchDelete({ fullName });
  if (!r.ok && r.message && /not fully merged/i.test(r.message)) {
    r = await f.bridge.branchDelete({ fullName, force: true });
  }
  assert.equal(r.ok, true, r.message);
  const restore = r.was;
  const upstream = r.upstream;
  if (!restore) return undefined;
  return {
    label: `Restore ${name}`,
    undo: async () => {
      const back = await f.bridge.branchCreate({ name, startPoint: restore, upstream });
      if (!back.ok) return back.message ?? `Couldn't restore ${name}.`;
      return undefined;
    },
  };
}

// ══ Branches ═════════════════════════════════════════════════════════════════

cell({
  id: "D01",
  operation: "Delete branch (Branches view) — merged, with an upstream",
  state: "on main; feature merged, tracks origin/feature",
  expected: "feature back at the same commit, tracking origin/feature again",
  setup: (f) => {
    f.git("branch", "feature");
    f.git("push", "-q", "-u", "origin", "refs/heads/feature:refs/heads/feature");
    f.commit("M", "m.txt");
  },
  op: (f) => deleteBranchLikeRenderer(f, "feature"),
  expect: (f, s) => {
    assert.equal(s.refs.feature, `${subjectOf(f, sha(f, "main~1"))}→origin/feature`, "feature back, tracking origin/feature");
  },
});

cell({
  id: "D02",
  operation: "Delete branch (Branches view) — NOT merged, force-deleted",
  state: "on main; feature has an unmerged local commit F",
  expected: "feature back at F",
  setup: (f) => {
    f.git("checkout", "-q", "-b", "feature");
    f.memo.F = f.commit("F", "feat.txt");
    f.git("checkout", "-q", "main");
  },
  op: (f) => deleteBranchLikeRenderer(f, "feature"),
  expect: (f) => {
    assert.equal(sha(f, "refs/heads/feature"), f.memo.F, "feature back at F");
  },
});

cell({
  id: "D03",
  operation: "Delete branch (Branches view)",
  state: "a NEW branch of the same name is made (at another commit) before Undo",
  expected: "Undo refuses; the new branch is untouched",
  setup: (f) => {
    f.git("checkout", "-q", "-b", "feature");
    f.commit("F", "feat.txt");
    f.git("checkout", "-q", "main");
    f.memo.M = f.commit("M", "m.txt");
  },
  op: (f) => deleteBranchLikeRenderer(f, "feature"),
  between: (f) => f.git("branch", "feature", "main"),
  expect: (f, _s, { ran }) => {
    assert.equal(sha(f, "refs/heads/feature"), f.memo.M, "the new feature is untouched");
    assert.equal(ran?.kind, "error", "refused, in words");
  },
});

cell({
  id: "D04",
  operation: "Delete branch 'release' (Branches view) beside a TAG 'release'",
  state: "on main; branch release at R (unmerged), tag release at base",
  expected: "branch release back at R; the tag untouched",
  setup: (f) => {
    f.git("tag", "release");
    f.git("checkout", "-q", "-b", "release");
    f.memo.R = f.commit("R", "r.txt");
    f.git("checkout", "-q", "main");
  },
  op: (f) => deleteBranchLikeRenderer(f, "release"),
  expect: (f) => {
    assert.equal(sha(f, "refs/heads/release"), f.memo.R, "branch back at R");
    assert.equal(sha(f, "refs/tags/release"), sha(f, "main"), "tag untouched");
  },
});

cell({
  id: "D05",
  operation: "Delete finished branches (Branches view sweep) — two branches",
  state: "on main; done1 and done2 both merged, done1 tracks origin/done1",
  expected: "both back where they were, done1 tracking again",
  setup: (f) => {
    f.git("branch", "done1");
    f.git("push", "-q", "-u", "origin", "refs/heads/done1:refs/heads/done1");
    f.git("branch", "done2");
    f.commit("M", "m.txt");
  },
  op: async (f) => {
    // sweepFinishedBranches: sequential deletes, one undo restoring all.
    const restorable: Array<{ name: string; was: string; upstream?: string }> = [];
    for (const name of ["done1", "done2"]) {
      const r = await f.bridge.branchDelete({ fullName: `refs/heads/${name}`, force: false });
      assert.equal(r.ok, true, r.message);
      if (r.was) restorable.push({ name, was: r.was, upstream: r.upstream });
    }
    return {
      label: "Restore 2 branches",
      undo: async () => {
        const failed: string[] = [];
        for (const b of restorable) {
          const back = await f.bridge.branchCreate({ name: b.name, startPoint: b.was, upstream: b.upstream });
          if (!back.ok) failed.push(b.name);
        }
        return failed.length ? `Couldn't restore ${failed.join(", ")}.` : undefined;
      },
    };
  },
  expect: (f, s) => {
    assert.match(s.refs.done1 ?? "", /^base\(.*\)→origin\/done1$/, "done1 back, tracking");
    assert.match(s.refs.done2 ?? "", /^base\(/, "done2 back");
  },
});

cell({
  id: "D06",
  operation: "Delete remote branch origin/feature (Branches view)",
  state: "feature pushed; nobody touches origin meanwhile",
  expected: "origin/feature back at the same commit on the remote",
  setup: (f) => {
    f.git("checkout", "-q", "-b", "feature");
    f.memo.F = f.commit("F", "feat.txt");
    f.git("push", "-q", "-u", "origin", "refs/heads/feature:refs/heads/feature");
    f.git("checkout", "-q", "main");
  },
  op: async (f) => {
    const gone = await f.bridge.branchDeleteRemote({ remote: "origin", name: "feature" });
    assert.equal(gone.ok, true, gone.message);
    if (!gone.was) return undefined;
    const was = gone.was;
    return {
      label: "Push feature back to origin",
      undo: async () => {
        const back = await f.bridge.branchRestoreRemote({ remote: "origin", name: "feature", sha: was });
        return back.ok ? undefined : (back.message ?? "Couldn't push feature back.");
      },
    };
  },
  expect: (f) => {
    assert.equal(f.inRemote("rev-parse", "refs/heads/feature"), f.memo.F, "origin has feature at F again");
  },
});

cell({
  id: "D07",
  operation: "Delete remote branch origin/feature (Branches view)",
  state: "somebody RE-CREATES origin/feature (ahead of the old tip) before Undo",
  expected: "Undo refuses; their branch on origin untouched",
  setup: (f) => {
    f.git("checkout", "-q", "-b", "feature");
    f.commit("F", "feat.txt");
    f.git("push", "-q", "-u", "origin", "refs/heads/feature:refs/heads/feature");
    f.git("checkout", "-q", "main");
  },
  op: async (f) => {
    const gone = await f.bridge.branchDeleteRemote({ remote: "origin", name: "feature" });
    assert.equal(gone.ok, true, gone.message);
    const was = gone.was!;
    return {
      label: "Push feature back to origin",
      undo: async () => {
        const back = await f.bridge.branchRestoreRemote({ remote: "origin", name: "feature", sha: was });
        return back.ok ? undefined : (back.message ?? "Couldn't push feature back.");
      },
    };
  },
  between: (f) => {
    f.git("checkout", "-q", "feature");
    f.memo.G = f.commit("G", "g.txt");
    f.git("push", "-q", "origin", "refs/heads/feature:refs/heads/feature");
    f.git("checkout", "-q", "main");
  },
  expect: (f, _s, { ran }) => {
    assert.equal(f.inRemote("rev-parse", "refs/heads/feature"), f.memo.G, "their G is still the tip");
    assert.notEqual(ran?.kind, "success", "not reported as undone");
  },
});

cell({
  id: "D08",
  operation: "Delete tag (Branches view) — annotated",
  state: "annotated tag v1 on base",
  expected: "v1 back, still ANNOTATED (same tag object)",
  setup: (f) => {
    f.git("tag", "-a", "v1", "-m", "release one");
    f.memo.tagObject = sha(f, "refs/tags/v1");
  },
  op: async (f) => {
    const r = await f.bridge.tagDelete("v1");
    assert.equal(r.ok, true, r.message);
    const was = r.was!;
    return {
      label: "Put v1 back",
      undo: async () => {
        const back = await f.bridge.tagRestore({ name: "v1", sha: was });
        return back.ok ? undefined : (back.message ?? "Couldn't put v1 back.");
      },
    };
  },
  expect: (f) => {
    assert.equal(sha(f, "refs/tags/v1"), f.memo.tagObject, "the same tag object");
    assert.equal(f.git("cat-file", "-t", "refs/tags/v1"), "tag", "annotated");
  },
});

cell({
  id: "D09",
  operation: "Drop stash (Stashes) — the MIDDLE of three",
  state: "stash@{0}=three, stash@{1}=two, stash@{2}=one; drop stash@{1}",
  expected: "'two' back — at stash@{1}, where it was",
  setup: (f) => {
    for (const m of ["one", "two", "three"]) {
      f.write("f.txt", `${m}\n`);
      f.git("stash", "push", "-q", "-m", m);
    }
  },
  op: async (f) => {
    const list = await f.bridge.stashList();
    const st = list.find((x) => x.ref === "stash@{1}")!;
    const r = await f.bridge.stashDrop(st.ref);
    assert.equal(r.ok, true, r.message);
    return {
      label: "Put the stash back",
      undo: async () => {
        const back = await f.bridge.stashRestore({ sha: st.sha, message: st.message });
        return back.ok ? undefined : (back.message ?? "Couldn't put the stash back.");
      },
    };
  },
  expect: (_f, s, { row }) => {
    row.extra = { stashOrderAfterUndo: s.stashes };
    assert.ok(s.stashes.some((l) => /\btwo$/.test(l)), "two is back");
    assert.match(s.stashes[1] ?? "", /\btwo$/, "at stash@{1}, where it was");
  },
});

cell({
  id: "D09b",
  operation: "Drop stash (Stashes list / stash page) — the MIDDLE of three, named by SHA as both send it",
  state: "stash@{0}=three, stash@{1}=two, stash@{2}=one; drop two by its sha",
  expected: "'two' back — at stash@{1}, where it was, not on top",
  setup: (f) => {
    for (const m of ["one", "two", "three"]) {
      f.write("f.txt", `${m}\n`);
      f.git("stash", "push", "-q", "-m", m);
    }
  },
  op: async (f) => {
    const list = await f.bridge.stashList();
    const st = list.find((x) => x.ref === "stash@{1}")!;
    // What renderer.ts stashActLive and refDetail.ts stashAct send: the sha.
    const r = await f.bridge.stashDrop(st.sha);
    assert.equal(r.ok, true, r.message);
    return {
      label: "Put the stash back",
      undo: async () => {
        const back = await f.bridge.stashRestore({ sha: st.sha, message: st.message });
        return back.ok ? undefined : (back.message ?? "Couldn't put the stash back.");
      },
    };
  },
  expect: (_f, s, { row }) => {
    row.extra = { stashOrderAfterUndo: s.stashes };
    assert.ok(s.stashes.some((l) => /\btwo$/.test(l)), "two is back");
    assert.match(s.stashes[1] ?? "", /\btwo$/, "at stash@{1}, where it was");
  },
});

cell({
  id: "D10",
  operation: "Rename branch (Branches view) — local only",
  state: "feature (tracks nothing) renamed to feat2",
  expected: "feature back under its old name, same commit",
  setup: (f) => {
    f.git("checkout", "-q", "-b", "feature");
    f.memo.F = f.commit("F", "feat.txt");
    f.git("checkout", "-q", "main");
  },
  op: async (f) => {
    const r = await f.bridge.branchRename({ fullName: "refs/heads/feature", to: "feat2" });
    assert.equal(r.ok, true, r.message);
    return {
      label: "Rename feat2 back to feature",
      undo: async () => {
        const u = await f.bridge.branchRename({ fullName: "refs/heads/feat2", to: "feature" });
        return u.ok ? undefined : (u.message ?? "Couldn't rename feat2 back.");
      },
    };
  },
  expect: (f) => {
    assert.equal(sha(f, "refs/heads/feature"), f.memo.F);
    assert.equal(hasRef(f, "refs/heads/feat2"), false);
  },
});

cell({
  id: "D21",
  operation: "Rename branch (Branches view) — 'Rename on origin' (publish new name, delete the old one)",
  state: "feature tracks origin/feature; renamed to feat2 on origin too",
  expected: "feature back, origin/feature back, and feature tracking origin/feature again",
  setup: (f) => {
    f.git("checkout", "-q", "-b", "feature");
    f.memo.F = f.commit("F", "feat.txt");
    f.git("push", "-q", "-u", "origin", "refs/heads/feature:refs/heads/feature");
    f.git("checkout", "-q", "main");
  },
  op: async (f) => {
    // renameBranchFlow → reconcileUpstream's "rename" choice: branch:rename,
    // branch:publish {name: to}, branch:deleteRemote {name: old}.
    const r = await f.bridge.branchRename({ fullName: "refs/heads/feature", to: "feat2" });
    assert.equal(r.ok, true, r.message);
    const pushed = await f.bridge.branchPublishAs({ name: "feat2", remote: "origin" });
    assert.equal(pushed.ok, true, pushed.message);
    const gone = await f.bridge.branchDeleteRemote({ remote: "origin", name: "feature" });
    assert.equal(gone.ok, true, gone.message);
    const fixed = { remote: "origin", was: gone.was };
    const back = { fullName: "refs/heads/feat2", to: "feature" };
    // The renderer's closure for this variant ("Put origin/feature back").
    return {
      label: "Put origin/feature back",
      undo: async () => {
        if (fixed.was) {
          const put = await f.bridge.branchRestoreRemote({ remote: fixed.remote, name: "feature", sha: fixed.was });
          if (!put.ok) return put.message || "Couldn't put origin/feature back.";
        }
        const u = await f.bridge.branchRename(back);
        if (!u.ok) return u.message || "Couldn't rename feat2 back.";
        // …and, as the "publish" variant's closure does, points the branch
        // at its own remote branch again (renderer.ts renameBranchFlow).
        await f.bridge.branchSetUpstream({ fullName: "refs/heads/feature", upstream: "origin/feature" });
        return undefined;
      },
    };
  },
  expect: (f, s, { row }) => {
    row.extra = { featureUpstreamAfterUndo: s.refs.feature };
    assert.equal(sha(f, "refs/heads/feature"), f.memo.F, "feature back");
    assert.equal(f.inRemote("rev-parse", "refs/heads/feature"), f.memo.F, "origin/feature back");
    assert.match(s.refs.feature ?? "", /→origin\/feature$/, "feature tracks origin/feature again (not origin/feat2)");
  },
});

// ══ Reset to upstream (#32) ══════════════════════════════════════════════════

/** origin/feature = base+R; local feature = base+L (diverged). */
function diverged(f: Fx): void {
  f.git("checkout", "-q", "-b", "feature");
  f.commit("R", "r.txt");
  f.git("push", "-q", "-u", "origin", "refs/heads/feature:refs/heads/feature");
  f.git("reset", "-q", "--hard", "HEAD~1");
  f.memo.L = f.commit("L", "l.txt");
}

async function resetLikeRenderer(f: Fx): Promise<Undoable | undefined> {
  const fullName = "refs/heads/feature";
  const p = await f.bridge.branchResetPlan({ fullName });
  assert.equal(p.ok, true, p.message);
  const r = await f.bridge.branchResetToUpstream({ root: f.dir, fullName, from: p.from!, to: p.to! });
  assert.equal(r.ok, true, r.message);
  if (!r.was || !p.to) return undefined;
  const was = r.was;
  const now = p.to;
  return {
    label: "Put feature back",
    undo: async () => {
      const back = await f.bridge.branchResetUndo({ root: f.dir, fullName, was, now, snapshot: r.snapshot, current: !!r.current });
      if (!back.ok) {
        const why = back.message ?? "Couldn't put feature back.";
        return back.expected ? { info: why } : why;
      }
      return undefined;
    },
  };
}

cell({
  id: "D11",
  operation: "Reset to 'origin/feature' (Branches view)",
  state: "on feature (checked out), diverged, with an uncommitted edit",
  expected: "feature back at L with the edit",
  setup: (f) => {
    diverged(f);
    f.write("f.txt", "my edit\n");
  },
  op: resetLikeRenderer,
  expect: (f, s) => {
    assert.equal(sha(f, "refs/heads/feature"), f.memo.L);
    assert.equal(f.read("f.txt"), "my edit\n");
    assert.match(s.head, /^feature @/);
  },
});

cell({
  id: "D12",
  operation: "Reset to 'origin/feature' (Branches view)",
  state: "on main; feature NOT checked out, diverged",
  expected: "feature back at L; HEAD and main untouched",
  setup: (f) => {
    diverged(f);
    f.git("checkout", "-q", "main");
    f.write("f.txt", "edit on main\n");
  },
  op: resetLikeRenderer,
  expect: (f, s) => {
    assert.equal(sha(f, "refs/heads/feature"), f.memo.L);
    assert.match(s.head, /^main @/);
    assert.equal(f.read("f.txt"), "edit on main\n");
  },
});

// ══ Drop Commit (#32) — the renderer's own flow ═════════════════════════════

async function dropLikeRenderer(f: Fx, target: string, choice: "carry" | "only" | undefined): Promise<Undoable | undefined> {
  let offered: Undoable | undefined;
  const result = await dropCommitFlow(sha(f, target), {
    plan: (req) => f.rebase.dropPlan(req),
    drop: (req) => f.rebase.drop(req),
    undo: (req) => f.rebase.undoDrop(req),
    confirm: async () => true,
    choose: async () => choice ?? "cancel",
    toast: () => {},
    undoable: (_message, action) => {
      offered = action;
    },
    refresh: async () => {},
    landOnConflicts: async () => {},
  });
  assert.equal(result, "done", `the drop ran (${result})`);
  return offered;
}

/** main: base, A, B, C; `side` on B when asked. */
function abc(f: Fx, side = false): void {
  f.commit("A", "a.txt");
  f.memo.B = f.commit("B", "b.txt");
  if (side) f.git("branch", "side");
  f.memo.C = f.commit("C", "c.txt");
}

cell({
  id: "D13",
  operation: "Drop commit A (graph menu)",
  state: "on main (base, A, B, C local), clean",
  expected: "main back at C",
  setup: (f) => abc(f),
  op: (f) => dropLikeRenderer(f, "main~2", undefined),
  expect: (f) => {
    assert.equal(sha(f, "refs/heads/main"), f.memo.C);
  },
});

cell({
  id: "D14",
  operation: "Drop commit A (graph menu) — 'Drop and move those branches'",
  state: "on main (base, A, B, C); side on B (replayed); carry",
  expected: "main back at C AND side back at the original B",
  setup: (f) => abc(f, true),
  op: (f) => dropLikeRenderer(f, "main~2", "carry"),
  expect: (f) => {
    assert.equal(sha(f, "refs/heads/main"), f.memo.C, "main back");
    assert.equal(sha(f, "refs/heads/side"), f.memo.B, "side back on the ORIGINAL B");
  },
});

cell({
  id: "D15",
  operation: "Drop commit A (graph menu), then 'Create branch here' + switch (topic at the new tip)",
  state: "on main; after the drop the user makes and checks out topic at HEAD; Undo",
  expected: "main back at C; topic untouched (or Undo refuses)",
  setup: (f) => abc(f),
  op: (f) => dropLikeRenderer(f, "main~2", undefined),
  between: (f) => {
    f.memo.dropped = sha(f, "main");
    f.git("checkout", "-q", "-b", "topic");
  },
  expect: (f, _s, { row }) => {
    row.extra = { topicAfterUndo: subjectOf(f, sha(f, "topic")), mainAfterUndo: subjectOf(f, sha(f, "main")) };
    assert.equal(sha(f, "refs/heads/topic"), f.memo.dropped, "topic — made after the drop — is untouched");
    const mainBack = sha(f, "refs/heads/main") === f.memo.C;
    const refused = !mainBack && sha(f, "refs/heads/main") === f.memo.dropped;
    assert.ok(mainBack || refused, "main is back, or nothing moved");
  },
});

// ══ Drop N / Squash N (#32) — the renderer's own several-commit flow ════════

async function manyLikeRenderer(
  f: Fx,
  action: "drop-many" | "squash-many" | "cherry-pick-many" | "revert-many",
  targets: string[],
): Promise<Undoable | undefined> {
  let offered: Undoable | undefined;
  const result = await runManyAction(action, targets.map((t) => sha(f, t)), {
    plan: (req) => f.rebase.commitsPlan(req),
    rewrite: (req) => f.rebase.commitsRewrite(req),
    undo: (req) => f.rebase.commitsUndo(req),
    // commit:action, as bridge.ts sends it when nothing is in the way.
    apply: (req) => f.bridge.commitAction(req),
    confirm: async () => true,
    choose: async () => "cancel",
    message: async (o) => o.value,
    toast: () => {},
    undoable: (_message, action) => {
      offered = action;
    },
    refresh: async () => {},
    landOnConflicts: async () => {},
    copy: async () => {},
    compare: () => {},
  });
  assert.equal(result, "done", `the rewrite ran (${result})`);
  return offered;
}

for (const [id, action, verb] of [
  ["D15b", "squash-many", "Squash"],
  ["D15c", "drop-many", "Drop"],
] as const) {
  cell({
    id,
    operation: `${verb} 2 commits A, B (graph menu for a selection), then 'Create branch here' + switch (topic at the new tip)`,
    state: "on main (base, A, B, C); after the rewrite the user makes and checks out topic at HEAD; Undo",
    expected: "main back at C; topic untouched (or Undo refuses)",
    setup: (f) => abc(f),
    op: (f) => manyLikeRenderer(f, action, ["main~1", "main~2"]),
    between: (f) => {
      f.memo.rewritten = sha(f, "main");
      f.git("checkout", "-q", "-b", "topic");
    },
    expect: (f, _s, { row }) => {
      row.extra = { topicAfterUndo: subjectOf(f, sha(f, "topic")), mainAfterUndo: subjectOf(f, sha(f, "main")) };
      assert.equal(sha(f, "refs/heads/topic"), f.memo.rewritten, "topic — made after the rewrite — is untouched");
      const mainBack = sha(f, "refs/heads/main") === f.memo.C;
      const refused = !mainBack && sha(f, "refs/heads/main") === f.memo.rewritten;
      assert.ok(mainBack || refused, "main is back, or nothing moved");
    },
  });
}

// Cherry-pick N and Revert N: one git command over the commits (commit:action
// with `shas`), then the same commits:undo as Drop N — so the same trap: HEAD's
// commit alone can't say which branch ran it, and a branch made and checked out
// at the new tip since shares it.
for (const [id, action, verb] of [
  ["D15d", "cherry-pick-many", "Cherry-pick"],
  ["D15e", "revert-many", "Revert"],
] as const) {
  cell({
    id,
    operation: `${verb} 2 commits (graph menu for a selection), then 'Create branch here' + switch (topic at the new tip)`,
    state:
      action === "cherry-pick-many"
        ? "on main (base); side has A, B; after the pick the user makes and checks out topic at HEAD; Undo"
        : "on main (base, A, B, C); after the revert the user makes and checks out topic at HEAD; Undo",
    expected: "main back where it was; topic untouched (or Undo refuses)",
    setup: (f) => {
      if (action === "cherry-pick-many") {
        f.git("checkout", "-q", "-b", "side");
        f.memo.A = f.commit("A", "a.txt");
        f.memo.B = f.commit("B", "b.txt");
        f.git("checkout", "-q", "main");
      } else {
        abc(f);
        f.memo.A = sha(f, "main~2");
      }
      f.memo.mainBefore = sha(f, "main");
    },
    op: (f) => manyLikeRenderer(f, action, action === "cherry-pick-many" ? ["side", "side~1"] : ["main~1", "main~2"]),
    between: (f) => {
      f.memo.applied = sha(f, "main");
      f.git("checkout", "-q", "-b", "topic");
    },
    expect: (f, _s, { row }) => {
      row.extra = { topicAfterUndo: subjectOf(f, sha(f, "topic")), mainAfterUndo: subjectOf(f, sha(f, "main")) };
      assert.notEqual(f.memo.applied, f.memo.mainBefore, "the op moved main");
      assert.equal(sha(f, "refs/heads/topic"), f.memo.applied, "topic — made after the op — is untouched");
      const mainBack = sha(f, "refs/heads/main") === f.memo.mainBefore;
      const refused = !mainBack && sha(f, "refs/heads/main") === f.memo.applied;
      assert.ok(mainBack || refused, "main is back, or nothing moved");
    },
  });
}

// ══ Discard changes (Changes view) ══════════════════════════════════════════

async function discardLikeRenderer(f: Fx, paths: string[]): Promise<Undoable | undefined> {
  // renderer.ts: beforeDiscard (discard:snapshot) → discard per path → offerDiscardUndo.
  const snap = await f.bridge.discardSnapshot();
  for (const p of paths) {
    const r = await f.bridge.discard(p);
    assert.equal(r.ok, true, r.message);
  }
  if (!snap.sha) return undefined;
  const restore = { sha: snap.sha, paths };
  return {
    label: "Bring the changes back",
    undo: async () => {
      const r = await f.bridge.discardUndo(restore);
      return r.ok ? undefined : (r.message ?? "Couldn't bring them back.");
    },
  };
}

cell({
  id: "D16",
  operation: "Discard changes to f.txt (Changes view)",
  state: "f.txt has an unstaged edit",
  expected: "the edit back, unstaged",
  setup: (f) => f.write("f.txt", "my edit\n"),
  op: (f) => discardLikeRenderer(f, ["f.txt"]),
  expect: (f, s) => {
    assert.equal(f.read("f.txt"), "my edit\n");
    assert.deepEqual(s.status, [" M f.txt"]);
  },
});

cell({
  id: "D17",
  operation: "Discard changes to f.txt (Changes view), then the user edits f.txt again",
  state: "f.txt edit discarded; a NEW edit typed into f.txt before Undo",
  expected: "the new edit is kept (or Undo refuses / says it will be replaced)",
  setup: (f) => f.write("f.txt", "first edit\n"),
  op: (f) => discardLikeRenderer(f, ["f.txt"]),
  between: (f) => f.write("f.txt", "second edit, typed after the discard\n"),
  expect: (f, _s, { ran }) => {
    assert.ok(
      f.read("f.txt") === "second edit, typed after the discard\n" || ran?.kind !== "success",
      `the later edit was overwritten by Undo (f.txt is now ${JSON.stringify(f.read("f.txt"))}; toast: ${ran?.toast})`,
    );
  },
});

// ══ Conflicts dashboard: Accept Yours / Theirs (⌘Z brings the conflict back) ═

function conflictedMerge(f: Fx): void {
  f.commit("M", "f.txt", "main's line\n");
  f.git("checkout", "-q", "-b", "feature", "HEAD~1");
  f.commit("F", "f.txt", "feature's line\n");
  f.git("checkout", "-q", "main");
  try {
    f.git("merge", "feature");
  } catch {
    /* the conflict is the point */
  }
}

async function acceptLikeRenderer(f: Fx, path: string): Promise<Undoable | undefined> {
  // mergeParity.ts runFileVerb: conflict:takeRole, then the pushed undo.
  const r = await f.bridge.conflictTakeRole({ path, role: "yours" });
  assert.equal(r.ok, true, r.message);
  return {
    label: `Bring back the conflict in ${path}`,
    undo: async () => {
      const back = await f.bridge.conflictRestore({ path });
      // restoreResult(): a refusal is said, not thrown.
      if (!back.ok) return back.expected ? { info: back.message ?? "" } : (back.message ?? "Couldn't.");
      return undefined;
    },
  };
}

cell({
  id: "D18",
  operation: "Accept Yours on f.txt (conflicts dashboard) during a merge",
  state: "merge of feature stopped, f.txt conflicted",
  expected: "f.txt conflicted again (markers back), merge still in progress",
  setup: conflictedMerge,
  op: (f) => acceptLikeRenderer(f, "f.txt"),
  expect: (f, s) => {
    assert.deepEqual(s.status, ["UU f.txt"]);
    assert.match(f.read("f.txt") ?? "", /<<<<<<<[\s\S]*>>>>>>>/);
    assert.equal(s.op, "merge");
  },
});

cell({
  id: "D19",
  operation: "Accept Yours on f.txt (conflicts dashboard), then the user edits f.txt further",
  state: "merge in progress; f.txt resolved + staged, then hand-edited (unstaged) before ⌘Z",
  expected: "the hand edit is kept (or ⌘Z refuses / says it will be replaced)",
  setup: conflictedMerge,
  op: (f) => acceptLikeRenderer(f, "f.txt"),
  between: (f) => f.write("f.txt", "main's line, polished by hand\n"),
  expect: (f, _s, { ran }) => {
    assert.ok(
      f.read("f.txt") === "main's line, polished by hand\n" || ran?.kind !== "success",
      `the hand edit was overwritten by conflict markers (toast: ${ran?.toast})`,
    );
  },
});

cell({
  id: "D20",
  operation: "Accept Yours on f.txt (conflicts dashboard), then the merge is COMMITTED",
  state: "merge finished before ⌘Z",
  expected: "⌘Z refuses in words; the committed merge untouched",
  setup: conflictedMerge,
  op: (f) => acceptLikeRenderer(f, "f.txt"),
  between: (f) => f.git("commit", "-q", "--no-edit"),
  expect: (f, s, { ran }) => {
    assert.equal(ran?.kind, "info", `refused as expected (${ran?.toast})`);
    assert.deepEqual(s.status, []);
    assert.equal(s.op, "none");
    assert.equal(f.read("f.txt"), "main's line\n");
  },
});
