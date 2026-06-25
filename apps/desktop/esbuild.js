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
  // The page shell.
  fs.copyFileSync(
    path.join(rendererDir, "index.html"),
    path.join(distDir, "renderer/index.html"),
  );
  // The window/dev icon (electron-builder embeds the packaged icon separately).
  const icon = path.join(repoRoot, "brand/gitstudio-icon-512.png");
  if (fs.existsSync(icon)) {
    fs.copyFileSync(icon, path.join(distDir, "renderer/icon.png"));
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
    external: ["electron", "electron-updater"],
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
