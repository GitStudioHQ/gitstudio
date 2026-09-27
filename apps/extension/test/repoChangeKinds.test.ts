// RepoManager's change event says WHAT moved, and the subscribers that show
// history act only on what can have moved it.
//
// vscode.git fires its state event on every `git status` it runs — a save, a
// window focus — and every subscriber reloaded everything on it: all three
// commit-graph surfaces re-read their log, refs and layout (~90 KB each), blame
// dropped every cached file, the Timeline emptied. Only the working tree had
// moved. Now the event carries kinds (repoChange.ts), from where it came:
// vscode.git's state with HEAD / upstream / counts unchanged is the working
// tree; a different HEAD, the refs/ watcher or HEAD's own file is a ref move;
// the operation-state files are an operation; repositories opening, closing or
// the active one moving is everything.
//
// Three halves: the classification (pure), RepoManager against a real
// repository with vscode.git's events played through a stand-in, and the
// subscribers — the graph's plan (pure table), and at source level that the
// graph, blame and the Timeline route their handlers through it.

import Module from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  classifyStateEvent,
  headSignature,
  repoChange,
  touches,
  type RepoChangeKind,
} from "../src/git/repoChange";
import { planGraphRefresh } from "../src/graph/refreshPlan";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeRepoStub.cjs") : resolve.call(this, request, ...rest);
};

interface FakeWatcher {
  pattern: { base: { fsPath: string }; pattern: string };
  fire(kind?: "create" | "change" | "delete"): void;
}
interface FakeRepo {
  rootUri: { fsPath: string };
  state: { HEAD: Record<string, unknown> };
  __fireState(): void;
}
interface Harness {
  setFolders(folders: { name: string; fsPath: string }[]): void;
  reset(opts?: { repositories?: unknown[]; state?: "initialized" | "uninitialized" }): void;
  repository(root: string, head?: Record<string, unknown>): FakeRepo;
  gitOpen(repo: unknown): void;
  watchers: FakeWatcher[];
}

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { __test: vs } = require("vscode") as { __test: Harness };
const { RepoManager } = require("../src/git/repoManager") as typeof import("../src/git/repoManager");
/* eslint-enable @typescript-eslint/no-require-imports */

// ── The classification ───────────────────────────────────────────────────────

test("touches: an event says which kinds it carries; one that says none touches everything", () => {
  const wt = repoChange(["workingTree"]);
  assert.equal(touches(wt, "workingTree"), true);
  assert.equal(touches(wt, "refs", "operation", "repos"), false);
  assert.equal(touches(repoChange(["refs"]), "refs", "operation"), true);
  assert.equal(touches(undefined, "refs"), true, "an older fire() with no event");
  assert.equal(touches(repoChange([]), "refs"), true);
});

test("a vscode.git state event is a ref move only when HEAD, its upstream, the counts or a rebase stop moved", () => {
  const base = { HEAD: { name: "main", commit: "a1", upstream: { remote: "origin", name: "main" }, ahead: 0, behind: 0 } };
  const sig = headSignature(base);
  const cells: [string, unknown, RepoChangeKind[]][] = [
    ["nothing ref-ish changed (a save, a focus)", base, ["workingTree"]],
    ["a commit", { HEAD: { ...base.HEAD, commit: "b2" } }, ["refs", "workingTree"]],
    ["a checkout", { HEAD: { ...base.HEAD, name: "feature" } }, ["refs", "workingTree"]],
    ["a fetch that found more", { HEAD: { ...base.HEAD, behind: 3 } }, ["refs", "workingTree"]],
    ["a push", { HEAD: { ...base.HEAD, ahead: 0, behind: 0, upstream: { remote: "fork", name: "main" } } }, ["refs", "workingTree"]],
    ["a rebase stop", { ...base, rebaseCommit: { hash: "c3" } }, ["refs", "workingTree"]],
  ];
  for (const [name, state, want] of cells) {
    assert.deepEqual(classifyStateEvent(sig, headSignature(state as never)), want, name);
  }
  assert.deepEqual(classifyStateEvent(undefined, sig), ["refs", "workingTree"], "a first sighting is everything");
});

// ── RepoManager, against a real repository ───────────────────────────────────

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "gs-repo-change-")));
after(() => rmSync(scratch, { recursive: true, force: true }));
const cfg = join(scratch, "gitconfig");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
const ROOT = join(scratch, "repo");
execFileSync("git", ["init", "-q", ROOT], { stdio: "ignore" });
execFileSync("git", ["-C", ROOT, "config", "gc.auto", "0"], { stdio: "ignore" });

const live: { dispose(): void }[] = [];
after(() => live.forEach((m) => m.dispose()));
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Past RepoManager's 400 ms debounce. */
const DEBOUNCED = 520;

test("RepoManager: each source is told apart, and a burst inside the debounce is one event with every kind", async () => {
  vs.reset();
  vs.setFolders([{ name: "repo", fsPath: ROOT }]);
  const m = await RepoManager.create();
  live.push(m);
  await settle(300);
  const repo = vs.repository(ROOT, { name: "main", commit: "a1", ahead: 0, behind: 0 });
  vs.gitOpen(repo);
  // The watchers attach once git has said where its files are.
  for (let i = 0; i < 50 && !vs.watchers.some((w) => w.pattern.pattern === "refs/**"); i++) await settle(20);
  await settle(DEBOUNCED);

  const events: string[][] = [];
  m.onDidChange((e) => events.push([...e.kinds].sort()));
  const next = async (): Promise<string[] | undefined> => {
    events.length = 0;
    await settle(DEBOUNCED);
    assert.ok(events.length <= 1, `one debounced event, not ${events.length}`);
    return events[0];
  };
  const refsWatcher = vs.watchers.filter((w) => w.pattern.pattern === "refs/**").pop()!;
  const opWatcher = vs.watchers.filter((w) => w.pattern.pattern.startsWith("{HEAD")).pop()!;
  assert.ok(refsWatcher && opWatcher, "both watchers were made");

  repo.__fireState();
  assert.deepEqual(await next(), ["workingTree"], "status ran, nothing ref-ish moved");

  repo.state.HEAD = { ...repo.state.HEAD, commit: "b2" };
  repo.__fireState();
  assert.deepEqual(await next(), ["refs", "workingTree"], "a commit");

  repo.state.HEAD = { ...repo.state.HEAD, behind: 2 };
  repo.__fireState();
  assert.deepEqual(await next(), ["refs", "workingTree"], "a fetch");

  refsWatcher.fire("change");
  assert.deepEqual(await next(), ["refs"], "a ref file moved");

  opWatcher.fire("create");
  assert.deepEqual(await next(), ["operation", "refs"], "MERGE_HEAD appeared (HEAD's file is watched there too)");

  // A save, then a ref move, inside one debounce window: one event, both kinds.
  events.length = 0;
  repo.__fireState();
  refsWatcher.fire("change");
  await settle(DEBOUNCED);
  assert.deepEqual(events, [["refs", "workingTree"]]);

  // The same state again is the working tree again — the signature moved on.
  repo.__fireState();
  assert.deepEqual(await next(), ["workingTree"]);
});

// ── The subscribers ──────────────────────────────────────────────────────────

test("the graph's plan: a reload only when history can have moved or the Uncommitted row comes or goes", () => {
  const wt = repoChange(["workingTree"]);
  type Facts = { shown: boolean; wanted: boolean; detailsOnWip: boolean };
  const cells: [string, ReturnType<typeof repoChange> | undefined, Facts, string][] = [];
  for (const kinds of [["refs"], ["operation"], ["repos"], ["refs", "workingTree"]] as RepoChangeKind[][]) {
    for (const shown of [false, true]) {
      for (const wanted of [false, true]) {
        cells.push([`${kinds} with the row ${shown}→${wanted}`, repoChange(kinds), { shown, wanted, detailsOnWip: true }, "reload"]);
      }
    }
  }
  cells.push(["unknown event", undefined, { shown: true, wanted: true, detailsOnWip: false }, "reload"]);
  cells.push(["working tree, clean → dirty: the row appears", wt, { shown: false, wanted: true, detailsOnWip: false }, "reload"]);
  cells.push(["working tree, dirty → clean: the row goes", wt, { shown: true, wanted: false, detailsOnWip: true }, "reload"]);
  cells.push(["working tree, stays dirty, its details open", wt, { shown: true, wanted: true, detailsOnWip: true }, "wipDetails"]);
  cells.push(["working tree, stays dirty, another commit's details", wt, { shown: true, wanted: true, detailsOnWip: false }, "nothing"]);
  cells.push(["working tree, stays clean", wt, { shown: false, wanted: false, detailsOnWip: false }, "nothing"]);
  for (const [name, e, facts, want] of cells) {
    assert.equal(planGraphRefresh(e, facts), want, name);
  }
});

const SRC = join(__dirname, "..", "src");

test("the graph, blame and the Timeline act on a change through what it touched", () => {
  const graph = readFileSync(join(SRC, "graph/graphPanel.ts"), "utf8");
  assert.match(graph, /this\.repos\.onDidChange\(\(e\) => this\.onRepoChange\(e\)\)/, "the graph hands the event to onRepoChange");
  assert.doesNotMatch(graph, /this\.repos\.onDidChange\(\(\) => this\.scheduleRefresh\(\)\)/, "never a reload on every event");
  const onRepoChange = graph.slice(graph.indexOf("private onRepoChange("), graph.indexOf("private scheduleRefresh("));
  assert.match(onRepoChange, /planGraphRefresh\(/, "…which asks the plan");
  assert.match(onRepoChange, /void this\.loadInitial\(\)/);
  assert.match(onRepoChange, /this\.pushWipDetails\(active\)/);

  const blame = readFileSync(join(SRC, "blame/blameController.ts"), "utf8");
  assert.match(
    blame,
    /this\.repos\.onDidChange\(\(e\) => \{\s*if \(!touches\(e, "refs", "operation", "repos"\)\) \{\s*return;\s*\}\s*this\.blameCache\.clear\(\);/,
    "blame drops its cache only when a ref, an operation or the repository moved",
  );
  const timeline = readFileSync(join(SRC, "history/fileTimelineProvider.ts"), "utf8");
  assert.match(
    timeline,
    /this\.repos\.onDidChange\(\(e\) => \{\s*if \(touches\(e, "refs", "operation", "repos"\)\) \{\s*this\.changeEmitter\.fire\(\{ uri: undefined, reset: true \}\);/,
    "the Timeline resets only when history can have moved",
  );
});
