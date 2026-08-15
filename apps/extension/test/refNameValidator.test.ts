import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The dialog validators (`DLG_VALIDATORS`) live inside the Changes webview's
// inline <script>, which is authored as a String.raw template literal in
// commitView.ts. Nothing type-checks that script — it is a string until the
// browser parses it — so this test lifts the real source out and RUNS it.
//
// Source-text guards are not enough here. webviewTemplateEscapes.test.ts proves
// no backslash is silently dropped, but it cannot tell a correct `\s` from a
// `\\s` that is a perfectly legal escape meaning something else entirely. Both
// mistakes have shipped:
//
//   untagged literal + /\s/   → webview got /s/    → "styles" rejected as a space
//   String.raw     + /\\s/    → webview gets /\\s/ → matches a literal backslash
//
// Either way you cannot name a branch, and neither shows up in tsc, esbuild or
// a grep. So assert on behaviour: what does the validator actually accept?

const SRC = fileURLToPath(new URL("../src/changes/commitView.ts", import.meta.url));

type Validator = (v: string) => string | null;
interface Validators {
  refName: Validator;
  remoteName: Validator;
  url: Validator;
  nonEmpty: Validator;
}

/**
 * Lift `DLG_VALIDATORS` out of commitView.ts and evaluate it.
 *
 * The literal is String.raw-tagged, so the bytes in the .ts file between the
 * backticks are byte-for-byte what the webview's JS parser sees. That makes a
 * plain slice of the source the honest input — no un-escaping, which would
 * reintroduce the very transformation under test.
 */
async function loadValidators(): Promise<Validators> {
  const source = await readFile(SRC, "utf8");

  assert.match(
    source,
    /return String\.raw`<!DOCTYPE html>/,
    "commitView.ts's html() must stay String.raw-tagged, or every regex in the " +
      "inline script silently changes meaning",
  );

  const open = source.indexOf("var DLG_VALIDATORS = {");
  assert.ok(open > 0, "could not find DLG_VALIDATORS in commitView.ts");
  const close = source.indexOf("\n    };", open);
  assert.ok(close > open, "could not find the end of DLG_VALIDATORS");
  const block = source.slice(open, close + "\n    };".length);

  assert.ok(
    !block.includes("${"),
    "DLG_VALIDATORS gained a template substitution; this test's plain slice is " +
      "no longer a faithful copy of what the webview runs",
  );

  return new Function(`${block}; return DLG_VALIDATORS;`)() as Validators;
}

test("refName accepts ordinary branch names", async () => {
  const { refName } = await loadValidators();
  // Every one of these contains an "s" — the exact class of name that the
  // cooked /s/ rejected as "cannot contain spaces" (issue reported on 1.4.0).
  for (const name of ["styles", "s", "master", "feature/save-user", "release-1.2"]) {
    assert.equal(refName(name), null, `${name} should be a valid ref name`);
  }
});

test("refName rejects real whitespace", async () => {
  const { refName } = await loadValidators();
  for (const name of ["has space", "tab\there", "new\nline"]) {
    assert.match(
      refName(name) ?? "",
      /space/i,
      `${JSON.stringify(name)} should be rejected for whitespace`,
    );
  }
});

test("refName rejects the characters git forbids", async () => {
  const { refName } = await loadValidators();
  // These are the false-ACCEPT half of the bug: when \[ and \\ collapsed, the
  // character class only matched at end-of-string and dropped backslash entirely.
  for (const name of ["bad~name", "bad^name", "bad:name", "bad?name", "bad*name", "bad[name", "bad\\name"]) {
    assert.ok(refName(name), `${name} must be rejected — git will not accept it`);
  }
  for (const name of ["-leading", "a..b", "trailing.", "trailing/", "@", "a@{b"]) {
    assert.ok(refName(name), `${name} must be rejected`);
  }
});

test("remoteName accepts names with an s, rejects spaces", async () => {
  const { remoteName } = await loadValidators();
  assert.equal(remoteName("upstream"), null, "'upstream' is the second-most common remote name");
  assert.equal(remoteName("origin"), null);
  assert.ok(remoteName("two words"));
});

test("url accepts real remote URLs", async () => {
  const { url } = await loadValidators();
  // "https" contains an s: with the cooked /s/ every https remote was rejected.
  for (const u of [
    "https://github.com/GitStudioHQ/gitstudio.git",
    "git@github.com:GitStudioHQ/gitstudio.git",
    "ssh://git@example.com/repo.git",
    "/Users/me/src/repo",
  ]) {
    assert.equal(url(u), null, `${u} should be accepted as a remote URL`);
  }
  assert.ok(url("https://example.com/a repo.git"), "a URL with a space is rejected");
});
