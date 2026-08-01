import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderMarkdown, sanitizeHtml } from "../src/renderer/markdown";

// renderMarkdown output goes straight into innerHTML for READMEs, issue/PR
// bodies, release notes, gists and AI chat — i.e. fully untrusted input from any
// repo or user. The rendering cases below pin the "looks broken" bugs; the
// security cases pin the allowlist that makes raw-HTML passthrough safe.

// ── rendering: the cases that used to render broken ──────────────────────────

test("images render as <img> (badges no longer show a stray '!')", () => {
  const out = renderMarkdown("![build](https://img.shields.io/badge/build-passing.svg)");
  assert.match(out, /<img [^>]*src="https:\/\/img\.shields\.io\/badge\/build-passing\.svg"/);
  assert.match(out, /alt="build"/);
  assert.ok(!out.includes("!<a"), "leftover '!' before a link");
});

test("badge links nest an image inside the anchor", () => {
  const out = renderMarkdown("[![CI](https://ci.test/b.svg)](https://ci.test/run)");
  assert.match(out, /<a [^>]*href="https:\/\/ci\.test\/run"[^>]*>\s*<img [^>]*src="https:\/\/ci\.test\/b\.svg"/);
});

test("raw HTML blocks survive (the centered-header README opening)", () => {
  const out = renderMarkdown('<p align="center">\n  <img src="logo.png" width="120" />\n</p>');
  assert.match(out, /<p align="center">/);
  assert.match(out, /<img [^>]*src="logo\.png"[^>]*width="120"/);
  assert.ok(!out.includes("&lt;p"), "HTML was escaped instead of rendered");
});

test("inline HTML and character entities are preserved", () => {
  assert.match(renderMarkdown("Press <kbd>⌘</kbd> now"), /<kbd>⌘<\/kbd>/);
  assert.match(renderMarkdown("a&nbsp;b"), /a&nbsp;b/);
  // A stray, non-tag '<' stays inert text rather than eating the line.
  assert.match(renderMarkdown("2 < 3 and 5 > 4"), /2 &lt; 3/);
});

test("task lists render checkboxes, not literal brackets", () => {
  const out = renderMarkdown("- [x] shipped\n- [ ] pending");
  assert.match(out, /md-task-list/);
  assert.match(out, /md-task-done/);
  assert.ok(!out.includes("[x]") && !out.includes("[ ]"), "raw brackets leaked");
});

test("strikethrough, autolinks, and ~~~ fences", () => {
  assert.match(renderMarkdown("~~gone~~"), /<del>gone<\/del>/);
  assert.match(renderMarkdown("see https://gitstudio.dev now"), /<a [^>]*href="https:\/\/gitstudio\.dev"/);
  assert.match(renderMarkdown("<https://gitstudio.dev>"), /<a [^>]*href="https:\/\/gitstudio\.dev"/);
  assert.match(renderMarkdown("~~~js\nlet a = 1;\n~~~"), /<pre><code class="language-js">let a = 1;/);
});

test("setext headings and indented code blocks", () => {
  assert.match(renderMarkdown("Title\n====="), /<h1>Title<\/h1>/);
  assert.match(renderMarkdown("Sub\n---"), /<h2>Sub<\/h2>/);
  assert.match(renderMarkdown("    const x = 1;"), /<pre><code>const x = 1;/);
});

test("existing constructs still work (headings, lists, tables, quotes, code)", () => {
  assert.match(renderMarkdown("# Hi"), /<h1>Hi<\/h1>/);
  assert.match(renderMarkdown("- a\n- b"), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(renderMarkdown("| a | b |\n|---|--:|\n| 1 | 2 |"), /<table class="md-table">/);
  assert.match(renderMarkdown("| a | b |\n|---|--:|\n| 1 | 2 |"), /class="md-right"/);
  assert.match(renderMarkdown("> quoted"), /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(renderMarkdown("`code`"), /<code>code<\/code>/);
  assert.match(renderMarkdown("**b** and *i*"), /<strong>b<\/strong> and <em>i<\/em>/);
  assert.match(renderMarkdown("---"), /<hr \/>/);
});

// ── regressions caught by adversarial review ────────────────────────────────

test("URLs with query strings survive intact (no &amp;amp; corruption)", () => {
  const out = renderMarkdown("[b](https://img.shields.io/x.svg?a=1&b=2&label=CI)");
  assert.match(out, /href="https:\/\/img\.shields\.io\/x\.svg\?a=1&amp;b=2&amp;label=CI"/);
  assert.ok(!out.includes("&amp;amp;"), "URL was double-escaped");
  // Same for image sources, which is where badges actually live.
  const img = renderMarkdown("![b](https://img.shields.io/x.svg?a=1&b=2)");
  assert.match(img, /src="https:\/\/img\.shields\.io\/x\.svg\?a=1&amp;b=2"/);
  assert.ok(!img.includes("&amp;amp;"));
});

test("sanitizeHtml is idempotent for URLs (it runs over its own output)", () => {
  const once = renderMarkdown("[b](https://x.test/a?p=1&q=2)");
  assert.equal(sanitizeHtml(once), once, "second sanitize pass changed the URL");
});

test("links and images with a title render (not raw markdown)", () => {
  const link = renderMarkdown('[docs](https://x.test "The docs")');
  assert.match(link, /<a [^>]*href="https:\/\/x\.test"[^>]*title="The docs"[^>]*>docs<\/a>/);
  assert.ok(!link.includes("]("), "link rendered as literal markdown");

  const img = renderMarkdown('![logo](logo.png "Our logo")');
  assert.match(img, /<img [^>]*src="logo\.png"[^>]*title="Our logo"/);
  assert.ok(!img.includes("!["), "image rendered as literal markdown");
  assert.ok(!/(^|[^!])!<a/.test(img), "stray '!' leaked");
});

test("inline code is inert — HTML inside backticks is shown, not run", () => {
  const out = renderMarkdown("use `<b>bold</b>` and `<script>alert(1)</script>` here");
  assert.match(out, /<code>&lt;b&gt;bold&lt;\/b&gt;<\/code>/);
  assert.match(out, /<code>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code>/);
  // The literal text must survive — it must NOT be eaten by the sanitizer.
  assert.ok(!/<b>bold<\/b>/.test(out), "HTML in a code span rendered live");
  assert.ok(out.includes("alert(1)"), "code-span contents were deleted");
});

test("setext rule does not swallow lists, quotes or HTML followed by ---", () => {
  // A list item followed by a horizontal rule stays a list + <hr>.
  const list = renderMarkdown("- item one\n---");
  assert.match(list, /<ul><li>item one<\/li><\/ul>/);
  assert.ok(!/<h2>/.test(list), "list item became a heading");

  const quote = renderMarkdown("> quoted\n---");
  assert.match(quote, /<blockquote>/);
  assert.ok(!/<h2>quoted/.test(quote));

  const html = renderMarkdown('<p align="center">hi</p>\n---');
  assert.match(html, /<p align="center">/);
  assert.ok(!/<h2>/.test(html));

  // Genuine setext headings still work.
  assert.match(renderMarkdown("Real Heading\n---"), /<h2>Real Heading<\/h2>/);
  assert.match(renderMarkdown("Real Title\n==="), /<h1>Real Title<\/h1>/);
});

test("code blocks never interpret their contents", () => {
  const out = renderMarkdown("```\n<script>alert(1)</script>\n```");
  assert.match(out, /&lt;script&gt;/);
  assert.ok(!/<script/i.test(out));
});

// ── security: the allowlist boundary ─────────────────────────────────────────

test("script tags are dropped with their contents", () => {
  for (const src of [
    "<script>alert(1)</script>",
    "<SCRIPT>alert(1)</SCRIPT>",
    "<script src='https://evil.test/x.js'></script>",
    "text <script>steal()</script> more",
  ]) {
    const out = renderMarkdown(src);
    assert.ok(!/<script/i.test(out), `script survived: ${src}`);
    assert.ok(!out.includes("alert(1)"), `script body survived: ${src}`);
  }
});

test("event handlers and style attributes are stripped", () => {
  const out = renderMarkdown('<img src="x.png" onerror="alert(1)" onload=alert(2) style="position:fixed">');
  assert.ok(!/onerror/i.test(out), "onerror survived");
  assert.ok(!/onload/i.test(out), "onload survived");
  assert.ok(!/style=/i.test(out), "style survived");
  assert.match(out, /<img [^>]*src="x\.png"/, "the image itself should render");
});

test("javascript: and data: URLs are neutralized", () => {
  assert.match(renderMarkdown("[click](javascript:alert(1))"), /href="#"/);
  assert.match(renderMarkdown('<a href="JaVaScRiPt:alert(1)">x</a>'), /href="#"/);
  // control characters used to smuggle a scheme past a naive check
  assert.match(renderMarkdown('<a href="java\tscript:alert(1)">x</a>'), /href="#"/);
  assert.match(renderMarkdown("![x](javascript:alert(1))"), /src="#"/);
  // data:text/html is an XSS vector; data:image/svg can script — both refused.
  assert.match(renderMarkdown('<img src="data:text/html;base64,PHNjcmlwdD4=">'), /src="#"/);
  assert.match(renderMarkdown('<img src="data:image/svg+xml;base64,PHN2Zz4=">'), /src="#"/);
  // a legitimate raster data URI is allowed
  assert.match(renderMarkdown('<img src="data:image/png;base64,iVBORw0KGgo=">'), /src="data:image\/png/);
});

test("foreign-content and framing elements are dropped with contents", () => {
  for (const src of [
    "<svg><script>alert(1)</script></svg>",
    "<iframe src='https://evil.test'></iframe>",
    "<math><mtext><script>alert(1)</script></mtext></math>",
    "<object data='x'></object>",
    "<embed src='x'>",
    "<form><input name=x></form>",
    "<noscript><p>x</p></noscript>",
    "<template><script>alert(1)</script></template>",
    "<style>body{display:none}</style>",
  ]) {
    const out = renderMarkdown(src);
    assert.ok(!/<(svg|iframe|math|object|embed|form|input|noscript|template|style|script)\b/i.test(out),
      `foreign element survived: ${src} -> ${out}`);
    assert.ok(!out.includes("alert(1)"), `payload survived: ${src}`);
  }
});

test("unknown tags are dropped but their text is kept", () => {
  const out = renderMarkdown("<marquee>hello</marquee>");
  assert.ok(!/marquee/i.test(out));
  assert.match(out, /hello/);
});

test("links always get safe rel/target, even if the author sets otherwise", () => {
  const out = renderMarkdown('<a href="https://x.test" target="_self" rel="opener">x</a>');
  assert.match(out, /rel="noopener noreferrer nofollow"/);
  assert.match(out, /target="_blank"/);
  assert.ok(!/rel="opener"/.test(out));
});

test("comments, doctypes and CDATA are removed", () => {
  assert.equal(sanitizeHtml("<!-- <script>alert(1)</script> -->"), "");
  assert.ok(!sanitizeHtml("<!DOCTYPE html><p>x</p>").includes("DOCTYPE"));
  assert.ok(!sanitizeHtml("<![CDATA[<script>alert(1)</script>]]>").includes("alert"));
});

test("attribute values containing '>' cannot break out of the tag", () => {
  const out = sanitizeHtml('<a href="https://x.test/a>b" title="c>d">link</a>');
  assert.ok(!out.includes("<script"));
  assert.match(out, /<a [^>]*>link<\/a>/);
});

test("id attributes are dropped (no anchor hijacking)", () => {
  assert.ok(!/id=/.test(renderMarkdown('<div id="header">x</div>')));
});

test("pathological input stays bounded", () => {
  // deep quote nesting and deep list indentation must not blow the stack
  assert.doesNotThrow(() => renderMarkdown(">".repeat(200) + " deep"));
  assert.doesNotThrow(() => renderMarkdown(Array.from({ length: 60 }, (_, i) => " ".repeat(i * 2) + "- x").join("\n")));
  assert.doesNotThrow(() => renderMarkdown("a".repeat(200_000)));
});

test("empty and whitespace input render empty", () => {
  assert.equal(renderMarkdown(""), "");
  assert.equal(renderMarkdown("\n\n  \n").trim(), "");
});
