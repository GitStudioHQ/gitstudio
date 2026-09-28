// Moves through GitStudio's UI the way a person would, for shots.ts and
// hero.ts: palette commands, the side bar and its views, the panel, files.

import { Workbench, sleep, jsLiteral, type Rect, type Webview } from "./vscode";

/** A resting place for the pointer: the empty title bar, left of the command centre. */
export const REST = { x: 300, y: 17 };

export async function changesView(wb: Workbench): Promise<Webview> {
  return wb.webview(`D.querySelector('.changes-toolbar')`);
}

export async function graphView(wb: Workbench): Promise<Webview> {
  return wb.webview(`D.querySelector('.gs-graph-pane') && Q('.row').length > 5`);
}

export const rowBySubject = (s: string) =>
  `Q('.row').find((r) => (r.querySelector('.subject')?.textContent || '').trim() === ${jsLiteral(s)})`;

export async function sidebarShown(wb: Workbench): Promise<boolean> {
  return !!(await wb.rect(".part.sidebar"));
}

/** GitStudio's side bar on screen, or no side bar at all. */
export async function showSidebar(wb: Workbench, show: boolean): Promise<void> {
  if (show) {
    const ours = await wb.eval<boolean>(
      `!!document.querySelector('.part.sidebar') && document.querySelector('.part.sidebar').getBoundingClientRect().width > 0 && /GitStudio/.test(document.querySelector('.part.sidebar .composite.title')?.textContent || '')`,
    );
    if (ours) return;
    await wb.command("View: Show GitStudio");
  } else {
    if (!(await sidebarShown(wb))) return;
    await wb.command("View: Close Primary Side Bar");
  }
  await sleep(700);
}

/** Only `title` open among GitStudio's views. */
export async function onlyPane(wb: Workbench, title: string): Promise<void> {
  for (const t of ["Changes", "Commits", "Worktrees", "Pull Requests"]) if (t !== title) await wb.setPane(t, false);
  await wb.setPane(title, true);
  await sleep(600);
}

/** Whether the panel fills the editor area (it is then taller than half the window). */
export async function panelMaximized(wb: Workbench): Promise<boolean> {
  return wb.eval<boolean>(
    `(() => { const p = document.querySelector('.part.panel'); if (!p) return false; const r = p.getBoundingClientRect(); return r.height > innerHeight * 0.6; })()`,
  );
}

export async function maximizePanel(wb: Workbench, on: boolean): Promise<void> {
  for (let i = 0; i < 3 && (await panelMaximized(wb)) !== on; i++) {
    await wb.command("View: Toggle Maximized Panel");
    await sleep(700);
  }
  if ((await panelMaximized(wb)) !== on) throw new Error(`the panel would not ${on ? "maximize" : "restore"}`);
}

export async function openFile(wb: Workbench, path: string): Promise<void> {
  await wb.command("Go to File...");
  await wb.type(path);
  await sleep(700);
  await wb.key("Enter", "Enter", 13);
  await wb.waitFor(
    `[...document.querySelectorAll('.tabs-container .tab.active')].some((t) => (t.getAttribute('aria-label') || '').startsWith(${jsLiteral(path.split("/").pop()!)}))`,
    10_000,
    `${path} open`,
  );
  await sleep(800);
}

/** The editor line holding `text` (workbench CSS px). */
export async function editorLine(wb: Workbench, text: string): Promise<Rect> {
  const r = await wb.eval<Rect | null>(
    // Monaco draws spaces as no-break spaces.
    `(() => { const l = [...document.querySelectorAll('.editor-instance .view-line')].find((l) => l.textContent.replace(/\\u00a0/g, ' ').includes(${jsLiteral(text)})); if (!l) return null; const r = l.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`,
  );
  if (!r) throw new Error(`no editor line with ${text}`);
  return r;
}

/** GitStudio's blame annotations on or off for the active editor, with its title-bar toggle. */
export async function setBlame(wb: Workbench, on: boolean): Promise<void> {
  // The annotations are drawn with CSS: each line's starts with its date.
  const shown = async () => /\b20\d\d-\d\d-\d\d\b/.test(await wb.decorationText());
  if ((await shown()) === on) return;
  await wb.clickAction(".editor-actions", "Annotate with Git Blame");
  const until = Date.now() + 10_000;
  while ((await shown()) !== on) {
    if (Date.now() > until) throw new Error(`blame annotations would not turn ${on ? "on" : "off"}`);
    await sleep(200);
  }
  await sleep(400);
}

/** The Commit Graph in the panel; maximized unless told otherwise. */
export async function openGraph(wb: Workbench, maximize = true): Promise<Webview> {
  await wb.command("GitStudio: Show Commit Graph");
  const g = await graphView(wb);
  await sleep(500);
  if (maximize) await maximizePanel(wb, true);
  await sleep(700);
  return g;
}

/** Everything back to a plain window: no editors, no panel, no popups, no notifications. */
export async function reset(wb: Workbench): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await wb.key("Escape", "Escape", 27);
    await sleep(150);
  }
  await wb.move(REST.x, REST.y);
  await wb.command("View: Close All Editors");
  if (await wb.rect(".part.panel")) {
    await maximizePanel(wb, false);
    await wb.command("View: Toggle Panel Visibility");
  }
  await wb.command("Notifications: Clear All Notifications");
  await showSidebar(wb, true);
}

/**
 * Waits (up to 8 s, then goes on) until VS Code's own Source Control badge in
 * the activity bar shows a count again: after a stage it spins while the
 * built-in git extension re-reads the repository.
 */
export async function scmSettled(wb: Workbench): Promise<void> {
  await wb
    .waitFor(
      `(() => { const a = [...document.querySelectorAll('.activitybar .action-item')].find((i) => (i.querySelector('.action-label')?.getAttribute('aria-label') || '').startsWith('Source Control')); const b = a && a.querySelector('.badge'); return !b || /^\\d+$/.test((b.textContent || '').trim()); })()`,
      8_000,
      "the Source Control badge",
    )
    .catch(() => undefined);
  await sleep(300);
}

/**
 * Where the last of `rows` (an expression over Q yielding elements) ends in
 * `view`'s page, plus `margin`: a workbench y to crop a side-bar shot at, so
 * it shows the view and not the empty space under its content.
 */
export async function contentBottom(view: Webview, rows: string, margin = 14): Promise<number> {
  const f = await view.frame();
  const b = await view.eval<number>(`Math.max(0, ...(${rows}).map((e) => e.getBoundingClientRect().bottom))`);
  if (!b) throw new Error(`no content to crop to: ${rows}`);
  return Math.min(f.y + f.h, f.y + b + margin);
}

/**
 * The activity bar and the side bar, from under the title bar down to
 * `bottom` (a workbench y) or the status bar.
 */
export async function sidebarClip(wb: Workbench, bottom?: number): Promise<Rect> {
  const sb = await wb.rect(".part.sidebar");
  const title = await wb.rect(".part.titlebar");
  const status = await wb.rect(".part.statusbar");
  if (!sb || !title || !status) throw new Error("no side bar to crop to");
  const end = Math.min(status.y, bottom ?? status.y);
  return { x: 0, y: title.h, w: Math.round(sb.x + sb.w), h: Math.round(end - title.h) };
}
