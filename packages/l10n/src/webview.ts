/**
 * Webview half of the GitStudio localization seam.
 *
 * The extension host embeds the localized bundle into every webview page as
 * `globalThis.__gitstudioL10n` (see `l10nWebviewScript` in
 * `@gitstudio/l10n`). Importing this module — which every webview entry point
 * does as its first import — hands that object to the official `@vscode/l10n`
 * runtime, so `l10n.t(...)` anywhere in the shared UI returns Chinese when
 * VS Code runs in Chinese and English otherwise.
 *
 * Must stay free of Node built-ins: this module is bundled for the browser.
 *
 * Hosts that are not VS Code (the Electron desktop renderer, which also bundles
 * `@gitstudio/webview-ui`) simply never define the global, so this is a no-op
 * there and `l10n.t()` keeps returning the English source — which is exactly
 * the behaviour the desktop app ships today.
 */
import { config } from "@vscode/l10n";
import type { l10nJsonFormat } from "@vscode/l10n";

interface L10nGlobal {
  __gitstudioL10n?: l10nJsonFormat;
}

let configured = false;

/** Hand the host-injected bundle to `@vscode/l10n`. Idempotent, never throws. */
export function bootWebviewL10n(): void {
  if (configured) {
    return;
  }
  configured = true;
  const globals = globalThis as unknown as L10nGlobal;
  const bundle = globals.__gitstudioL10n;
  if (bundle && typeof bundle === "object") {
    try {
      config({ contents: bundle });
    } catch {
      // Keep English rather than break the page.
    }
  }
}

// Configure as a side effect of the import, so a webview entry point only ever
// needs `import "@gitstudio/l10n/webview";` on its first line.
bootWebviewL10n();
