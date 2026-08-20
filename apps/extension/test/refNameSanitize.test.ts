import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// DLG_SANITIZE turns free text into a name git will accept, and is offered in
// the branch dialog as "use this instead". Like DLG_VALIDATORS it lives inside
// the Changes webview's String.raw literal, where nothing type-checks it — so
// this lifts the real source out and RUNS it, rather than asserting on text.
//
// The pairing matters: whatever the sanitiser produces must satisfy the
// validator, or the dialog would suggest a fix it then refuses. The last test
// here checks exactly that, over every case in this file.

const SRC = fileURLToPath(new URL("../src/changes/commitView.ts", import.meta.url));

type Sanitizer = (v: string) => string;
type Validator = (v: string) => string | null;

async function load(): Promise<{ clean: Sanitizer; check: Validator }> {
  const source = await readFile(SRC, "utf8");
  assert.match(
    source,
    /return String\.raw`<!DOCTYPE html>/,
    "commitView.ts's html() must stay String.raw-tagged, or every regex in the " +
      "inline script silently changes meaning",
  );

  const slice = (marker: string): string => {
    const open = source.indexOf(marker);
    assert.ok(open > 0, `could not find ${marker} in commitView.ts`);
    const close = source.indexOf("\n    };", open);
    assert.ok(close > open, `could not find the end of ${marker}`);
    const block = source.slice(open, close + "\n    };".length);
    assert.ok(
      !block.includes("${"),
      `${marker} gained a template substitution; this plain slice is no longer ` +
        "a faithful copy of what the webview runs",
    );
    return block;
  };

  const factory = new Function(
    `${slice("var DLG_SANITIZE = {")}\n${slice("var DLG_VALIDATORS = {")}\n` +
      "return { clean: DLG_SANITIZE.refName, check: DLG_VALIDATORS.refName };",
  ) as () => { clean: Sanitizer; check: Validator };
  return factory();
}

// Loaded once, lazily: the test runner's CJS transform forbids top-level await.
const loaded = load();

test("the pasted-ticket case: spaces become hyphens, the rest survives", async () => {
  const { clean, check } = await loaded;
  const out = clean("SPS-1234 ALA baLa 12/02/21 something something-else-entirely");
  assert.equal(out, "SPS-1234-ALA-baLa-12-02-21-something-something-else-entirely");
  assert.equal(check(out), null, "the suggestion must itself be valid");
});

test("a date does NOT become a ref hierarchy", async () => {
  const { clean } = await loaded;
  // Verified against real git: a slash makes a DIRECTORY under refs/heads, so
  //   git branch "CAD-1234-...-10/11/2345-now"
  // then permanently blocks "CAD-1234-...-10" and "...-10/11":
  //   fatal: cannot lock ref '...-10': '...-10/11/2345-now' exists
  // Pasting a ticket title would silently reserve names nobody asked for.
  const out = clean("CAD-1234 PESTorino laminio something something 10/11/2345 now");
  assert.equal(out, "CAD-1234-PESTorino-laminio-something-something-10-11-2345-now");
  assert.ok(!out.includes("/"), "a date must not introduce path segments");
});

test("but a real hierarchy prefix keeps its slash", async () => {
  const { clean } = await loaded;
  assert.equal(clean("feature/my new thing"), "feature/my-new-thing");
  assert.equal(clean("release/2024 hotfix"), "release/2024-hotfix");
  assert.equal(clean("user/anton/spike"), "user/anton/spike");
});

test("case is preserved — it is a preference, not a validity problem", async () => {
  const { clean, check } = await loaded;
  assert.equal(clean("SPS-1234 Fix The Thing"), "SPS-1234-Fix-The-Thing");
});

test("a forward slash survives: it is git's hierarchy separator", async () => {
  const { clean, check } = await loaded;
  assert.equal(clean("feature/my new thing"), "feature/my-new-thing");
});

test("every character git forbids is replaced", async () => {
  const { clean, check } = await loaded;
  // space ~ ^ : ? * [ \ and control characters.
  const out = clean("a b~c^d:e?f*g[h\\i");
  assert.equal(check(out), null);
  for (const bad of [" ", "~", "^", ":", "?", "*", "[", "\\"]) {
    assert.ok(!out.includes(bad), `still contains ${JSON.stringify(bad)}`);
  }
});

test("runs collapse instead of leaving a row of hyphens", async () => {
  const { clean, check } = await loaded;
  assert.equal(clean("too    many     spaces"), "too-many-spaces");
  assert.equal(clean("a -- b"), "a-b");
  assert.equal(clean("deep//nested"), "deep/nested");
});

test("leading and trailing junk is trimmed, not left to fail validation", async () => {
  const { clean, check } = await loaded;
  assert.equal(clean("  padded  "), "padded");
  assert.equal(clean("/leading/slash/"), "leading/slash");
  assert.equal(clean("-dashes-"), "dashes");
  assert.equal(clean("...dots..."), "dots");
});

test("the sequences git rejects outright are removed", async () => {
  const { clean, check } = await loaded;
  assert.equal(check(clean("a..b")), null, "'..' is rejected by git");
  assert.equal(check(clean("head@{0}")), null, "'@{' is a reflog selector");
  assert.equal(check(clean("ends.")), null, "a trailing dot is rejected");
  assert.equal(clean("@"), "", "a lone @ is not a name");
});

test("a component may not end with .lock", async () => {
  const { clean, check } = await loaded;
  assert.equal(clean("feature/thing.lock"), "feature/thing");
  assert.equal(check(clean("feature/thing.lock")), null);
});

test("an already-valid name is returned untouched", async () => {
  const { clean, check } = await loaded;
  for (const ok of ["main", "feature/diff-tick-staging", "v1.9.0", "SPS-1234"]) {
    assert.equal(clean(ok), ok, `${ok} should be left alone`);
    assert.equal(check(ok), null);
  }
});

test("text with nothing usable in it yields empty, not a broken name", async () => {
  const { clean, check } = await loaded;
  // Empty means "no suggestion to offer" — the dialog shows none rather than
  // proposing something git would reject.
  assert.equal(clean("   "), "");
  assert.equal(clean("///"), "");
  assert.equal(clean("~^:"), "");
});

test("whatever the sanitiser returns, the validator accepts", async () => {
  const { clean, check } = await loaded;
  const inputs = [
    "SPS-1234 ALA baLa 12/02/21 something",
    "feature/my new thing",
    "a b~c^d:e?f*g[h\\i",
    "...dots...", "a..b", "head@{0}", "ends.", "@", "-dashes-",
    "  padded  ", "deep//nested", "feature/thing.lock", "too    many spaces",
    "UPPER Case Ticket", "tab\there", "new\nline",
  ];
  for (const raw of inputs) {
    const out = clean(raw);
    if (out === "") continue; // nothing to suggest
    assert.equal(
      check(out),
      null,
      `sanitising ${JSON.stringify(raw)} gave ${JSON.stringify(out)}, which the ` +
        "validator rejects — the dialog would suggest a fix it then refuses",
    );
  }
});

test("every branch-name prompt names the SHARED validator", async () => {
  // The suggestion is offered by matching on `validate: "refName"`. Two prompts
  // hand-rolled their own inline validator instead — the branch menu's "New
  // Branch" and the push modal's — so they got no suggestion at all, and the
  // push-modal copy was weaker than the shared rule (spaces only: it accepted
  // "..", a trailing dot, "~" and the rest).
  //
  // Any new prompt that copies a rule instead of naming one breaks both the
  // suggestion and the guarantee that one rule governs branch names.
  const source = await readFile(SRC, "utf8");
  const copies = source.match(/Branch names cannot contain spaces|Not a valid branch name/g);
  assert.equal(
    copies,
    null,
    "a branch-name rule was inlined instead of using validate: \"refName\"",
  );
});
