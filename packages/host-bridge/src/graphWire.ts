// Pure WireRow assembly shared by every host (the VS Code extension graph panel
// and the desktop main process). Given the engine's laid-out rows plus the
// commit metadata and ref decorations a host has gathered, it produces the
// `WireRow[]` the `<gitstudio-graph>` element renders — the exact transformation
// the extension's graphPanel performs, lifted to a host-agnostic, unit-testable
// spot so the desktop app reuses it verbatim instead of copying it.
//
// IMPORTANT: TYPE-ONLY-friendly — no `vscode`/`node`/`monaco`/`fs` imports. The
// engine/host-bridge purity guard depends on this staying pure.

import type { WireRef, WireRow } from "./graphProtocol";

/** The subset of a laid-out graph row this builder needs (mirrors GraphRow). */
export interface LayoutRowLike {
  sha: string;
  column: number;
  color: number;
  isMerge: boolean;
  segments: WireRow["segments"];
}

/** The subset of a commit record this builder denormalizes into a row. */
export interface CommitMetaLike {
  subject: string;
  author: string;
  authorEmail: string;
  authorDate: number;
}

/** The subset of a git ref this builder turns into a chip. */
export interface RefLike {
  type: "head" | "remote" | "tag" | "stash";
  name: string;
  /** Fully-qualified name, "refs/heads/main" — carried onto the chip. */
  fullName: string;
  isCurrent: boolean;
  /** Set only on `refs/remotes/<remote>/HEAD` — the remote's default branch. */
  symref?: string;
}

/** Inputs gathered by the host before assembling the wire rows. */
export interface BuildWireRowsInput {
  /** The engine's laid-out rows, newest-first. */
  rows: LayoutRowLike[];
  /** sha -> commit metadata (denormalized into the row). */
  records: ReadonlyMap<string, CommitMetaLike>;
  /** sha -> ref decorations attached to that commit. */
  refsBySha: ReadonlyMap<string, RefLike[]>;
}

/** Lays a host's gathered data out into the wire rows the graph element wants. */
export function buildWireRows(input: BuildWireRowsInput): WireRow[] {
  return input.rows.map((row) => {
    const record = input.records.get(row.sha);
    return {
      sha: row.sha,
      shortSha: row.sha.slice(0, 7),
      column: row.column,
      color: row.color,
      isMerge: row.isMerge,
      segments: row.segments,
      subject: record?.subject ?? "",
      author: record?.author ?? "",
      authorEmail: record?.authorEmail ?? "",
      authorDate: record?.authorDate ?? 0,
      refs: wireRefs(input.refsBySha.get(row.sha)),
    };
  });
}

/** Ref chips for a sha, current HEAD first, then locals, remotes, tags. */
export function wireRefs(refs: readonly RefLike[] | undefined): WireRef[] {
  if (!refs || refs.length === 0) {
    return [];
  }
  const out: WireRef[] = [];
  for (const ref of refs) {
    // The full name rides on every chip (issue #30's follow-up): the short
    // one is "heads/release" beside a tag "release", which is no label, no
    // key for folding a twin, and no way back to the ref.
    const fullName = ref.fullName;
    if (ref.type === "head") {
      out.push({ name: ref.name, fullName, kind: ref.isCurrent ? "currentHead" : "head" });
    } else if (ref.type === "remote") {
      // `refs/remotes/<remote>/HEAD` shortens to the bare remote name, so this
      // drew a chip labelled "origin" that is not a branch and matches nothing
      // in the Branches list — a dead link sitting on the same commit as the
      // real `origin/main` chip beside it. A symref is a POINTER; the thing it
      // points at is already here under its own name.
      if (ref.symref) continue;
      out.push({ name: ref.name, fullName, kind: "remoteHead" });
    } else if (ref.type === "tag") {
      out.push({ name: ref.name, fullName, kind: "tag" });
    }
  }
  out.sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
  return out;
}

function kindRank(kind: WireRef["kind"]): number {
  switch (kind) {
    case "currentHead":
      return 0;
    case "head":
      return 1;
    case "remoteHead":
      return 2;
    case "tag":
      return 3;
  }
}
