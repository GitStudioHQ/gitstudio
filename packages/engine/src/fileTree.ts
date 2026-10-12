// A change's files as a folder tree — the one builder behind every surface
// that groups changed files by folder: a pull request's Files tab and a
// commit's "Files changed" in the graph's details pane (#81).
//
// Pure: it takes anything with a repo-relative `path` and gives the same
// thing back at its place in the tree, so each surface keeps its own file
// shape (a PR's file, a commit's CommitFileChange) and its own row.

/** A folder (with what is in it) or a file, as the tree holds them. */
export type FileTreeNode<F> =
  | { kind: "dir"; name: string; path: string; children: FileTreeNode<F>[] }
  | { kind: "file"; name: string; file: F };

/**
 * The changed files as a tree: folders first, then files, each by name; a
 * folder with nothing but one folder in it is one row ("src/pr"), as VS
 * Code's own compact folders are. A folder's `path` is its whole path from
 * the root, and its `name` is what its row shows (the compacted chain).
 */
export function fileTree<F extends { path: string }>(files: readonly F[]): FileTreeNode<F>[] {
  interface Dir {
    dirs: Map<string, Dir>;
    files: F[];
  }
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let d = root;
    for (const p of parts.slice(0, -1)) {
      let next = d.dirs.get(p);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        d.dirs.set(p, next);
      }
      d = next;
    }
    d.files.push(f);
  }
  const build = (d: Dir, prefix: string): FileTreeNode<F>[] => {
    const out: FileTreeNode<F>[] = [];
    for (const [name, sub] of [...d.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      let label = name;
      let node = sub;
      while (node.files.length === 0 && node.dirs.size === 1) {
        const [[n2, s2]] = [...node.dirs];
        label = `${label}/${n2}`;
        node = s2;
      }
      const path = prefix ? `${prefix}/${label}` : label;
      out.push({ kind: "dir", name: label, path, children: build(node, path) });
    }
    for (const f of [...d.files].sort((a, b) => a.path.localeCompare(b.path))) {
      out.push({ kind: "file", name: f.path.slice(f.path.lastIndexOf("/") + 1), file: f });
    }
    return out;
  };
  return build(root, "");
}

/** Every file under a node, at any depth, in the tree's order. */
export function filesUnder<F>(node: FileTreeNode<F>): F[] {
  if (node.kind === "file") return [node.file];
  return node.children.flatMap((c) => filesUnder(c));
}
