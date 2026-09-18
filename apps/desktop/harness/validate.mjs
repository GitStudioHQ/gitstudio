#!/usr/bin/env node
// Does the app do what was ASKED FOR?
//
//   node harness/validate.mjs [id-filter…]
//   node harness/validate.mjs --json
//
// `check.mjs` asserts the app's own invariants — nothing clipped, Escape closes
// a layer, a lap of the app does not re-measure the DOM. All 376 of them were
// green when the owner looked at the result and said "not good enough, you are
// missing lots of details".
//
// They were green because they answer a different question. A request is made of
// CLAUSES, and a clause implemented approximately — or implemented for one
// surface and not its sibling — is a miss no invariant catches. Nothing is
// broken; it is simply not what was asked for.
//
// So this runs `requirements.js`, where each entry carries the owner's own
// sentence and a predicate against the real app, and prints what is MET and
// what is not — quoting the sentence, because that is the form it will be read
// in. An UNMET row is not a failure of the harness. It is the backlog.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = process.env.GS_HARNESS_PAGE ? resolve(process.env.GS_HARNESS_PAGE) : resolve(HERE, "page");
const PAGE = resolve(PAGE_DIR, "harness.html");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const filters = argv.filter((a) => !a.startsWith("--"));

if (!existsSync(PAGE)) {
  console.error("harness/page is not built — run: node esbuild.js && harness/gen.sh");
  process.exit(2);
}

/** The requirement list, read from the same file the page loads. */
function requirementIds() {
  const src = readFileSync(resolve(HERE, "requirements.js"), "utf8");
  return [...src.matchAll(/^\s{6}id: "([^"]+)"/gm)].map((m) => m[1]);
}

const PRELUDE = `
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const _el = (x) => (typeof x === "string" ? $(x) : x);
const text = (x) => { const n = _el(x); return n ? (n.textContent || "").trim() : null; };
const box = (x) => { const n = _el(x); if (!n) return null; const r = n.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
const css = (x, ...p) => { const n = _el(x); if (!n) return null; const s = getComputedStyle(n);
  const o = {}; for (const k of p) o[k] = s.getPropertyValue(k) || s[k]; return o; };
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
// requirements.js is loaded by the PAGE, so its closures cannot see anything
// declared in this probe's scope. The helpers go on the global object or every
// requirement throws "settle is not defined" — which is a broken harness
// reporting an unmet requirement, the most misleading result this file could
// produce.
Object.assign(globalThis, { $, $$, text, box, css, settle });
`;

function runOne(req) {
  return new Promise((done) => {
    const body = `
${PRELUDE}
const list = window.__GS_REQUIREMENTS || [];
const req = list.find((r) => r.id === ${JSON.stringify(req.id)});
if (!req) return { id: ${JSON.stringify(req.id)}, met: false, detail: "requirement not found in requirements.js" };
try {
  const out = await req.run();
  return { id: req.id, says: req.says, met: !!out.met, detail: out.detail };
} catch (e) {
  return { id: req.id, says: req.says, met: false, detail: "threw: " + (e && e.message ? e.message : String(e)) };
}
`;
    const probe = encodeURIComponent(body);
    const extra = req.extra ? `&${req.extra}` : "";
    // A clause may need a THEME or a WIDTH: "nail the light mode" cannot be
    // judged in dark, and "use the full screen" cannot be judged at 1600px.
    // Both default to what every earlier clause already assumed.
    const theme = req.theme ?? "dark";
    const width = req.width ?? 1600;
    const url = `file://${PAGE}?scene=${req.scene}&theme=${theme}&probe=${probe}${extra}`;
    execFile(
      CHROME,
      ["--headless", "--disable-gpu", "--hide-scrollbars", `--window-size=${width},1000`, "--virtual-time-budget=20000", "--dump-dom", url],
      { maxBuffer: 64 * 1024 * 1024, timeout: 120_000, killSignal: "SIGKILL" },
      (err, stdout) => {
        const m = /<title>PROBE ([\s\S]*?)<\/title>/.exec(stdout || "");
        if (!m) {
          done({ id: req.id, says: req.says, met: false, detail: "the scene did not answer" });
          return;
        }
        const decoded = m[1]
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, "&");
        try {
          done(JSON.parse(decoded));
        } catch {
          done({ id: req.id, says: req.says, met: false, detail: `unreadable answer: ${decoded.slice(0, 120)}` });
        }
      },
    );
  });
}

/** Pull scene/extra/theme/width/says out of requirements.js without running it. */
function readRequirements() {
  const src = readFileSync(resolve(HERE, "requirements.js"), "utf8");
  const out = [];
  // Match up to the clause's own `run`, then read each setting by NAME from
  // that slice. The old form listed the keys in one fixed order, so a clause
  // carrying `theme` or `width` silently lost them and ran in dark at 1600px —
  // which is exactly the wrong answer for "nail the light mode" and for "use
  // the full screen size".
  const re = /id:\s*"([^"]+)",\s*says:\s*([\s\S]*?),\s*(?=async run\(\)|run\(\))/g;
  let m;
  while ((m = re.exec(src))) {
    const head = m[2];
    const sceneM = /scene:\s*"([^"]+)"/.exec(head);
    if (!sceneM) continue;
    const saysRaw = head.slice(0, sceneM.index);
    const says = saysRaw
      .split("\n")
      .map((l) => l.trim().replace(/^"|",?$/g, "").replace(/\\"/g, '"'))
      .join(" ")
      .replace(/\s+/g, " ")
      .replace(/\+$/, "")
      .trim();
    const pick = (k) => {
      const hit = new RegExp(k + ':\\s*"([^"]+)"').exec(head);
      return hit ? hit[1] : undefined;
    };
    const num = (k) => {
      const hit = new RegExp(k + ":\\s*(\\d+)").exec(head);
      return hit ? Number(hit[1]) : undefined;
    };
    out.push({
      id: m[1],
      says,
      scene: sceneM[1],
      extra: pick("extra"),
      theme: pick("theme"),
      width: num("width"),
    });
  }
  return out;
}

const all = readRequirements();
const known = new Set(requirementIds());
for (const id of known) {
  if (!all.some((r) => r.id === id)) {
    console.error(`requirement ${id} could not be parsed — check its shape in requirements.js`);
  }
}
const wanted = filters.length ? all.filter((r) => filters.some((f) => r.id.includes(f))) : all;
if (!wanted.length) {
  console.error("no requirements matched");
  process.exit(2);
}

const results = [];
// Sequential: each runs its own Chrome, and a dozen at once makes the timings
// (and the machine) unreliable.
for (const req of wanted) {
  results.push(await runOne(req));
  process.stderr.write(".");
}
process.stderr.write("\n");

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const met = results.filter((r) => r.met);
  const unmet = results.filter((r) => !r.met);
  const wrap = (s, w, indent) =>
    (s || "")
      .split(" ")
      .reduce(
        (lines, word) => {
          const last = lines[lines.length - 1];
          if ((last + " " + word).trim().length > w) lines.push(word);
          else lines[lines.length - 1] = (last + " " + word).trim();
          return lines;
        },
        [""],
      )
      .join("\n" + " ".repeat(indent));

  console.log("");
  for (const r of results) {
    const mark = r.met ? "\x1b[32m MET \x1b[0m" : "\x1b[31mUNMET\x1b[0m";
    console.log(`${mark}  ${r.id}`);
    console.log(`        “${wrap(r.says, 84, 9)}”`);
    console.log(`        ${wrap(r.detail, 84, 8)}`);
    console.log("");
  }
  console.log(`${met.length} met, ${unmet.length} unmet\n`);
  if (unmet.length) {
    console.log("Not met — this is the backlog, in the owner's own words:");
    for (const r of unmet) console.log(`  • ${r.id}: ${r.detail}`);
    console.log("");
  }
}
