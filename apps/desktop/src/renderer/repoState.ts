// "●3 ↑1 ↓2" — a repository's working-tree signals, said the same way on every
// screen that lists repositories you have (Home's card and the Repositories
// screen, #32). One `git status --porcelain=v2 --branch` per repository in the
// main process (main/localRepos.ts); this is only how the answer is WORN.
//
// Two rules, both learned on Home first:
//   · nothing to say means nothing shown — a clean repository with nothing to
//     push or pull wears no cluster, because a row of zeros is noise wearing
//     precision;
//   · an unanswerable repository (missing, not a repository any more, slower
//     than the probe's timeout) is also nothing, never "0": zero is a claim.

import { el, span } from "./ui";
import type { LocalRepoStatus } from "../shared/ipc";
import { plural } from "./textFit";

/** Is there anything worth saying? */
export function hasNews(st: LocalRepoStatus | undefined): st is LocalRepoStatus {
  return !!st && (st.dirty > 0 || st.ahead > 0 || st.behind > 0);
}

/** The bits, each with the hover that says what its symbol means. Empty when
 *  there is no news. */
export function repoStateBits(st: LocalRepoStatus | undefined): HTMLElement[] {
  if (!hasNews(st)) return [];
  const out: HTMLElement[] = [];
  if (st.dirty > 0) {
    const d = span(`●${st.dirty}`, "repo-state-bit is-dirty");
    d.title = `${st.dirty} changed ${st.dirty === 1 ? "file" : "files"} in the working tree`;
    out.push(d);
  }
  if (st.ahead > 0) {
    const a = span(`↑${st.ahead}`, "repo-state-bit is-ahead");
    a.title = `${st.ahead} ${st.ahead === 1 ? "commit" : "commits"} not pushed${st.branch ? ` on ${st.branch}` : ""}`;
    out.push(a);
  }
  if (st.behind > 0) {
    const b = span(`↓${st.behind}`, "repo-state-bit is-behind");
    b.title = `${st.behind} ${st.behind === 1 ? "commit" : "commits"} behind the remote`;
    out.push(b);
  }
  return out;
}

/** The whole cluster, or undefined when there is nothing to say. */
export function repoState(st: LocalRepoStatus | undefined): HTMLElement | undefined {
  const bits = repoStateBits(st);
  if (!bits.length) return undefined;
  const cluster = el("span", "repo-state");
  cluster.append(...bits);
  return cluster;
}

/** The same facts in words, for a row's accessible name — the symbols and
 *  their hovers reach nobody using a screen reader. */
export function repoStateWords(st: LocalRepoStatus | undefined): string {
  if (!hasNews(st)) return "";
  const parts: string[] = [];
  if (st.dirty > 0) parts.push(plural(st.dirty, "changed file"));
  if (st.ahead > 0) parts.push(`${plural(st.ahead, "commit")} to push`);
  if (st.behind > 0) parts.push(`${plural(st.behind, "commit")} to pull`);
  return parts.join(", ");
}
