// The Pull Requests view's REAL page — src/pr/prListHtml.ts around the
// shared list's bundle, as esbuild builds it — under its OWN Content-Security-
// Policy in headless Chrome. The list sets a label's colour and an avatar's
// hue through the CSSOM because the policy drops style attributes; this is
// where a regression to `setAttribute("style")` (or an inline <style>) would
// show: the policy refuses it, and the colour is gone. Every headless check
// without the policy passed while the extension's panel drew grey labels.

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decodeVerdictTitle, findChrome } from "../../../packages/webview-ui/test/headless";
import { headlessChromeArgs } from "../../../scripts/test/no-network-chrome.mjs";
import { prListHtml, prListCsp } from "../src/pr/prListHtml";
import { listScenes } from "../../../packages/webview-ui/test/fixtures/prListFixtures";

const CHROME = findChrome();
const ROOT = join(__dirname, "..", "..", "..");
const NONCE = "testnonce0123456789abcdefABCDEF01";

test("the page's own policy lets the list paint: no refusal, labels in their colours, the theme on the page", { skip: CHROME ? false : "no windowless Chrome (set GS_CHROME)" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-pr-list-page-"));
  try {
    const out = await build({
      entryPoints: [join(ROOT, "packages", "webview-ui", "src", "pr", "list-main.ts")],
      bundle: true,
      write: false,
      outdir: "out",
      platform: "browser",
      format: "iife",
      logLevel: "silent",
    });
    writeFileSync(join(dir, "pr-list.js"), out.outputFiles.find((f) => f.path.endsWith(".js"))!.text);
    writeFileSync(join(dir, "pr-list.css"), out.outputFiles.find((f) => f.path.endsWith(".css"))!.text);
    const codicons = dirname(require.resolve("@vscode/codicons/dist/codicon.css"));
    copyFileSync(join(codicons, "codicon.css"), join(dir, "codicon.css"));
    copyFileSync(join(codicons, "codicon.ttf"), join(dir, "codicon.ttf"));
    const state = { ...listScenes().open, seq: 2 };
    // What VS Code does around a webview: the theme onto <html> through the
    // CSSOM, the page's API — then, after the bundle, what the host posts.
    const before = `<script nonce="${NONCE}">
      const refused = [];
      document.addEventListener("securitypolicyviolation", (e) => refused.push(e.violatedDirective + " " + (e.blockedURI || "inline")));
      window.__refused = refused;
      document.documentElement.style.setProperty("--vscode-foreground", "#cccccc");
      document.documentElement.style.setProperty("--vscode-sideBar-background", "#252526");
      document.body.className = "vscode-dark";
      window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
    </script>`;
    const after = `<script nonce="${NONCE}">
      window.postMessage(${JSON.stringify({ type: "state", state })}, "*");
      setTimeout(() => {
        const fails = [];
        const bug = [...document.querySelectorAll(".prl-label")].find((l) => l.textContent === "bug");
        const perf = [...document.querySelectorAll(".prl-label")].find((l) => l.textContent === "performance");
        if (!bug || !perf) fails.push("labels drawn");
        else {
          if (getComputedStyle(bug).getPropertyValue("--prl-label").trim() !== "#d73a4a") fails.push("bug's colour: " + getComputedStyle(bug).getPropertyValue("--prl-label"));
          if (getComputedStyle(bug).backgroundColor === getComputedStyle(perf).backgroundColor) fails.push("two labels, one grey");
        }
        if (getComputedStyle(document.body).marginLeft !== "0px") fails.push("the body keeps VS Code's padding");
        if (document.querySelectorAll(".prl-row").length !== 7) fails.push("rows: " + document.querySelectorAll(".prl-row").length);
        for (const r of window.__refused) fails.push("refused: " + r);
        document.title = "CHECK " + JSON.stringify({ fails });
      }, 300);
    </script>`;
    const html = prListHtml({ cspSource: "file:", nonce: NONCE, codiconCss: "codicon.css", listCss: "pr-list.css", listJs: "pr-list.js" })
      .replace('<div id="root"></div>', `<div id="root"></div>\n${before}`)
      .replace("</body>", `${after}\n</body>`);
    assert.ok(html.includes(`content="${prListCsp("file:", NONCE)}"`), "the page carries its policy");
    assert.doesNotMatch(prListCsp("x", "n"), /unsafe-inline/, "and it allows no inline style or script");
    assert.doesNotMatch(prListHtml({ cspSource: "x", nonce: "n", codiconCss: "a", listCss: "b", listJs: "c" }), /style="|<style/, "the page itself has no inline style");
    const page = join(dir, "page.html");
    writeFileSync(page, html);
    const stdout = await new Promise<string>((res) =>
      execFile(
        CHROME!,
        headlessChromeArgs(["--disable-gpu", "--no-sandbox", `--user-data-dir=${join(dir, "profile")}`, "--allow-file-access-from-files", "--virtual-time-budget=5000", "--window-size=320,900", "--dump-dom", `file://${page}`]),
        { maxBuffer: 32 * 1024 * 1024, timeout: 60_000, killSignal: "SIGKILL" },
        (_err, out) => res(out ?? ""),
      ),
    );
    const m = /<title>CHECK ([\s\S]*?)<\/title>/.exec(stdout);
    assert.ok(m, `a verdict (title: ${/<title>([\s\S]*?)<\/title>/.exec(stdout)?.[1]})`);
    assert.deepEqual(JSON.parse(decodeVerdictTitle(m[1])).fails, []);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
