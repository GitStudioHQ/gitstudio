import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Structural guards on app.css. Both failures below have actually happened in
// this repo, and both are SILENT: the stylesheet still parses, it just stops
// meaning what it says.

const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../src/renderer/styles/app.css"),
  "utf8",
);

/** Strip comments the way a CSS parser does: the FIRST closing pair wins. */
function stripComments(css: string): { code: string; comments: string[] } {
  const comments: string[] = [];
  let out = "";
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) {
        comments.push(css.slice(i));
        break;
      }
      comments.push(css.slice(i, end + 2));
      // Preserve newlines so line numbers stay meaningful.
      out += css.slice(i, end + 2).replace(/[^\n]/g, " ");
      i = end + 1;
      continue;
    }
    out += css[i];
  }
  return { code: out, comments };
}

test("no comment closes early on a star-slash inside a selector glob", () => {
  // A comment containing a glob like ".gh-checks-<star>/" terminates AT the
  // glob rather than at its intended end, and CSS error
  // recovery then eats the next live declaration. This silently killed --sp-1,
  // .sec-list's padding and .gh-head-tools' margin app-wide.
  const { comments } = stripComments(CSS);
  const offenders: string[] = [];
  let idx = 0;
  for (const c of comments) {
    idx = CSS.indexOf(c, idx);
    const after = CSS[idx + c.length];
    // A comment that ends immediately before a letter, dot or dash is the
    // signature of a selector glob having closed it by accident.
    if (after && /[A-Za-z.\-]/.test(after)) {
      const line = CSS.slice(0, idx).split("\n").length;
      offenders.push(`line ${line}: …${CSS.slice(idx + c.length - 24, idx + c.length + 16)}…`);
    }
    idx += c.length;
  }
  assert.deepEqual(offenders, [], `comment(s) closed into a selector:\n${offenders.join("\n")}`);
});

test("braces balance — an unclosed rule swallows every rule after it", () => {
  const { code } = stripComments(CSS);
  let depth = 0;
  let strayLine = 0;
  let line = 1;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === "\n") line++;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0 && !strayLine) strayLine = line;
    }
  }
  assert.equal(strayLine, 0, `stray closing brace at line ${strayLine}`);
  assert.equal(depth, 0, `${depth} unclosed rule block(s) — everything after the first is dead`);
});

test("no selector is left without a declaration block", () => {
  // `.foo {` immediately followed by another selector line means the block's
  // body was lost in an edit — which is how .dc-createpr came to swallow every
  // rule after it. At-rules (@media, @supports, @keyframes) legitimately
  // contain selectors, so only rule blocks are checked.
  const { code } = stripComments(CSS);
  const lines = code.split("\n");
  const bad: number[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const open = lines[i].trim();
    if (!open.endsWith("{") || open.startsWith("@")) continue;
    const next = lines[i + 1].trim();
    // A declaration has a colon before any brace; a selector does not.
    const looksLikeSelector = /^[.#][\w-]/.test(next) && !next.includes(":") && !next.includes("}");
    if (looksLikeSelector) bad.push(i + 2);
  }
  assert.deepEqual(bad, [], `selector directly inside a rule block at line(s) ${bad.join(", ")}`);
});

// The guards must FAIL on the real defects — a guard that cannot fail is a
// guard that proves nothing. These run against synthetic stylesheets.

function offenders(css: string): { earlyClose: number; depth: number } {
  const { comments } = stripComments(css);
  let idx = 0;
  let earlyClose = 0;
  for (const c of comments) {
    idx = css.indexOf(c, idx);
    const after = css[idx + c.length];
    if (after && /[A-Za-z.\-]/.test(after)) earlyClose++;
    idx += c.length;
  }
  let depth = 0;
  for (const ch of stripComments(css).code) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return { earlyClose, depth };
}

test("the early-close guard catches the real defect", () => {
  const glob = "*" + "/";
  const broken = `:root {\n  /* scale — the sec-${glob}det- pages use it. */\n  --sp-1: 4px;\n}\n`;
  assert.equal(offenders(broken).earlyClose, 1, "should flag the glob-terminated comment");
  const fine = `:root {\n  /* scale — the sec- and det- pages use it. */\n  --sp-1: 4px;\n}\n`;
  assert.equal(offenders(fine).earlyClose, 0, "should not flag a clean comment");
});

test("the brace guard catches an unclosed rule", () => {
  assert.equal(offenders(".a {\n  color: red;\n}\n").depth, 0);
  assert.equal(offenders(".a {\n.b { color: red; }\n").depth, 1, "should report one unclosed block");
});

/**
 * A comment must never sit BETWEEN a selector and its block, or between two
 * selectors in a list.
 *
 * CSS ignores comments, so this:
 *
 *     .cmp-seg-btn.active /* why the badge is accented *\/
 *     .cmp-seg-count { background: accent; }
 *
 * does not mean "here is why .cmp-seg-btn.active .cmp-seg-count is accented".
 * It parses as ONE descendant selector, `.cmp-seg-btn.active .cmp-seg-count`,
 * and whatever the author meant the qualifier to do is silently gone. Measured
 * on the shipping build: every Compare badge took the accent, so the active
 * segment was indistinguishable from the inactive one.
 *
 * This is the FOURTH time a comment beside a selector has eaten a declaration
 * in this file, each time presenting as "looks broken, source looks fine". The
 * fix for a defect that recurs is to make its shape impossible.
 *
 * The rule: a comment ends a line, or it starts one. It never sits in the
 * middle of a selector.
 */
test("no comment splits a selector from its block", () => {
  const lines = CSS.split("\n");
  const bad: string[] = [];
  lines.forEach((line, i) => {
    const start = line.indexOf("/*");
    if (start < 0) return;
    const before = line.slice(0, start).trim();
    // Nothing before the comment: it is a leading comment, which is fine.
    if (!before) return;
    // A complete declaration or a closed block before it is fine too —
    // `color: red; /* why */` and `}  /* end of section */`.
    if (/[;{}]$/.test(before)) return;
    // What is left is a SELECTOR fragment with a comment after it. Legal only
    // when the comment closes and the block opens on this same line.
    const after = line.slice(start);
    if (/\*\/\s*\{/.test(after)) return;
    bad.push(`app.css:${i + 1}  ${line.trim().slice(0, 96)}`);
  });
  assert.deepEqual(
    bad,
    [],
    "a comment between a selector and its block is invisible to CSS — the selector joins the " +
      "next one as a DESCENDANT and the qualifier is silently lost. Put the comment on its own " +
      "line above the rule:\n" +
      bad.join("\n"),
  );
});
