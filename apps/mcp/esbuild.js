// Bundle the GitStudio MCP server into a single self-contained Node script with
// a shebang, so `gitstudio-mcp` runs with no install step beyond the file itself.
// The @gitstudio/* workspace deps are bundled in; nothing is left external.

const esbuild = require("esbuild");
const path = require("path");

esbuild
  .build({
    entryPoints: [path.resolve(__dirname, "src/index.ts")],
    outfile: path.resolve(__dirname, "dist/index.js"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    minify: false,
    sourcemap: false,
    banner: { js: "#!/usr/bin/env node" },
    logLevel: "info",
  })
  .then(() => {
    // Make the output executable so the `bin` entry works directly.
    const fs = require("fs");
    fs.chmodSync(path.resolve(__dirname, "dist/index.js"), 0o755);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
