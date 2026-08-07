import * as vscode from "vscode";

// GitStudio's own dialogs — the host-side half.
//
// WHY THIS EXISTS. `vscode.window.showQuickPick` / `showInputBox` render the
// command-palette search bar: it hijacks the top of the window, drops everything
// you typed the moment focus moves (alt-tab, a notification, clicking the
// editor), can't complete over the refs our views are already holding, and reads
// as "you are searching" when you are actually naming a branch. `showXMessage(…,
// {modal: true})` is the same story one level up — an OS-chrome sheet that has
// nothing to do with the surface you clicked in.
//
// Every GitStudio interaction now renders inside our own view instead: a real
// dialog, in our type, with our icons, that survives focus loss because it is
// just DOM. This module is how host-side command code reaches it.
//
// THE RULE: no file under apps/extension/src may call showInputBox,
// showQuickPick, or pass `modal: true`. Use promptInput / promptPick /
// promptPickMany / promptConfirm. Plain (non-modal) toasts are still fine —
// those report an outcome, they don't ask a question.

/** One row in a pick list. */
export interface DialogChoice {
  /** Stable identifier handed back to the caller. */
  id: string;
  label: string;
  /** Codicon name without the `codicon-` prefix (e.g. "git-branch"). */
  icon?: string;
  /** Muted trailing text — a sha, a git flag, a count. */
  detail?: string;
  /** Second line under the label, for explaining what a choice does. */
  description?: string;
  /** Renders in the danger colour and is never the default focus. */
  danger?: boolean;
  /** Initial checkbox state (multi-select only). */
  picked?: boolean;
}

/** A completion candidate for an input dialog. */
export interface DialogCandidate {
  name: string;
  /** Muted category label — "branch", "remote", "tag". */
  kind?: string;
  /** Codicon name without the `codicon-` prefix. */
  icon?: string;
}

/**
 * Which validator the webview runs as you type. A NAME, not a function: the spec
 * crosses a postMessage boundary, so it has to survive structured clone.
 */
export type DialogValidator =
  | "refName"
  | "remoteName"
  | "url"
  | "nonEmpty";

interface BaseSpec {
  title: string;
  /** One line under the title explaining what will happen. */
  hint?: string;
}

export interface InputSpec extends BaseSpec {
  kind: "input";
  placeholder?: string;
  /** Pre-filled text; selected on open, so typing replaces it. */
  value?: string;
  confirmLabel?: string;
  /** Completion candidates. Free text stays allowed unless `strict`. */
  candidates?: DialogCandidate[];
  /** Require the value to be one of `candidates`. */
  strict?: boolean;
  validate?: DialogValidator;
  /** Render a textarea (PR bodies, commit messages). */
  multiline?: boolean;
  /** Mask the field (API keys). The value still crosses postMessage once, on
   *  confirm — the same trip a quick-input password field makes. */
  secret?: boolean;
}

export interface PickSpec extends BaseSpec {
  kind: "pick";
  choices: DialogChoice[];
  /** Show a filter box above the list. Defaults on past 8 choices. */
  filter?: boolean;
}

export interface MultiPickSpec extends BaseSpec {
  kind: "multiPick";
  choices: DialogChoice[];
  confirmLabel?: string;
}

export interface ConfirmSpec extends BaseSpec {
  kind: "confirm";
  message: string;
  confirmLabel: string;
  /** Style the confirm button as destructive and don't autofocus it. */
  danger?: boolean;
}

export type DialogSpec = InputSpec | PickSpec | MultiPickSpec | ConfirmSpec;

/** What the webview sends back. `undefined` value ⇒ dismissed. */
export interface DialogResult {
  /** Input: the text. Pick: the chosen id. MultiPick: the chosen ids. Confirm: "ok". */
  value?: string | string[];
}

/**
 * A GitStudio webview that can render dialogs. Implemented by the Changes view;
 * `show` is responsible for making itself visible first.
 */
export interface DialogHost {
  show(spec: DialogSpec): Promise<DialogResult | undefined>;
}

let host: DialogHost | undefined;

/** Wire up the surface that renders dialogs (the Changes view, at activation). */
export function registerDialogHost(h: DialogHost): vscode.Disposable {
  host = h;
  return new vscode.Disposable(() => {
    if (host === h) {
      host = undefined;
    }
  });
}

/**
 * Run a dialog, or fail closed.
 *
 * If the host is somehow missing (the view failed to resolve), we return
 * "dismissed" rather than silently falling back to a quick pick. A fallback that
 * quietly reintroduced the search bar is exactly the regression this module
 * exists to prevent, and a cancelled dialog is always a safe answer — every
 * caller treats it as "the user backed out".
 */
async function run(spec: DialogSpec): Promise<DialogResult | undefined> {
  if (!host) {
    void vscode.window.showWarningMessage(
      "GitStudio: the Changes view isn't available, so this action can't ask for input. Open the GitStudio sidebar and try again.",
    );
    return undefined;
  }
  return host.show(spec);
}

/** Ask for a line of text. Returns undefined when dismissed. */
export async function promptInput(
  spec: Omit<InputSpec, "kind">,
): Promise<string | undefined> {
  const r = await run({ ...spec, kind: "input" });
  const v = r?.value;
  return typeof v === "string" ? v : undefined;
}

/** Ask the user to choose one option. Returns the choice's `id`. */
export async function promptPick(
  spec: Omit<PickSpec, "kind">,
): Promise<string | undefined> {
  if (spec.choices.length === 0) {
    return undefined;
  }
  const r = await run({ ...spec, kind: "pick" });
  const v = r?.value;
  return typeof v === "string" ? v : undefined;
}

/**
 * Ask the user to choose any number of options. Returns the chosen ids — an
 * EMPTY ARRAY is a valid answer ("none of these"), distinct from `undefined`
 * ("cancelled"), so callers must check for undefined rather than truthiness.
 */
export async function promptPickMany(
  spec: Omit<MultiPickSpec, "kind">,
): Promise<string[] | undefined> {
  const r = await run({ ...spec, kind: "multiPick" });
  const v = r?.value;
  return Array.isArray(v) ? v : undefined;
}

/** Ask a yes/no question. Dismissing counts as "no". */
export async function promptConfirm(
  spec: Omit<ConfirmSpec, "kind">,
): Promise<boolean> {
  const r = await run({ ...spec, kind: "confirm" });
  return r?.value === "ok";
}

/**
 * Convenience for the very common "pick one of a handful of actions" shape that
 * used to be `showWarningMessage(msg, {modal: true}, "A", "B")`. Returns the id
 * of the chosen action, or undefined when dismissed.
 */
export async function promptAction(
  title: string,
  message: string,
  choices: DialogChoice[],
): Promise<string | undefined> {
  return promptPick({ title, hint: message, choices });
}
