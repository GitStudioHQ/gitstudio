import * as vscode from "vscode";
import type { GitContext } from "@gitstudio/git-service/index";
import type { RepoManager } from "../git/repoManager";
import { relativeTime } from "../util/relativeTime";
import { runCommitAction } from "../graph/commitActions";
import { promptPick } from "../ui/dialogs";

const FIELD_SEP = "\x1f";

interface ReflogEntry {
  /** Abbreviated hash (%h). */
  hash: string;
  /** Reflog selector, e.g. "HEAD@{3}" (%gd). */
  selector: string;
  /** Reflog subject — the action, e.g. "checkout: moving from x to y" (%gs). */
  action: string;
  /** Committer date (epoch seconds), parsed from %ci. */
  date: number;
}

/**
 * `gitstudio.showReflog`: the recovery safety-net browser. Lists `git reflog`
 * entries in a GitStudio dialog; picking one offers Create branch here / Reset
 * current branch to here / Checkout — reusing the shared commit actions. This is
 * the foundation M8's Undo builds on.
 */
export async function showReflog(repos: RepoManager): Promise<void> {
  const active = repos.getActive();
  if (!active) {
    void vscode.window.showInformationMessage("No active Git repository.");
    return;
  }

  let entries: ReflogEntry[];
  try {
    entries = await loadReflog(active.ctx);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Reflog failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (entries.length === 0) {
    void vscode.window.showInformationMessage("The reflog is empty.");
    return;
  }

  const pickedIndex = await promptPick({
    title: "Reflog — Time Machine",
    hint: "Every position HEAD has held, including ones no branch points at any more.",
    choices: entries.map((e, i) => ({
      id: String(i),
      label: e.action,
      icon: "history",
      detail: e.hash,
      description: `${e.selector} · ${relativeTime(e.date)}`,
    })),
  });
  if (pickedIndex === undefined) {
    return;
  }
  const entry = entries[Number(pickedIndex)];
  if (!entry) {
    return;
  }

  await offerRecoveryActions(active.ctx, entry);
}

async function offerRecoveryActions(
  ctx: GitContext,
  entry: ReflogEntry,
): Promise<void> {
  // Resolve to a full sha so the commit actions get a stable target.
  const sha = await resolveSha(ctx, entry.hash);
  const commit = { sha, subject: entry.action };

  const chosen = await promptPick({
    title: `Recover — ${entry.selector} (${entry.hash})`,
    hint: entry.action,
    choices: [
      { id: "branch", label: "Create Branch Here", icon: "git-branch", description: "Give this commit a name so it stops being unreachable." },
      { id: "checkout", label: "Checkout", icon: "git-commit", description: "Go here on a detached HEAD to look around." },
      { id: "reset", label: "Reset Branch to Here", icon: "history", description: "Move the current branch back to this commit." },
      { id: "copySha", label: "Copy SHA", icon: "copy" },
    ],
  });
  if (!chosen) {
    return;
  }
  // Reuse the shared commit actions (which confirm destructive ops and surface
  // git errors). RepoManager's .git watchers refresh the views automatically.
  await runCommitAction(chosen, ctx, commit);
}

async function loadReflog(ctx: GitContext): Promise<ReflogEntry[]> {
  const result = await ctx.process.run([
    "reflog",
    `--format=%h${FIELD_SEP}%gd${FIELD_SEP}%gs${FIELD_SEP}%ci`,
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `git reflog exited ${result.code}`);
  }

  const entries: ReflogEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    const fields = line.split(FIELD_SEP);
    if (fields.length < 4) {
      continue;
    }
    entries.push({
      hash: fields[0],
      selector: fields[1],
      action: fields[2],
      date: parseIsoDate(fields[3]),
    });
  }
  return entries;
}

async function resolveSha(ctx: GitContext, ref: string): Promise<string> {
  const result = await ctx.process.run(["rev-parse", ref]);
  return result.code === 0 ? result.stdout.trim() : ref;
}

/** Parses git's `%ci` (ISO 8601 with offset) to epoch seconds. */
function parseIsoDate(iso: string): number {
  const ms = Date.parse(iso.trim());
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}
