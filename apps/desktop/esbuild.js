// esbuild build for the GitStudio desktop (Electron) app — three bundles plus
// Monaco's editor worker:
//   • main     — Electron main process (Node/CJS; `electron` external)
//   • preload  — contextBridge preload  (Node/CJS; `electron` external)
//   • renderer — the page bundle        (browser/IIFE; bundles Lit + Monaco +
//                the @gitstudio/* packages)
//
// The renderer mirrors the extension's webview build: the dompurify-redirect
// plugin (so Monaco carries the patched standalone dompurify), `.ttf` inlined as
// a data URL, and a standalone Monaco worker. `electron` is marked external, so
// these bundles build WITHOUT the Electron binary installed.

const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const repoRoot = path.resolve(__dirname, "../..");
const rendererDir = path.resolve(__dirname, "src/renderer");
const distDir = path.resolve(__dirname, "dist");

/**
 * monaco-editor vendors a stale DOMPurify; redirect its internal import to the
 * patched standalone dompurify (pinned via the root npm "overrides"). Identical
 * to the extension's plugin.
 * @type {import('esbuild').Plugin}
 */
const dompurifyRedirectPlugin = {
  name: "dompurify-redirect",
  setup(build) {
    const patched = path.join(
      path.dirname(require.resolve("dompurify")),
      "purify.es.mjs",
    );
    build.onResolve({ filter: /dompurify[\\/]dompurify\.js$/ }, () => ({
      path: patched,
    }));
  },
};

/** @type {import('esbuild').Plugin} */
const problemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => console.log("[build] started"));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(
            `    ${location.file}:${location.line}:${location.column}:`,
          );
        }
      }
      console.log(
        `[build] finished${result.errors.length ? ` with ${result.errors.length} error(s)` : ""}`,
      );
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const base = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: "silent",
  tsconfig: path.resolve(__dirname, "tsconfig.json"),
  plugins: [problemMatcherPlugin],
};

function copyStaticAssets() {
  fs.mkdirSync(path.join(distDir, "renderer"), { recursive: true });
  // The page shell — cache-bust the bundle refs so a reload after a rebuild can
  // NEVER serve Chromium's stale cached renderer.css / renderer.js.
  const stamp = Date.now().toString(36);
  const html = fs
    .readFileSync(path.join(rendererDir, "index.html"), "utf8")
    .replace('href="./renderer.css"', `href="./renderer.css?v=${stamp}"`)
    .replace('src="./theme-boot.js"', `src="./theme-boot.js?v=${stamp}"`)
    .replace('src="./renderer.js"', `src="./renderer.js?v=${stamp}"`);
  fs.writeFileSync(path.join(distDir, "renderer/index.html"), html);
  // The pre-paint theme bootstrap — a same-origin file so the CSP can forbid
  // inline scripts. Copied verbatim (esbuild does not process it).
  fs.copyFileSync(
    path.join(rendererDir, "theme-boot.js"),
    path.join(distDir, "renderer/theme-boot.js"),
  );
  // The window/dev icon (electron-builder embeds the packaged icon separately)
  // plus the in-app brand assets. The welcome hero is the squircle app-icon
  // mark, theme-swapped (a light-tile sibling so it sits on the light welcome
  // screen instead of floating as a dark square); the wordmark is theme-swapped
  // text. The top-bar mark is an inline currentColor SVG in the renderer, so it
  // needs no asset here.
  const brand = {
    // The macOS-padded mark (824px art inset in a 1024 canvas, per Apple's icon
    // grid) — a full-bleed square is scaled edge-to-edge into the dock slot and
    // renders visibly bigger than every neighbouring app.
    // NOTE: no light-tile sibling any more. The dock icon is fixed identity and
    // no longer theme-swaps: the white tile washed the mark's lanes out.
    "brand/gitstudio-icon-mac-1024.png": "icon.png",
    "brand/gitstudio-icon.svg": "brand-icon.svg",
    "brand/gitstudio-icon-light.svg": "brand-icon-light.svg",
    "brand/gitstudio-wordmark-light.svg": "brand-wordmark-light.svg",
    "brand/gitstudio-wordmark-dark.svg": "brand-wordmark-dark.svg",
  };
  for (const [src, dest] of Object.entries(brand)) {
    const abs = path.join(repoRoot, src);
    if (fs.existsSync(abs)) {
      fs.copyFileSync(abs, path.join(distDir, "renderer", dest));
    }
  }
}

/** A plugin that re-copies the static assets after each (re)build, for watch. */
const copyAssetsPlugin = {
  name: "copy-assets",
  setup(build) {
    build.onEnd(() => copyStaticAssets());
  },
};

async function main() {
  const mainCtx = await esbuild.context({
    ...base,
    entryPoints: [path.resolve(__dirname, "src/main/main.ts")],
    outfile: path.join(distDir, "main/main.js"),
    platform: "node",
    format: "cjs",
    target: "node20",
    // `electron` is provided by the runtime; `node-pty` is a NATIVE module (the
    // terminal bridge loads it lazily) that can't be bundled — kept external so
    // `require("node-pty")` resolves from node_modules (packaged builds
    // asar-unpack it). electron-updater is pure JS and MUST be bundled: the
    // packaged app ships only `dist/**` (not node_modules), so leaving it
    // external silently disabled auto-update in every shipped build.
    external: ["electron", "node-pty"],
  });

  const preloadCtx = await esbuild.context({
    ...base,
    entryPoints: [path.resolve(__dirname, "src/preload/preload.ts")],
    outfile: path.join(distDir, "preload/preload.js"),
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["electron"],
  });

  const rendererCtx = await esbuild.context({
    ...base,
    entryPoints: [path.resolve(rendererDir, "renderer.ts")],
    outfile: path.join(distDir, "renderer/renderer.js"),
    platform: "browser",
    format: "iife",
    target: "chrome120",
    loader: { ".ttf": "dataurl" },
    plugins: [problemMatcherPlugin, dompurifyRedirectPlugin, copyAssetsPlugin],
  });

  // Monaco's editor worker, bundled standalone; loaded via a blob shim at runtime.
  const workerCtx = await esbuild.context({
    ...base,
    entryPoints: [
      require.resolve("monaco-editor/esm/vs/editor/editor.worker.js"),
    ],
    outfile: path.join(distDir, "renderer/editor.worker.js"),
    platform: "browser",
    format: "iife",
    target: "chrome120",
  });

  const contexts = [mainCtx, preloadCtx, rendererCtx, workerCtx];

  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    console.log("[build] watching…");
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    copyStaticAssets();
    reportSizes();
    await Promise.all(contexts.map((c) => c.dispose()));
  }
}

function reportSizes() {
  const files = [
    "main/main.js",
    "preload/preload.js",
    "renderer/renderer.js",
    "renderer/editor.worker.js",
  ];
  console.log("[build] bundle sizes:");
  for (const rel of files) {
    const p = path.join(distDir, rel);
    if (fs.existsSync(p)) {
      const kb = (fs.statSync(p).size / 1024).toFixed(1);
      console.log(`  ${rel.padEnd(28)} ${kb} KB`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
