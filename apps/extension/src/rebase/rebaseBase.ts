import * as l10n from "@vscode/l10n";

/**
 * A rebase base, in words: a sha — or a sha's parent, "<sha>^", which is what
 * both interactive-rebase doors hand git — shortened; `--root` as "the root
 * commit"; any other ref as typed. The two doors' Undo labels and the
 * workspace's header all read it; they had drifted, and the terminal door's
 * label showed the full 40-character sha plus "^".
 */
export function describeRebaseBase(ref: string): string {
  if (ref === "--root") return l10n.t("the root commit");
  const m = /^([0-9a-f]{40,64})(\^?)$/i.exec(ref);
  return m ? `${m[1].slice(0, 7)}${m[2]}` : ref;
}
