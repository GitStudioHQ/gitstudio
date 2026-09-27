// A pull request's REAL page — src/pr/prPageHtml.ts around the shared page's
// bundle, as esbuild builds it — under its OWN Content-Security-Policy in
// headless Chrome. The page sets a label's colour, an avatar's hue and a
// tree row's depth through the CSSOM because the policy drops style
// attributes; this is where a regression to `setAttribute("style")` (or an
// inline <style>) would show: the policy refuses it, and the colour is gone.
// The old description panel drew every label the same grey for exactly this.

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decodeVerdictTitle, findChrome } from "../../../packages/webview-ui/test/headless";
import { headlessChromeArgs } from "../../../scripts/test/no-network-chrome.mjs";
import { prPageCsp, prPageHtml } from "../src/pr/prPageHtml";
import { pageScenes } from "../../../packages/webview-ui/test/fixtures/prPageFixtures";

const CHROME = findChrome();
const ROOT = join(__dirname, "..", "..", "..");
const NONCE = "testnonce0123456789abcdefABCDEF01";

test("the page's own policy lets it paint: no refusal, labels and the merge method in place, the theme on the page", { skip: CHROME ? false : "no windowless Chrome (set GS_CHROME)" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-pr-page-html-"));
  try {
    const out = await build({
      entryPoints: [join(ROOT, "packages", "webview-ui", "src", "pr", "page-main.ts")],
      bundle: true,
      write: false,
      outdir: "out",
      platform: "browser",
      format: "iife",
      logLevel: "silent",
    });
    writeFileSync(join(dir, "pr-page.js"), out.outputFiles.find((f) => f.path.endsWith(".js"))!.text);
    writeFileSync(join(dir, "pr-page.css"), out.outputFiles.find((f) => f.path.endsWith(".css"))!.text);
    const codicons = dirname(require.resolve("@vscode/codicons/dist/codicon.css"));
    copyFileSync(join(codicons, "codicon.css"), join(dir, "codicon.css"));
    copyFileSync(join(codicons, "codicon.ttf"), join(dir, "codicon.ttf"));
    const state = { ...pageScenes().mergeBox, seq: 2 };
    const before = `<script nonce="${NONCE}">
      const refused = [];
      document.addEventListener("securitypolicyviolation", (e) => refused.push(e.violatedDirective + " " + (e.blockedURI || "inline")));
      window.__refused = refused;
      window.__posted = [];
      document.documentElement.style.setProperty("--vscode-foreground", "#cccccc");
      document.documentElement.style.setProperty("--vscode-editor-background", "#1e1e1e");
      document.body.className = "vscode-dark";
      window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posted.push(m); }, getState() {}, setState() {} });
    </script>`;
    const after = `<script nonce="${NONCE}">
      window.postMessage(${JSON.stringify({ type: "state", state })}, "*");
      setTimeout(() => {
        const fails = [];
        const label = (name) => [...document.querySelectorAll(".prp-label")].find((l) => l.textContent === name);
        const perf = label("performance"), diff = label("diff");
        if (!perf || !diff) fails.push("labels drawn");
        else {
          if (getComputedStyle(perf).getPropertyValue("--prp-label").trim() !== "#fbca04") fails.push("performance's colour: " + getComputedStyle(perf).getPropertyValue("--prp-label"));
          if (getComputedStyle(perf).backgroundColor === getComputedStyle(diff).backgroundColor) fails.push("two labels, one colour");
        }
        const hue = document.querySelector(".prp-avatar-initial");
        if (!hue || getComputedStyle(hue).getPropertyValue("--prp-hue").trim() === "") fails.push("an avatar's hue");
        // The setting's method (squash) is offered first and chosen.
        const on = document.querySelector(".prp-method.is-on .prp-method-label");
        if (!on || on.textContent !== "Squash and merge") fails.push("the preferred method first: " + (on && on.textContent));
        const title = document.querySelector(".prp-merge-title");
        if (!title || title.value !== "Stream large diffs instead of loading them whole (#482)") fails.push("the squash title: " + (title && title.value));
        if (getComputedStyle(document.body).marginLeft !== "0px") fails.push("the body keeps VS Code's padding");
        if (!window.__posted.some((m) => m.type === "ready")) fails.push("the page never said it was ready");
        for (const r of window.__refused) fails.push("refused: " + r);
        document.title = "CHECK " + JSON.stringify({ fails });
      }, 300);
    </script>`;
    const html = prPageHtml({ cspSource: "file:", nonce: NONCE, codiconCss: "codicon.css", pageCss: "pr-page.css", pageJs: "pr-page.js", mergeMethod: "squash", title: "acme/webapp#482" })
      .replace(/<div id="root"([^>]*)><\/div>/, (m) => `${m}\n${before}`)
      .replace("</body>", `${after}\n</body>`);
    assert.ok(html.includes(`content="${prPageCsp("file:", NONCE)}"`), "the page carries its policy");
    assert.doesNotMatch(prPageCsp("x", "n"), /unsafe-inline|unsafe-eval/, "and it allows no inline style or script");
    assert.doesNotMatch(prPageHtml({ cspSource: "x", nonce: "n", codiconCss: "a", pageCss: "b", pageJs: "c", title: "t" }), /style="|<style/, "the page itself has no inline style");
    assert.match(prPageHtml({ cspSource: "x", nonce: "n", codiconCss: "a", pageCss: "b", pageJs: "c", title: "<x>" }), /<title>&lt;x&gt;<\/title>/, "its title is text");
    assert.doesNotMatch(prPageHtml({ cspSource: "x", nonce: "n", codiconCss: "a", pageCss: "b", pageJs: "c", title: "t", mergeMethod: '"><script>' }), /data-merge-method/, "a method it doesn't know never reaches the page");
    const page = join(dir, "page.html");
    writeFileSync(page, html);
    const stdout = await new Promise<string>((res) =>
      execFile(
        CHROME!,
        headlessChromeArgs(["--disable-gpu", "--no-sandbox", `--user-data-dir=${join(dir, "profile")}`, "--allow-file-access-from-files", "--virtual-time-budget=5000", "--window-size=1000,900", "--dump-dom", `file://${page}`]),
        { maxBuffer: 32 * 1024 * 1024, timeout: 60_000, killSignal: "SIGKILL" },
        (_err, o) => res(o ?? ""),
      ),
    );
    const m = /<title>CHECK ([\s\S]*?)<\/title>/.exec(stdout);
    assert.ok(m, `a verdict (title: ${/<title>([\s\S]*?)<\/title>/.exec(stdout)?.[1]})`);
    assert.deepEqual(JSON.parse(decodeVerdictTitle(m[1])).fails, []);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
