// The page side of the merge-view headless tests: the REAL MergeView, the real
// diff.css (bundled with Monaco's own CSS), and one fixture with a block of
// every colour category.
//
// Bundled by test/fixtures/mergeViewPage.ts; the test scripts reach it through
// `window.gsMerge`.

import "../../src/styles/diff.css";
import { MergeView } from "../../src/mergeView";
import { DiffView } from "../../src/diffView";
import * as monaco from "monaco-editor";
import { spanY } from "../../src/ribbons";
import { buildMergeModel } from "@gitstudio/engine/mergeModel";
import { category, sideBlockSpan } from "@gitstudio/engine/types";
import type { MergeInitPayload } from "@gitstudio/host-bridge/protocol";
import type { OperationView } from "@gitstudio/host-bridge/conflictsProtocol";

// Monaco asks for a worker for language features. The merge computes its
// model in-process, so a worker that never answers is enough — and keeps a
// file:// page from logging a failed worker load.
(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker: () =>
    new Worker(URL.createObjectURL(new Blob([""], { type: "text/javascript" }))),
};

const lines = (arr: string[]): string => arr.join("\n");

/**
 * One block per category, each separated by an unchanged line so none touch:
 *
 *   #0 conflict            c1: Yours and Theirs rewrote it differently
 *   #1 resolvable conflict r1 / r2: Yours rewrote r1, Theirs r2 (touching)
 *   #2 identical (exact)   s1: both made the same change
 *   #3 identical (≈)       w1: the same change, Theirs with trailing spaces
 *                          (a conflict under "none"; ≈ under "trailing")
 *   #4 yours-only          y1: modified in Yours
 *   #5 theirs-only         an insertion in Theirs (blue: one side only)
 *   #6 theirs-only         d1 deleted in Theirs (grey: lines removed, no conflict)
 *   #7 yours-only          ws1 re-indented in Yours (whitespace-only under
 *                          "trailing"; a plain change under "none")
 */
export const FIXTURE = {
  base: lines([
    "header",
    "c1 = base",
    "keep1",
    "r1 = base",
    "r2 = base",
    "keep2",
    "s1 = base",
    "keep3",
    "w1 = base",
    "keep4",
    "y1 = base",
    "keep5",
    "keep6",
    "d1 = base",
    "keep7",
    "ws1 = base",
    "footer",
  ]),
  ours: lines([
    "header",
    "c1 = yours",
    "keep1",
    "r1 = yours",
    "r2 = base",
    "keep2",
    "s1 = same",
    "keep3",
    "w1 = new",
    "keep4",
    "y1 = yours",
    "keep5",
    "keep6",
    "d1 = base",
    "keep7",
    "    ws1 = base",
    "footer",
  ]),
  theirs: lines([
    "header",
    "c1 = theirs",
    "keep1",
    "r1 = base",
    "r2 = theirs",
    "keep2",
    "s1 = same",
    "keep3",
    "w1 = new   ",
    "keep4",
    "y1 = base",
    "keep5",
    "t0 = theirs",
    "keep6",
    "keep7",
    "ws1 = base",
    "footer",
  ]),
};

/** A hand-built rebase OperationView (Yours = stage 3 = the branch being rebased). */
export const REBASE_OP: OperationView = {
  kind: "rebase",
  backend: "merge",
  episode: "rebase:0000000",
  title: "Rebasing test onto master",
  direction: { from: "yours", verb: "onto", to: "theirs" },
  step: { n: 1, m: 1, unit: "commit" },
  yours: {
    role: "yours",
    stage: 3,
    name: "test",
    paneTitle: "Rebasing 1234567 from test",
    description: "Your commit being replayed",
  },
  theirs: {
    role: "theirs",
    stage: 2,
    name: "master",
    paneTitle: "Already rebased commits and commits from master",
    description: "What you are rebasing onto",
  },
  verbs: { continue: "Continue Rebase", abort: "Abort Rebase" },
  canContinue: false,
  canSkip: false,
};

export function payload(over: Partial<MergeInitPayload> = {}): MergeInitPayload {
  return {
    fileName: "colours.txt",
    conflictType: "content",
    source: "git-stages",
    hasBase: true,
    oursLabel: "Yours",
    theirsLabel: "Theirs",
    base: FIXTURE.base,
    ours: FIXTURE.ours,
    theirs: FIXTURE.theirs,
    result: FIXTURE.base,
    ...over,
  };
}

(window as unknown as { gsMerge: unknown }).gsMerge = {
  MergeView,
  DiffView,
  monaco,
  spanY,
  buildMergeModel,
  category,
  sideBlockSpan,
  FIXTURE,
  REBASE_OP,
  payload,
};
