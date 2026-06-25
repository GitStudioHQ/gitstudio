const esbuild = require("esbuild");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const repoRoot = path.resolve(__dirname, "../..");
const webviewUiSrc = path.resolve(repoRoot, "packages/webview-ui/src");

/**
 * monaco-editor vendors its own (stale) copy of DOMPurify. Redirect monaco's
 * internal import to the patched standalone dompurify pinned via the root npm
 * "overrides", so the bundled webview carries the fixed copy. Drop-in: same
 * default export + sanitize/addHook/removeAllHooks API.
 * @type {import('esbuild').Plugin}
 */
const dompurifyRedirectPlugin = {
  name: "dompurify-redirect",
  setup(build) {
    // dompurify's "exports" map doesn't expose the dist subpath, so resolve its
    // main entry (dist/purify.cjs.js) and derive the sibling ESM build.
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
};

async function main() {
  // Extension host (Node / CommonJS). `vscode` is provided by the runtime.
  const extensionCtx = await esbuild.context({
    ...base,
    entryPoints: [path.resolve(__dirname, "src/extension.ts")],
    outfile: path.resolve(__dirname, "dist/extension.js"),
    platform: "node",
    format: "cjs",
    external: ["vscode"],
  });

  // Shared webview front-end (browser / IIFE). Monaco pulls in .css and .ttf;
  // inline the font as a data URL so it needs no dynamic webview path.
  const webviewCtx = await esbuild.context({
    ...base,
    entryPoints: [path.resolve(webviewUiSrc, "main.ts")],
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

  // The virtualized commit-graph webview (Lit + @tanstack/virtual-core). Its
  // .css import emits dist/webview/graph.css alongside the bundle.
  const graphCtx = await esbuild.context({
    ...base,
    entryPoints: [path.resolve(webviewUiSrc, "graph/main.ts")],
    outfile: path.resolve(__dirname, "dist/webview/graph.js"),
    platform: "browser",
    format: "iife",
    loader: { ".ttf": "dataurl" },
  });

  const contexts = [extensionCtx, webviewCtx, workerCtx, graphCtx];

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
