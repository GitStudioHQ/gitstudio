// Renders any file of any matrix scenario in the REAL merge view, headlessly,
// and screenshots it — in the extension's webview and in the desktop app.
//
//   npx tsx scripts/merge-e2e/render.ts --scenario rebase.diff3 --file stress/userService.js
//   npx tsx scripts/merge-e2e/render.ts --scenario merge.merge --file "app/version.py,assets/logo.bin" \
//       --theme dark,light,hc-dark,hc-light --host ext --out-dir /tmp/shots
//   npx tsx scripts/merge-e2e/render.ts --scenario stash.zdiff3 --file f.txt --host desktop --theme light
//
// Options:
//   --scenario <op.style>   a matrix scenario (scripts/merge-e2e/cases.ts)
//   --file a,b              repository paths (as git lists them)
//   --theme a,b             ext: dark | light | hc-dark | hc-light (VS Code's Dark+ / Light+ / HC
//                           token values, themes.ts); desktop: dark | light
//   --host ext|desktop|both default both (a high-contrast theme renders the extension only)
//   --target <dir>          a matrix fixtures.sh already built; default: build just this scenario
//   --out-dir <dir>         default: $TMPDIR/gs-merge-e2e-shots
//   --width/--height/--scale  default 1600 × 1000 CSS px at 2×
//   --no-build              desktop: reuse the renderer already in apps/desktop/dist
//   --steps a,b             after the first shot, press these controls in turn, a shot after each:
//                           accept-yours | ignore-theirs | accept-theirs | ignore-yours | legend-key
//
// The content is REAL: the repository fixtures.sh stopped mid-operation, read
// through the same code the products run —
//   extension: ConflictOps.readSides → buildMergePayload (merge-vscode/payload.ts),
//              posted as `init` to the production webview entry (webview-ui/src/main.ts),
//              under a stubbed acquireVsCodeApi, in a page shaped like webviewHtml.ts;
//   desktop:   GitBridge.conflictModel + ConflictOps.snapshot + OperationProvider.view,
//              served by the harness shim (window.__GS_MERGE_FIXTURE) to the real
//              renderer, which is then driven: open the Changes row for the file.
// Prints one JSON line per shot: what the view SAYS (header, pane titles,
// counter, legend) and every page error, so a check can assert on it too.

import { build } from "esbuild";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GitContext } from "@gitstudio/git-service/GitContext";
import { buildMatrix, desktopBridge, extensionPayload } from "./oracle";
import { Browser, type Page } from "./cdp";
import { BODY_CLASS, VSCODE_THEME_NAMES, VSCODE_THEMES, type VsCodeTheme } from "./themes";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
/**
 * The extension webview entry to bundle. GS_MERGE_WEBVIEW_ENTRY points it at
 * another build's copy (alignment.test.ts renders the pre-fix merge view that
 * way, to prove its measurement fails on it).
 */
const WEBVIEW_ENTRY = process.env.GS_MERGE_WEBVIEW_ENTRY || join(REPO, "packages/webview-ui/src/main.ts");
const DESKTOP = join(REPO, "apps/desktop");

export type Host = "ext" | "desktop";

export interface Shot {
  host: Host;
  scenario: string;
  file: string;
  theme: string;
  out: string;
  /** What the rendered view says. */
  seen: {
    header?: string;
    panes: string[];
    counter?: string;
    noText?: string;
    legend: Record<string, string>;
  };
  errors: string[];
}

// ── The extension's webview ──────────────────────────────────────────────────

let extBundle: Promise<string> | undefined;

/** The production webview entry, bundled the way apps/extension/esbuild.js does. */
function extensionBundle(): Promise<string> {
  extBundle ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "gs-merge-e2e-ext-"));
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    await build({
      entryPoints: { main: WEBVIEW_ENTRY },
      outdir: dir,
      bundle: true,
      platform: "browser",
      format: "iife",
      loader: { ".ttf": "dataurl" },
      tsconfig: join(REPO, "apps/extension/tsconfig.json"),
      logLevel: "silent",
    });
    return dir;
  })();
  return extBundle;
}

let pageSeq = 0;

async function extensionPage(root: string, rel: string, theme: VsCodeTheme): Promise<string> {
  const dir = await extensionBundle();
  const ctx = new GitContext({ root });
  try {
    const op = await ctx.operation.view();
    const payload = await extensionPayload(ctx, root, rel, op);
    const n = pageSeq++;
    writeFileSync(
      join(dir, `payload-${n}.js`),
      `window.__GS_INIT = ${JSON.stringify({ type: "init", ...payload })};\n`,
    );
    const vars = Object.entries(VSCODE_THEMES[theme])
      .map(([k, v]) => `${k}:${v}`)
      .join(";")
      .replace(/"/g, "&quot;");
    // The shape of merge-vscode's webviewHtml.ts (no CSP: a file:// page has no
    // webview origin), with VS Code's theme variables and body classes.
    writeFileSync(
      join(dir, `page-${n}.html`),
      `<!DOCTYPE html>
<html lang="en" style="${vars}">
<head>
  <meta charset="UTF-8" />
  <link href="main.css" rel="stylesheet" />
  <title>Merge</title>
  <style>
    html, body, #root { height: 100%; margin: 0; padding: 0; }
    body {
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      background: var(--vscode-editor-background);
      overflow: hidden;
    }
    #placeholder { display: flex; align-items: center; justify-content: center; height: 100%; opacity: 0.6; }
  </style>
</head>
<body class="${BODY_CLASS[theme]}" data-vscode-theme-kind="${BODY_CLASS[theme].split(" ").pop()}" data-vscode-theme-name="${VSCODE_THEME_NAMES[theme]}">
  <div id="root"><div id="placeholder">Loading editor…</div></div>
  <script src="payload-${n}.js"></script>
  <script>
    window.__JBMERGE__ = { workerUri: "data:text/javascript," };
    window.__posted = [];
    window.acquireVsCodeApi = () => ({
      postMessage(m) {
        window.__posted.push(m);
        if (m && m.type === "ready") setTimeout(() => window.postMessage(window.__GS_INIT, "*"), 0);
      },
      getState() { return undefined; },
      setState() {},
    });
  </script>
  <script src="main.js"></script>
</body>
</html>
`,
    );
    return pathToFileURL(join(dir, `page-${n}.html`)).href;
  } finally {
    ctx.dispose();
  }
}

// ── The desktop app (harness renderer + shim) ────────────────────────────────

let desktopPageDir: Promise<string> | undefined;

function desktopHarness(noBuild: boolean): Promise<string> {
  desktopPageDir ??= (async () => {
    if (!noBuild) {
      const r = spawnSync("node", ["esbuild.js"], { cwd: DESKTOP, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`desktop build failed:\n${r.stdout}\n${r.stderr}`);
    }
    const dir = mkdtempSync(join(tmpdir(), "gs-merge-e2e-desktop-"));
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
    execFileSync("sh", [join(DESKTOP, "harness/gen.sh"), dir], {
      env: { ...process.env, GS_NO_BUILD: "1" },
      stdio: "ignore",
    });
    // The app loads Monaco's editor worker from beside the page
    // (monacoBoot.ts); gen.sh does not copy it, and without it every merge
    // view opens under an "importScripts failed" error toast.
    copyFileSync(join(DESKTOP, "dist/renderer/editor.worker.js"), join(dir, "editor.worker.js"));
    return dir;
  })();
  return desktopPageDir;
}

/** One page per scenario repository, its fixture holding every file's model, read once. */
const desktopFixtures = new Map<string, Promise<string>>();

function desktopFixture(dir: string, root: string): Promise<string> {
  let made = desktopFixtures.get(root);
  if (made) return made;
  made = (async () => {
    const ctx = new GitContext({ root });
    try {
      const op = await ctx.operation.view();
      const [snap, facts] = await Promise.all([ctx.conflictOps.snapshot({ op }), ctx.conflictOps.conflictFiles({ op })]);
      const xy = new Map(facts.map((f) => [f.path, f.xy]));
      const bridge = await desktopBridge(root);
      const models: Record<string, unknown> = {};
      for (const f of snap.files) models[f.path] = await bridge.conflictModel(f.path);
      const n = pageSeq++;
      writeFileSync(
        join(dir, `merge-e2e-fixture-${n}.js`),
        `window.__GS_MERGE_FIXTURE = ${JSON.stringify({
          op,
          files: snap.files.map((f) => ({ ...f, xy: xy.get(f.path) })),
          models,
        })};\n`,
      );
      const html = readFileSync(join(dir, "harness.html"), "utf8").replace(
        `<script src="./shim.js"></script>`,
        `<script src="./merge-e2e-fixture-${n}.js"></script>\n    <script src="./shim.js"></script>`,
      );
      if (!html.includes(`merge-e2e-fixture-${n}.js`))
        throw new Error("harness.html has no shim.js script to put the fixture before");
      writeFileSync(join(dir, `merge-e2e-${n}.html`), html);
      return join(dir, `merge-e2e-${n}.html`);
    } finally {
      ctx.dispose();
    }
  })();
  desktopFixtures.set(root, made);
  return made;
}

async function desktopPage(root: string, theme: "dark" | "light", noBuild: boolean): Promise<string> {
  const dir = await desktopHarness(noBuild);
  const page = await desktopFixture(dir, root);
  return `${pathToFileURL(page).href}?scene=changes&theme=${theme}`;
}

// ── Driving and reading the page ─────────────────────────────────────────────

/** Settle: the three panes painted (or the no-text panel shown), then a beat for ribbons and gutters. */
async function settleMerge(page: Page): Promise<void> {
  await page.waitFor(
    `document.querySelector(".ms-notext") || (document.querySelectorAll(".jb-pane-title").length >= 3 && ` +
      `[...document.querySelectorAll(".monaco-editor .view-lines")].filter((v) => v.querySelector(".view-line")).length >= 3)`,
    30_000,
    "the merge view to paint",
  );
  await new Promise((r) => setTimeout(r, 800));
}

const READ_VIEW = `(() => {
  const t = (s) => { const e = document.querySelector(s); return e ? e.textContent.trim() : undefined; };
  return {
    header: t(".ms-op-title"),
    panes: [...document.querySelectorAll(".jb-pane-title")].map((e) => e.textContent.trim()),
    counter: t(".jb-counter"),
    noText: t(".ms-notext-title"),
    legend: Object.fromEntries([...document.querySelectorAll(".jb-legend-chip[data-category]")].map((b) => [b.dataset.category, (b.querySelector(".jb-legend-count") || b).textContent.trim()])),
  };
})()`;

export function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_");
}

/**
 * Gestures a shot can take after the view settles, each through the real
 * control a user presses (the gutter buttons act on a primary-button press).
 * Each targets the FIRST block still offering that control, a conflict when
 * there is one.
 */
export const STEPS: Record<string, string> = {
  "accept-yours": pressFirst(".jb-gutter-a .jb-change-actions", ".jb-btn-accept"),
  "ignore-theirs": pressFirst(".jb-gutter-b .jb-change-actions", ".jb-btn-ignore"),
  "accept-theirs": pressFirst(".jb-gutter-b .jb-change-actions", ".jb-btn-accept"),
  "ignore-yours": pressFirst(".jb-gutter-a .jb-change-actions", ".jb-btn-ignore"),
  // The legend's "?" key, open.
  "legend-key": `(() => {
    const b = document.querySelector(".jb-legend-help");
    if (!b) return false;
    b.click();
    return true;
  })()`,
  // Half handled everywhere on screen: Yours taken on every conflict (Theirs
  // left pending), every Yours-only and identical change taken, every
  // Theirs-only one ignored — each through its own gutter control.
  half: `(() => {
    const press = (b) => b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    const pick = () =>
      document.querySelector('.jb-gutter-a .jb-change-actions:not([data-category="theirs-only"]) .jb-btn-accept') ||
      document.querySelector('.jb-gutter-b .jb-change-actions[data-category="theirs-only"] .jb-btn-ignore');
    let n = 0;
    for (let b = pick(); b && n < 200; b = pick()) { press(b); n++; }
    return n > 0;
  })()`,
  // Everything resolved at once: the bottom bar's Accept Yours.
  "resolve-yours": `(() => {
    const b = document.querySelector(".ms-accept-yours");
    if (!b || b.disabled) return false;
    b.click();
    return true;
  })()`,
};

function pressFirst(group: string, button: string): string {
  return `(() => {
    const groups = [...document.querySelectorAll(${JSON.stringify(group)})];
    const g = groups.find((e) => e.dataset.category === "conflict") || groups[0];
    const b = g && g.querySelector(${JSON.stringify(button)});
    if (!b) return false;
    b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    return true;
  })()`;
}

export interface OpenSpec {
  host: Host;
  /** The scenario repository (a built matrix's `<target>/<op>/<style>`). */
  root: string;
  file: string;
  theme: string;
  width?: number;
  height?: number;
  scale?: number;
  noBuild?: boolean;
}

/** Opens one file of one scenario in the real merge view and waits for it to paint. */
export async function openMerge(browser: Browser, o: OpenSpec): Promise<{ page: Page; failure?: string }> {
  if (o.host === "ext" && !(o.theme in VSCODE_THEMES)) throw new Error(`unknown theme ${o.theme}`);
  const url =
    o.host === "ext"
      ? await extensionPage(o.root, o.file, o.theme as VsCodeTheme)
      : await desktopPage(o.root, o.theme as "dark" | "light", !!o.noBuild);
  const page = await browser.newPage(o.width ?? 1600, o.height ?? 1000, o.scale ?? 2);
  await browser.goto(page, url);
  if (o.host === "desktop") {
    const sel = JSON.stringify(`button.file-row[data-path="${o.file.replace(/(["\\])/g, "\\$1")}"]`);
    await page.waitFor(`document.querySelector(${sel})`, 30_000, `the Changes row for ${o.file}`);
    await page.eval(`document.querySelector(${sel}).click()`);
  }
  let failure: string | undefined;
  try {
    await settleMerge(page);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  return { page, failure };
}

/** Takes one of STEPS; false when the view offered no such control. */
export async function step(page: Page, name: string): Promise<boolean> {
  const js = STEPS[name];
  if (!js) throw new Error(`unknown step ${name} (known: ${Object.keys(STEPS).join(", ")})`);
  const done = await page.eval<boolean>(js);
  await new Promise((r) => setTimeout(r, 500));
  return done;
}

export async function readView(page: Page): Promise<Shot["seen"]> {
  return (await page.eval<Shot["seen"]>(READ_VIEW)) ?? { panes: [], legend: {} };
}

export interface RenderOptions {
  scenario: string;
  files: string[];
  themes: string[];
  hosts: Host[];
  target?: string;
  outDir: string;
  width?: number;
  height?: number;
  scale?: number;
  noBuild?: boolean;
  /** Gestures to take after the first shot, in turn, with a shot after each. */
  steps?: string[];
  /** A shot's file name; default `<host>-<scenario>-<theme>-<file>[+<step>…].png`. */
  name?: (s: { host: Host; scenario: string; file: string; theme: string; steps: string[] }) => string;
}

/** Render every file × theme × host of one scenario; returns what each shot showed. */
export async function renderMerge(o: RenderOptions): Promise<Shot[]> {
  const [op, style] = o.scenario.split(".");
  if (!op || !style) throw new Error(`--scenario is <op>.<style>, e.g. rebase.diff3 (got ${o.scenario})`);
  let target = o.target;
  let temp: string | undefined;
  if (!target) {
    temp = mkdtempSync(join(tmpdir(), "gs-merge-e2e-matrix-"));
    buildMatrix(temp, { ops: [op], styles: [style] });
    target = temp;
  }
  const root = join(target, op, style);
  if (!existsSync(join(root, ".git"))) throw new Error(`no scenario ${o.scenario} in ${target}`);
  mkdirSync(o.outDir, { recursive: true });
  const width = o.width ?? 1600;
  const height = o.height ?? 1000;
  const name =
    o.name ??
    ((s) => `${s.host}-${s.scenario}-${s.theme}-${slug(s.file)}${s.steps.map((x) => `+${x}`).join("")}.png`);
  const browser = await Browser.launch({ width, height });
  const shots: Shot[] = [];
  try {
    for (const host of o.hosts) {
      for (const theme of o.themes) {
        if (host === "desktop" && theme !== "dark" && theme !== "light") continue;
        for (const file of o.files) {
          const { page, failure } = await openMerge(browser, {
            host,
            root,
            file,
            theme,
            width,
            height,
            scale: o.scale,
            noBuild: o.noBuild,
          });
          const taken: string[] = [];
          const shoot = async (extra: string[]) => {
            const out = join(o.outDir, name({ host, scenario: o.scenario, file, theme, steps: [...taken] }));
            writeFileSync(out, await page.screenshot());
            shots.push({
              host,
              scenario: o.scenario,
              file,
              theme,
              out,
              seen: await readView(page),
              errors: [...(failure ? [failure] : []), ...extra, ...page.errors],
            });
          };
          await shoot([]);
          for (const s of o.steps ?? []) {
            const done = await step(page, s);
            taken.push(s);
            await shoot(done ? [] : [`step ${s}: the view offered no such control`]);
          }
          await browser.closePage(page);
        }
      }
    }
  } finally {
    await browser.close();
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
  return shots;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    return eq ? eq.slice(name.length + 3) : undefined;
  };
  const list = (v: string | undefined, dflt: string[]) =>
    v
      ? v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : dflt;
  const scenario = flag("scenario");
  const files = list(flag("file"), []);
  if (!scenario || files.length === 0) {
    process.stderr.write(
      readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("\n")
        .slice(1, 22)
        .join("\n") + "\n",
    );
    process.exit(2);
  }
  const host = flag("host") ?? "both";
  const shots = await renderMerge({
    scenario,
    files,
    themes: list(flag("theme"), ["dark"]),
    hosts: host === "both" ? ["ext", "desktop"] : [host as Host],
    target: flag("target") ? resolve(flag("target")!) : undefined,
    outDir: resolve(flag("out-dir") ?? join(tmpdir(), "gs-merge-e2e-shots")),
    width: flag("width") ? Number(flag("width")) : undefined,
    height: flag("height") ? Number(flag("height")) : undefined,
    scale: flag("scale") ? Number(flag("scale")) : undefined,
    noBuild: argv.includes("--no-build"),
    steps: list(flag("steps"), []),
  });
  for (const s of shots) process.stdout.write(JSON.stringify(s) + "\n");
  process.exit(shots.some((s) => s.errors.length > 0) ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
