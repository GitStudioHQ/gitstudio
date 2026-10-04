#!/usr/bin/env node
// Run one shard of the test suite: `extension`, `desktop`, `git` (git-service),
// or `rest` (every other workspace with tests, found from package.json — so a
// new workspace is never left out of CI by a hand-kept list).
//
//   node scripts/test/shard.mjs rest
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const OWN = { extension: "apps/extension", desktop: "apps/desktop", git: "packages/git-service" };
const shard = process.argv[2];
if (!shard || !(shard in OWN || shard === "rest")) {
  console.error("usage: node scripts/test/shard.mjs extension|desktop|git|rest");
  process.exit(2);
}
const all = [];
for (const pattern of JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).workspaces) {
  const parent = join(ROOT, pattern.replace(/\/\*$/, ""));
  for (const name of readdirSync(parent).sort()) {
    const file = join(parent, name, "package.json");
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).scripts?.test) all.push(relative(ROOT, join(parent, name)).split("\\").join("/"));
  }
}
const mine = shard === "rest" ? all.filter((w) => !Object.values(OWN).includes(w)) : [OWN[shard]];
console.log(`shard ${shard}: ${mine.join(", ")}`);
const r = spawnSync("npm", ["test", ...mine.flatMap((w) => ["--workspace", w])], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
process.exit(r.status ?? 1);
