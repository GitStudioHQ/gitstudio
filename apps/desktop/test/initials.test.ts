import { test } from "node:test";
import assert from "node:assert/strict";

// `ui.ts` reaches `bridge.ts`, which reads `window.gitstudio` at module load.
// A bare object is enough — nothing here calls the bridge.
(globalThis as unknown as { window?: unknown }).window ??= {
  gitstudio: { invoke: () => Promise.resolve(undefined), on: () => () => {} },
  addEventListener: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
};
const ui = (): Promise<{ initials: (n: string) => string }> => import("../src/renderer/ui");

/**
 * Avatar-fallback initials.
 *
 * The single-part branch stripped everything outside `[A-Za-z0-9]` — which
 * deletes every Cyrillic, Greek, CJK, Arabic and Hebrew character there is. So
 * a contributor named "Пётр" or "田中" got a "?" tile sitting next to their own
 * correctly-spelled name in the same row: the app rendering their name fine and
 * claiming, an inch away, that it could not read it.
 *
 * The multi-part branch took `[0]`, a UTF-16 unit, so an astral first character
 * produced half a surrogate pair — a tofu box.
 */
test("non-Latin names get their own initials, not a question mark", async () => {
  const { initials } = await ui();
  assert.equal(initials("Пётр"), "ПЁ", "Cyrillic");
  assert.equal(initials("田中"), "田中", "CJK");
  assert.equal(initials("محمد"), "مح", "Arabic");
  assert.equal(initials("Ελένη"), "ΕΛ", "Greek");
  assert.equal(initials("Пётр Иванов"), "ПИ", "two Cyrillic parts");
});

test("astral characters are never cut in half", async () => {
  const { initials } = await ui();
  // Outside the BMP: one code point, two UTF-16 units. `slice(0, 2)` used to
  // return exactly one lone surrogate here.
  const name = "𝒜𝒷";
  const out = initials(name);
  assert.ok(
    ![...out].some((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c >= 0xd800 && c <= 0xdfff;
    }),
    `no lone surrogate in ${JSON.stringify(out)}`,
  );
});

test("the login cases that drove this still hold", async () => {
  const { initials } = await ui();
  // "s-ohta" is one whitespace-part; the first two characters were "s-", so the
  // tile rendered punctuation. Dashes, dots and underscores are word breaks.
  assert.equal(initials("s-ohta"), "SO");
  assert.equal(initials("ada.lovelace"), "AL");
  assert.equal(initials("grace_hopper"), "GH");
  assert.equal(initials("Ada Lovelace"), "AL");
  assert.equal(initials("mono"), "MO");
  assert.equal(initials(""), "?");
  assert.equal(initials("   "), "?");
  assert.equal(initials("-"), "?", "punctuation alone has no initials");
});
