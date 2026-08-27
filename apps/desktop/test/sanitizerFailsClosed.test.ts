// sanitizeHtml is the one security boundary in the renderer: every issue body,
// PR description, review comment, release note, gist and README the app shows
// is attacker-controlled text from GitHub, and the renderer it lands in holds
// `window.gitstudio` — the whole IPC surface. A bypass here is not a cosmetic
// bug.
//
// The existing markdown tests check that known-bad CONSTRUCTS are removed. This
// file checks the property that makes the whole class impossible instead:
//
//   every `<` in the output begins a tag this sanitizer itself produced.
//
// That property failed. The tag pattern requires a `>` after a balanced run of
// attributes, so a tag with an UNTERMINATED attribute quote — `<img src="x` —
// simply did not match, and unmatched text was passed through verbatim. A
// browser then ran that quote on to the next `"` anywhere in the document,
// which the sanitizer helpfully supplied from a later tag's own `title="…"`,
// and every token after it was parsed as an attribute of the tag that had never
// been attribute-filtered. Confirmed in headless Chrome: the payload below gave
// an <img> a live onerror that fired.

import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeHtml, renderMarkdown } from "../src/renderer/markdown";

/**
 * Every `<` that is not the start of a well-formed tag. Sanitizer output must
 * have none: a `<` the browser will try to parse but that this sanitizer never
 * inspected is exactly the hole that was open.
 */
function danglingMarkup(html: string): string[] {
  const spans: Array<[number, number]> = [];
  const tag = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[^<>]*?)?\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(html))) spans.push([m.index, m.index + m[0].length]);
  const loose: string[] = [];
  for (let i = 0; i < html.length; i++) {
    if (html[i] !== "<") continue;
    if (!spans.some(([a, b]) => i >= a && i < b)) loose.push(html.slice(i, i + 48));
  }
  return loose;
}

/** Markup a browser would treat as live but the allowlist never approved. */
const PAYLOADS = [
  // The proven bypass, both quote flavours.
  '<img src="x',
  "<img src='x",
  '<a href="x onclick=alert(1)>click</a>',
  "<a href='x onclick=alert(1)>click</a>",
  '<img src="x onerror=alert(1)>',
  // Unterminated on a tag that is not even allowlisted.
  '<iframe src="x',
  '<svg width="1',
  // A tag whose name runs into the attribute soup.
  "<a href=x onclick=alert(1)>t</a>",
  // Backtick and unquoted values.
  "<img src=`x` onerror=alert(1)>",
  // Split and nested tag names.
  "<scr<script>ipt>alert(1)</script>",
  "<<img src=x onerror=alert(1)>",
  // Newlines and tabs inside the tag.
  '<img\nsrc="x\tonerror=alert(1)>',
  // A stray `<` in prose must also come out inert.
  "a < b and c <3 d",
  "5 <6",
];

test("the proven bypass no longer produces live markup", () => {
  // Two fragments in one body. The first opens a quote the tag pattern cannot
  // close; the second supplies the closing quote from the sanitizer's own
  // output, putting attacker text into attribute position on the first tag.
  const body =
    '<img src="x\n\nsome ordinary text\n\n<b title="onerror=alert(document.domain) x">bold</b>';
  const out = sanitizeHtml(body);
  assert.ok(
    out.startsWith("&lt;img"),
    `the unparseable tag must be escaped, got: ${out.slice(0, 60)}`,
  );
  assert.deepEqual(danglingMarkup(out), []);
  // The legitimate second tag still renders, with its value inert.
  assert.match(out, /<b title="onerror=alert\(document\.domain\) x">bold<\/b>/);
});

test("the same body through the real renderMarkdown path is inert too", () => {
  const out = renderMarkdown(
    '<img src="x\n\nsome ordinary text\n\n<b title="onerror=alert(document.domain) x">bold</b>',
  );
  assert.deepEqual(danglingMarkup(out), []);
});

for (const p of PAYLOADS) {
  test(`no dangling markup survives: ${JSON.stringify(p).slice(0, 46)}`, () => {
    const out = sanitizeHtml(p);
    assert.deepEqual(
      danglingMarkup(out),
      [],
      `sanitizer left markup a browser would parse: ${JSON.stringify(out).slice(0, 160)}`,
    );
  });
}

test("a body cannot forge the tag sentinel to smuggle markup", () => {
  // Allowlisted tags are parked behind U+E001 during the escape pass. If a body
  // could supply its own sentinel it could name a slot and have arbitrary text
  // restored as markup — so the sentinel is stripped from the input first.
  const S = "\uE001";
  const forged = `${S}0${S}<b>x</b>`;
  const out = sanitizeHtml(forged);
  assert.equal(out.includes(S), false, "sentinels must not survive into output");
  assert.match(out, /<b>x<\/b>/, "and real markup still renders");
  assert.deepEqual(danglingMarkup(out), []);
  assert.equal(renderMarkdown(`${S}0${S}plain`).includes(S), false);
});

test("ordinary markup is untouched by the escape pass", () => {
  const out = sanitizeHtml(
    '<p>hello <b>world</b> and <a href="https://example.com">a link</a></p><ul><li>x</li></ul>',
  );
  assert.match(out, /<p>/);
  assert.match(out, /<b>world<\/b>/);
  assert.match(out, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer nofollow">/);
  assert.match(out, /<li>x<\/li>/);
  assert.deepEqual(danglingMarkup(out), []);
});

test("prose that merely looks like markup reads as prose", () => {
  assert.equal(sanitizeHtml("a < b"), "a &lt; b");
  assert.equal(sanitizeHtml("i <3 you"), "i &lt;3 you");
  // …and a void tag still self-closes rather than being escaped.
  assert.match(sanitizeHtml("<br>"), /<br \/>/);
});

test("a disallowed tag is dropped, not escaped into visible source", () => {
  // Escaping an <iframe> would render the literal text "<iframe src=...>" into
  // the comment, which is its own kind of wrong. Well-formed disallowed tags
  // are removed; only UNPARSEABLE ones become text.
  const out = sanitizeHtml('<iframe src="https://e.com"></iframe>after');
  assert.equal(out.includes("iframe"), false);
  assert.match(out, /after/);
});
