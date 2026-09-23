import { settle, stub } from "./support/useVscodeStub";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { GitContext } from "@gitstudio/git-service/GitContext";
import { ExitGuard } from "../src/exitGuard";
import type { MergeHostCore } from "../src/host";
import { JetBrainsUi } from "../src/jetbrainsUi";
import type { MergeProduct, MergeRepo, RepoLocator } from "../src/product";
import { git, gitFails, newRepo, removeTemp } from "./fixtures";

// The VS Code JetBrains hand-off writes the IDE's result into the real file,
// so it is a WRITE and must pass the guards the embedded Apply passes (P2 →
// P4: ConflictOps.externalMergeInput). It read the sides with readSides and
// handed the IDE `uri.fsPath` directly: a Latin-1 file reached the IDE as
// U+FFFD and was saved back that way, and a path reached through a symlinked
// folder was written outside the repository.

beforeEach(() => stub.reset());

const skip = process.platform === "win32" ? "the fake IDE is a shell script" : false;

function setup(): { dir: string; repo: string; ideRan: string; ui: JetBrainsUi; notes: string[]; uri: vscode.Uri; cleanup(): void } {
  const r = newRepo("jb");
  const latin = (tag: string) => Buffer.from(`caf\xe9 ${tag}\nline two\n`, "latin1");
  writeFileSync(join(r.repo, "latin.txt"), latin("base"));
  git(r.repo, "add", "latin.txt");
  git(r.repo, "commit", "-m", "base");
  git(r.repo, "checkout", "-b", "feature");
  writeFileSync(join(r.repo, "latin.txt"), latin("feature"));
  git(r.repo, "commit", "-am", "feature");
  git(r.repo, "checkout", "master");
  writeFileSync(join(r.repo, "latin.txt"), latin("master"));
  git(r.repo, "commit", "-am", "master");
  gitFails(r.repo, "merge", "feature");

  // A fake IDE that leaves a mark if it is ever launched.
  const bin = join(r.dir, "bin");
  mkdirSync(bin);
  const ideRan = join(r.dir, "ide-ran");
  writeFileSync(join(bin, "idea"), `#!/bin/sh\ntouch "${ideRan}"\n`);
  chmodSync(join(bin, "idea"), 0o755);

  const ctx = new GitContext({ root: r.repo });
  const repo = { root: r.repo, ctx } as unknown as MergeRepo;
  const locator: RepoLocator = {
    all: () => [repo],
    forPath: (p) => (p.startsWith(r.repo) ? repo : undefined),
    active: () => repo,
    onDidChange: () => new vscode.Disposable(() => {}),
  };
  const notes: string[] = [];
  const host = {
    context: { extensionUri: vscode.Uri.file("/ext") },
    product: { settingsSection: "test.merge", locator, ideAvailableContextKey: "test.ide" } as unknown as MergeProduct,
    exitGuard: new ExitGuard(),
    settings: () => ({
      autoOpen: true,
      autoApplyNonConflicting: false,
      conflictResolver: "jetbrains",
      diffTool: "embedded",
      preferredIde: "auto",
      jetbrainsPath: join(bin, "idea"),
    }),
    defers: () => false,
    notify: async (kind: string, text: string) => {
      notes.push(`${kind}: ${text}`);
      return undefined;
    },
    changed: () => {},
  } as unknown as MergeHostCore;
  const uri = vscode.Uri.file(join(r.repo, "latin.txt"));
  (vscode.workspace.textDocuments as unknown as unknown[]).push({ uri, getText: () => "<<<<<<< HEAD\n", isDirty: false });
  const ui = new JetBrainsUi(host, async () => {}, async () => {});
  return {
    ...r,
    ideRan,
    ui,
    notes,
    uri,
    cleanup: () => {
      (vscode.workspace.textDocuments as unknown as unknown[]).length = 0;
      ui.dispose();
      ctx.dispose();
      removeTemp(r.dir);
    },
  };
}

test("a file that is not UTF-8 is refused before the IDE is launched", { skip }, async () => {
  const s = setup();
  try {
    await s.ui.merge(s.uri);
    await settle();
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(existsSync(s.ideRan), false, "the IDE was never launched with U+FFFD in its sides");
    assert.ok(s.notes.some((n) => /UTF-8/.test(n)), `the refusal says why: ${JSON.stringify(s.notes)}`);
  } finally {
    s.cleanup();
  }
});
