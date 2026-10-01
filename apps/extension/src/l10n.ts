/**
 * Boots the shared i18n runtime for the extension host.
 *
 * This module MUST be the first import of the extension entry point. It
 * configures `@vscode/l10n` once, before any other module in the import graph
 * is evaluated: modules in `@gitstudio/webview-ui` and friends build
 * user-facing strings in module-level tables, and those are read during the
 * import walk, not inside a function.
 *
 * `vscode.l10n.uri` is the URI of the `bundle.l10n.<locale>.json` that VS Code
 * resolved for the display language (see `"l10n": "./l10n"` in package.json).
 * It is `undefined` when the display language is English, which leaves the
 * runtime unconfigured — every `l10n.t()` call then returns its English source,
 * which is also the fallback for any missing key.
 */
import * as vscode from "vscode";
import { configureL10n } from "@gitstudio/l10n/index";

configureL10n(vscode.l10n.uri ? { fsPath: vscode.l10n.uri.fsPath } : undefined);
