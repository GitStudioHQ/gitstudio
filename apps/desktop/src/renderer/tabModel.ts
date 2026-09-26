// The rules of the repository tab row (issue #32), with no DOM in them, so the
// state table in docs/desktop-repo-tabs.md is testable cell by cell in node.
//
// The row itself is repoTabs.ts; the shell that owns one App per tab is in
// renderer.ts; main's RepoStore holds the same order and decides the same
// "who is active after a close" rule (tested there too).

/** The tab after (dir 1) or before (dir -1) `active`, wrapping at both ends.
 *  Undefined only when there is no tab to go to. */
export function stepTab(order: readonly string[], active: string | undefined, dir: 1 | -1): string | undefined {
  if (!order.length) return undefined;
  const i = active === undefined ? -1 : order.indexOf(active);
  if (i < 0) return order[dir === 1 ? 0 : order.length - 1];
  return order[(i + dir + order.length) % order.length];
}

/**
 * The tab a number key names: 1–8 are the first eight, 9 is always the LAST
 * (a browser's rule — with ten tabs, the tenth is still one key away). A digit
 * past the end names nothing, rather than the last tab by accident.
 */
export function tabAtDigit(order: readonly string[], digit: number): string | undefined {
  if (!Number.isInteger(digit) || digit < 1 || digit > 9 || !order.length) return undefined;
  if (digit === 9) return order[order.length - 1];
  return order[digit - 1];
}

/**
 * Which tab is in front after `closing` closes: the one to its right, else the
 * one to its left. Closing a tab that is NOT in front changes nothing.
 * main/repoStore.ts closeTab applies the same rule to the same list.
 */
export function afterClose(
  order: readonly string[],
  closing: string,
  active: string | undefined,
): string | undefined {
  if (closing !== active) return active;
  const i = order.indexOf(closing);
  if (i < 0) return active;
  const rest = order.filter((r) => r !== closing);
  return rest[i] ?? rest[i - 1];
}

/** What a key press asks of the tab row, if anything. */
export type TabKey =
  | { kind: "next" }
  | { kind: "prev" }
  | { kind: "digit"; n: number }
  | { kind: "close" };

export interface KeyLike {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The tab row's keyboard, read from one key event.
 *
 *  · Ctrl+Tab / Ctrl+Shift+Tab — next / previous, on every platform (browsers,
 *    VS Code, JetBrains all agree), and Ctrl+PageDown / Ctrl+PageUp with them.
 *  · A number: ⌘1–9 already means the rail's views here, so tabs take VS
 *    Code's "open editor at index" chord instead — Ctrl+1–9 on macOS, Alt+1–9
 *    on Windows and Linux (where Ctrl+digit IS the rail).
 *  · ⌘W / Ctrl+W — close the tab in front. In Electron the menu's accelerator
 *    owns it (Repo ▸ Close Tab) and the page never sees the key; the page-level
 *    reading is for a window with no menu bar (the harness).
 */
export function tabKeyAction(e: KeyLike, isMac: boolean): TabKey | undefined {
  if (e.key === "Tab" && e.ctrlKey && !e.metaKey && !e.altKey) {
    return e.shiftKey ? { kind: "prev" } : { kind: "next" };
  }
  if ((e.key === "PageDown" || e.key === "PageUp") && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    return e.key === "PageDown" ? { kind: "next" } : { kind: "prev" };
  }
  // By `code` when there is one: Alt+digit on a Mac keyboard types "¡™£…",
  // and a layout that puts digits on shifted keys still has Digit1…Digit9.
  const digit = /^Digit([1-9])$/.exec(e.code ?? "")?.[1] ?? (/^[1-9]$/.test(e.key) ? e.key : undefined);
  if (digit && !e.shiftKey) {
    const onMac = isMac && e.ctrlKey && !e.metaKey && !e.altKey;
    const offMac = !isMac && e.altKey && !e.ctrlKey && !e.metaKey;
    if (onMac || offMac) return { kind: "digit", n: Number(digit) };
  }
  if ((e.key === "w" || e.key === "W") && !e.shiftKey && !e.altKey) {
    if ((isMac && e.metaKey && !e.ctrlKey) || (!isMac && e.ctrlKey && !e.metaKey)) return { kind: "close" };
  }
  return undefined;
}

/** The quiet change mark a tab wears: "●3", or nothing for a clean tree or a
 *  repository that could not be asked (never "0" — zero is a claim). */
export function changeMark(dirty: number | undefined): string {
  return dirty && dirty > 0 ? `●${dirty}` : "";
}

/** The tab's accessible name, in words — the mark, the spinner and the
 *  struck-through name of a folder that is gone reach nobody using a screen
 *  reader. */
export function tabLabel(
  name: string,
  dirty: number | undefined,
  running: string | undefined,
  gone = false,
): string {
  const parts = [name];
  if (gone) parts.push("folder not found");
  else if (dirty && dirty > 0) parts.push(`${dirty} changed ${dirty === 1 ? "file" : "files"}`);
  if (running) parts.push(`${running} running`);
  return parts.join(", ");
}
