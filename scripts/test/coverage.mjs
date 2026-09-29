#!/usr/bin/env node
// Run every workspace's tests under c8, one workspace at a time, and merge the
// line hits into coverage/lcov.info (what CI uploads to Codecov).
//
//   node scripts/test/coverage.mjs
//
// Why not one `c8 npm test` over the whole repo: c8 merges V8's raw coverage by
// script URL before it maps anything back to TypeScript, and assumes every
// process that loaded a file ran the SAME code. They did not — a package's
// source is transpiled once for its own tests and differently again when an
// app's tests load it through the workspace link — so the byte ranges of one
// were read against the text of another. Files shared that way came out as
// garbage: host-bridge's scrubber showed 13% while its own tests cover every
// line. Measured per workspace, each run only ever sees one transpilation; the
// merge below then adds up hits per LINE, which is exactly what Codecov does
// with several reports.
//
// Every workspace runs even when one fails, and the script fails at the end if
// any did — the same verdict as `npm test`, with the whole report either way.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = join(ROOT, "coverage");
const INCLUDE = ["apps/*/src/**", "packages/*/src/**"];

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const workspaces = [];
for (const pattern of pkg.workspaces) {
  const parent = join(ROOT, pattern.replace(/\/\*$/, ""));
  for (const name of readdirSync(parent).sort()) {
    const dir = join(parent, name);
    const file = join(dir, "package.json");
    if (!existsSync(file)) continue;
    if (JSON.parse(readFileSync(file, "utf8")).scripts?.test) workspaces.push(relative(ROOT, dir));
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const failed = [];
for (const ws of workspaces) {
  const slug = ws.replace(/[\\/]/g, "-");
  console.log(`\n── coverage: ${ws} ──`);
  const r = spawnSync(
    npx,
    [
      "--yes",
      "c8@10",
      "--reporter=lcov",
      `--report-dir=${join(OUT, "parts", slug)}`,
      `--temp-directory=${join(OUT, "tmp", slug)}`,
      ...INCLUDE.map((g) => `--include=${g}`),
      "npm",
      "test",
      "--workspace",
      ws,
    ],
    { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (r.status !== 0) failed.push(ws);
}

// Merge: per source file, per line, add the hits. Lines found = the union.
/** @type {Map<string, Map<number, number>>} */
const files = new Map();
for (const ws of workspaces) {
  const lcov = join(OUT, "parts", ws.replace(/[\\/]/g, "-"), "lcov.info");
  if (!existsSync(lcov)) continue;
  let lines;
  for (const raw of readFileSync(lcov, "utf8").split(/\r?\n/)) {
    if (raw.startsWith("SF:")) {
      const sf = relative(ROOT, resolve(ROOT, raw.slice(3))).split("\\").join("/");
      lines = files.get(sf) ?? new Map();
      files.set(sf, lines);
    } else if (raw.startsWith("DA:") && lines) {
      const [n, hits] = raw.slice(3).split(",").map(Number);
      lines.set(n, (lines.get(n) ?? 0) + hits);
    }
  }
}
let found = 0;
let hit = 0;
const out = [];
for (const sf of [...files.keys()].sort()) {
  const lines = files.get(sf);
  out.push("TN:", `SF:${sf}`);
  const nums = [...lines.keys()].sort((a, b) => a - b);
  let lh = 0;
  for (const n of nums) {
    out.push(`DA:${n},${lines.get(n)}`);
    if (lines.get(n) > 0) lh++;
  }
  out.push(`LF:${nums.length}`, `LH:${lh}`, "end_of_record");
  found += nums.length;
  hit += lh;
}
writeFileSync(join(OUT, "lcov.info"), out.join("\n") + "\n");
rmSync(join(OUT, "tmp"), { recursive: true, force: true });
console.log(`\ncoverage: ${hit}/${found} lines (${((100 * hit) / Math.max(found, 1)).toFixed(2)}%) over ${files.size} files → coverage/lcov.info`);
if (failed.length) {
  console.error(`tests failed in: ${failed.join(", ")}`);
  process.exit(1);
}
