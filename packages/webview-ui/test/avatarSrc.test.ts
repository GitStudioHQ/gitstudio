import { strict as assert } from "node:assert";
import { test } from "node:test";
import { avatarSrc } from "../src/pr/avatarSrc";
import { fakeAvatar } from "./fixtures/prListFixtures";

// avatarSrc is the one door from the host's PR state (posted into the webview,
// so untrusted) to an <img src> on the list, page and create surfaces. What it
// returns is rebuilt from a fixed origin or data: header, so these pin both
// halves: every avatar GitHub actually serves comes out byte-for-byte the
// same, and anything else comes out undefined (the initials disc).

test("GitHub's avatar URLs come out unchanged", () => {
  for (const url of [
    "https://avatars.githubusercontent.com/u/1?s=40",
    "https://avatars.githubusercontent.com/u/9919?v=4",
    "https://avatars.githubusercontent.com/u/9919?s=80&v=4",
    "https://avatars.githubusercontent.com/in/15368?v=4",
    "https://avatars.githubusercontent.com/octocat",
    "https://avatars.githubusercontent.com/u/1",
  ]) {
    assert.equal(avatarSrc(url), url);
  }
});

test("the fixtures' inline SVG avatars come out unchanged", () => {
  for (const hue of [0, 90, 265]) {
    const url = fakeAvatar(hue);
    assert.equal(avatarSrc(url), url);
  }
  assert.equal(avatarSrc("data:image/png;base64,iVBORw0KGgo%3D"), "data:image/png;base64,iVBORw0KGgo%3D");
  // Base64's own + / = are percent-encoded; a data: URL is percent-decoded
  // before it is read, so the image is the same one.
  assert.equal(avatarSrc("data:image/gif;base64,R0lG+/=="), "data:image/gif;base64,R0lG%2B%2F%3D%3D");
});

test("any other host, scheme, port or credentials is no avatar", () => {
  for (const url of [
    null,
    undefined,
    "",
    "http://avatars.githubusercontent.com/u/1",
    "http://evil.example/x.png",
    "https://evil.example/u/1",
    "https://avatars.githubusercontent.com.evil.example/u/1",
    "https://evil.example/?https://avatars.githubusercontent.com/",
    "https://avatars.githubusercontent.com:8443/u/1",
    "https://user:pw@avatars.githubusercontent.com/u/1",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)//https://avatars.githubusercontent.com/",
    "data:text/html,<script>alert(1)</script>",
    "data:image/svg+xml;foo=bar,<svg/>",
    "data:image/png;utf8;base64,AAAA",
    "data:image/png",
    "data:image/x-icon;base64,AAAA",
    "not a url",
  ]) {
    assert.equal(avatarSrc(url), undefined, String(url));
  }
});

test("whatever comes out starts with the origin or header written here", () => {
  const out = avatarSrc('https://avatars.githubusercontent.com/u/1"><script>?a="&b=<x>');
  assert.ok(out?.startsWith("https://avatars.githubusercontent.com/"), out);
  assert.ok(!/[<>"]/.test(out ?? ""), out);
  const svg = avatarSrc('data:image/svg+xml;utf8,"><script>');
  assert.ok(svg?.startsWith("data:image/svg+xml;utf8,") && !/[<>"]/.test(svg), svg);
});
