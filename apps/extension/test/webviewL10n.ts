/**
 * Installs the two l10n surfaces that source-level tests need when they lift a
 * function out of a host file, or a piece of an inline `<script>` out of the
 * template that hosts it, and evaluate it.
 *
 *  - `l10nT` is the page global the injected webview script defines (see
 *    packages/l10n, `l10nWebviewScript`), used by the inline programs this
 *    extension authors as `String.raw` template literals.
 *  - `l10n` stands in for `import * as l10n from "@vscode/l10n"`, which an
 *    eval'd fragment cannot carry with it.
 *
 * Both substitute `{0}`/`{name}` placeholders the way the runtime does and
 * return the message unchanged for a missing key — that is, they give the
 * English fallback, so the tests keep asserting on the names they read in the
 * source.
 *
 * Importing this module is enough; it exports nothing.
 */
type Replacement = string | number | boolean;

function t(message: string, ...args: Replacement[] | [Record<string, Replacement>]): string {
  const [first] = args;
  if (args.length === 1 && first !== null && typeof first === "object") {
    const named = first as Record<string, Replacement>;
    return message.replace(/\{(\w+)\}/g, (m, key: string) => (key in named ? String(named[key]) : m));
  }
  return message.replace(/\{(\d+)\}/g, (m, index: string) => {
    const value = (args as Replacement[])[Number(index)];
    return value === undefined ? m : String(value);
  });
}

const globals = globalThis as unknown as {
  l10n?: { t: typeof t };
  l10nT?: (message: string, ...args: Replacement[]) => string;
};

if (!globals.l10n) globals.l10n = { t };
if (!globals.l10nT) globals.l10nT = (message, ...args) => t(message, ...args);

export {};
