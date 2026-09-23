// Holds an oracle to the matrix's definition (cases.ts), in both directions:
// every operation × conflict style is there, every content case produced its
// conflicted files with the shape git and both hosts must give them, and
// nothing is conflicted that no case claims. Also the invariants every later
// check leans on — the stage convention, which content is Yours, the markers
// each conflict style writes, and the property that makes each case the case.
//
// Pure: it reads an Oracle and returns what is wrong, in plain words.

import { YOURS_STAGE } from "@gitstudio/engine/conflict/sides";
import { CONTENT_CASES, MATRIX_FILE_COUNT, OPERATIONS, STYLES, scenarioIds, type EngineExpect } from "./cases";
import type { FileOracle, Oracle } from "./oracle";

const TEXTUAL = new Set(["text", "added-both"]);
const STAGE_CONTENT: Array<["1" | "2" | "3", string]> = [
  ["1", "base"],
  ["2", "x"],
  ["3", "y"],
];

function engineProblems(e: EngineExpect, f: FileOracle): string[] {
  const out: string[] = [];
  const m = f.engine;
  if (!m) return ["the engine built no model"];
  if (e.conflicts !== undefined && m.counts.conflict !== e.conflicts) {
    out.push(`${m.counts.conflict} conflicts, expected ${e.conflicts}`);
  }
  if (e.minBlocks !== undefined && m.blocks.length < e.minBlocks) out.push(`${m.blocks.length} blocks, expected ≥ ${e.minBlocks}`);
  for (const letter of e.has ?? "") if (!m.blocks.includes(letter)) out.push(`no "${letter}" block in ${m.blocks.slice(0, 60)}`);
  if (e.last !== undefined && m.blocks.at(-1) !== e.last) out.push(`the last block is "${m.blocks.at(-1)}", expected "${e.last}"`);
  if (e.eolMismatch !== undefined && !!m.eolMismatch !== e.eolMismatch) out.push(`eolMismatch is ${!!m.eolMismatch}`);
  if (e.eol !== undefined && m.eol !== e.eol) out.push(`eol is ${m.eol}, expected ${e.eol}`);
  if (e.sameIgnoringWhitespace && m.ignoringWhitespace.same < 1) out.push("no identical block with whitespace ignored");
  return out;
}

export function matrixProblems(o: Oracle): string[] {
  const problems: string[] = [];
  const want = new Set(scenarioIds());
  for (const id of want) if (!o.scenarios[id]) problems.push(`scenario ${id} is missing`);
  for (const id of Object.keys(o.scenarios)) if (!want.has(id)) problems.push(`scenario ${id} is not defined in cases.ts`);

  for (const def of OPERATIONS) {
    for (const style of STYLES) {
      const id = `${def.id}.${style}`;
      const s = o.scenarios[id];
      if (!s) continue;
      const p = (m: string) => problems.push(`${id}: ${m}`);

      if (s.kind !== def.kind) p(`the operation is "${s.kind}", expected "${def.kind}"`);
      if (def.backend && s.backend !== def.backend) p(`the backend is "${s.backend}", expected "${def.backend}"`);
      if (def.step && JSON.stringify(s.step) !== JSON.stringify(def.step)) {
        p(`stopped at ${JSON.stringify(s.step)}, expected ${JSON.stringify(def.step)}`);
      }
      if (def.queued !== undefined && s.queued !== def.queued) p(`${s.queued} queued, expected ${def.queued}`);
      if (s.yours.stage !== YOURS_STAGE[def.kind]) p(`Yours is stage ${s.yours.stage}, expected ${YOURS_STAGE[def.kind]}`);
      if (!s.header) p("the operation has no header");
      if (!s.yours.paneTitle || !s.theirs.paneTitle) p("a pane has no title");
      for (const m of s.labelMismatches) p(`pane titles differ from the operation's: ${m}`);

      const paths = Object.keys(s.files);
      if (def.matrix) {
        if (paths.length !== MATRIX_FILE_COUNT) p(`${paths.length} conflicted files, expected ${MATRIX_FILE_COUNT}`);
        for (const c of CONTENT_CASES) {
          c.files.forEach((cf, i) => {
            const hits = paths.filter((pp) => (cf.pattern ? cf.pattern.test(pp) : pp === cf.path));
            if (hits.length !== 1) {
              p(`case ${c.id}: ${cf.path} ${hits.length === 0 ? "is not conflicted" : `matches ${hits.join(", ")}`}`);
              return;
            }
            const f = s.files[hits[0]];
            if (!cf.xy.includes(f.xy)) p(`case ${c.id}: ${hits[0]} is ${f.xy}, expected ${cf.xy.join(" or ")}`);
            if (f.shape !== cf.shape) p(`case ${c.id}: ${hits[0]} is "${f.shape}", expected "${cf.shape}"`);
            if (i === 0 && c.engine) for (const m of engineProblems(c.engine, f)) p(`case ${c.id}: ${hits[0]}: ${m}`);
          });
        }
      } else if (def.files) {
        const got = [...paths].sort().join(", ");
        const exp = [...def.files].sort().join(", ");
        if (got !== exp) p(`conflicted files are [${got}], expected exactly [${exp}]`);
      }

      for (const [path, f] of Object.entries(s.files)) {
        const q = (m: string) => p(`${path}: ${m}`);
        if (f.case === "UNKNOWN") q("conflicted, but no content case claims it");
        // Both hosts read the same thing.
        if (f.desktop.shape !== f.shape) q(`the desktop calls it "${f.desktop.shape}", the extensions "${f.shape}"`);
        if (!f.desktop.sameSides) q("the desktop's sides differ from the extensions' payload");
        // The stage convention fixtures.sh promises.
        for (const [n, content] of STAGE_CONTENT) {
          const v = f.stages[n];
          if (v !== undefined && !v.split("|").includes(content)) q(`stage ${n} holds ${v}, expected ${content}`);
        }
        // Yours / Theirs are the operation's stages.
        if (f.yours !== (f.stages[String(s.yours.stage) as "2" | "3"] ?? null)) q(`Yours is ${f.yours}, not stage ${s.yours.stage}`);
        if (f.theirs !== (f.stages[String(s.theirs.stage) as "2" | "3"] ?? null)) {
          q(`Theirs is ${f.theirs}, not stage ${s.theirs.stage}`);
        }
        const textual = TEXTUAL.has(f.shape);
        if (textual !== (f.engine !== null)) q(textual ? "a text merge with no engine model" : "an engine model for a file with no text merge");
        // What each conflict style writes into the working file.
        if (textual && f.xy === "UU") {
          if (f.markers.conflicts === 0) q("no conflict markers in the working file");
          if (style === "merge" && f.markers.baseSections !== 0) q(`${f.markers.baseSections} base sections in merge style`);
          if (style !== "merge" && f.markers.baseSections !== f.markers.conflicts) {
            q(`${f.markers.conflicts} conflicts but ${f.markers.baseSections} base sections in ${style} style`);
          }
        }
      }
    }
  }
  return problems;
}
