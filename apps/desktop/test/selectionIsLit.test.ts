import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(resolve(HERE, "../src/renderer/styles/app.css"), "utf8");

/** Every plain style rule in the sheet, @media/@supports bodies included. */
function rules(css: string): { selector: string; body: string; line: number }[] {
  // Comments blanked, not removed, so a rule keeps its line number.
  const s = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const out: { selector: string; body: string; line: number }[] = [];
  const walk = (start: number, end: number): void => {
    let i = start;
    let from = start;
    while (i < end) {
      const c = s[i];
      if (c === ";") from = i + 1;
      if (c !== "{") {
        i++;
        continue;
      }
      const selector = s.slice(from, i).trim();
      let depth = 1;
      let j = i + 1;
      while (j < end && depth) {
        if (s[j] === "{") depth++;
        else if (s[j] === "}") depth--;
        j++;
      }
      const body = s.slice(i + 1, j - 1);
      if (/^@(keyframes|font-face)/.test(selector)) {
        // not style rules
      } else if (selector.startsWith("@") || body.includes("{")) {
        walk(i + 1, j - 1);
      } else {
        out.push({ selector, body, line: s.slice(0, i).split("\n").length });
      }
      i = j;
      from = j;
    }
  };
  walk(0, s.length);
  return out;
}

/** A comma-separated value split at the top level only (not inside a colour). */
function topLevel(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of v) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * THE OWNER'S RULE: a selected, active or current thing is never marked with a
 * line — no bar down its edge (an inset box-shadow, a border side, a
 * ::before/::after strip), no rule on top, no underline, no accent outline.
 * ("disgusting", "trash".) It is lit instead: a fill tinted with the accent,
 * and on a pill, a tab or a button a soft glow (--sel-fill, --sel-glow).
 *
 * The harness sweep (`no-selection-is-drawn-as-a-line` in harness/checks.js)
 * measures what the scenes reach. This reads the stylesheet, so a surface no
 * scene reaches — the clone dialog's picked repository, the commit page's HEAD
 * chip, a rebase preset — cannot grow a line back unseen.
 *
 * What is NOT a selected state stays out of it: hover and keyboard focus
 * (`:focus-visible` rings are accessibility), drag-and-drop insertion markers,
 * a native checkbox's own `:checked` box, and status colours (a warning pill,
 * an approved reviewer) whose selectors name no selected state.
 */
test("no selected, active or current state is drawn as a line", () => {
  const STATE =
    /(\.active\b|\.is-active\b|\.is-selected\b|\.is-sel\b|\.selected\b|\.is-current\b|\.current\b|\.is-on\b|\.row-landed\b|\.is-currentHead\b|aria-selected|aria-current|aria-pressed)/;
  const NOT_SELECTION = /:(hover|focus|focus-visible|focus-within|active)\b|drag|drop/;
  const found: string[] = [];
  for (const r of rules(CSS)) {
    const parts = r.selector
      .split(",")
      .map((p) => p.trim())
      .filter((p) => STATE.test(p) && !NOT_SELECTION.test(p));
    if (!parts.length) continue;
    const decls = r.body
      .split(";")
      .map((d) => d.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    const pseudo = parts.some((p) => /::?(before|after)\b/.test(p));
    for (const d of decls) {
      const [prop, ...rest] = d.split(":");
      const value = rest.join(":").trim();
      const name = prop.trim();
      let why = "";
      if (name === "box-shadow") {
        // Any inset shadow pushed to one side (a bar), or an inset ring.
        for (const s of topLevel(value)) {
          if (!/\binset\b/.test(s) || /^var\(--sheen\)$/.test(s.trim())) continue;
          // The lengths, with every colour (and its nested parentheses) cut out.
          let bare = s.replace(/\binset\b/, "");
          for (let prev = ""; prev !== bare; ) {
            prev = bare;
            bare = bare.replace(/[a-z-]+\([^()]*\)/g, "");
          }
          const lens = bare.match(/-?[\d.]+(px)?/g) ?? [];
          const [x = 0, y = 0, , spread = 0] = lens.map((v) => parseFloat(v));
          if (x || y) why = `an inset bar (${s.trim()})`;
          else if (spread) why = `an inset ring (${s.trim()})`;
        }
      } else if (/^border(-(top|right|bottom|left|block|inline)(-start|-end)?)?(-color|-width|-style)?$/.test(name) && !/^(none|0|0px|transparent)$/.test(value)) {
        why = `a border (${name}: ${value})`;
      } else if (/^(outline|outline-color|text-decoration|text-decoration-line)$/.test(name) && !/^(none|0)$/.test(value)) {
        why = `a line (${name}: ${value})`;
      } else if (pseudo && name === "content" && value !== "none") {
        why = "a ::before/::after strip";
      }
      if (why) found.push(`app.css:${r.line} ${parts.join(", ")} — ${why}`);
    }
  }
  assert.deepEqual(found, [], `selected states drawn as lines:\n  ${found.join("\n  ")}`);
});

/** The replacement exists, so the rule above cannot pass by painting nothing. */
test("the selected state has a tint, a glow and an ink in both themes", () => {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const theme of ["dark", "light"]) {
    const block = new RegExp(`body\\.vscode-${theme}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css)?.[1] ?? "";
    for (const token of ["--sel-fill", "--sel-fill-strong", "--sel-glow", "--sel-glow-soft", "--sel-ink"]) {
      assert.match(block, new RegExp(`${token}\\s*:[^;]*gs-accent`), `${theme} declares ${token} from the accent`);
    }
  }
});
