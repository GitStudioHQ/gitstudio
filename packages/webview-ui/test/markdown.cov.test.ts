import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderMarkdown, sanitizeHtml } from "../src/markdown";

// The numeric and boolean attributes the sanitizer lets through (and the
// malformed values it drops), and the list builder's two edge paths: a list
// that changes type mid-run, and nesting past the depth cap.

test("table cells keep a sane colspan/rowspan and drop anything else", () => {
  assert.equal(
    sanitizeHtml('<table><tr><td colspan="2" rowspan="abc">x</td><td rowspan="3" colspan="1234">y</td></tr></table>'),
    '<table><tr><td colspan="2">x</td><td rowspan="3">y</td></tr></table>',
  );
});

test("an image keeps a 1–4 digit width/height and loses a longer one", () => {
  assert.equal(sanitizeHtml('<img src="a.png" width="12345" height="40">'), '<img src="a.png" height="40" loading="lazy" />');
  assert.match(sanitizeHtml('<img src="a.png" width="120" height="40px">'), /^<img src="a\.png" width="120" loading="lazy" \/>$/);
});

test("start is kept on an ordered list only, and only as a small number", () => {
  assert.equal(
    sanitizeHtml('<ol start="3"><li>a</li></ol><ul start="3"><li>b</li></ul><ol start="1234567"></ol>'),
    '<ol start="3"><li>a</li></ol><ul><li>b</li></ul><ol></ol>',
  );
});

test("open survives on <details> and nowhere else", () => {
  assert.equal(
    sanitizeHtml("<details open><summary>s</summary>x</details><div open>y</div>"),
    "<details open><summary>s</summary>x</details><div>y</div>",
  );
});

test("a list that switches between bullets and numbers at one indent closes and reopens the right tag", () => {
  assert.equal(
    renderMarkdown("- a\n1. b\n- c"),
    "<ul><li>a</li></ul><ol><li>b</li></ol><ul><li>c</li></ul>",
  );
});

test("nesting past the depth cap keeps the deeper items as siblings in the deepest list", () => {
  const deep = Array.from({ length: 13 }, (_, i) => "  ".repeat(i) + "- l" + i).join("\n");
  const out = renderMarkdown(deep);
  assert.equal((out.match(/<ul>/g) ?? []).length, 10, "ten levels, no more");
  assert.equal((out.match(/<\/ul>/g) ?? []).length, 10, "and every one is closed");
  assert.match(out, /<li>l9<\/li><li>l10<\/li><li>l11<\/li><li>l12<\/li><\/ul>/);
  for (let i = 0; i < 13; i++) assert.ok(out.includes(`l${i}`), `item ${i} is not lost`);
});

test("stepping back out of a nested list closes the sublist inside its parent item", () => {
  assert.equal(
    renderMarkdown("- a\n  - b\n    - c\n- d"),
    "<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>",
  );
});
