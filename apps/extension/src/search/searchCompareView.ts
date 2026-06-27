import * as vscode from "vscode";
import type { CommitRecord, GitRef } from "@gitstudio/host-bridge/git";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { relativeTime } from "../util/relativeTime";
import { toRevisionUri } from "../history/revisionContentProvider";

// The Search & Compare pillar — one TreeView with two pinned roots:
//   Search  — results of the last `gitstudio.search` (by message/author/file/
//             changed-code/sha).
//   Compare — the commits in A..B from the last `gitstudio.compareRefs`.
// Both render commit rows reusing the commitsView look. Results persist (are
// "pinned") until a new search / compare replaces them.

const SEARCH_LIMIT = 200;

type RootKind = "search" | "compare";

interface SearchState {
  /** Human label, e.g. `message: "fix"`. */
  label: string;
  commits: CommitRecord[];
}

/** A file changed between the two compared refs. */
interface CompareFile {
  path: string;
  /** Single-letter git status (A/M/D/R…). */
  status: string;
}

interface CompareState {
  label: string; // "A..B"
  commits: CommitRecord[];
  files: CompareFile[];
  refA: string;
  refB: string;
  root: string;
}

type Node = RootNode | GroupNode | CommitItemNode | FileItemNode;

class RootNode extends vscode.TreeItem {
  readonly kind = "root" as const;
  constructor(
    readonly root: RootKind,
    label: string,
    description: string | undefined,
    hasChildren: boolean,
  ) {
    super(
      label,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    this.description = description;
    this.iconPath = new vscode.ThemeIcon(
      root === "search" ? "search" : "git-compare",
    );
    this.tooltip =
      root === "search"
        ? "Results of the last commit search"
        : "Commits in the last A..B comparison";
    this.contextValue = `gitstudio.searchCompare.${root}`;
  }
}

class CommitItemNode extends vscode.TreeItem {
  readonly kind = "commit" as const;
  constructor(readonly commit: CommitRecord) {
    super(
      commit.subject || "(no commit message)",
      vscode.TreeItemCollapsibleState.None,
    );
    this.description = `${commit.author} · ${relativeTime(
      commit.authorDate,
    )} · ${commit.sha.slice(0, 7)}`;
    this.iconPath =
      commit.parents.length > 1
        ? new vscode.ThemeIcon("git-merge")
        : new vscode.ThemeIcon("git-commit");
    this.contextValue = "gitstudio.searchCompare.commit";
    this.tooltip = buildCommitTooltip(commit);
    this.command = {
      command: "gitstudio.searchCompare.openCommit",
      title: "Open Commit",
      arguments: [this],
    };
  }
}

/** A sub-group under the Compare root: "Commits" or "Files changed". */
class GroupNode extends vscode.TreeItem {
  readonly kind = "group" as const;
  constructor(
    readonly group: "commits" | "files",
    count: number,
  ) {
    super(
      group === "commits" ? "Commits" : "Files changed",
      count > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    this.description = String(count);
    this.iconPath = new vscode.ThemeIcon(group === "commits" ? "git-commit" : "files");
    this.contextValue = `gitstudio.searchCompare.group.${group}`;
  }
}

/** A changed-file row under the Compare → Files group; click opens an A↔B diff. */
class FileItemNode extends vscode.TreeItem {
  readonly kind = "file" as const;
  constructor(
    readonly file: CompareFile,
    root: string,
    refA: string,
    refB: string,
  ) {
    super(file.path.split("/").pop() ?? file.path, vscode.TreeItemCollapsibleState.None);
    const dir = file.path.includes("/")
      ? file.path.slice(0, file.path.lastIndexOf("/"))
      : "";
    this.description = `${file.status}${dir ? "  " + dir : ""}`;
    this.iconPath = vscode.ThemeIcon.File;
    this.tooltip = `${file.status}  ${file.path}`;
    this.contextValue = "gitstudio.searchCompare.file";
    this.command = {
      command: "gitstudio.searchCompare.openFileDiff",
      title: "Open Diff",
      arguments: [{ root, refA, refB, path: file.path }],
    };
  }
}

function buildCommitTooltip(commit: CommitRecord): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  const date = new Date(commit.authorDate * 1000);
  md.appendMarkdown(`**${escapeMarkdown(commit.subject)}**\n\n`);
  md.appendMarkdown(`$(git-commit) \`${commit.sha.slice(0, 12)}\``);
  if (commit.parents.length > 1) {
    md.appendMarkdown(` · $(git-merge) merge`);
  }
  md.appendMarkdown(`\n\n`);
  md.appendMarkdown(
    `$(account) ${escapeMarkdown(commit.author)} <${escapeMarkdown(
      commit.authorEmail,
    )}>\n\n`,
  );
  md.appendMarkdown(`$(calendar) ${date.toLocaleString()}`);
  return md;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

/**
 * Feeds the Search & Compare tree. Holds the pinned search + compare results in
 * memory and re-renders on demand. Commit rows click through to the commit's
 * graph / diff. Refreshes its roots when the repo changes (results stay pinned).
 */
export class SearchCompareTreeProvider
  implements vscode.TreeDataProvider<Node>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  private search: SearchState | undefined;
  private compare: CompareState | undefined;

  constructor(private readonly repos: RepoManager) {
    // Repo changes only re-title the roots; pinned results remain.
    this.disposables.push(this.repos.onDidChange(() => this.emitter.fire(undefined)));
  }

  setSearch(state: SearchState | undefined): void {
    this.search = state;
    this.emitter.fire(undefined);
  }

  setCompare(state: CompareState | undefined): void {
    this.compare = state;
    this.emitter.fire(undefined);
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  getChildren(element?: Node): Node[] {
    if (!element) {
      return [
        new RootNode(
          "search",
          "Search",
          this.search
            ? `${this.search.label} · ${this.search.commits.length}`
            : "no results yet",
          !!this.search && this.search.commits.length > 0,
        ),
        new RootNode(
          "compare",
          "Compare",
          this.compare
            ? `${this.compare.label} · ${this.compare.commits.length} commits, ${this.compare.files.length} files`
            : "no comparison yet",
          !!this.compare &&
            this.compare.commits.length + this.compare.files.length > 0,
        ),
      ];
    }
    if (element.kind === "root") {
      if (element.root === "search") {
        return (this.search?.commits ?? []).map((c) => new CommitItemNode(c));
      }
      // The Compare root splits into Commits + Files-changed groups.
      const c = this.compare;
      if (!c) {
        return [];
      }
      return [
        new GroupNode("commits", c.commits.length),
        new GroupNode("files", c.files.length),
      ];
    }
    if (element.kind === "group") {
      const c = this.compare;
      if (!c) {
        return [];
      }
      return element.group === "commits"
        ? c.commits.map((x) => new CommitItemNode(x))
        : c.files.map((f) => new FileItemNode(f, c.root, c.refA, c.refB));
    }
    return [];
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.emitter.dispose();
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

function active(repos: RepoManager): RepoEntry | undefined {
  const a = repos.getActive();
  if (!a) {
    void vscode.window.showInformationMessage("GitStudio: no active repository.");
  }
  return a;
}

/** Collect up to `limit` commits from a `git log` invocation. */
async function collectCommits(
  repo: RepoEntry,
  logArgs: string[],
  paths: string[],
): Promise<CommitRecord[]> {
  // We use the LogProvider's streamCommits where possible, but pickaxe / grep
  // need raw args, so run git log directly with the same record framing.
  const FIELD = "\x1f";
  const RECORD = "\x1e";
  const format =
    `--pretty=format:%H${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%at` +
    `${FIELD}%cn${FIELD}%ce${FIELD}%ct${FIELD}%s${FIELD}%b${RECORD}`;
  const args = ["log", "--date-order", format, `--max-count=${SEARCH_LIMIT}`, ...logArgs];
  if (paths.length > 0) {
    args.push("--", ...paths);
  }
  const result = await repo.ctx.process.run(args);
  if (result.code !== 0) {
    return [];
  }
  const commits: CommitRecord[] = [];
  for (const raw of result.stdout.split(RECORD)) {
    const trimmed = raw.startsWith("\n") ? raw.slice(1) : raw;
    if (trimmed.length === 0) {
      continue;
    }
    const f = trimmed.split(FIELD);
    if (f.length < 10 || f[0] === "") {
      continue;
    }
    commits.push({
      sha: f[0],
      parents: f[1].split(" ").filter((p) => p.length > 0),
      author: f[2],
      authorEmail: f[3],
      authorDate: Number(f[4]),
      committer: f[5],
      committerEmail: f[6],
      committerDate: Number(f[7]),
      subject: f[8],
      body: f[9],
    });
  }
  return commits;
}

/** `gitstudio.search` — multi-step QuickPick search, results pinned to Search. */
export async function runSearch(
  repos: RepoManager,
  provider: SearchCompareTreeProvider,
  reveal: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }
  const mode = await vscode.window.showQuickPick(
    [
      { label: "$(comment) Message", id: "message", description: "--grep" },
      { label: "$(account) Author", id: "author", description: "--author" },
      { label: "$(file) File path", id: "file", description: "touched a file" },
      {
        label: "$(symbol-string) Changed code",
        id: "pickaxe",
        description: "-S / -G pickaxe",
      },
      { label: "$(git-commit) SHA", id: "sha", description: "find a commit" },
    ],
    { title: "Search commits", placeHolder: "Search by…" },
  );
  if (!mode) {
    return;
  }

  const term = await vscode.window.showInputBox({
    title: `Search by ${mode.id}`,
    prompt: searchPrompt(mode.id),
    validateInput: (v) => (v.trim() ? undefined : "Enter a search term"),
  });
  if (!term) {
    return;
  }

  let logArgs: string[] = ["--all"];
  let paths: string[] = [];
  switch (mode.id) {
    case "message":
      logArgs.push("--grep", term, "-i");
      break;
    case "author":
      logArgs.push("--author", term, "-i");
      break;
    case "file":
      paths = [term];
      break;
    case "pickaxe":
      logArgs.push(`-G${term}`);
      break;
    case "sha":
      // A single commit lookup — just that rev, no --all walk.
      logArgs = [term, "-n", "1"];
      break;
    default:
      break;
  }

  const commits = await collectCommits(a, logArgs, paths);
  provider.setSearch({
    label: `${mode.id}: "${term}"`,
    commits,
  });
  reveal();
  if (commits.length === 0) {
    void vscode.window.showInformationMessage(
      `GitStudio: no commits matched ${mode.id} "${term}".`,
    );
  }
}

function searchPrompt(mode: string): string {
  switch (mode) {
    case "message":
      return "Text to find in commit messages";
    case "author":
      return "Author name or email substring";
    case "file":
      return "File path (relative to the repo root)";
    case "pickaxe":
      return "Code string/regex added or removed in a commit";
    case "sha":
      return "Full or abbreviated commit SHA";
    default:
      return "Search term";
  }
}

/** `gitstudio.compareRefs` — pick ref A then ref B, list A..B commits. */
export async function compareRefs(
  repos: RepoManager,
  provider: SearchCompareTreeProvider,
  reveal: () => void,
  presetA?: string,
  presetB?: string,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }
  let refs: GitRef[] = [];
  try {
    refs = await a.ctx.refs.listRefs();
  } catch {
    /* ignore */
  }
  const pickable = refs.filter(
    (r) => r.type === "head" || r.type === "remote" || r.type === "tag",
  );

  const refA = presetA ?? (await pickRef(pickable, "Compare: pick base (A)"));
  if (!refA) {
    return;
  }
  const refB =
    presetB ?? (await pickRef(pickable, `Compare ${refA}… with (B)`));
  if (!refB) {
    return;
  }

  const commits = await collectCommits(a, [`${refA}..${refB}`], []);
  const files = await collectCompareFiles(a, refA, refB);
  provider.setCompare({
    label: `${refA}..${refB}`,
    commits,
    files,
    refA,
    refB,
    root: a.root,
  });
  reveal();
  if (commits.length === 0 && files.length === 0) {
    void vscode.window.showInformationMessage(
      `GitStudio: ${refB} has no commits or changes beyond ${refA}.`,
    );
  }
}

/** Files changed between A and B (3-dot, GitHub-style "what B introduced"). */
async function collectCompareFiles(
  repo: RepoEntry,
  refA: string,
  refB: string,
): Promise<CompareFile[]> {
  const r = await repo.ctx.process.run([
    "diff",
    "--name-status",
    "-M",
    `${refA}...${refB}`,
  ]);
  if (r.code !== 0) {
    return [];
  }
  const files: CompareFile[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.split("\t");
    const status = (parts[0] ?? "").charAt(0);
    const path = parts.length >= 3 ? parts[2] : parts[1] ?? "";
    if (path) {
      files.push({ path, status });
    }
  }
  return files;
}

/** `gitstudio.searchCompare.openFileDiff` — diff a file between the two refs. */
export async function openCompareFileDiff(arg: {
  root: string;
  refA: string;
  refB: string;
  path: string;
}): Promise<void> {
  if (!arg) {
    return;
  }
  const left = toRevisionUri(arg.root, arg.refA, arg.path);
  const right = toRevisionUri(arg.root, arg.refB, arg.path);
  const name = arg.path.split("/").pop() ?? arg.path;
  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    `${name} (${arg.refA} ↔ ${arg.refB})`,
  );
}

async function pickRef(
  refs: GitRef[],
  title: string,
): Promise<string | undefined> {
  const icon = (r: GitRef) =>
    r.type === "tag" ? "$(tag)" : r.type === "remote" ? "$(cloud)" : "$(git-branch)";
  const picked = await vscode.window.showQuickPick(
    refs.map((r) => ({
      label: `${icon(r)} ${r.name}`,
      description: r.sha.slice(0, 7),
      name: r.name,
    })),
    { title, placeHolder: "Pick a branch / tag" },
  );
  return picked?.name;
}

/** Entry point used by the Branches view's "Compare with current". */
export async function compareWithCurrent(
  repos: RepoManager,
  provider: SearchCompareTreeProvider,
  reveal: () => void,
  otherRef: string,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }
  const head = await a.ctx.refs.getHead();
  const current = head.detached ? head.sha : head.branch;
  // Show what `otherRef` has that current doesn't (current..other).
  await compareRefs(repos, provider, reveal, current, otherRef);
}

/** `gitstudio.searchCompare.openCommit` — show the commit in the graph. */
export async function openSearchCommit(
  node: CommitItemNode,
): Promise<void> {
  if (!node) {
    return;
  }
  // Reuse the interactive-rebase-style entry? Simplest: copy + reveal in graph.
  await vscode.commands.executeCommand("gitstudio.showCommitGraph");
}
