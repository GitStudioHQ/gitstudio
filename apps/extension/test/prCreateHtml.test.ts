// The REAL New pull request form — src/pr/prCreateHtml.ts around the shared
// form's bundle, as esbuild builds it — under its OWN Content-Security-Policy
// in headless Chrome. The form sets a label's colour and an avatar's hue
// through the CSSOM because the policy drops style attributes; this is where
// a regression to `setAttribute("style")` (or an inline <style>) would show:
// the policy refuses it, and the colour is gone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { decodeVerdictTitle, findChrome } from "../../../packages/webview-ui/test/headless";
import { headlessChromeArgs } from "../../../scripts/test/no-network-chrome.mjs";
import { prCreateCsp, prCreateHtml } from "../src/pr/prCreateHtml";
import { createScenes } from "../../../packages/webview-ui/test/fixtures/prCreateFixtures";

const CHROME = findChrome();
const ROOT = join(__dirname, "..", "..", "..");
const NONCE = "testnonce0123456789abcdefABCDEF01";

test("the form's own policy lets it paint: no refusal, a picked label's colour and an avatar's hue in place, the theme on the page", { skip: CHROME ? false : "no windowless Chrome (set GS_CHROME)" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-pr-create-html-"));
  try {
    const out = await build({
      entryPoints: [join(ROOT, "packages", "webview-ui", "src", "pr", "create-main.ts")],
      bundle: true,
      write: false,
      outdir: "out",
      platform: "browser",
      format: "iife",
      logLevel: "silent",
    });
    writeFileSync(join(dir, "pr-create.js"), out.outputFiles.find((f) => f.path.endsWith(".js"))!.text);
    writeFileSync(join(dir, "pr-create.css"), out.outputFiles.find((f) => f.path.endsWith(".css"))!.text);
    const codicons = dirname(require.resolve("@vscode/codicons/dist/codicon.css"));
    copyFileSync(join(codicons, "codicon.css"), join(dir, "codicon.css"));
    copyFileSync(join(codicons, "codicon.ttf"), join(dir, "codicon.ttf"));
    const state = { ...createScenes().ready, seq: 2 };
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
        // Pick a label and a reviewer, as a user does.
        document.querySelector('[data-picker="labels"]').click();
        const sw = document.querySelector(".prc-swatch");
        if (!sw || getComputedStyle(sw).backgroundColor !== "rgb(215, 58, 74)") fails.push("bug's swatch in the label picker, its own red: " + (sw && getComputedStyle(sw).backgroundColor));
        [...document.querySelectorAll(".prc-picker-item")].find((b) => b.dataset.id === "performance").click();
        document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        document.querySelector('[data-picker="reviewers"]').click();
        [...document.querySelectorAll(".prc-picker-item")].find((b) => b.dataset.id === "alice-chen").click();
        const chip = document.querySelector('[data-key="label-performance"]');
        if (!chip) fails.push("the label drawn");
        else if (getComputedStyle(chip).getPropertyValue("--prp-label").trim() !== "#0e8a16") fails.push("its colour: " + getComputedStyle(chip).getPropertyValue("--prp-label"));
        const hue = document.querySelector('[data-key="reviewers-alice-chen"] .prp-avatar-initial');
        if (!hue || getComputedStyle(hue).getPropertyValue("--prp-hue").trim() === "") fails.push("an avatar's hue");
        const title = document.querySelector(".prc-title");
        if (!title || title.value !== "Stream large diffs") fails.push("the proposed title: " + (title && title.value));
        if (getComputedStyle(document.body).marginLeft !== "0px") fails.push("the body keeps VS Code's padding");
        if (!window.__posted.some((m) => m.type === "ready")) fails.push("the page never said it was ready");
        for (const r of window.__refused) fails.push("refused: " + r);
        document.title = "CHECK " + JSON.stringify({ fails });
      }, 300);
    </script>`;
    const html = prCreateHtml({ cspSource: "file:", nonce: NONCE, codiconCss: "codicon.css", formCss: "pr-create.css", formJs: "pr-create.js", title: "New pull request" })
      .replace(/<div id="root"([^>]*)><\/div>/, (m) => `${m}\n${before}`)
      .replace("</body>", `${after}\n</body>`);
    assert.ok(html.includes(`content="${prCreateCsp("file:", NONCE)}"`), "the page carries its policy");
    assert.doesNotMatch(prCreateCsp("x", "n"), /unsafe-inline|unsafe-eval/, "and it allows no inline style or script");
    assert.match(prCreateCsp("x", "n"), /img-src x https:\/\/avatars\.githubusercontent\.com data:;/, "images: GitHub's avatars only — the form shows no one's prose");
    assert.doesNotMatch(prCreateHtml({ cspSource: "x", nonce: "n", codiconCss: "a", formCss: "b", formJs: "c", title: "t" }), /style="|<style/, "the page itself has no inline style");
    assert.match(prCreateHtml({ cspSource: "x", nonce: "n", codiconCss: "a", formCss: "b", formJs: "c", title: "<x>" }), /<title>&lt;x&gt;<\/title>/, "its title is text");
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
