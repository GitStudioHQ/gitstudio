/**
 * Boots the shared i18n runtime for Merge Studio. MUST be the first import of
 * src/extension.ts: the shared merge packages build user-facing strings in
 * module-level tables, read while the import graph is evaluated.
 *
 * `vscode.l10n.uri` is the bundle VS Code picked for its display language
 * (`"l10n": "./l10n"` in package.json), and undefined in English.
 */
import * as vscode from "vscode";
import { configureL10n } from "@gitstudio/l10n/index";

configureL10n(vscode.l10n.uri ? { fsPath: vscode.l10n.uri.fsPath } : undefined);
