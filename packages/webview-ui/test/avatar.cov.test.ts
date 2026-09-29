import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { authorInitials, avatarHtml, avatarHue, emailHash, gravatarUrl } from "../src/graph/avatar";
import { absTime, esc, relTime, statCount, DAY, HOUR, MINUTE, MONTH, YEAR } from "../src/graph/format";

// The graph's author avatars: the inline MD5 must be THE md5 (Gravatar looks a
// photo up by it), the fallback disc must be stable per author, and the row
// markup must never let an author's name or a URL out of its attribute.

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

test("emailHash is the RFC 1321 md5 of the trimmed, lowercased address", () => {
  // The two published test vectors, then the normalisation Gravatar asks for.
  assert.equal(emailHash(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(emailHash("abc"), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(emailHash("  MyEmailAddress@Example.com "), "0bc83cb571cd1c50ba6f3e8a78ef1346");
  assert.equal(emailHash("  MyEmailAddress@Example.com "), emailHash("myemailaddress@example.com"), "cached under the normalised key");
});

test("emailHash agrees with node's md5 across block boundaries and non-ASCII text", () => {
  const inputs = [
    "a",
    "x".repeat(55), // the last length whose padding fits one block
    "x".repeat(56), // …and the first that spills into a second
    "x".repeat(63),
    "x".repeat(64),
    "y".repeat(200),
    "zoë@exämple.org", // two-byte UTF-8
    "作者@例子.中国", // three-byte UTF-8
    "dev🚀@rocket.io", // a surrogate pair: four-byte UTF-8
  ];
  for (const s of inputs) assert.equal(emailHash(s), md5(s.trim().toLowerCase()), JSON.stringify(s));
});

test("a GitHub noreply address resolves to that user's GitHub avatar, with or without the id prefix", () => {
  assert.equal(gravatarUrl("12345+octo-cat@users.noreply.github.com"), "https://avatars.githubusercontent.com/octo-cat?size=40");
  assert.equal(gravatarUrl(" octocat@users.noreply.github.com ", 64), "https://avatars.githubusercontent.com/octocat?size=64");
});

test("any other address asks Gravatar for a real photo or a 404, never an identicon", () => {
  assert.equal(
    gravatarUrl("MyEmailAddress@example.com"),
    "https://www.gravatar.com/avatar/0bc83cb571cd1c50ba6f3e8a78ef1346?d=404&s=40",
  );
  assert.match(gravatarUrl("a@b.c", 80), /\?d=404&s=80$/);
  // A login cannot start or end with a hyphen: that is not a noreply address.
  assert.match(gravatarUrl("-bad-@users.noreply.github.com"), /^https:\/\/www\.gravatar\.com\//);
});

test("the disc's hue is stable per author, in range, and derived from the hash", () => {
  const h = avatarHue("Dev@Example.com");
  assert.equal(h, avatarHue("dev@example.com"));
  assert.equal(h, parseInt(md5("dev@example.com").slice(0, 8), 16) % 360);
  for (const e of ["a@b", "c@d", "zoë@x", ""]) {
    const v = avatarHue(e);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 360, `${e} → ${v}`);
  }
});

test("initials: first and last word of a name, two letters of a single word, else the email", () => {
  assert.equal(authorInitials("Ada Lovelace", "ada@x"), "AL");
  assert.equal(authorInitials("jean-luc  picard", "j@x"), "JP");
  assert.equal(authorInitials("Grace Brewster Murray Hopper", "g@x"), "GH");
  assert.equal(authorInitials("linus", "l@x"), "LI");
  assert.equal(authorInitials("", "first.last@example.com"), "FL");
  assert.equal(authorInitials("", "solo@example.com"), "SO");
  assert.equal(authorInitials("", "@example.com"), "?");
  assert.equal(authorInitials("---", "x@y"), "?", "nothing but separators");
});

test("initials never cut an astral character in half", () => {
  const one = authorInitials("🚀 Rocket", "r@x");
  assert.equal(one, "🚀R");
  assert.equal(authorInitials("𝒜𝒷", "x@y"), "𝒜𝒷");
  for (const s of [one, authorInitials("𝒜𝒷", "x@y")]) {
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s), "no lone high surrogate");
  }
});

test("a row avatar layers the photo over the initials disc, hidden until it loads", () => {
  const html = avatarHtml("Ada Lovelace", "ada@example.com", 12, "#abc", "https://x/a.png", false);
  const hue = avatarHue("ada@example.com");
  assert.ok(html.startsWith(`<span class="avatar" style="--gs-av-hue:${hue};--gs-av-x:12px;--gs-av-ring:#abc" aria-hidden="true">`));
  assert.match(html, /<span class="fallback">AL<\/span>/);
  assert.match(html, /<img class="av-img" src="https:\/\/x\/a\.png" alt="" loading="lazy" decoding="async" \/>/);
  assert.ok(html.endsWith("</span>"));
});

test("a photo that already loaded once renders visible straight away", () => {
  assert.match(avatarHtml("A", "a@x", 0, "red", "u", true), /<img class="av-img is-loaded" src="u"/);
});

test("the avatar markup escapes the name, the ring and the URL", () => {
  const html = avatarHtml("<b", "x@y", 0, 'red" onmouseover="x', 'https://e/"><script>', false);
  assert.doesNotMatch(html, /<script>|<b|onmouseover="x/);
  assert.match(html, /<span class="fallback">&lt;B<\/span>/);
  assert.match(html, /--gs-av-ring:red&quot; onmouseover=&quot;x"/);
  assert.match(html, /src="https:\/\/e\/&quot;&gt;&lt;script&gt;"/);
});

test("esc makes text safe for element content and double-quoted attributes", () => {
  assert.equal(esc(`<a href="x">Tom & Jerry</a>`), "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&lt;/a&gt;");
  assert.equal(esc("&lt;"), "&amp;lt;", "an entity in the text stays text");
  assert.equal(esc("plain"), "plain");
});

test("statCount only lets a whole, positive, finite number through", () => {
  assert.equal(statCount(7), 7);
  assert.equal(statCount(3.9), 3);
  for (const bad of [0, -2, NaN, Infinity, "12", null, undefined, {}]) assert.equal(statCount(bad), 0, String(bad));
});

test("relTime reads a compact age at each unit boundary", () => {
  const now = 1_000_000_000;
  const at = (ago: number) => relTime(now - ago, now);
  assert.equal(at(0), "now");
  assert.equal(at(MINUTE - 1), "now");
  assert.equal(at(MINUTE), "1m");
  assert.equal(at(HOUR - 1), "59m");
  assert.equal(at(HOUR), "1h");
  assert.equal(at(DAY - 1), "23h");
  assert.equal(at(DAY * 2), "2d");
  assert.equal(at(MONTH), "1mo");
  assert.equal(at(MONTH * 4), "4mo");
  assert.equal(at(YEAR), "1y");
  assert.equal(at(YEAR * 3 + DAY), "3y");
  assert.equal(at(-500), "now", "a commit dated in the future is not a negative age");
});

test("relTime defaults to the current clock", () => {
  assert.equal(relTime(Date.now() / 1000 - 2 * HOUR - 30), "2h");
});

test("absTime is the local timestamp for the tooltip, and empty when the date cannot be formatted", () => {
  assert.equal(absTime(0), new Date(0).toLocaleString());
  assert.equal(absTime(1_700_000_000), new Date(1_700_000_000_000).toLocaleString());
  assert.equal(absTime(Number.NaN), "Invalid Date", "an unparseable time says so rather than throwing");
  // A value the Date arithmetic itself rejects (a BigInt from a careless host)
  // costs the tooltip, not the row.
  assert.equal(absTime(1n as unknown as number), "");
});
