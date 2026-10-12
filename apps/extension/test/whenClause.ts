/**
 * A small evaluator for VS Code `when` clauses — enough of the grammar the
 * manifests use (`!`, `&&`, `||`, parentheses, `==`, `!=`, `=~ /re/`, bare
 * keys, quoted strings) to ask "is this item SHOWN in that editor?" instead of
 * "does this string contain that word?".
 *
 * Precedence follows VS Code's parser: `!` binds tightest, then the
 * comparisons, then `&&`, then `||`. A key the context does not define is
 * undefined, so it is falsy and `== x` is false — VS Code's behaviour too.
 */

export type WhenContext = Record<string, string | number | boolean | undefined>;

type Token =
  | { t: "op"; v: "!" | "&&" | "||" | "(" | ")" | "==" | "!=" | "=~" }
  | { t: "word"; v: string }
  | { t: "regex"; v: RegExp };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "==" || two === "!=" || two === "=~") {
      out.push({ t: "op", v: two });
      i += 2;
      if (two === "=~") {
        // The regex literal that must follow: /…/flags, with escapes.
        while (/\s/.test(src[i])) i++;
        if (src[i] !== "/") throw new Error(`=~ without a regex in ${src}`);
        let j = i + 1;
        while (j < src.length && src[j] !== "/") j += src[j] === "\\" ? 2 : 1;
        const body = src.slice(i + 1, j);
        let k = j + 1;
        while (/[a-z]/.test(src[k] ?? "")) k++;
        out.push({ t: "regex", v: new RegExp(body, src.slice(j + 1, k)) });
        i = k;
      }
      continue;
    }
    if (c === "!" || c === "(" || c === ")") {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      out.push({ t: "word", v: src.slice(i, end + 1) });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < src.length && !/[\s!()&|=]/.test(src[j])) j++;
    out.push({ t: "word", v: src.slice(i, j) });
    i = j;
  }
  return out;
}

/** Evaluates `when` against `ctx`. An absent clause is always true, as in VS Code. */
export function evalWhen(when: string | undefined, ctx: WhenContext): boolean {
  if (!when || !when.trim()) return true;
  const toks = tokenize(when);
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;

  const literal = (w: string): string | number | boolean => {
    if (/^(['"]).*\1$/.test(w)) return w.slice(1, -1);
    if (w === "true") return true;
    if (w === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(w)) return Number(w);
    return w;
  };

  const primary = (): boolean => {
    if (isOp("!")) {
      p++;
      return !primary();
    }
    if (isOp("(")) {
      p++;
      const v = or();
      if (!isOp(")")) throw new Error(`unbalanced parentheses in ${when}`);
      p++;
      return v;
    }
    const tok = toks[p++];
    if (!tok || tok.t !== "word") throw new Error(`unexpected token in ${when}`);
    if (tok.v === "true") return true;
    if (tok.v === "false") return false;
    const value = ctx[tok.v];
    if (isOp("==") || isOp("!=")) {
      const negate = peek()!.v === "!=";
      p++;
      const rhs = toks[p++];
      if (!rhs || rhs.t !== "word") throw new Error(`no right-hand side in ${when}`);
      // VS Code compares loosely: a key holding 1 equals the literal "1".
      const equal = value !== undefined && String(value) === String(literal(rhs.v));
      return negate ? !equal : equal;
    }
    if (isOp("=~")) {
      p++;
      const re = toks[p++];
      if (!re || re.t !== "regex") throw new Error(`no regex in ${when}`);
      return value !== undefined && re.v.test(String(value));
    }
    return !!value;
  };
  const and = (): boolean => {
    let v = primary();
    while (isOp("&&")) {
      p++;
      const rhs = primary();
      v = v && rhs;
    }
    return v;
  };
  const or = (): boolean => {
    let v = and();
    while (isOp("||")) {
      p++;
      const rhs = and();
      v = v || rhs;
    }
    return v;
  };
  const result = or();
  if (p !== toks.length) throw new Error(`trailing tokens in ${when}`);
  return result;
}
