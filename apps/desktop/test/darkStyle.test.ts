import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DARK_STYLE_PREF,
  DARK_STYLES,
  DEFAULT_DARK_STYLE,
  NEON_CLASS,
  dockIconFor,
  parseDarkStyle,
  previewIconFor,
} from "../src/shared/darkStyle";
import { DockAppearance } from "../src/main/dockAppearance";

// Settings ▸ Appearance ▸ Dark style: Graphite or Neon, for the window AND the
// Dock. The owner's complaint was the Dock icon changing the moment the app
// opened; these pin the rules that stop it.

const ROOT = join(__dirname, "../../..");
const SRC = join(__dirname, "../src");
const appCss = readFileSync(join(SRC, "renderer/styles/app.css"), "utf8");
const themeBoot = readFileSync(join(SRC, "renderer/theme-boot.js"), "utf8");
const launchReveal = readFileSync(join(SRC, "renderer/launch-reveal.js"), "utf8");
const esbuild = readFileSync(join(__dirname, "../esbuild.js"), "utf8");
const rendererTs = readFileSync(join(SRC, "renderer/renderer.ts"), "utf8");

test("the default is Graphite — the look macOS already shows for the closed app", () => {
  assert.equal(DEFAULT_DARK_STYLE, "graphite");
  assert.deepEqual([...DARK_STYLES], ["graphite", "neon"]);
  assert.equal(parseDarkStyle(undefined), "graphite");
  assert.equal(parseDarkStyle("neon"), "neon");
  assert.equal(parseDarkStyle("graphite"), "graphite");
  for (const junk of ["NEON", "", null, 1, {}, "system"]) assert.equal(parseDarkStyle(junk), "graphite", String(junk));
});

test("each style maps to its Dock tile; Graphite in a packaged Mac build is the bundle's own icon", () => {
  // Packaged macOS: the bundle icon IS Graphite (AppIcon.icon on 26, the
  // graphite icns before it) — so the app draws nothing over it.
  assert.equal(dockIconFor("dark", "graphite", true), "bundle");
  assert.equal(dockIconFor("dark", "neon", true), "dock.png");
  assert.equal(dockIconFor("light", "graphite", true), "dock-light.png", "Light is unchanged");
  assert.equal(dockIconFor("light", "neon", true), "dock-light.png", "Light is unchanged");
  // A dev build's bundle icon is Electron's, so Graphite needs its tile.
  assert.equal(dockIconFor("dark", "graphite", false), "dock-graphite.png");
  assert.equal(dockIconFor("dark", "neon", false), "dock.png");
});

test("every tile the mapping names ships in dist/renderer, from a brand file that exists", () => {
  const brand = new Map<string, string>();
  for (const m of esbuild.matchAll(/"(brand\/[\w.-]+)":\s*"([\w.-]+)"/g)) brand.set(m[2], m[1]);
  const named = new Set<string>();
  for (const v of ["dark", "light"] as const)
    for (const s of DARK_STYLES) for (const b of [true, false]) named.add(dockIconFor(v, s, b));
  named.delete("bundle");
  for (const s of DARK_STYLES) named.add(previewIconFor(s).replace(/^\.\//, ""));
  for (const file of named) {
    const src = brand.get(file);
    assert.ok(src, `esbuild.js copies something to ${file}`);
    assert.ok(existsSync(join(ROOT, src)), `${src} exists`);
  }
});

test("the closed-app icns for macOS 11–15 is the Graphite tile, so closed = open everywhere", () => {
  const compile = readFileSync(join(__dirname, "../build/compile-icon.sh"), "utf8");
  assert.match(compile, /Image\.open\("\.\.\/\.\.\/\.\.\/brand\/gitstudio-dock-graphite-1024\.png"\)/);
});

test("theme-boot.js, launch-reveal.js and app.css speak the shared names", () => {
  // theme-boot.js runs before the bundle and cannot import darkStyle.ts.
  assert.equal(NEON_CLASS, "gs-neon");
  assert.equal(DARK_STYLE_PREF, "darkStyle");
  assert.match(themeBoot, /prefs\.darkStyle === "neon"/);
  assert.match(themeBoot, /" gs-neon"/);
  assert.match(launchReveal, /gs-neon/);
  assert.match(appCss, /^body\.vscode-dark\.gs-neon \{/m, "one Neon token block");
  // The renderer persists it under the same key.
  assert.match(rendererTs, /darkStyle: this\.darkStyle,/);
  assert.match(rendererTs, /this\.darkStyle = parseDarkStyle\(prefs\.darkStyle\);/);
});

test("the Neon block only re-points tokens Graphite declares", () => {
  const block = (sel: string): Map<string, string> => {
    const at = appCss.search(new RegExp(`^${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{`, "m"));
    assert.ok(at >= 0, sel);
    const body = appCss.slice(at, appCss.indexOf("\n}", at)).replace(/\/\*[\s\S]*?\*\//g, "");
    return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  const graphite = block("body.vscode-dark");
  const neon = block("body.vscode-dark.gs-neon");
  assert.ok(neon.size >= 20, `the Neon block is found (${neon.size} tokens)`);
  for (const name of neon.keys()) assert.ok(graphite.has(name), `${name} is a Graphite token`);
  // The swatches in Settings paint each style's own ground and sidebar.
  const sw = (sel: string, name: string) => new RegExp(`${sel}[^{]*\\{[^}]*${name}:\\s*([^;]+);`).exec(appCss)?.[1].trim();
  assert.equal(sw("\\.settings-style-swatch ", "--sw-bg"), graphite.get("--app-bg"));
  assert.equal(sw("\\.settings-style-swatch ", "--sw-panel"), graphite.get("--app-panel"));
  assert.equal(sw('\\.settings-style-swatch\\[data-style="neon"\\]', "--sw-bg"), neon.get("--app-bg"));
  assert.equal(sw('\\.settings-style-swatch\\[data-style="neon"\\]', "--sw-panel"), neon.get("--app-panel"));
});

/** A DockAppearance over a temp userData, recording every Dock call. */
function dock(bundleIsGraphite = true) {
  const dir = mkdtempSync(join(tmpdir(), "gs-dock-"));
  const file = join(dir, "sub", "gitstudio-appearance.json");
  const calls: Array<string | null> = [];
  const make = () =>
    new DockAppearance(file, { setIcon: (i) => calls.push(i === null ? null : i.replace(/^.*[\\/]/, "")), rendererDir: "/r", bundleIsGraphite });
  return { dir, file, calls, make, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("Graphite never touches the Dock: opening the app shows what the closed app showed", () => {
  const d = dock();
  const a = d.make();
  a.load(); // nothing saved yet
  a.apply("dark");
  a.report("dark", "graphite");
  a.report("dark", undefined); // an older page: no style → Graphite
  assert.deepEqual(d.calls, [], "no setIcon at all");
  d.done();
});

test("Neon draws its tile, and going back to Graphite hands the tile back to macOS", () => {
  const d = dock();
  const a = d.make();
  a.report("dark", "neon");
  a.report("dark", "graphite");
  a.report("light", "graphite");
  a.report("dark", "graphite");
  assert.deepEqual(d.calls, ["dock.png", null, "dock-light.png", null]);
  d.done();
});

test("a dev build paints Graphite from its PNG", () => {
  const d = dock(false);
  d.make().report("dark", "graphite");
  assert.deepEqual(d.calls, ["dock-graphite.png"]);
  d.done();
});

test("the report is remembered, so the next start paints the right tile before the page speaks", () => {
  const d = dock();
  const first = d.make();
  first.report("dark", "neon");
  assert.deepEqual(JSON.parse(readFileSync(d.file, "utf8")), { style: "neon", variant: "dark" });
  const next = d.make();
  next.load();
  assert.equal(next.style, "neon");
  assert.equal(next.variant, "dark");
  next.apply(next.variant ?? "dark");
  assert.deepEqual(d.calls, ["dock.png", "dock.png"], "the second start's first act is the Neon tile");
  d.done();
});

test("an unreadable appearance file is the defaults, never a throw", () => {
  const d = dock();
  const a = d.make();
  a.report("dark", "graphite"); // creates the folder
  writeFileSync(d.file, "{not json");
  const b = d.make();
  b.load();
  assert.equal(b.style, "graphite");
  assert.equal(b.variant, undefined, "no remembered variant: main falls back to the OS scheme");
  d.done();
});

test("a failing Dock is harmless", () => {
  const a = new DockAppearance(join(tmpdir(), "gs-no-such", "x.json"), {
    setIcon: () => {
      throw new Error("no dock");
    },
    rendererDir: "/r",
    bundleIsGraphite: true,
  });
  assert.doesNotThrow(() => a.report("dark", "neon"));
  rmSync(join(tmpdir(), "gs-no-such"), { recursive: true, force: true });
});
