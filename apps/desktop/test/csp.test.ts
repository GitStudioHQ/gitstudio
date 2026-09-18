import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The renderer's CSP is one meta tag, and one narrow slice of it broke every
// image in every issue, PR and README:
//
//   "images dont load and appear broken everywhere, issues, prs, md files"
//
// img-src listed GitHub's own hosts — and GitHub's modern attachment URLs
// (github.com/user-attachments/assets/…) answer with a 302 to an S3 bucket
// (github-production-user-asset-….s3.amazonaws.com). CSP checks EVERY hop of
// a redirect chain, so the allowed first hop still ended in a blocked image.
// And READMEs reference the whole world: img.shields.io on virtually every
// repository, imgur, raw hosts. Images cannot execute; `https:` wholesale is
// the correct posture for a client that renders markdown written by everyone.
//
// This test pins the policy so a future tightening pass cannot quietly
// reintroduce the broken-glyph app.

const html = readFileSync(join(__dirname, "../src/renderer/index.html"), "utf8");
const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";

function directive(name: string): string {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s([^;]*)`).exec(csp);
  return m ? m[1].trim() : "";
}

test("the CSP exists and stays strict where strictness matters", () => {
  assert.ok(csp, "the meta CSP is present");
  assert.equal(directive("default-src"), "'none'", "default stays closed");
  assert.doesNotMatch(directive("script-src"), /https?:/, "no remote script ever");
  assert.equal(directive("connect-src"), "'self'", "no remote fetch from the page");
});

test("images may come from any https host — attachments redirect to S3", () => {
  const img = directive("img-src").split(/\s+/);
  assert.ok(img.includes("https:"), `img-src admits https: (${img.join(" ")})`);
  assert.ok(img.includes("data:"), "and data: for inline images");
  assert.ok(img.includes("'self'"), "and the app's own files");
  // http: (cleartext) stays out — an https: page won't load it anyway, and
  // listing it would only signal the wrong intent.
  assert.ok(!img.includes("http:"), "cleartext image hosts stay out");
});
