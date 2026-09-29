import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { LAUNCH_FADE_MS } from "../src/renderer/launchScreen";

// The launch screen is the window's first frame: inline CSS + inline SVG in
// index.html, painted before the bundle runs, faded out by launchScreen.ts.
// These pin what it must never lose — its colours are the app's, it animates
// only what the compositor can run while the bundle holds the main thread,
// it needs no inline script (the CSP forbids one), and the theme it is painted
// in is the theme the person picked.

const SRC = join(__dirname, "../src");
const html = readFileSync(join(SRC, "renderer/index.html"), "utf8");
const appCss = readFileSync(join(SRC, "renderer/styles/app.css"), "utf8");
const mainTs = readFileSync(join(SRC, "main/main.ts"), "utf8");
const themeBoot = readFileSync(join(SRC, "renderer/theme-boot.js"), "utf8");
const launchReveal = readFileSync(join(SRC, "renderer/launch-reveal.js"), "utf8");

function between(a: string, b: string): string {
  const i = html.indexOf(a);
  const j = html.indexOf(b);
  assert.ok(i >= 0 && j > i, `${a} … ${b} in index.html`);
  return html.slice(i, j);
}
const style = between("<!-- launch:style -->", "<!-- /launch:style -->");
const screen = between("<!-- launch:screen -->", "<!-- /launch:screen -->");

/** A custom property's value inside the first rule matching `selector`. */
function tokenIn(css: string, selector: string, name: string): string {
  const at = css.indexOf(`${selector} {`);
  assert.ok(at >= 0, `rule ${selector}`);
  const body = css.slice(at, css.indexOf("}", at));
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(body);
  assert.ok(m, `${name} in ${selector}`);
  return m[1].trim().toLowerCase();
}

test("the launch screen is in the page before the bundle, and is decorative", () => {
  const boot = html.indexOf('src="./theme-boot.js"');
  const launch = html.indexOf('<div id="launch"');
  const root = html.indexOf('<div id="root">');
  const bundle = html.indexOf('src="./renderer.js"');
  assert.ok(boot >= 0 && boot < launch, "after theme-boot.js, so its theme class is already on <body>");
  assert.ok(launch < root && root < bundle, "before the app root and the bundle");
  assert.match(screen, /<div id="launch" aria-hidden="true">/, "hidden from assistive tech; #boot keeps the words");
  assert.match(html, /<div id="boot">Loading GitStudio…<\/div>/, "the spoken loading text is still there");
  assert.doesNotMatch(screen, /\b(href|src)=/, "nothing to fetch: the mark and the wordmark are inline");
});

test("no inline script — the CSP stays closed to one", () => {
  // Case-insensitive: HTML tag and attribute names are (CodeQL, #59).
  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    assert.match(m[1], /\bsrc="\.\//i, `every script is a same-origin file: <script${m[1]}>`);
  }
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
  const scriptSrc = /(?:^|;)\s*script-src\s([^;]*)/.exec(csp)?.[1] ?? "";
  assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval/, `script-src is not loosened (${scriptSrc})`);
});

test("the bundle is deferred, so the launch screen paints while it compiles", () => {
  assert.match(html, /<script defer src="\.\/renderer\.js"><\/script>/);
  assert.match(html, /<script src="\.\/theme-boot\.js"><\/script>/, "theme-boot stays synchronous: it sets the theme before paint");
});

test("its ground is the app's canvas and the window's own background, in both themes", () => {
  const darkApp = tokenIn(appCss, "body.vscode-dark", "--app-bg");
  const lightApp = tokenIn(appCss, "body.vscode-light", "--app-bg");
  assert.equal(tokenIn(style, "#launch", "--lc-bg"), darkApp, "dark launch ground = dark --app-bg");
  assert.equal(tokenIn(style, "body.vscode-light #launch", "--lc-bg"), lightApp, "light launch ground = light --app-bg");
  const win = /function windowBackground[\s\S]*?return theme === "light" \? "(#[0-9a-f]+)" : "(#[0-9a-f]+)";/.exec(mainTs);
  assert.ok(win, "main.ts windowBackground()");
  assert.equal(win[1], lightApp, "main's light window background");
  assert.equal(win[2], darkApp, "main's dark window background");
});

test("it animates only transform and opacity, and reduced motion is a plain fade", () => {
  const frames = [...style.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\}\s*\}/g)];
  assert.ok(frames.length >= 4, "the launch keyframes are found");
  for (const [, name, body] of frames) {
    const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    for (const p of props) assert.ok(p === "opacity" || p === "transform", `@keyframes ${name} animates ${p}`);
  }
  const transitions = [...style.matchAll(/transition:\s*([^;]+);/g)].map((m) => m[1]);
  assert.ok(transitions.length >= 2, "the dissolve's transitions are found");
  for (const value of transitions) {
    // "transform 240ms cubic-bezier(…), opacity 140ms …": one property per comma, once the
    // easing functions' own commas are out of the way.
    for (const part of value.replace(/\([^)]*\)/g, "").split(",")) {
      const prop = part.trim().split(/\s+/)[0];
      assert.ok(prop === "opacity" || prop === "transform", `a transition on ${prop}`);
    }
  }
  const reduce = style.slice(style.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.ok(reduce.length > 40, "a reduced-motion block");
  assert.match(reduce, /animation: launch-fade/, "the glow only fades in");
  assert.match(reduce, /\.launch-mark,\s*#launch \.launch-word \{ animation: none; \}/, "and the mark does not move");
  assert.match(reduce, /\.launch-progress \{ display: none; \}/, "no sweeping progress bar");
  // Leaving hands the pointer and the title-bar drag straight to the app.
  assert.match(style, /#launch\.is-leaving \{ opacity: 0; pointer-events: none; -webkit-app-region: no-drag; \}/);
  assert.match(style, /-webkit-app-region: drag;/, "until then the screen drags the window");
});

test("every moving part is an HTML box, never an <svg> — those animate on the main thread", () => {
  // Chromium runs a CSS animation on an SVG element on the main thread, and
  // the bundle holds the main thread for most of a cold start: with the
  // classes on the <svg>s, the graph and the wordmark sat frozen at their
  // first frame, invisible, until the app was nearly up.
  const animated = new Set<string>();
  for (const m of style.matchAll(/(#launch \.[\w-]+(?: > \w+)?)\s*\{[^}]*\banimation:\s*launch-/g)) animated.add(m[1]);
  assert.ok(animated.size >= 5, `the animated selectors are found (${[...animated].join(", ")})`);
  for (const sel of animated) {
    const m = /^#launch \.([\w-]+)(?: > (\w+))?$/.exec(sel);
    assert.ok(m, sel);
    if (m[2]) {
      assert.notEqual(m[2], "svg", `${sel} animates an <svg>`);
      continue;
    }
    const tags = [...screen.matchAll(new RegExp(`<(\\w+)[^>]*\\bclass="${m[1]}"`, "g"))].map((t) => t[1]);
    assert.ok(tags.length > 0, `.${m[1]} is in the markup`);
    for (const t of tags) assert.equal(t, "div", `.${m[1]} is a <${t}>, not an HTML box`);
  }
});

test("the mark is whole from its first frame — nothing in it fades or assembles in", () => {
  // The app is often up within a couple of hundred milliseconds and the
  // hand-off never waits, so a part that faded in was caught half-drawn: on
  // dark, a cube with no commit graph and no wordmark.
  const frames = new Map<string, string>();
  for (const [, name, body] of style.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\}\s*\}/g)) frames.set(name, body);
  for (const part of ["launch-mark", "launch-cube", "launch-graph", "launch-word"]) {
    for (const m of style.matchAll(new RegExp(`#launch \\.${part}\\b[^{]*\\{[^}]*\\banimation:\\s*([\\w-]+)`, "g"))) {
      if (m[1] === "none") continue;
      const body = frames.get(m[1]);
      assert.ok(body, `@keyframes ${m[1]} is defined`);
      assert.doesNotMatch(body, /opacity/, `.${part} animates ${m[1]}, which fades it`);
    }
  }
});

test("the mark wears the Dock icon's own palette, in both themes", () => {
  const icon = readFileSync(join(__dirname, "../../../brand/gitstudio-icon.svg"), "utf8").toLowerCase();
  const stops = (id: string) => {
    const g = new RegExp(`<lineargradient id="${id}"[\\s\\S]*?</lineargradient>`).exec(icon);
    assert.ok(g, `gradient ${id} in the icon`);
    return [...g[0].matchAll(/stop-color="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
  };
  const want: Record<string, string> = {};
  [want["--lc-top-a"], want["--lc-top-b"]] = stops("ftop");
  [want["--lc-left-a"], want["--lc-left-b"]] = stops("fleft");
  [want["--lc-right-a"], want["--lc-right-b"]] = stops("fright");
  [want["--lc-lane-a"], want["--lc-lane-b"]] = stops("lane");
  for (const [name, hex] of Object.entries(want)) assert.equal(tokenIn(style, "#launch", name), hex, name);
  const light = style.slice(style.indexOf("body.vscode-light #launch {"));
  const lightRule = light.slice(0, light.indexOf("}"));
  for (const name of Object.keys(want)) assert.ok(!lightRule.includes(`${name}:`), `light does not repaint ${name}`);
});

test("the screen is removed once its dissolve has run, not before and not long after", () => {
  // launchScreen.ts removes the element on a timer (a transition that never
  // runs must not leave it behind), so the timer has to match the CSS.
  const at = style.indexOf("#launch {");
  const rule = style.slice(at, style.indexOf("}", at));
  const fade = /transition: opacity (\d+)ms/.exec(rule);
  assert.ok(fade, "#launch dissolves by an opacity transition");
  assert.equal(Number(fade[1]), LAUNCH_FADE_MS, "launchScreen.ts's LAUNCH_FADE_MS is the dissolve's duration");
  assert.ok(LAUNCH_FADE_MS <= 300, "a dissolve, not a curtain");
});

test("the mark leaves before the ground does, so no logo is stamped over the app", () => {
  // The two opacities multiply. When both eased over similar spans, a
  // third-strength logo sat over a half-visible app for ~100ms.
  const rule = (sel: string) => {
    const at = style.indexOf(`${sel} {`);
    return style.slice(at, style.indexOf("}", at));
  };
  const ground = /transition: opacity (\d+)ms cubic-bezier\(([^)]*)\)/.exec(rule("#launch"));
  const mark = /opacity (\d+)ms cubic-bezier\(([^)]*)\)/.exec(rule("#launch .launch-stage"));
  assert.ok(ground && mark, "both dissolves are found");
  assert.ok(Number(mark[1]) * 2 <= Number(ground[1]), `the mark (${mark[1]}ms) is gone within the ground's first half (${ground[1]}ms)`);
  const [gx1, gy1, gx2, gy2] = ground[2].split(",").map(Number);
  assert.ok(gx2 === 1 && gy2 === 1 && gy1 === 0 && gx1 > 0, `the ground eases in, holding while the mark leaves (${ground[2]})`);
  const [, my1] = mark[2].split(",").map(Number);
  assert.equal(Number(mark[2].split(",")[0]), 0, `the mark eases out, dropping at once (${mark[2]})`);
  assert.equal(my1, 0);
});

test("the hand-off never holds the app back for the animation's sake", () => {
  const src = readFileSync(join(SRC, "renderer/launchScreen.ts"), "utf8");
  const body = src.slice(src.indexOf("export function dismissLaunchScreen"));
  // The leaving class goes on in the same call that marks the app ready —
  // no timer, no await in between.
  const ready = body.indexOf('mark("gs:app-ready")');
  const leaving = body.indexOf('el.classList.add("is-leaving")');
  assert.ok(ready >= 0 && leaving > ready, "is-leaving is added in dismissLaunchScreen itself");
  assert.doesNotMatch(body.slice(ready, leaving), /setTimeout|await|requestAnimationFrame/, "nothing waits in between");
});

/**
 * Run theme-boot.js against a fake page, on a fake clock. `until` is how far
 * the clock runs (ms after the first frame); `bundleAt`, when set, is when the
 * bundle starts executing — its first statement is launch-reveal.js.
 * Returns the body class and what the page told main, with when.
 */
function boot(o: { search?: string; prefs?: string | null; osLight?: boolean; until?: number; bundleAt?: number }): {
  theme: string;
  told: Array<[string, unknown, number]>;
} {
  const told: Array<[string, unknown, number]> = [];
  const frames: Array<() => void> = [];
  let now = 0;
  let timers: Array<{ at: number; f: () => void }> = [];
  const body = { className: "" };
  const win: Record<string, unknown> = {
    location: { search: o.search ?? "" },
    URLSearchParams,
    localStorage: {
      getItem: (k: string) => (k === "gitstudio.ui.prefs" ? (o.prefs ?? null) : null),
    },
    matchMedia: (q: string) => ({ matches: q.includes("light") ? !!o.osLight : !o.osLight }),
    navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel" },
    document: {
      body,
      documentElement: { classList: { add: () => undefined } },
      getElementById: () => null,
    },
    performance: { mark: () => undefined },
    requestAnimationFrame: (f: () => void) => frames.push(f),
    setTimeout: (f: () => void, ms = 0) => timers.push({ at: now + ms, f }),
    gitstudio: {
      invoke: (channel: string, payload: unknown) => {
        told.push([channel, JSON.parse(JSON.stringify(payload)), now]);
        return Promise.resolve();
      },
    },
    JSON,
  };
  win.window = win;
  runInNewContext(themeBoot, win);
  // The first frame; the clock starts there.
  for (const f of frames.splice(0)) f();
  const until = o.until ?? 1000;
  const bundle = o.bundleAt;
  let bundleRan = false;
  for (;;) {
    timers.sort((x, y) => x.at - y.at);
    const next = timers[0];
    const nextAt = next && next.at <= until ? next.at : Infinity;
    if (bundle !== undefined && !bundleRan && bundle <= nextAt && bundle <= until) {
      now = bundle;
      bundleRan = true;
      // The bundle's first statement (esbuild's banner), against the same page.
      runInNewContext(launchReveal, win);
      continue;
    }
    if (nextAt === Infinity) break;
    timers = timers.slice(1);
    now = next.at;
    next.f();
  }
  return { theme: body.className, told };
}

test("the first frame is painted in the theme the person picked", () => {
  assert.equal(boot({ osLight: false }).theme, "vscode-dark", "System on a dark OS");
  assert.equal(boot({ osLight: true }).theme, "vscode-light", "System on a light OS");
  assert.equal(boot({ osLight: false, prefs: '{"themeMode":"light"}' }).theme, "vscode-light", "Light pinned on a dark OS");
  assert.equal(boot({ osLight: true, prefs: '{"themeMode":"dark"}' }).theme, "vscode-dark", "Dark pinned on a light OS");
  assert.equal(boot({ osLight: true, prefs: '{"themeMode":"system"}' }).theme, "vscode-light", "System, said out loud");
  assert.equal(boot({ osLight: true, prefs: "{not json" }).theme, "vscode-light", "a broken blob follows the OS");
  assert.equal(boot({ osLight: true, prefs: '{"themeMode":"dark"}', search: "?theme=light" }).theme, "vscode-light", "?theme= (the harness) wins");
});

test("the window is asked for as the bundle starts, in the launch screen's theme — once", () => {
  // The usual start: the bundle runs 30ms after the branded frame.
  const t = boot({ osLight: false, prefs: '{"themeMode":"light"}', bundleAt: 30 });
  assert.deepEqual(t.told, [["window:launchPainted", { theme: "light" }, 30]], "asked once, from the bundle, in Light");
  assert.deepEqual(boot({ osLight: false, bundleAt: 30 }).told, [["window:launchPainted", { theme: "dark" }, 30]]);
});

test("a bundle slow to arrive still gets its window 150ms after the branded frame", () => {
  // Showing the window any earlier stalled the bundle's delivery out of
  // app.asar (launchScreen.ts); later than this and a slow start looks dead.
  const slow = boot({ osLight: false, bundleAt: 900 });
  assert.equal(slow.told.length, 1, `asked once (${JSON.stringify(slow.told)})`);
  assert.equal(slow.told[0][0], "window:launchPainted");
  assert.equal(slow.told[0][2], 150, "by theme-boot.js, 150ms after the frame");
  // …and with no bundle at all (it failed to load), still.
  assert.equal(boot({ osLight: true, until: 1000 }).told.length, 1);
  // Nothing is asked before either: the frame alone is not the signal.
  assert.deepEqual(boot({ osLight: false, until: 149 }).told, []);
});

test("the window request is the renderer bundle's first statement, and keeps it strict", () => {
  // A module cannot be first — esbuild hoists hundreds of modules above what
  // renderer.ts imports first — so esbuild.js prepends launch-reveal.js.
  const build = readFileSync(join(__dirname, "../esbuild.js"), "utf8");
  const renderer = build.slice(build.indexOf("const rendererCtx"), build.indexOf("});", build.indexOf("const rendererCtx")));
  assert.match(renderer, /banner:\s*\{\s*js:\s*fs\.readFileSync\(path\.join\(rendererDir, "launch-reveal\.js"\)/, "the renderer build's banner is launch-reveal.js");
  // The bundle's own "use strict" is no longer the file's first statement, so
  // the banner has to open with one or the whole bundle would run sloppy.
  // \r?: Windows CI checks files out with CRLF line ends (core.autocrlf).
  assert.match(launchReveal, /^"use strict";\r?\n/, "launch-reveal.js opens with \"use strict\"");
});
