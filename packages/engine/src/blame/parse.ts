// Pure parser for `git blame --incremental` (the incremental porcelain).
//
// The incremental format emits one *group* per contiguous run of lines that
// share a commit. Each group starts with a header line:
//
//   <40-hex-sha> <orig-line> <final-line> <num-lines>
//
// followed by metadata lines (`author`, `author-mail`, `author-time`,
// `author-tz`, `committer`, `committer-mail`, `committer-time`,
// `committer-tz`, `summary`, an optional `boundary`, an optional
// `previous <sha> <path>`), and a terminating `filename <path>` line.
//
// Crucially, git emits the *full* metadata block only the FIRST time a commit
// appears. Later groups for the same sha carry just the header + `filename`
// (and maybe `previous` / `boundary`). So we cache commit metadata by sha and
// reuse it for the lean follow-up groups.
//
// This module is PURE — no node/vscode/fs imports — so it stays trivially
// unit-testable and can power both the VS Code extension and the desktop app.
// The blame types live canonically in @gitstudio/host-bridge (type-only); we
// re-export them here for ergonomic `from "@gitstudio/engine/blame/parse"`.

import type {
  BlameCommit,
  BlameLine,
  BlameResult,
} from "@gitstudio/host-bridge/blame";
import { UNCOMMITTED_SHA } from "@gitstudio/host-bridge/blame";

export type { BlameCommit, BlameLine, BlameResult };
export { UNCOMMITTED_SHA };

const HEADER_RE = /^([0-9a-f]{40}) (\d+) (\d+) (\d+)$/;

/**
 * Parses `git blame --incremental` output into per-line attribution plus a
 * sha→commit map. Robust to `\r\n` line endings, a trailing newline, blank
 * lines, and groups arriving in any order.
 */
export function parseIncrementalBlame(output: string): BlameResult {
  const commits = new Map<string, BlameCommit>();
  const lines: BlameLine[] = [];

  // Normalize line endings, then walk line-by-line. Headers gate each group;
  // metadata keys in between mutate the in-progress commit for that sha.
  const rawLines = output.replace(/\r\n/g, "\n").split("\n");

  let current: BlameCommit | undefined;

  for (const raw of rawLines) {
    if (raw.length === 0) {
      continue;
    }

    const header = HEADER_RE.exec(raw);
    if (header) {
      const sha = header[1];
      const origLine = Number(header[2]);
      const finalLine = Number(header[3]);
      const numLines = Number(header[4]);

      // Reuse cached metadata (lean follow-up groups carry none), or seed a
      // fresh placeholder the metadata lines below will fill in.
      let commit = commits.get(sha);
      if (!commit) {
        commit = {
          sha,
          author: "",
          authorMail: "",
          authorTime: 0,
          authorTz: "",
          committer: "",
          committerMail: "",
          committerTime: 0,
          summary: "",
          isBoundary: false,
        };
        commits.set(sha, commit);
      }
      current = commit;

      // Expand the group into one BlameLine per covered source line.
      for (let i = 0; i < numLines; i++) {
        lines.push({
          finalLine: finalLine + i,
          origLine: origLine + i,
          sha,
        });
      }
      continue;
    }

    if (!current) {
      // Stray metadata before any header — ignore defensively.
      continue;
    }

    // A metadata line: split on the first space into key + value.
    const spaceIdx = raw.indexOf(" ");
    const key = spaceIdx === -1 ? raw : raw.slice(0, spaceIdx);
    const value = spaceIdx === -1 ? "" : raw.slice(spaceIdx + 1);

    switch (key) {
      case "author":
        current.author = value;
        break;
      case "author-mail":
        current.authorMail = stripAngles(value);
        break;
      case "author-time":
        current.authorTime = Number(value);
        break;
      case "author-tz":
        current.authorTz = value;
        break;
      case "committer":
        current.committer = value;
        break;
      case "committer-mail":
        current.committerMail = stripAngles(value);
        break;
      case "committer-time":
        current.committerTime = Number(value);
        break;
      case "summary":
        current.summary = value;
        break;
      case "boundary":
        current.isBoundary = true;
        break;
      case "previous": {
        // `previous <sha> <path>` — path may contain spaces.
        const prevSpace = value.indexOf(" ");
        if (prevSpace !== -1) {
          current.previous = {
            sha: value.slice(0, prevSpace),
            filename: value.slice(prevSpace + 1),
          };
        }
        break;
      }
      // `filename`, `committer-tz`, and any future keys are ignored — the
      // header already gave us everything line-mapping needs.
      default:
        break;
    }
  }

  lines.sort((a, b) => a.finalLine - b.finalLine);
  return { commits, lines };
}

/** git wraps mails in angle brackets: `<bob@example.com>` → `bob@example.com`. */
function stripAngles(value: string): string {
  if (value.startsWith("<") && value.endsWith(">")) {
    return value.slice(1, -1);
  }
  return value;
}
