// Undo — for the things that are not text.
//
// Every editor on this machine undoes a typo with ⌘Z, and this app used to
// undo nothing: stop tracking a folder, forget a repository, move a clone to
// the Trash, change where clones land — all of it one click, no confirmation
// on most, and no way back. The toast said what had happened, which is not the
// same as being able to change your mind about it.
//
// So: a stack. An action that can be reversed registers how, and gets two
// ways back — the Undo button on its own toast, right where you are looking,
// and ⌘Z (Ctrl+Z) from anywhere, for the case where the toast has gone.
//
// Rules that keep this honest:
//
//   • Only register an undo you can actually perform. Undo that reports
//     success and restores nothing is worse than no undo at all, so
//     `repos:trash` registers one only when the app established where the
//     folder landed, and the main process refuses to overwrite anything that
//     has taken its place since.
//   • The undo runs and then says what it did. If it fails, it says that
//     instead, and stays on the stack for a second try only when retrying
//     could work.
//   • Text keeps its own undo. ⌘Z inside an input, a textarea, a
//     contenteditable or Monaco is the editor's, never ours.
//   • Except inside the MERGE editor. There ⌘Z is the merge's own history
//     (accept, ignore, apply-all, reset…), and a text undo would desync it
//     from the blocks it tracks. The shell registers itself here, and every
//     route ⌘Z can take — the key, the Edit menu, both — ends in it once.

import { toast } from "./dialogs";

export interface Undoable {
  /** What happens if you undo, in the imperative — "Restore ~/work". */
  label: string;
  /** Perform the reversal. Throw or return a message to report a failure. */
  undo: () => Promise<string | void> | string | void;
  /** Redraw whatever was showing the changed state. */
  after?: () => Promise<void> | void;
}

/** Deepest first. Small on purpose: this is "I didn't mean that", not history. */
const stack: Undoable[] = [];
const LIMIT = 20;

/**
 * Record a reversible action, tell the user what happened, and offer Undo on
 * the toast. Everything destructive on the repositories screen goes through
 * here, so none of it can ship without a way back.
 */
export function didUndoable(message: string, action: Undoable): void {
  push(action);
  toast(message, "success", undefined, {
    label: "Undo",
    onClick: () => void run(action),
  });
}

export function push(action: Undoable): void {
  stack.push(action);
  if (stack.length > LIMIT) stack.shift();
}

/** Undo the most recent action. Returns false when there was nothing to undo. */
export async function undoLast(): Promise<boolean> {
  const action = stack.pop();
  if (!action) {
    toast("Nothing to undo.", "info");
    return false;
  }
  await run(action);
  return true;
}

/** How many reversals are waiting — the harness asserts on this. */
export function undoDepth(): number {
  return stack.length;
}

/**
 * Drop everything pending.
 *
 * Called when the open repository changes: an undo is a promise about a
 * specific repository, and "restore the branch I deleted" carried into a
 * different one would CREATE a branch nobody asked for. Nothing on this stack
 * is worth that, so switching repositories forgets it.
 */
export function clearUndo(): void {
  stack.length = 0;
}

async function run(action: Undoable): Promise<void> {
  // Whichever way it was triggered — the toast button or ⌘Z — it happens once.
  const at = stack.indexOf(action);
  if (at >= 0) stack.splice(at, 1);
  try {
    const failure = await action.undo();
    if (typeof failure === "string" && failure) {
      toast(failure, "error");
      return;
    }
  } catch (e) {
    toast(e instanceof Error ? e.message : "Couldn't undo that.", "error");
    return;
  }
  await action.after?.();
  toast(`Undone — ${lower(action.label)}.`, "success");
}

function lower(s: string): string {
  // "Restore ~/work" reads wrong after an em dash; "restore ~/work" reads
  // right. Only the first letter, and only when it isn't a name or a path.
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

/** A mounted merge editor: what ⌘Z and ⇧⌘Z mean while focus is inside it. */
export interface MergeHistoryTarget {
  /** The shell's root (it carries `data-merge-surface`). */
  root: HTMLElement;
  undo(): void;
  redo(): void;
}

const mergeTargets = new Set<MergeHistoryTarget>();

/**
 * Route ⌘Z to a merge editor while focus is inside `target.root`. Returns the
 * unregister. The desktop's Edit ▸ Undo is a MENU accelerator — it reaches
 * the renderer as `menu:command`, not as a key — so without this the menu's
 * copy of ⌘Z in the merge editor fell through to `document.execCommand("undo")`,
 * a text undo underneath the merge's own history.
 */
export function registerMergeHistory(target: MergeHistoryTarget): () => void {
  mergeTargets.add(target);
  return () => {
    mergeTargets.delete(target);
  };
}

/** The merge editor that owns this node's keystrokes, if it is inside one. */
export function mergeHistoryFor(node: EventTarget | null): MergeHistoryTarget | undefined {
  const el = node as Node | null;
  if (!el || typeof el.nodeType !== "number") return undefined;
  for (const t of mergeTargets) {
    if (t.root.isConnected && t.root.contains(el)) return t;
  }
  return undefined;
}

/** True when the keystroke belongs to whatever is being typed into. */
function inTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.closest) return false;
  if (el.isContentEditable) return true;
  if (el.closest(".monaco-editor")) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

let installed = false;

/**
 * Bind ⌘Z / Ctrl+Z. Idempotent — the renderer calls it once at start-up.
 *
 * Only outside Electron. In the packaged app the Edit menu owns the
 * accelerator and calls `undoOrText`, and a page handler as well would undo
 * TWO things per keypress. The harness has no menu bar, so there the page must
 * own the key or none of this could be tested.
 */
export function installUndoKey(): void {
  if (installed) return;
  installed = true;
  if (/Electron\//.test(navigator.userAgent)) return;
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "z" && e.key !== "Z") return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.shiftKey) return; // ⇧⌘Z is redo, which this stack does not do
      // Inside the merge editor the shell's own key handler owns ⌘Z.
      if (mergeHistoryFor(e.target)) return;
      if (inTextField(e.target)) return;
      // Nothing on the stack: let the platform have the keystroke rather than
      // swallowing it and looking broken.
      if (!stack.length) return;
      e.preventDefault();
      void undoLast();
    },
    // Capture, so a view that stops propagation on its own keydown can't
    // silently take ⌘Z away from the whole app.
    true,
  );
}

/**
 * What ⌘Z means, decided at the moment it is pressed.
 *
 * The Edit menu hands the keystroke here rather than to Electron's `undo`
 * role, because that role can only ever undo typing — with it bound, undoing
 * a deleted repository from the keyboard was impossible. So: our stack first,
 * and the text undo it replaced when the stack is empty, which keeps ⌘Z doing
 * what it always did inside a commit message.
 */
export async function undoOrText(): Promise<void> {
  // Focus inside the merge editor: the merge's history, and nothing else —
  // not a repository deletion further down the app's stack, and not a text
  // undo under the merge's feet. The shell de-duplicates a keypress that
  // ALSO reached it as a key, so one press is one undo either way.
  const merge = mergeHistoryFor(document.activeElement);
  if (merge) {
    merge.undo();
    return;
  }
  // A menu accelerator fires wherever the focus is, so this has to make the
  // same judgement the key handler makes: mid-sentence in a commit message,
  // ⌘Z is the sentence's, even with a deleted repository on the stack.
  if (!inTextField(document.activeElement) && undoDepth()) {
    await undoLast();
    return;
  }
  document.execCommand?.("undo");
}

/**
 * ⇧⌘Z, decided the same way: the merge editor's redo while focus is inside
 * it, the text redo otherwise. The Edit menu's Redo sends
 * `menu:command { command: "redo" }` the way Undo sends undo — it used to be
 * Electron's `role: "redo"`, a text redo underneath the merge's history.
 */
export function redoOrText(): void {
  const merge = mergeHistoryFor(document.activeElement);
  if (merge) {
    merge.redo();
    return;
  }
  document.execCommand?.("redo");
}
