// Generates oracle.json — what every later check expects of every file in the
// matrix — from the built repositories, with the ENGINE and git itself. Never
// hand-typed: every value below is read from git (the index, the operation
// state, `git merge-file`), from the products' own code paths (ConflictOps +
// buildMergePayload for the extensions, GitBridge.conflictModel for the
// desktop), or from packages/engine's buildMergeModel over that payload.
//
//   npx tsx scripts/merge-e2e/oracle.ts                     # build a fresh matrix in a temp dir, rewrite oracle.json
//   npx tsx scripts/merge-e2e/oracle.ts --target <dir>      # use a matrix fixtures.sh already built there
//   npx tsx scripts/merge-e2e/oracle.ts --check             # fail if oracle.json is not what the matrix produces
//
// Per scenario (operation × conflict style): the operation as the products
// name it (kind, header, step N of M, pane titles, which stage is Yours), and
// per conflicted file: git's XY, the shape, which content each stage holds
// (base / x / y, by blob), which content is Yours and Theirs, the category of
// EVERY block (one letter each, see LEGEND) and the counts per category, git's
// own merge-file conflict count to cross-check them, the markers the working
// file carries in this conflict style, and the desktop's shape for the same
// file.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Hermetic git for every process this one spawns (GitContext included).
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";
process.env.GIT_OPTIONAL_LOCKS = "0";
delete process.env.GIT_TRACE2;
delete process.env.GIT_TRACE2_EVENT;
delete process.env.GIT_TRACE2_PERF;

import { GitContext } from "@gitstudio/git-service/GitContext";
import { buildMergeModel } from "@gitstudio/engine/mergeModel";
import { category, type ChangeBlock, type MergeModel } from "@gitstudio/engine/types";
import { readMergePayload } from "@gitstudio/merge-vscode/payload";
import type { MergeInitPayload } from "@gitstudio/host-bridge/protocol";
import type { OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import { RepoStore } from "../../apps/desktop/src/main/repoStore";
import { GitBridge } from "../../apps/desktop/src/main/gitBridge";
import { caseOf, OPERATIONS, STYLES } from "./cases";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ORACLE_PATH = join(HERE, "oracle.json");
export const FIXTURES = join(HERE, "fixtures.sh");

/** One letter per block, in document order. */
export const LEGEND = {
  c: "conflict",
  r: "conflict the wand resolves (non-overlapping edits)",
  s: "same change on both sides (exact)",
  w: "same change up to whitespace",
  y: "Yours only",
  t: "Theirs only",
} as const;

export interface Counts {
  conflict: number;
  same: number;
  yoursOnly: number;
  theirsOnly: number;
  resolvable: number;
}

export interface FileOracle {
  case: string;
  xy: string;
  shape: string;
  missingRole?: string;
  hasBase: boolean;
  /** Which content each git stage holds, by blob: "base" | "x" | "y" (or several, "x|y", when equal); absent = no stage. */
  stages: Partial<Record<"1" | "2" | "3", string>>;
  /** Which content is Yours (left pane) and Theirs (right pane) — through the operation. */
  yours: string | null;
  theirs: string | null;
  engine: {
    blocks: string;
    counts: Counts;
    eol: string;
    eolMismatch?: { yours: string; theirs: string; result: string };
    /** The same model with whitespace ignored ("all"). */
    ignoringWhitespace: Counts;
  } | null;
  /** `git merge-file`'s conflict count over stages 2 / 1 / 3 (null: git will not text-merge it). */
  gitMergeFile: number | null;
  /** Conflict markers in the working file, as this conflict style wrote them. */
  markers: { conflicts: number; baseSections: number };
  desktop: { shape: string; sameSides: boolean };
}

export interface ScenarioOracle {
  op: string;
  style: string;
  dir: string;
  command: string;
  kind: string;
  backend?: string;
  header: string;
  step?: { n: number; m: number; unit: string };
  queued?: number;
  commit?: string;
  yours: { stage: number; name: string; paneTitle: string };
  theirs: { stage: number; name: string; paneTitle: string };
  verbs: Record<string, string>;
  canSkip: boolean;
  /** Files whose payload / desktop pane titles are NOT the operation's (should be none). */
  labelMismatches: string[];
  summary: { files: number; byShape: Record<string, number>; engineConflicts: number; gitConflicts: number };
  files: Record<string, FileOracle>;
}

export interface Oracle {
  generatedBy: string;
  git: string;
  loadBlocks: number;
  convention: string;
  legend: typeof LEGEND;
  scenarios: Record<string, ScenarioOracle>;
}

const run = (cwd: string, args: string[], input?: string | Buffer): string =>
  execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });

/** Build the matrix with fixtures.sh into `target` (created). */
export function buildMatrix(target: string, opts: { ops?: string[]; styles?: string[] } = {}): void {
  const args = [FIXTURES, target];
  if (opts.ops) args.push("--ops", opts.ops.join(","));
  if (opts.styles) args.push("--styles", opts.styles.join(","));
  const r = spawnSync("bash", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`fixtures.sh failed (${r.status}):\n${r.stderr}`);
}

interface MatrixManifest {
  git: string;
  loadBlocks: number;
  scenarios: Array<{ id: string; op: string; style: string; dir: string; command: string }>;
}

/** blob sha → which variants hold it (anywhere in the content tree). */
function contentBlobs(target: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const add = (sha: string, v: string) => {
    let s = map.get(sha);
    if (!s) map.set(sha, (s = new Set()));
    s.add(v);
  };
  for (const v of ["base", "x", "y"]) {
    const root = join(target, ".content", v);
    const files: string[] = [];
    const links: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isSymbolicLink()) links.push(p);
        else if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(root);
    const shas = run(root, ["hash-object", "--no-filters", "--stdin-paths"], files.join("\n") + "\n")
      .trim()
      .split("\n");
    for (const s of shas) add(s, v);
    for (const l of links) add(run(root, ["hash-object", "--stdin"], readlinkSync(l)).trim(), v);
    add(run(join(target, ".sub"), ["rev-parse", `${v}^{commit}`]).trim(), v);
  }
  return map;
}

function variantOf(blobs: Map<string, Set<string>>, sha: string): string {
  const s = blobs.get(sha);
  return s ? ["base", "x", "y"].filter((v) => s.has(v)).join("|") : `unknown:${sha.slice(0, 12)}`;
}

function counts(m: MergeModel): Counts {
  const c: Counts = { conflict: 0, same: 0, yoursOnly: 0, theirsOnly: 0, resolvable: 0 };
  for (const b of m.blocks) {
    const k = category(b);
    if (k === "conflict") c.conflict++;
    else if (k === "same") c.same++;
    else if (k === "yours-only") c.yoursOnly++;
    else c.theirsOnly++;
    if (b.kind === "conflict" && b.resolvable) c.resolvable++;
  }
  return c;
}

function letter(b: ChangeBlock): string {
  switch (b.kind) {
    case "conflict":
      return b.resolvable ? "r" : "c";
    case "both-same":
      return b.exact === false ? "w" : "s";
    case "left-only":
      return "y";
    case "right-only":
      return "t";
  }
}

/**
 * The engine's view of a payload, exactly as the merge view builds it
 * (buildMergeModel over base / ours / theirs, whitespace "none" by default),
 * plus the same with whitespace ignored. Memoised by content: the matrix keeps
 * one stage convention everywhere, so the 30-odd scenarios hold only two
 * orientations of each file, and the load fixture costs seconds per model.
 */
const engineMemo = new Map<string, NonNullable<FileOracle["engine"]>>();
function engineFacts(p: Pick<MergeInitPayload, "base" | "ours" | "theirs">): NonNullable<FileOracle["engine"]> {
  const key = [p.base, p.ours, p.theirs].map((t) => createHash("sha1").update(t).digest("hex")).join(":");
  const hit = engineMemo.get(key);
  if (hit) return structuredClone(hit);
  const none = buildMergeModel(p.base, p.ours, p.theirs, { whitespace: "none" });
  const all = buildMergeModel(p.base, p.ours, p.theirs, { whitespace: "all" });
  const facts: NonNullable<FileOracle["engine"]> = {
    blocks: none.blocks.map(letter).join(""),
    counts: counts(none),
    eol: none.eol,
    ...(none.eolMismatch ? { eolMismatch: { ...none.eolMismatch } } : {}),
    ignoringWhitespace: counts(all),
  };
  engineMemo.set(key, facts);
  return structuredClone(facts);
}

type StageEntry = { mode: string; sha: string };

function unmergedStages(root: string): Map<string, Map<number, StageEntry>> {
  const out = new Map<string, Map<number, StageEntry>>();
  for (const rec of run(root, ["ls-files", "-u", "-z"]).split("\0")) {
    const m = /^(\d{6}) ([0-9a-f]+) ([123])\t([\s\S]*)$/.exec(rec);
    if (!m) continue;
    let st = out.get(m[4]);
    if (!st) out.set(m[4], (st = new Map()));
    st.set(Number(m[3]), { mode: m[1], sha: m[2] });
  }
  return out;
}

const XY: Record<string, string> = { "123": "UU", "23": "AA", "1": "DD", "12": "UD", "13": "DU", "2": "AU", "3": "UA" };

/**
 * `git merge-file` over stages 2 / 1 / 3, in the repository (so in its
 * merge.conflictStyle): the conflicts it writes. Counted from the markers in
 * its output — the exit code saturates at 127, and the load fixture has more.
 */
function gitMergeFile(root: string, st: Map<number, StageEntry>, scratch: string): number | null {
  const two = st.get(2);
  const three = st.get(3);
  if (!two || !three) return null;
  const regular = (e?: StageEntry) => !e || e.mode.startsWith("100");
  if (!regular(two) || !regular(three) || !regular(st.get(1))) return null;
  const write = (name: string, e?: StageEntry) => {
    const p = join(scratch, name);
    writeFileSync(
      p,
      e ? execFileSync("git", ["cat-file", "blob", e.sha], { cwd: root, maxBuffer: 256 * 1024 * 1024 }) : "",
    );
    return p;
  };
  const a = write("ours", two);
  const o = write("base", st.get(1));
  const b = write("theirs", three);
  const r = spawnSync("git", ["merge-file", "-p", "-L", "ours", "-L", "base", "-L", "theirs", a, o, b], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status === null || r.status < 0 || r.status > 127) return null; // binary / error
  return (r.stdout.toString("latin1").match(/^<{7} ours\r?$/gm) ?? []).length;
}

function markerCounts(abs: string): { conflicts: number; baseSections: number } {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return { conflicts: 0, baseSections: 0 };
  }
  if (!st.isFile()) return { conflicts: 0, baseSections: 0 };
  const text = readFileSync(abs, "latin1");
  return {
    conflicts: (text.match(/^<{7}(?: |\r?$)/gm) ?? []).length,
    baseSections: (text.match(/^\|{7}(?: |\r?$)/gm) ?? []).length,
  };
}

/** The live document text the extension's merge editor would hold. */
export function workingText(abs: string): string {
  try {
    return lstatSync(abs).isFile() ? readFileSync(abs, "utf8") : "";
  } catch {
    return "";
  }
}

/** The extension's payload for one file: ConflictOps.readSides → buildMergePayload, the hosts' one builder. */
export async function extensionPayload(
  ctx: GitContext,
  root: string,
  rel: string,
  op: OperationView,
): Promise<MergeInitPayload> {
  const abs = join(root, rel);
  return readMergePayload(
    ctx.conflictOps,
    rel,
    { fileName: abs, workingText: workingText(abs), autoApplyNonConflicting: false },
    { op },
  );
}

/** The desktop's ConflictModel for one file: the real GitBridge over the real repository. */
export async function desktopBridge(root: string): Promise<GitBridge> {
  const repos = new RepoStore([]);
  await repos.open(root);
  return new GitBridge(repos);
}

async function scenarioOracle(
  target: string,
  s: MatrixManifest["scenarios"][number],
  blobs: Map<string, Set<string>>,
): Promise<ScenarioOracle> {
  const root = join(target, s.dir);
  const ctx = new GitContext({ root });
  const bridge = await desktopBridge(root);
  const scratch = mkdtempSync(join(tmpdir(), "gs-oracle-"));
  try {
    const op = await ctx.operation.view();
    const facts = await ctx.conflictOps.conflictFiles({ op });
    const stages = unmergedStages(root);
    const files: Record<string, FileOracle> = {};
    const labelMismatches: string[] = [];
    const byShape: Record<string, number> = {};
    let engineConflicts = 0;
    let gitConflicts = 0;
    for (const f of [...facts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      const st = stages.get(f.path) ?? new Map();
      const payload = await extensionPayload(ctx, root, f.path, op);
      const model = await bridge.conflictModel(f.path);
      if (payload.oursLabel !== op.yours.paneTitle || payload.theirsLabel !== op.theirs.paneTitle) {
        labelMismatches.push(`${f.path}: extension "${payload.oursLabel}" / "${payload.theirsLabel}"`);
      }
      if (model && (model.oursLabel !== op.yours.paneTitle || model.theirsLabel !== op.theirs.paneTitle)) {
        labelMismatches.push(`${f.path}: desktop "${model.oursLabel}" / "${model.theirsLabel}"`);
      }
      const stageVariant: FileOracle["stages"] = {};
      for (const n of [1, 2, 3] as const) {
        const e = st.get(n);
        if (e) stageVariant[String(n) as "1" | "2" | "3"] = variantOf(blobs, e.sha);
      }
      const textual = payload.shape === "text" || payload.shape === "added-both";
      const engine: FileOracle["engine"] = textual ? engineFacts(payload) : null;
      if (engine) engineConflicts += engine.counts.conflict;
      const g = gitMergeFile(root, st, scratch);
      if (g !== null) gitConflicts += g;
      const xy = XY[[...st.keys()].sort().join("")] ?? f.xy;
      files[f.path] = {
        case: caseOf(f.path)?.c.id ?? "UNKNOWN",
        xy,
        shape: payload.shape ?? "text",
        ...(payload.missingRole ? { missingRole: payload.missingRole } : {}),
        hasBase: payload.hasBase,
        stages: stageVariant,
        yours: stageVariant[String(op.yours.stage) as "2" | "3"] ?? null,
        theirs: stageVariant[String(op.theirs.stage) as "2" | "3"] ?? null,
        engine,
        gitMergeFile: g,
        markers: markerCounts(join(root, f.path)),
        desktop: {
          shape: model?.shape ?? "none",
          sameSides:
            !!model && model.ours === payload.ours && model.theirs === payload.theirs && model.base === payload.base,
        },
      };
      byShape[files[f.path].shape] = (byShape[files[f.path].shape] ?? 0) + 1;
    }
    return {
      op: s.op,
      style: s.style,
      dir: s.dir,
      command: s.command,
      kind: op.kind,
      ...(op.backend ? { backend: op.backend } : {}),
      header: op.title,
      ...(op.step ? { step: { ...op.step } } : {}),
      ...(op.queued !== undefined ? { queued: op.queued } : {}),
      ...(op.commit ? { commit: op.commit.subject } : {}),
      yours: { stage: op.yours.stage, name: op.yours.name, paneTitle: op.yours.paneTitle },
      theirs: { stage: op.theirs.stage, name: op.theirs.name, paneTitle: op.theirs.paneTitle },
      verbs: { ...op.verbs } as Record<string, string>,
      canSkip: op.canSkip,
      labelMismatches,
      summary: { files: Object.keys(files).length, byShape, engineConflicts, gitConflicts },
      files,
    };
  } finally {
    ctx.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Read every scenario fixtures.sh built under `target`. */
export async function buildOracle(target: string): Promise<Oracle> {
  const manifest = JSON.parse(readFileSync(join(target, "matrix.json"), "utf8")) as MatrixManifest;
  const blobs = contentBlobs(target);
  // A few scenarios at a time: each is ~30 files × a dozen git spawns through
  // both hosts' read paths, and those are spawn-bound, not CPU-bound.
  const results = new Array<ScenarioOracle>(manifest.scenarios.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < manifest.scenarios.length) {
      const i = next++;
      results[i] = await scenarioOracle(target, manifest.scenarios[i], blobs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, manifest.scenarios.length) }, worker));
  const scenarios: Record<string, ScenarioOracle> = {};
  manifest.scenarios.forEach((s, i) => (scenarios[s.id] = results[i]));
  return {
    generatedBy: "scripts/merge-e2e/oracle.ts over scripts/merge-e2e/fixtures.sh — never edit by hand",
    git: manifest.git,
    loadBlocks: manifest.loadBlocks,
    convention:
      "stage 1 = base, stage 2 = x, stage 3 = y in every operation; yours/theirs name the content each role gets",
    legend: LEGEND,
    scenarios,
  };
}

/**
 * Stable text: two-space JSON, except each file's entry sits on ONE line, so a
 * diff of oracle.json reads as "this file in this scenario changed".
 */
export function serializeOracle(o: Oracle): string {
  const lines: string[] = ["{"];
  const top = Object.entries(o).filter(([k]) => k !== "scenarios");
  for (const [k, v] of top) lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  lines.push(`  "scenarios": {`);
  const ids = Object.keys(o.scenarios);
  ids.forEach((id, i) => {
    const s = o.scenarios[id];
    lines.push(`    ${JSON.stringify(id)}: {`);
    const entries = Object.entries(s).filter(([k]) => k !== "files");
    for (const [k, v] of entries) lines.push(`      ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
    lines.push(`      "files": {`);
    const paths = Object.keys(s.files);
    paths.forEach((p, j) => {
      lines.push(`        ${JSON.stringify(p)}: ${JSON.stringify(s.files[p])}${j < paths.length - 1 ? "," : ""}`);
    });
    lines.push(`      }`);
    lines.push(`    }${i < ids.length - 1 ? "," : ""}`);
  });
  lines.push("  }");
  lines.push("}");
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const check = argv.includes("--check");
  const out = resolve(flag("--out") ?? ORACLE_PATH);
  let target = flag("--target");
  let temp: string | undefined;
  if (!target) {
    temp = mkdtempSync(join(tmpdir(), "gs-merge-matrix-"));
    target = temp;
    process.stderr.write(`building the matrix in ${target} …\n`);
    buildMatrix(target);
  }
  try {
    const text = serializeOracle(await buildOracle(resolve(target)));
    if (check) {
      const committed = existsSync(out) ? readFileSync(out, "utf8") : "";
      if (committed !== text) {
        process.stderr.write(
          `${relative(process.cwd(), out)} is stale — regenerate it with: npx tsx scripts/merge-e2e/oracle.ts\n`,
        );
        process.exit(1);
      }
      process.stderr.write("oracle.json is current\n");
    } else {
      writeFileSync(out, text);
      process.stderr.write(
        `wrote ${relative(process.cwd(), out)} (${Object.keys(JSON.parse(text).scenarios).length} scenarios)\n`,
      );
    }
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}

// Referenced so a reader can find the definition the oracle is checked against.
export { OPERATIONS, STYLES };
