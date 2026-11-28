// Which of the details pane's diffs is open (#158) — the host's half.
//
// The pane lights the file whose diff it opened. Only the host can see that
// diff's tab: switched to, the light moves to its file; closed, it goes out.
// This is that decision, free of vscode: given the diffs the pane opened and
// the tabs there are now, which file's diff is the open one.
//
// It is decided per repository. One graph shows one repository at a time and
// can be switched to another, and a working tree's changes have the same sha
// in every repository: without the repository, the open package.json of one
// lit the package.json of the next.
//
// A diff is known by its two sides, exactly as vscode.diff was given them.
// One the default diff viewer routed to GitStudio's comparison is a webview
// tab, which says only its label — the title the diff was opened with (the
// router keeps it) — so a comparison is matched by that, and that is a guess:
// two files of one name in one commit ("index.ts (a1b2c3d)"), or the working
// trees of two repositories ("package.json (HEAD ↔ Working Tree)"), have the
// same title, and a comparison of either counts as the other's too. Plain VS
// Code diff tabs (the default) are matched exactly.

/** A diff the pane opened: which file of which commit in which repository, and how its tab is known. */
export interface ListDiff {
  /** The repository's root, as the host names it. */
  root: string;
  sha: string;
  path: string;
  /** Its two sides as vscode.diff was given them (Uri.toString()). */
  original: string;
  modified: string;
  /** The title it was opened with: a routed comparison's tab label. */
  title: string;
}

/** A tab, as far as the light cares. */
export type TabSeen =
  | { kind: "diff"; original: string; modified: string }
  | { kind: "comparison"; label: string }
  | { kind: "other" };

/** The tabs open now: the one in front of the active group, and all of them. */
export interface TabsSeen {
  front?: TabSeen;
  all: readonly TabSeen[];
}

/** The file whose diff is open. */
export interface ActiveFile {
  sha: string;
  path: string;
}

/**
 * How long a diff just asked for keeps the light before its tab is seen.
 * Tabs change while it opens (a preview tab is replaced, a comparison stands
 * in for it), and none of that is the user moving away from it.
 */
export const DIFF_ON_ITS_WAY_MS = 5_000;

/** Diffs remembered at most: the ones with a tab open, which is few. */
const REMEMBERED = 64;

interface Opened extends ListDiff {
  at: number;
  /** Its tab has been seen open. */
  seen: boolean;
}

function shows(tab: TabSeen, d: ListDiff): boolean {
  if (tab.kind === "diff") return tab.original === d.original && tab.modified === d.modified;
  if (tab.kind === "comparison") return tab.label === d.title;
  return false;
}

export class ActiveFileTracker {
  private opened: Opened[] = [];
  /** The open file of each repository the pane opened diffs in, by root. */
  private current = new Map<string, Opened>();

  /** The file whose diff is open in the repository at `root`, if any. */
  active(root: string | undefined): ActiveFile | undefined {
    const cur = root === undefined ? undefined : this.current.get(root);
    return cur && { sha: cur.sha, path: cur.path };
  }

  /** Whether any diff the pane opened is still open (or on its way). */
  get following(): boolean {
    return this.opened.length > 0;
  }

  /** The pane opened this diff: its file is its repository's open one from now. */
  open(d: ListDiff, now = Date.now()): void {
    const o: Opened = { ...d, at: now, seen: false };
    this.opened = this.opened.filter((x) => !(x.original === d.original && x.modified === d.modified));
    this.opened.push(o);
    if (this.opened.length > REMEMBERED) this.opened.splice(0, this.opened.length - REMEMBERED);
    this.current.set(d.root, o);
  }

  /**
   * The tabs changed. For each repository: the tab in front showing one of
   * its diffs makes that file the open one; otherwise the open one stays
   * while some tab still shows it, then the latest of its others still
   * open, and with none, it has no open file. A
   * diff still on its way keeps the light whatever is in front meanwhile.
   * Says whether any repository's open file changed.
   */
  settle(tabs: TabsSeen, now = Date.now()): boolean {
    const shown = (d: ListDiff): boolean => tabs.all.some((t) => shows(t, d));
    for (const d of this.opened) {
      if (!d.seen && shown(d)) d.seen = true;
    }
    const onItsWay = (d: Opened): boolean => !d.seen && now - d.at < DIFF_ON_ITS_WAY_MS;
    const front = tabs.front;
    let changed = false;
    for (const root of new Set([...this.opened.map((d) => d.root), ...this.current.keys()])) {
      const cur = this.current.get(root);
      if (cur && onItsWay(cur)) continue;
      const inFront = front ? this.opened.filter((d) => d.root === root && shows(front, d)) : [];
      let next: Opened | undefined = cur;
      if (inFront.length > 0) {
        // Two of the pane's diffs can share a comparison's label (see the
        // top of this file): the open one, if it is one of them, else the latest.
        next = cur && inFront.includes(cur) ? cur : inFront[inFront.length - 1];
      } else if (!cur || !shown(cur)) {
        // Its tab closed with another tab in front: the latest of the
        // pane's diffs still open has the light, and none puts it out.
        next = cur ? [...this.opened].reverse().find((d) => d.root === root && d !== cur && shown(d)) : undefined;
      }
      if (next === cur) continue;
      changed = changed || next?.sha !== cur?.sha || next?.path !== cur?.path;
      if (next) this.current.set(root, next);
      else this.current.delete(root);
    }
    const kept = new Set(this.current.values());
    this.opened = this.opened.filter((d) => kept.has(d) || shown(d) || onItsWay(d));
    return changed;
  }
}
