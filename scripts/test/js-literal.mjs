// A value written into JavaScript source that a test or a harness hands a page
// to run (Runtime.evaluate, a page.eval string).
//
// JSON.stringify alone is a literal, not a safe one: it leaves `<`, `>` and
// `/` as they are, so a value holding `</script>` ends a script it is spliced
// into, and it leaves U+2028/U+2029 raw, which older engines read as line
// breaks inside a string. Here each of those is a \u escape instead — the
// page reads back exactly the same value, and no value can step out of its
// literal. Every call site that builds page code from data goes through this.

/**
 * `value` as a JavaScript literal: JSON.stringify, with `<`, `>`, `/`, U+2028
 * and U+2029 escaped.
 * @param {unknown} value
 * @returns {string}
 */
export function jsLiteral(value) {
  return JSON.stringify(value).replace(
    /[<>/\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
