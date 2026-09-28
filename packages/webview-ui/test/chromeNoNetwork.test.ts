import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { headlessChromeArgs, NO_NETWORK_CHROME } from "../../../scripts/test/no-network-chrome.mjs";
import { gravatarUrl } from "../src/graph/avatar";
import { findChrome, runInChrome } from "./headless";

/**
 * No headless Chrome a test or a harness launches reaches the network
 * (scripts/test/no-network-chrome.mjs). The pages ask for it: the commit graph
 * and the rail draw each author's avatar from gravatarUrl(), and every
 * headless graph check sent those requests out, one per author.
 *
 * Two halves. A page in a launched Chrome — through the webview checks'
 * launcher and the DevTools one — reaches this machine and nothing else; and
 * the census: every Chrome launcher in the repository takes its argv from
 * headlessChromeArgs(), so a new one written without it fails here.
 *
 * What stands for the internet, with no network to need: a `*.localhost` name.
 * Chrome answers it itself (loopback), so unguarded it reaches this test's own
 * server — the guard lets through localhost, 127.0.0.1 and ::1 only, and
 * refuses it like any other name. The control below launches the same page
 * with the guard's rule excepting that one name and sees it reached: the
 * refusal is the guard's, not the name's. (No Chrome here goes unguarded.)
 */

const CHROME = findChrome();
const skip = !CHROME && "no headless Chrome on this machine (set GS_CHROME)";
const ENTRY = fileURLToPath(new URL("./fixtures/dashboardEntry.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const HELPER = join(ROOT, "scripts", "test", "no-network-chrome.mjs");

/** A server on this machine that answers every path with a tiny image, and records who asked. */
async function localServer(): Promise<{ port: number; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.headers.host}${req.url}`);
    res.writeHead(200, { "content-type": "image/svg+xml", "access-control-allow-origin": "*", "cache-control": "no-store" });
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { port, hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** The addresses a page is sent to: this machine's, the stand-in, and the internet. */
function targets(port: number) {
  return {
    loopback: [`http://127.0.0.1:${port}/loopback`, `http://localhost:${port}/localhost`],
    standIn: `http://gs-stand-in.localhost:${port}/stand-in`,
    internet: [
      // What the graph and the rail draw an author with (noreply → GitHub).
      gravatarUrl("ada@example.com", 40),
      gravatarUrl("12345+ada@users.noreply.github.com", 28),
      // An address, not a name: TEST-NET-1, routed nowhere.
      "http://192.0.2.1/ip-literal",
    ],
  };
}

/** Page code: each URL fetched (no-cors: any answer at all resolves) and drawn as an <img>. */
const PROBE = `async (urls) => {
  const out = {};
  for (const u of urls) {
    const fetched = await fetch(u, { mode: "no-cors", cache: "no-store" }).then(() => "reached", () => "refused");
    const drawn = await new Promise((r) => {
      const img = new Image();
      img.onload = () => r("reached");
      img.onerror = () => r("refused");
      img.src = u + (u.includes("?") ? "&" : "?") + "img=1";
    });
    out[u] = fetched + "/" + drawn;
  }
  return out;
}`;

/** The same page, launched with `args` and read back from --dump-dom. */
function dumpProbe(args: string[], urls: string[]): Promise<Record<string, string>> {
  const dir = mkdtempSync(join(tmpdir(), "gs-no-network-chrome-"));
  const page = join(dir, "page.html");
  writeFileSync(
    page,
    `<!doctype html><title>PENDING</title><script>(${PROBE})(${JSON.stringify(urls)}).then((o) => { document.title = "PROBE " + JSON.stringify(o); });</script>`,
  );
  return new Promise((res, rej) => {
    execFile(
      CHROME!,
      [...args, `--user-data-dir=${join(dir, "profile")}`, "--disable-gpu", "--virtual-time-budget=10000", "--dump-dom", pathToFileURL(page).href],
      { timeout: 60_000, killSignal: "SIGKILL" },
      (err, stdout) => {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        const m = /<title>PROBE ([\s\S]*?)<\/title>/.exec(stdout ?? "");
        if (!m) return rej(err ?? new Error(`no probe result: ${String(stdout).slice(0, 300)}`));
        res(JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&")));
      },
    );
  });
}

function assertOnlyThisMachine(got: Record<string, string>, t: ReturnType<typeof targets>, hits: string[], via: string) {
  for (const u of t.loopback) assert.equal(got[u], "reached/reached", `${via}: ${u} — this machine is reached`);
  for (const u of [t.standIn, ...t.internet]) assert.equal(got[u], "refused/refused", `${via}: ${u} — refused`);
  assert.deepEqual(
    hits.filter((h) => !/^(127\.0\.0\.1|localhost):\d+\/(loopback|localhost)\b/.test(h)),
    [],
    `${via}: the server heard from nothing but the loopback probes`,
  );
}

test("a page in the webview checks' Chrome reaches this machine, and nothing else", { skip }, async () => {
  const server = await localServer();
  try {
    const t = targets(server.port);
    const urls = [...t.loopback, t.standIn, ...t.internet];
    const v = await runInChrome(CHROME!, ENTRY, `notes.got = await (${PROBE})(${JSON.stringify(urls)});`);
    assert.deepEqual(v.fails, []);
    assertOnlyThisMachine((v.notes as { got: Record<string, string> }).got, t, server.hits, "runInChrome");
  } finally {
    await server.close();
  }
});

test("…and the same through the DevTools launcher (scripts/merge-e2e/cdp.ts), on a real clock", { skip }, async (tt) => {
  const { Browser } = await import("../../../scripts/merge-e2e/cdp");
  const had = process.env.GS_CHROME;
  process.env.GS_CHROME = CHROME!;
  let browser: Awaited<ReturnType<typeof Browser.launch>>;
  try {
    browser = await Browser.launch();
  } catch (err) {
    // cdp.ts drives only a windowless shell; a runner with nothing but a
    // system Chrome has none to give it.
    tt.skip(`cdp.ts has no browser here: ${(err as Error).message}`);
    return;
  } finally {
    if (had === undefined) delete process.env.GS_CHROME;
    else process.env.GS_CHROME = had;
  }
  const server = await localServer();
  const dir = mkdtempSync(join(tmpdir(), "gs-no-network-cdp-"));
  try {
    writeFileSync(join(dir, "page.html"), "<!doctype html><title>cdp</title>");
    const page = await browser.newPage(400, 300, 1);
    await browser.goto(page, pathToFileURL(join(dir, "page.html")).href);
    const t = targets(server.port);
    const got = await page.eval<Record<string, string>>(`(${PROBE})(${JSON.stringify([...t.loopback, t.standIn, ...t.internet])})`);
    assertOnlyThisMachine(got, t, server.hits, "cdp.ts");
  } finally {
    await browser.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the stand-in is refused by the guard's rule and by nothing else: excepted by name, it IS reached", { skip }, async () => {
  const server = await localServer();
  try {
    const t = targets(server.port);
    const urls = [t.loopback[0], t.standIn];
    const guarded = await dumpProbe(headlessChromeArgs(), urls);
    assert.equal(guarded[t.standIn], "refused/refused", "guarded, the stand-in is refused");
    // The same launch with the resolver rule excepting the stand-in too — and
    // still nothing else, so even this Chrome reaches no further than here.
    const RULE = "--host-resolver-rules=";
    const excepted = headlessChromeArgs().map((a) => (a.startsWith(RULE) ? `${a}, EXCLUDE gs-stand-in.localhost` : a));
    assert.equal(excepted.filter((a, i) => a !== headlessChromeArgs()[i]).length, 1, "precondition: only the rule is changed");
    const got = await dumpProbe(excepted, urls);
    assert.equal(got[t.loopback[0]], "reached/reached");
    assert.equal(got[t.standIn], "reached/reached", "excepted, the stand-in reaches the server");
    assert.ok(server.hits.some((h) => h.startsWith("gs-stand-in.localhost:")), "…which heard it by that name");
  } finally {
    await server.close();
  }
});

test("headlessChromeArgs: --headless, the guard, then the launcher's own — which may not take the guard back", () => {
  const args = headlessChromeArgs(["--dump-dom", "file:///x.html"]);
  assert.deepEqual(args, [args[0], ...NO_NETWORK_CHROME, "--dump-dom", "file:///x.html"]);
  assert.match(args[0], /^--headless$/);
  assert.ok(
    NO_NETWORK_CHROME.includes("--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE ::1"),
    "every name and address resolves to nothing but this machine's",
  );
  for (const s of ["--no-proxy-server", "--disable-background-networking", "--disable-component-update", "--no-pings"]) {
    assert.ok(NO_NETWORK_CHROME.includes(s), s);
  }
  // Chrome takes the last of a repeated switch: a launcher's own would win.
  for (const undo of ["--host-resolver-rules=MAP * 127.0.0.1", "--proxy-server=http://127.0.0.1:8080", "--proxy-pac-url=http://x/p.pac"]) {
    assert.throws(() => headlessChromeArgs([undo]), /resolves nothing but this machine/, undo);
  }
  // A shell launcher reads the same list, one per line.
  const printed = execFileSync(process.execPath, [HELPER], { encoding: "utf8" });
  assert.deepEqual(printed.split("\n").filter(Boolean), headlessChromeArgs());
});

// ── the census ────────────────────────────────────────────────────────────

/** Chrome's own switches: a file that spells one in code launches a Chrome. */
const SWITCHES = ["headless", "dump-dom", "screenshot", "remote-debugging-port", "virtual-time-budget"];
const JS_SWITCH = (names: string[]) => new RegExp(`["'\`]--(?:${names.join("|")})(?![\\w-])`);
const SH_SWITCH = (names: string[]) => new RegExp(`(?:^|[\\s"'])--(?:${names.join("|")})(?![\\w-])`, "m");
const JS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const SH = new Set([".sh", ".bash", ".zsh", ".py"]);

/** Launchers that are not a test's Chrome, and why. Each must still launch (a stale entry fails). */
const NOT_A_TEST_CHROME: Record<string, string> = {
  "apps/desktop/harness/live.mjs": "drives the real GitStudio app over CDP — the app under measurement, which talks to GitHub by design",
  "scripts/merge-e2e/dashboardClicks.ts": "launches the real VS Code with the packaged extension installed, the editor under test",
  "scripts/extension-shots/vscode.ts": "launches the real VS Code, hidden, with the extension's test VSIX installed, to capture its README media",
  "apps/extension/harness/pylance-rename/runui.sh": "the real VS Code, with Pylance from the Marketplace",
  "brand/margined.py": "a docstring telling a person how to rasterise the tile by hand; nothing here launches",
};

/** The launchers the census must find — so a scan that breaks cannot pass on nothing. */
const KNOWN = [
  "packages/webview-ui/test/headless.ts",
  "packages/webview-ui/test/fixtures/mergeViewPage.ts",
  "packages/webview-ui/test/chromeNoNetwork.test.ts",
  "apps/extension/test/changesViewPage.ts",
  "scripts/merge-e2e/cdp.ts",
  "apps/desktop/harness/check.mjs",
  "apps/desktop/harness/validate.mjs",
  "apps/desktop/harness/probe.mjs",
  "apps/desktop/harness/perf.mjs",
  "apps/desktop/harness/contrast.mjs",
  "apps/desktop/harness/affordance.mjs",
  "apps/desktop/harness/fit.mjs",
  "apps/desktop/harness/shot.sh",
  "brand/rasterise.sh",
];

/**
 * One file's Chrome launches: whether it has any, and what is wrong with them.
 * `rel` is the path from the repository root, with forward slashes.
 */
function launchVerdict(rel: string, src: string): { launches: boolean; problems: string[] } {
  const ext = extname(rel);
  const js = JS.has(ext);
  if (!js && !SH.has(ext)) return { launches: false, problems: [] };
  const comment = js ? /^\s*(\/\/|\/\*|\*)/ : /^\s*#/;
  const code = src
    .split("\n")
    .filter((l) => !comment.test(l))
    .join("\n");
  const spelled = js ? JS_SWITCH : SH_SWITCH;
  const launches = spelled(SWITCHES).test(code);
  const problems: string[] = [];
  if (!launches) return { launches, problems };
  if (spelled(["headless"]).test(code)) {
    problems.push("spells --headless itself — take the argv from headlessChromeArgs() (scripts/test/no-network-chrome.mjs)");
  }
  if (js) {
    const from = /import\s*\{[^}]*\bheadlessChromeArgs\b[^}]*\}\s*from\s*["']([^"']+)["']/.exec(code)?.[1];
    const imported = !!from && from.startsWith(".") && resolve(ROOT, dirname(rel), from) === HELPER;
    if (!imported || !/\bheadlessChromeArgs\(/.test(code)) {
      problems.push("launches Chrome without headlessChromeArgs() from scripts/test/no-network-chrome.mjs");
    }
  } else if (!/scripts\/test\/no-network-chrome\.mjs/.test(code) || !code.includes('"$@"')) {
    problems.push('launches Chrome without the switches `node scripts/test/no-network-chrome.mjs` prints ("$@")');
  }
  return { launches, problems };
}

/** Every code file in the repository, from the root, tracked or new. */
function repositoryFiles(): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((p) => p && !p.split("/").includes("node_modules") && (JS.has(extname(p)) || SH.has(extname(p))));
}

test("census: every Chrome a test or a harness launches takes its argv from headlessChromeArgs()", () => {
  const found: string[] = [];
  const problems: string[] = [];
  for (const rel of repositoryFiles()) {
    if (resolve(ROOT, rel) === HELPER) continue;
    let src: string;
    try {
      src = readFileSync(join(ROOT, rel), "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    const v = launchVerdict(rel, src);
    if (!v.launches) continue;
    found.push(rel);
    if (rel in NOT_A_TEST_CHROME) continue;
    for (const p of v.problems) problems.push(`${rel}: ${p}`);
  }
  for (const k of KNOWN) assert.ok(found.includes(k), `the census did not see ${k} launch a Chrome — it broke`);
  for (const k of Object.keys(NOT_A_TEST_CHROME)) assert.ok(found.includes(k), `${k} no longer launches: take it off NOT_A_TEST_CHROME`);
  assert.equal(problems.join("\n"), "", "a Chrome launched without the guard");
});

test("census: it can see a launcher go around the helper", () => {
  // Spelled in two halves: this file is a launcher too, and spells no
  // --headless of its own.
  const H = "--" + "headless";
  // A new launcher, written the way every one was before the guard.
  const bare = launchVerdict("apps/desktop/harness/new.mjs", `execFile(CHROME, ["${H}", "--disable-gpu", "--dump-dom", url]);`);
  assert.equal(bare.launches, true);
  assert.equal(bare.problems.length, 2, bare.problems.join("; "));
  // The headless shell needs no --headless: a launch that leaves it out is still one.
  assert.equal(launchVerdict("packages/x/test/shot.ts", "spawn(chrome, [`--screenshot=${out}`, url]);").problems.length, 1);
  // The helper imported, and one launch taking it — but a second spelled out beside it.
  const IMPORT = 'import { headlessChromeArgs } from "../../../scripts/test/no-network-chrome.mjs";\n';
  const good = `${IMPORT}execFile(chrome, headlessChromeArgs(["--dump-dom", url]));`;
  assert.deepEqual(launchVerdict("apps/extension/test/newPage.ts", good), { launches: true, problems: [] });
  assert.equal(launchVerdict("apps/extension/test/newPage.ts", `${good}\nexecFile(chrome, ["${H}", "--screenshot=a.png", url]);`).problems.length, 1);
  // A headlessChromeArgs of its own is not the guard.
  assert.equal(launchVerdict("apps/extension/test/newPage.ts", good.replace("scripts/test/no-network-chrome.mjs", "test/myChrome.mjs")).problems.length, 1);
  // A shell launcher, before and after.
  assert.equal(launchVerdict("apps/x/shot.sh", `"$CHROME" ${H} --screenshot="$OUT" "$URL"\n`).problems.length, 2);
  const sh = 'set -- $(node "$HERE/../../scripts/test/no-network-chrome.mjs")\n"$CHROME" "$@" --screenshot="$OUT" "$URL"\n';
  assert.deepEqual(launchVerdict("apps/x/shot.sh", sh), { launches: true, problems: [] });
  // Comments are not launches.
  assert.equal(launchVerdict("apps/x/a.ts", `// run with "${H}" and "--dump-dom"\n`).launches, false);
  assert.equal(launchVerdict("apps/x/a.sh", `# chrome ${H} --screenshot=x.png\n`).launches, false);
});
