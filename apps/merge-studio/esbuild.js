// Merge Studio's build: the extension host bundle plus the shared webviews —
// the same webview-ui entries GitStudio's apps/extension builds (the merge /
// diff page with Monaco and its editor worker, and the conflicts dashboard),
// and the codicon font the dashboard links.
//
// The shared GitStudio packages are found in one of two layouts:
// - the gitstudio monorepo (apps/merge-studio): `@gitstudio/*` resolves
//   through the npm workspace links in node_modules, entries come from
//   ../../packages/webview-ui/src;
// - the standalone merge-studio repository written by
//   scripts/merge-studio/export.mjs: the packages are vendored under
//   vendor/gitstudio/<pkg>/src, and `@gitstudio/<pkg>/*` is aliased there.
// The build is otherwise identical, so both produce the same bundles.

const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const SHARED_PACKAGES = ["engine", "git-service", "host-bridge", "webview-ui", "merge-vscode"];
const vendorDir = path.resolve(__dirname, "vendor/gitstudio");
const vendored = fs.existsSync(vendorDir);

/** A shared package's src directory in whichever layout this is. */
function sharedSrc(pkg) {
  return vendored ? path.join(vendorDir, pkg, "src") : path.resolve(__dirname, "../../packages", pkg, "src");
}

/** `@gitstudio/<pkg>/<sub>` → vendor/gitstudio/<pkg>/src/<sub> (standalone layout only). */
const alias = vendored
  ? Object.fromEntries(SHARED_PACKAGES.map((pkg) => [`@gitstudio/${pkg}`, sharedSrc(pkg)]))
  : undefined;

/**
 * Copy VS Code's icon font (@vscode/codicons) into dist/ so the dashboard can
 * load it via asWebviewUri. node_modules is excluded from the VSIX; dist/ ships.
 */
function copyCodicons() {
  const srcDir = path.dirname(require.resolve("@vscode/codicons/dist/codicon.css"));
  const outDir = path.resolve(__dirname, "dist/codicons");
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of ["codicon.css", "codicon.ttf"]) {
    fs.copyFileSync(path.join(srcDir, file), path.join(outDir, file));
  }
}

/**
 * monaco-editor vendors its own (stale) copy of DOMPurify. Redirect monaco's
 * internal import to the patched standalone dompurify pinned by the npm
 * "overrides", so the bundled webview carries the fixed copy. Drop-in: same
 * default export and sanitize / addHook / removeAllHooks API.
 * @type {import('esbuild').Plugin}
 */
const dompurifyRedirectPlugin = {
  name: "dompurify-redirect",
  setup(build) {
    const patched = path.join(path.dirname(require.resolve("dompurify")), "purify.es.mjs");
    build.onResolve({ filter: /dompurify[\\/]dompurify\.js$/ }, () => ({ path: patched }));
  },
};

/** @type {import('esbuild').Plugin} */
const problemMatcherPlugin = {
  name: "esbuild-problem-matcher",
  setup(build) {
    build.onStart(() => console.log("[watch] build started"));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      }
      console.log("[watch] build finished");
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
  plugins: [problemMatcherPlugin, dompurifyRedirectPlugin],
  ...(alias ? { alias } : {}),
};

async function main() {
  copyCodicons();
  const webviewUiSrc = sharedSrc("webview-ui");

  // Extension host (Node / CommonJS). `vscode` is provided by the runtime.
  const extensionCtx = await esbuild.context({
    ...base,
    entryPoints: [path.resolve(__dirname, "src/extension.ts")],
    outfile: path.resolve(__dirname, "dist/extension.js"),
    platform: "node",
    format: "cjs",
    external: ["vscode"],
  });

  // The merge editor and diff page (Monaco). Monaco pulls in .css and .ttf;
  // the font is inlined as a data URL so it needs no dynamic webview path.
  const webviewCtx = await esbuild.context({
    ...base,
    entryPoints: [path.join(webviewUiSrc, "main.ts")],
    outfile: path.resolve(__dirname, "dist/webview/main.js"),
    platform: "browser",
    format: "iife",
    loader: { ".ttf": "dataurl" },
  });

  // Monaco's editor worker, bundled standalone; loaded via a blob shim at runtime.
  const workerCtx = await esbuild.context({
    ...base,
    entryPoints: [require.resolve("monaco-editor/esm/vs/editor/editor.worker.js")],
    outfile: path.resolve(__dirname, "dist/webview/editor.worker.js"),
    platform: "browser",
    format: "iife",
  });

  // The conflicts dashboard. Its .css import emits dist/webview/conflicts.css
  // beside the bundle; merge-vscode's conflictsPanel links both.
  const conflictsCtx = await esbuild.context({
    ...base,
    entryPoints: [path.join(webviewUiSrc, "conflicts/main.ts")],
    outfile: path.resolve(__dirname, "dist/webview/conflicts.js"),
    platform: "browser",
    format: "iife",
    loader: { ".ttf": "dataurl" },
  });

  const contexts = [extensionCtx, webviewCtx, workerCtx, conflictsCtx];
  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
  } else {
    await Promise.all(contexts.map((c) => c.rebuild()));
    await Promise.all(contexts.map((c) => c.dispose()));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
