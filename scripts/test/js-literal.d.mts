// Types for js-literal.mjs, for the TypeScript tests and harnesses that import it.

/**
 * `value` as a JavaScript literal: JSON.stringify, with `<`, `>`, `/`, U+2028
 * and U+2029 escaped.
 */
export declare function jsLiteral(value: unknown): string;
