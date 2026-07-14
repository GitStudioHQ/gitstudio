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
  isCurrent: boolean;
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
    if (ref.type === "head") {
      out.push({ name: ref.name, kind: ref.isCurrent ? "currentHead" : "head" });
    } else if (ref.type === "remote") {
      out.push({ name: ref.name, kind: "remoteHead" });
    } else if (ref.type === "tag") {
      out.push({ name: ref.name, kind: "tag" });
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
