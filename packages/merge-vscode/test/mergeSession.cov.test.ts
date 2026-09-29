import { test } from "node:test";
import assert from "node:assert/strict";
import type { OperationOutcome, OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import type { HostMessage } from "@gitstudio/host-bridge/protocol";
import { MergeSession, type MergeSessionDeps, type SessionGit } from "../src/mergeSession";
import { stageResolvedPath } from "../src/stageResolved";
import { view } from "./fixtures";

// The merge editor's session (mergeSession.ts) where git or the file is not
// what the happy path expects: no repository, git failing mid-way, an Undo
// that can no longer run. What the page and the user are told each time.

interface Knobs {
  view?: OperationView;
  viewFails?: boolean;
  detectFails?: boolean;
  readSidesFails?: boolean;
  isConflicted?: boolean | Error;
  restore?: { ok: boolean; changed: boolean; message?: string; expected?: boolean };
  takeRole?: { ok: boolean; changed: boolean; message?: string; expected?: boolean } | Error;
  continueOutcome?: OperationOutcome | Error;
  /** rev-parse HEAD's answer (a throw when an Error). */
  head?: string | Error;
  calls: string[];
}

function fakeGit(k: Knobs): SessionGit {
  const v = () => k.view ?? view("rebase");
  return {
    operation: {
      view: async () => {
        if (k.viewFails) throw new Error("git is busy");
        return v();
      },
      detect: async () => {
        if (k.detectFails) throw new Error("git is busy");
        return { kind: v().kind, unmerged: 1 };
      },
      continue: async () => {
        k.calls.push("continue");
        const r = k.continueOutcome ?? { ok: true, view: view("none"), remainingConflicts: 0 };
        if (r instanceof Error) throw r;
        return r;
      },
      abort: async () => {
        k.calls.push("abort");
        return { ok: true, view: view("none"), remainingConflicts: 0 };
      },
    },
    conflictOps: {
      readSides: async (path: string) => {
        if (k.readSidesFails) throw new Error("bad object 1234abcd");
        return { op: v(), path, shape: "text", hasBase: true, source: "git-stages", base: "b\n", yours: "y\n", theirs: "t\n" };
      },
      takeRole: async (path: string, role: string) => {
        k.calls.push(`takeRole:${path}:${role}`);
        const r = k.takeRole ?? { ok: true, changed: true };
        if (r instanceof Error) throw r;
        return r;
      },
      deleteFile: async (path: string) => {
        k.calls.push(`delete:${path}`);
        return { ok: true, changed: true };
      },
      noteChoice: (path: string, choice: string) => k.calls.push(`note:${path}:${choice}`),
      restore: async (path: string) => {
        k.calls.push(`restore:${path}`);
        return k.restore ?? { ok: true, changed: true };
      },
    },
    conflict: {
      isConflicted: async () => {
        if (k.isConflicted instanceof Error) throw k.isConflicted;
        return k.isConflicted ?? false;
      },
    },
    process: {
      run: async (args: string[]) => {
        k.calls.push(`git ${args.join(" ")}`);
        if (args[0] === "rev-parse") {
          if (k.head instanceof Error) throw k.head;
          return { code: 0, stdout: `${k.head ?? "abc123"}\n`, stderr: "" };
        }
        return { code: 0, stderr: "" };
      },
    },
  } as unknown as SessionGit;
}

function harness(git: SessionGit | undefined, extra: Partial<MergeSessionDeps> = {}) {
  const posts: HostMessage[] = [];
  const notes: { kind: string; text: string }[] = [];
  const deps: MergeSessionDeps = {
    git,
    rel: git ? "a.txt" : undefined,
    fileName: "/r/a.txt",
    workingText: () => "<<<<<<< ours\ny\n=======\nt\n>>>>>>> theirs\n",
    save: async () => {},
    post: (m) => posts.push(m),
    settings: () => ({ autoApplyNonConflicting: false }),
    notify: (kind, text) => notes.push({ kind, text }),
    ...extra,
  };
  return { posts, notes, deps };
}

const types = (posts: HostMessage[]) => posts.map((p) => p.type);

test("init: a conflict whose versions git cannot read is said, and the page is sent nothing half-read", async () => {
  const h = harness(fakeGit({ calls: [], readSidesFails: true }));
  await new MergeSession(h.deps).init();
  assert.deepEqual(h.posts, []);
  assert.deepEqual(h.notes, [{ kind: "error", text: "couldn't read the conflict versions — bad object 1234abcd" }]);
});

test("init: the product's one-time tip for this stop goes out with the sides", async () => {
  const seen: (OperationView | undefined)[] = [];
  const h = harness(fakeGit({ calls: [] }), {
    tip: (op) => {
      seen.push(op);
      return { id: "tip.key", text: "Yours is your commit, on the left." };
    },
  });
  await new MergeSession(h.deps).init();
  assert.equal(h.posts.length, 1);
  const init = h.posts[0] as Extract<HostMessage, { type: "init" }>;
  assert.deepEqual(init.tip, { id: "tip.key", text: "Yours is your commit, on the left." });
  assert.equal(seen[0]?.kind, "rebase", "asked for THIS stop's tip");
});

test("init: no tip for this stop leaves the payload without one", async () => {
  const h = harness(fakeGit({ calls: [] }), { tip: () => undefined });
  await new MergeSession(h.deps).init();
  assert.equal((h.posts[0] as { tip?: unknown }).tip, undefined);
});

test("outside a repository: whole-file resolutions, verbs and Undo say there is no git, and touch nothing", async () => {
  let changed = 0;
  const h = harness(undefined, { changed: () => changed++ });
  const s = new MergeSession(h.deps);
  await s.takeRole("yours");
  await s.deleteFile();
  await s.continueOperation();
  await s.abortOperation();
  await s.undoApply();
  assert.equal(await s.postOpChanged(), undefined);
  assert.deepEqual(h.posts, [
    { type: "applied", staged: false, message: "This file is not in a Git repository, so there is no conflict to resolve." },
    { type: "applied", staged: false, message: "This file is not in a Git repository, so there is no conflict to resolve." },
    { type: "outcome", kind: "failed", text: "This file is not in a Git repository." },
    { type: "outcome", kind: "failed", text: "This file is not in a Git repository." },
  ]);
  assert.equal(changed, 0);
});

test("a whole-file resolution git throws on is reported as an error and shown unapplied", async () => {
  const calls: string[] = [];
  const h = harness(fakeGit({ calls, takeRole: new Error("fatal: unable to write new index file") }));
  await new MergeSession(h.deps).takeRole("theirs");
  assert.deepEqual(calls, ["takeRole:a.txt:theirs"]);
  assert.deepEqual(h.notes, [{ kind: "error", text: "fatal: unable to write new index file" }]);
  assert.deepEqual(h.posts[0], { type: "applied", staged: false, message: "fatal: unable to write new index file" });
  assert.equal(h.posts[1].type, "opChanged");
});

test("a whole-file resolution git refuses unexpectedly is an error toast; an expected one is only inline", async () => {
  const calls: string[] = [];
  const k: Knobs = { calls, takeRole: { ok: false, changed: false, message: "could not checkout a.txt" } };
  const h = harness(fakeGit(k));
  const s = new MergeSession(h.deps);
  await s.takeRole("yours");
  k.takeRole = { ok: false, changed: false, expected: true, message: "a.txt has no Yours version." };
  await s.takeRole("yours");
  assert.deepEqual(h.notes, [{ kind: "error", text: "could not checkout a.txt" }]);
  const applied = h.posts.filter((p) => p.type === "applied");
  assert.deepEqual(applied, [
    { type: "applied", staged: false, message: "could not checkout a.txt" },
    { type: "applied", staged: false, message: "a.txt has no Yours version." },
  ]);
});

test("when the operation cannot be re-read, the page keeps its last state and nothing breaks", async () => {
  const h = harness(fakeGit({ calls: [], detectFails: true }));
  const s = new MergeSession(h.deps);
  assert.equal(await s.postOpChanged(), undefined);
  await s.takeRole("yours");
  assert.deepEqual(types(h.posts), ["applied"], "no opChanged when git would not say");
});

test("a Continue that throws is shown as failed, capitalised, and nothing else is posted", async () => {
  const calls: string[] = [];
  const h = harness(fakeGit({ calls, continueOutcome: new Error("could not read .git/rebase-merge/done") }));
  await new MergeSession(h.deps).continueOperation();
  assert.deepEqual(h.posts, [{ type: "outcome", kind: "failed", text: "Could not read .git/rebase-merge/done" }]);
});

test("a Continue that stops again, where git cannot say whether THIS file conflicts, keeps the page as it is", async () => {
  const calls: string[] = [];
  const h = harness(
    fakeGit({
      calls,
      isConflicted: new Error("git is busy"),
      continueOutcome: { ok: false, stopped: true, expected: true, view: view("rebase", { episode: "rebase:2" }), remainingConflicts: 1 },
    }),
  );
  await new MergeSession(h.deps).continueOperation();
  assert.deepEqual(types(h.posts), ["outcome", "opChanged"], "no re-init");
});

test("Undo: a restore git refuses is said, as a warning when expected, and shown on the page", async () => {
  const calls: string[] = [];
  const k: Knobs = { calls, restore: { ok: false, changed: false, expected: true, message: "the merge is over." } };
  const h = harness(fakeGit(k));
  const s = new MergeSession(h.deps);
  await s.undoApply();
  k.restore = { ok: false, changed: false };
  await s.undoApply();
  assert.deepEqual(h.notes, [
    { kind: "warn", text: "the merge is over." },
    { kind: "error", text: "couldn't restore the conflict." },
  ]);
  assert.deepEqual(h.posts, [
    { type: "outcome", kind: "failed", text: "The merge is over." },
    { type: "outcome", kind: "failed", text: "Couldn't restore the conflict." },
  ]);
});

test("Undo that worked re-reads the sides from what git wrote to disk", async () => {
  const calls: string[] = [];
  let changed = 0;
  const h = harness(fakeGit({ calls }), {
    diskText: async () => "<<<<<<< ours\nfrom disk\n=======\nt\n>>>>>>> theirs\n",
    changed: () => changed++,
  });
  await new MergeSession(h.deps).undoApply();
  assert.deepEqual(calls, ["restore:a.txt"]);
  assert.equal(changed, 1);
  assert.deepEqual(types(h.posts), ["opChanged", "init"]);
});

test("an Apply that resolves a conflict with no way to read the file back offers no Undo — only says it is staged", async () => {
  const calls: string[] = [];
  const offered: string[] = [];
  const h = harness(fakeGit({ calls, isConflicted: true }), {
    offerUndo: (text) => offered.push(text),
    // no diskText: the Undo could not check the file is still what the Apply wrote
  });
  await new MergeSession(h.deps).apply("resolved\n");
  assert.deepEqual(offered, []);
  assert.deepEqual(h.posts[0], { type: "applied", staged: true, message: undefined });
  assert.deepEqual(h.notes, [{ kind: "info", text: "resolved file saved and staged." }]);
});

test("HEAD that git will not report still allows an Undo while the file and the stop are unchanged", async () => {
  const calls: string[] = [];
  const offered: (() => Promise<void>)[] = [];
  const disk = "resolved\n";
  const h = harness(fakeGit({ calls, isConflicted: true, head: new Error("spawn EAGAIN") }), {
    diskText: async () => disk,
    offerUndo: (_text, undo) => offered.push(undo),
  });
  await new MergeSession(h.deps).apply(disk);
  assert.equal(offered.length, 1);
  assert.equal((h.posts[0] as { undoable?: boolean }).undoable, true);
  await offered[0]();
  assert.ok(calls.includes("restore:a.txt"), "the conflict is brought back");
});

test("an Undo after git moved to another stop refuses, and says nothing was changed", async () => {
  const calls: string[] = [];
  const offered: (() => Promise<void>)[] = [];
  const k: Knobs = { calls, isConflicted: true };
  const h = harness(fakeGit(k), {
    diskText: async () => "resolved\n",
    offerUndo: (_text, undo) => offered.push(undo),
  });
  await new MergeSession(h.deps).apply("resolved\n");
  k.view = view("rebase", { episode: "rebase:7" });
  await offered[0]();
  assert.ok(!calls.includes("restore:a.txt"));
  const text = "git has moved on since that Apply, so there is no conflict to bring back. Nothing was changed.";
  assert.deepEqual(h.notes[h.notes.length - 1], { kind: "info", text });
  assert.deepEqual(h.posts[h.posts.length - 1], { type: "outcome", kind: "failed", text: "Git has moved on since that Apply, so there is no conflict to bring back. Nothing was changed." });
});

test("staging a resolved file when git cannot even be started says so, in the words the page shows", async () => {
  const r = await stageResolvedPath(
    {
      run: async () => {
        throw new Error("spawn git ENOENT");
      },
    },
    "a.txt",
  );
  assert.deepEqual(r, {
    staged: false,
    message: "The file is saved, but git could not stage it (spawn git ENOENT). Stage it with git add before you continue.",
  });
});

test("a refused git add with nothing on stderr names its exit code", async () => {
  const r = await stageResolvedPath({ run: async () => ({ code: 128, stderr: "\n  \n" }) }, "a.txt");
  assert.equal(r.staged, false);
  assert.match(r.message ?? "", /git could not stage it \(git add exited with 128\)/);
});
