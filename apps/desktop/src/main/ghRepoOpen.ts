// One-click "open this GitHub repo as a NORMAL repo" — the whole point of a
// native GitHub app. No destination dialogs, no manual clone step:
//
//   1. If a local clone already exists (any recent repo, or the managed
//      folder) whose remote matches, open it INSTANTLY.
//   2. Otherwise clone it into the managed folder (~/GitStudio) with streamed
//      progress, then open it.
//
// Either way the app flips to the full repo experience — Code, Commits,
// Branches, PRs — exactly as if the user had opened a local folder.

import { app } from "electron";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CloneProgress } from "../shared/ipc";
import { startClone } from "./cloneBridge";
import { parseGitHubRemote } from "./githubRemote";
import type { RepoStore } from "./repoStore";

/** Where implicit clones live. Fixed and predictable (GitHub Desktop keeps
 *  ~/Documents/GitHub); users who care about placement use Clone… instead. */
export function managedReposDir(): string {
  return join(app.getPath("home"), "GitStudio");
}

/** `git -C root remote get-url origin`, parsed — or undefined. */
function originOf(root: string): Promise<{ owner: string; repo: string } | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, "remote", "get-url", "origin"],
      { timeout: 5_000 },
      (err, stdout) => resolve(err ? undefined : parseGitHubRemote(stdout.trim())),
    );
  });
}

async function matches(root: string, fullName: string): Promise<boolean> {
  const o = await originOf(root);
  return !!o && `${o.owner}/${o.repo}`.toLowerCase() === fullName.toLowerCase();
}

export interface GhOpenResult {
  ok: boolean;
  root?: string;
  /** True when this open had to clone first (the renderer words its toast). */
  cloned?: boolean;
  message?: string;
  /** Machine-readable failure mode — the renderer branches on THIS, never on
   *  message text (the old /already exists/i match was a fragile seam). */
  code?: "collision" | "clone-failed" | "open-failed" | "bad-name";
  /** See CommitActionResult.expected — a condition, not a defect to report. */
  expected?: boolean;
}

export async function openGitHubRepo(
  fullName: string,
  repos: RepoStore,
  onProgress: (p: CloneProgress) => void,
  /** Injectable for tests (app.getPath needs a live Electron app). */
  managed: string = managedReposDir(),
  /** Per-action destination override (the "Choose location…" sheet). */
  dest?: string,
  /** Per-action folder-name override. */
  nameOverride?: string,
): Promise<GhOpenResult> {
  const [owner, repo] = fullName.split("/", 2);
  if (!owner || !repo) {
    // Nobody TYPES this name. Every door onto ghrepo:open passes the full name
    // of a repository GitHub listed (a search hit, an org's or a user's repo
    // row) or of the repo page it is on, whose route only parses owner/repo.
    // So a name without both halves is a request our renderer built wrong —
    // reported, never `expected` (see PAYLOAD_REFUSALS in
    // test/expectedConditions.test.ts).
    return {
      ok: false,
      code: "bad-name",
      message: "That doesn't look like an owner/repo name.",
    };
  }

  // 1. An existing clone wins — recents first (where the user actually works),
  //    then the managed folder's two naming schemes.
  const candidates = [
    ...repos.recentRepos().map((r) => r.root),
    join(managed, repo),
    join(managed, `${owner}-${repo}`),
  ];
  // Probe candidates in PARALLEL (each probe is a git subprocess; a long
  // recents list on a slow volume serially stalled the "Preparing…" card),
  // then honor the original preference order when picking.
  const unique = [...new Set(candidates)].filter((root) => existsSync(root));
  const results = await Promise.all(unique.map((root) => matches(root, fullName)));
  const hitRoot = unique.find((_, i) => results[i]);
  if (hitRoot) {
    const info = await repos.open(hitRoot);
    return info
      ? { ok: true, root: hitRoot, cloned: false }
      : { ok: false, code: "open-failed", message: `Found a clone at ${hitRoot}, but it couldn't be opened.` };
  }

  // 2. No clone anywhere — make one in the chosen destination (an explicit
  //    override wins; otherwise the configured default folder).
  const parent = dest ?? managed;
  await mkdir(parent, { recursive: true });
  // Prefer the explicit name, then the plain repo name; fall back to
  // owner-repo when a DIFFERENT project already took that folder.
  let name = nameOverride?.trim() || repo;
  if (!nameOverride && existsSync(join(parent, name))) name = `${owner}-${repo}`;
  if (existsSync(join(parent, name))) {
    // The destination is taken: the sheet offers another folder name and the
    // user picks one. Not a defect (see main/expectedError.ts). The two
    // "couldn't be opened" answers below are, and still report — we found or
    // made a repository and then failed to open it.
    return {
      ok: false,
      code: "collision",
      expected: true,
      message: `${join(parent, name)} already exists but isn't this repository — pick another destination or folder name.`,
    };
  }
  const result = await startClone(
    { url: `https://github.com/${fullName}.git`, parentDir: parent, name },
    onProgress,
  );
  if (!result.ok || !result.root) {
    // startClone has already decided whether ITS failure was a condition (a bad
    // URL, a taken folder) or a real one; carry that verdict rather than
    // re-filing every clone refusal as a crash.
    return {
      ok: false,
      code: "clone-failed",
      ...(result.expected ? { expected: true } : {}),
      message: result.message || "The clone failed.",
    };
  }
  const info = await repos.open(result.root);
  return info
    ? { ok: true, root: result.root, cloned: true }
    : { ok: false, code: "open-failed", message: `Cloned to ${result.root}, but it couldn't be opened.` };
}
