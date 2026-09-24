// Import this FIRST in a test that runs one of the package's host modules:
// from here on, `import … from "vscode"` resolves to support/vscodeStub.cjs
// (require and import alike). Each test file runs in its own process under
// `node --test`, so the stub never reaches guards.test.ts, which proves the
// pure modules load WITHOUT vscode.

import Module, { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const STUB = join(__dirname, "vscodeStub.cjs");

type Resolve = (request: string, ...rest: unknown[]) => string;
const mod = Module as unknown as { _resolveFilename: Resolve; registerHooks?: (hooks: unknown) => void };
const original = mod._resolveFilename;
mod._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === "vscode" ? STUB : original.call(this, request, ...rest);
};
if (typeof mod.registerHooks === "function") {
  mod.registerHooks({
    resolve: (
      specifier: string,
      context: unknown,
      next: (s: string, c: unknown) => unknown,
    ) => (specifier === "vscode" ? { url: pathToFileURL(STUB).href, shortCircuit: true } : next(specifier, context)),
  });
}

/** The recorder the stub fills in (panels, toasts, tabs closed, watchers …). */
export const stub = createRequire(__filename)(STUB).__stub as VscodeStub;

export interface StubPanel {
  viewType: string;
  title: string;
  posted: unknown[];
  revealed: unknown[][];
  disposed: boolean;
  /** On screen; a test hides it (behind another editor) by setting it false. */
  visible: boolean;
  /** How many times the page's HTML was set — each set reloads the page. */
  htmlSets: number;
  /** Also what VS Code does when the user closes the tab. */
  dispose(): void;
  /** The page posting a message to the host. */
  receive(message: unknown): void;
}

export interface VscodeStub {
  panels: StubPanel[];
  messages: { kind: string; message: string; actions: string[] }[];
  statusMessages: string[];
  commands: unknown[][];
  watchers: { pattern: { base: { fsPath: string }; pattern: string }; disposed: boolean }[];
  closedTabs: unknown[];
  config: Record<string, unknown>;
  extensions: Record<string, unknown>;
  answer?: (kind: string, message: string, actions: string[]) => string | undefined;
  onCloseTabs?: (tabs: unknown[]) => void | Promise<void>;
  tabGroupsAll: { tabs: unknown[] }[];
  /** tabGroups.activeTabGroup. */
  activeTabGroup?: { activeTab?: { input?: unknown } };
  /** Every status-bar item created, in order. */
  statusItems: { id: string; text: string; tooltip: string; visible: boolean; backgroundColor?: unknown }[];
  /** workspace.onDidChangeConfiguration's emitter: fire({ affectsConfiguration(section) }). */
  onDidChangeConfiguration: { fire(event: unknown): void };
  /** extensions.onDidChange's emitter. */
  onDidChangeExtensions: { fire(event?: unknown): void };
  /** window.onDidChangeActiveTextEditor's emitter. */
  onDidChangeActiveTextEditor: { fire(editor: unknown): void };
  /** Every WorkspaceEdit handed to workspace.applyEdit, in order. */
  applied: { edits: { text?: string; newEol?: number }[] }[];
  /** workspace.onDidChangeTextDocument's emitter: fire({ document, contentChanges }). */
  onDidChangeTextDocument: { fire(event: unknown): void };
  reset(): void;
}

/** Let every queued promise continuation and immediate run. */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
  }
}
