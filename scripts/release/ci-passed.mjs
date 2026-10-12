#!/usr/bin/env node
// A release ships a commit CI has already tested on every OS — it does not test
// it again. Re-running the whole suite inside the release workflows cost an
// hour and was where flaky browser checks broke releases; the commit's own CI
// run is the verdict. This waits for that run (a tag pushed right after a
// merge can beat it) and fails the release unless every test job and the
// build passed.
//
//   GH_TOKEN=… GITHUB_REPOSITORY=owner/repo node scripts/release/ci-passed.mjs <sha>
const [sha] = process.argv.slice(2);
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
if (!sha || !repo || !token) {
  console.error("usage: GH_TOKEN=… GITHUB_REPOSITORY=owner/repo node scripts/release/ci-passed.mjs <sha>");
  process.exit(2);
}
const DEADLINE = Date.now() + 120 * 60_000;
const ours = (name) => name === "build" || name.startsWith("test (");

for (;;) {
  const r = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=100`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (!r.ok) {
    console.error(`ci-passed: GitHub answered ${r.status} ${await r.text()}`);
    process.exit(1);
  }
  const runs = (await r.json()).check_runs.filter((c) => ours(c.name));
  const tests = runs.filter((c) => c.name.startsWith("test ("));
  const open = runs.filter((c) => c.status !== "completed");
  const bad = runs.filter((c) => c.status === "completed" && c.conclusion !== "success");
  if (bad.length) {
    for (const c of bad) console.error(`ci-passed: ${c.name} — ${c.conclusion} (${c.html_url})`);
    console.error(`ci-passed: CI did not pass on ${sha}; not releasing it.`);
    process.exit(1);
  }
  if (!open.length && tests.length >= 3 && runs.some((c) => c.name === "build")) {
    console.log(`ci-passed: ${runs.length} jobs passed on ${sha}: ${runs.map((c) => c.name).join(", ")}`);
    process.exit(0);
  }
  if (Date.now() > DEADLINE) {
    console.error(`ci-passed: CI on ${sha} did not finish in time (${open.map((c) => c.name).join(", ") || "no CI run found"}).`);
    process.exit(1);
  }
  console.log(`ci-passed: waiting for ${open.length ? open.map((c) => c.name).join(", ") : "CI to start"}…`);
  await new Promise((done) => setTimeout(done, 60_000));
}
