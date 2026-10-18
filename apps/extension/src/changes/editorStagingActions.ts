import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import type { ChangeBlock } from "@gitstudio/git-service/blockStaging";
import type { StagedGutter } from "./stagedGutter";
import { selectionLines } from "./lineTargets";
import { blockAtLine } from "./blockAtLine";
import type { RepoManager } from "../git/repoManager";
import { stageSelectedLines, unstageSelectedLines, type StagingRefresh } from "./lineStaging";
import {
  SET_CHANGE_COMMAND,
  SET_SELECTED_LINES_COMMAND,
  commandFor,
  commandLink,
  isSetChangeArgs,
  isSetSelectedLinesArgs,
  selectionTouches,
  verbsFor,
  type StagingVerb,
} from "./stagingActions";

/**
 * Stage and unstage from the code itself (#87, reopened): people reach for the
 * change in the editor, not for a list beside it.
 *
 * VS Code lets an extension put nothing clickable in the gutter, so the click
 * lives where a click does reach an extension:
 *
 *  - a HOVER on a changed line — "Unstaged change · Stage change", and "Stage
 *    selected lines" while a selection touches the change. On by default
 *    (`gitstudio.staging.hoverActions`). Its links are focusable, so the
 *    keyboard path is Show or Focus Hover (⌘K ⌘I), Tab, Enter. It works the
 *    same on the modified side of a diff editor.
 *  - a CodeLens above each change — opt-in (`gitstudio.staging.codeLens`), as
 *    a line of links above every change is a lot of chrome. VS Code shows no
 *    CodeLens in a diff editor unless `diffEditor.codeLens` is on.
 *
 * Both act through StagedGutter.setAtLine and the line-staging commands — the
 * engine the line-number menu already uses — so the index ends up exactly as
 * that menu would leave it: a partly staged change, a deletion, an untracked
 * file included.
 */
export class EditorStagingActions implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lensesChanged = new vscode.EventEmitter<void>();

  constructor(private readonly gutter: StagedGutter) {
    this.disposables.push(
      this.lensesChanged,
      vscode.languages.registerHoverProvider({ scheme: "file" }, { provideHover: (doc, pos) => this.hover(doc, pos) }),
      vscode.languages.registerCodeLensProvider(
        { scheme: "file" },
        { onDidChangeCodeLenses: this.lensesChanged.event, provideCodeLenses: (doc) => this.lenses(doc) },
      ),
      gutter.onDidRefresh(() => {
        if (codeLensOn()) this.lensesChanged.fire();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("gitstudio.staging.codeLens")) this.lensesChanged.fire();
      }),
    );
  }

  /** The hover for a changed line: what the change is, and what can be done to it. */
  hover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (!hoverOn()) return undefined;
    const block = this.blockAt(document, position.line);
    if (!block) return undefined;
    const editor = editorFor(document.uri);
    const ranges = editor ? selectedRanges(editor) : [];
    const verbs = verbsFor(block.state, ranges.length > 0 && selectionTouches(block, ranges));
    if (verbs.length === 0) return undefined;

    const uri = document.uri.toString();
    const links = verbs.map((verb) => {
      const { command, args } = commandFor(verb, uri, block.working.start);
      return `[${verbLabel(verb, block.state)}](${commandLink(command, args)})`;
    });
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: [SET_CHANGE_COMMAND, SET_SELECTED_LINES_COMMAND] };
    md.appendMarkdown(`**${stateLabel(block.state)}** &nbsp; ${links.join(" &middot; ")}`);

    const last = Math.max(0, document.lineCount - 1);
    const start = Math.min(block.working.start, last);
    const end = Math.min(Math.max(block.working.start, block.working.end), last);
    return new vscode.Hover(md, new vscode.Range(start, 0, end, document.lineAt(end).text.length));
  }

  /** One lens per change: Stage, Unstage, or both for a partly staged one. */
  lenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!codeLensOn()) return [];
    const blocks = this.gutter.blocksFor(document.uri) ?? [];
    const last = Math.max(0, document.lineCount - 1);
    const uri = document.uri.toString();
    return blocks.flatMap((block) => {
      const line = Math.min(block.working.start, last);
      const range = new vscode.Range(line, 0, line, 0);
      return verbsFor(block.state, false).map((verb) => {
        const { command, args } = commandFor(verb, uri, block.working.start);
        return new vscode.CodeLens(range, { title: verbLabel(verb, block.state), command, arguments: [args] });
      });
    });
  }

  private blockAt(document: vscode.TextDocument, line: number): ChangeBlock | undefined {
    // A deletion has no working line of its own: its hover is on the line it sits above.
    return blockAtLine(this.gutter.blocksFor(document.uri) ?? [], line);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

/**
 * SET_CHANGE_COMMAND: the change at a line, staged or unstaged — through
 * StagedGutter.setAtLine, the engine the line-number menu's toggle uses.
 */
export async function runSetChange(gutter: StagedGutter, arg: unknown): Promise<void> {
  if (!isSetChangeArgs(arg)) return;
  await gutter.toggleAtUri(vscode.Uri.parse(arg.uri), arg.line, arg.staged);
}

/**
 * SET_SELECTED_LINES_COMMAND: the selected lines of the editor showing the
 * document — through Stage / Unstage Selected Lines, the same rule
 * (VS Code's: only the selected lines of a pure insertion or a same-length
 * edit; the whole change otherwise).
 */
export async function runSetSelectedLines(repos: RepoManager, refresh: StagingRefresh, arg: unknown): Promise<void> {
  if (!isSetSelectedLinesArgs(arg)) return;
  const editor = editorFor(vscode.Uri.parse(arg.uri));
  if (!editor) return;
  await (arg.staged ? stageSelectedLines : unstageSelectedLines)(repos, refresh, editor);
}

function hoverOn(): boolean {
  return vscode.workspace.getConfiguration("gitstudio").get<boolean>("staging.hoverActions", true) !== false;
}

function codeLensOn(): boolean {
  return vscode.workspace.getConfiguration("gitstudio").get<boolean>("staging.codeLens", false) === true;
}

/**
 * The editor showing `uri` whose selection a "selected lines" action means: the
 * active one when it shows the document — a hover link does not move focus — else
 * any visible one.
 */
export function editorFor(uri: vscode.Uri): vscode.TextEditor | undefined {
  const key = uri.toString();
  const active = vscode.window.activeTextEditor;
  if (active && active.document.uri.toString() === key) return active;
  return vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
}

/** The lines the editor's NON-empty selections cover (a bare caret selects nothing here). */
function selectedRanges(editor: vscode.TextEditor) {
  const chosen = editor.selections.filter((s) => !s.isEmpty);
  if (chosen.length === 0) return [];
  const doc = editor.document;
  const last = doc.lineCount - 1;
  return selectionLines(chosen, { line: last, character: doc.lineAt(last).text.length });
}

function stateLabel(state: ChangeBlock["state"]): string {
  switch (state) {
    case "staged":
      return l10n.t("Staged change");
    case "partial":
      return l10n.t("Partly staged change");
    default:
      return l10n.t("Unstaged change");
  }
}

function verbLabel(verb: StagingVerb, state: ChangeBlock["state"]): string {
  switch (verb) {
    case "stage":
      return state === "partial" ? l10n.t("$(add) Stage the rest") : l10n.t("$(add) Stage change");
    case "unstage":
      return l10n.t("$(remove) Unstage change");
    case "stageLines":
      return l10n.t("Stage selected lines");
    case "unstageLines":
      return l10n.t("Unstage selected lines");
  }
}
