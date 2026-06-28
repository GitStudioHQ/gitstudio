// Terminal autocomplete controller — the IO + UI around the pure engine.
//
// SAFETY CONTRACT (this is why it can't make the terminal worse):
//  • It only ever shows suggestions while the shell is at a prompt (per the OSC
//    133 signal). When a program is running, it is invisible and inert.
//  • It reads what you've typed from the terminal buffer (prompt → cursor); if it
//    can't determine that cleanly, it hides. It never guesses.
//  • It never submits a command. Accepting a suggestion rewrites the *current
//    prompt line only*, via the shell's own line-editing keys (Ctrl+A, Ctrl+K),
//    then types the chosen text — additive, and the user still presses Enter.
//  • Plain Enter is never hijacked unless you've actively arrowed into the list.

import type { IDisposable, Terminal } from "@xterm/xterm";
import { host } from "./bridge";
import { el, glyph, span } from "./ui";
import type { CommandTracking } from "./terminalCommands";
import {
  computeSuggestions,
  looksLikePath,
  parseInput,
  SHELL_BUILTINS,
  type Suggestion,
} from "./terminalCompletion";

const ICON: Record<Suggestion["type"], string> = {
  history: "history",
  command: "terminal",
  builtin: "gear",
  dir: "folder",
  file: "file",
};

export interface AutocompleteOptions {
  /** Write raw data to the PTY. */
  write: (data: string) => void;
}

export class TerminalAutocomplete {
  private readonly disposables: IDisposable[] = [];
  private readonly menu: HTMLElement;
  private items: Suggestion[] = [];
  private selected = -1;
  private open = false;

  /** Absolute buffer position where the current prompt's input begins. */
  private inputStart: { x: number; y: number } | null = null;
  private awaitFirstKey = false;
  private atPrompt = false;
  private pathCmds: string[] = [];
  /** Monotonic id to discard stale async (listDir) results. */
  private reqSeq = 0;
  private rafPending = 0;

  constructor(
    private readonly term: Terminal,
    private readonly tracking: CommandTracking,
    private readonly opts: AutocompleteOptions,
    private readonly container: HTMLElement,
  ) {
    this.menu = el("div", "term-ac");
    this.menu.style.display = "none";
    this.container.appendChild(this.menu);
  }

  attach(): void {
    void host.invoke("terminal:pathCommands", undefined).then((c) => {
      this.pathCmds = c ?? [];
    });
    this.disposables.push(
      this.term.onData((d) => this.onData(d)),
      this.term.onCursorMove(() => this.scheduleRefresh()),
    );
  }

  /** Called by the panel when the shell enters/leaves a prompt. */
  onPromptChange(atPrompt: boolean): void {
    this.atPrompt = atPrompt;
    if (atPrompt) {
      this.awaitFirstKey = true;
      this.inputStart = null;
    } else {
      this.close();
    }
  }

  // ── Input tracking ────────────────────────────────────────────────────────────

  private onData(d: string): void {
    // Capture where input begins: at the first printable key after a fresh
    // prompt, the cursor sits exactly at the input start (echo hasn't happened).
    if (this.awaitFirstKey && this.atPrompt && isPrintable(d)) {
      const buf = this.term.buffer.active;
      this.inputStart = { x: buf.cursorX, y: buf.baseY + buf.cursorY };
      this.awaitFirstKey = false;
    }
  }

  private scheduleRefresh(): void {
    if (this.rafPending) return;
    this.rafPending = requestAnimationFrame(() => {
      this.rafPending = 0;
      void this.refresh();
    });
  }

  /** Read the typed text between the input start and the cursor, or null. */
  private readTyped(): string | null {
    if (!this.inputStart) return null;
    const buf = this.term.buffer.active;
    const curY = buf.baseY + buf.cursorY;
    const curX = buf.cursorX;
    const start = this.inputStart;
    if (curY < start.y) return null; // cursor moved above the prompt → bail
    if (curY === start.y) {
      if (curX < start.x) return null; // deleted into the prompt → bail
      return buf.getLine(curY)?.translateToString(false, start.x, curX) ?? null;
    }
    // Multi-line input (wrapped or continuation): concatenate the rows.
    let s = buf.getLine(start.y)?.translateToString(false, start.x) ?? "";
    for (let y = start.y + 1; y < curY; y++) {
      s += buf.getLine(y)?.translateToString(false) ?? "";
    }
    s += buf.getLine(curY)?.translateToString(false, 0, curX) ?? "";
    return s;
  }

  private async refresh(): Promise<void> {
    if (!this.atPrompt || !this.inputStart) return this.close();
    const line = this.readTyped();
    if (line === null || line.trim() === "") return this.close();

    const parsed = parseInput(line);
    const reqId = ++this.reqSeq;
    let dirEntries: { name: string; isDir: boolean }[] = [];
    if (!parsed.isCommandPos || looksLikePath(parsed.token)) {
      dirEntries = await host
        .invoke("terminal:listDir", { cwd: this.tracking.currentCwd(), dir: parsed.dirPart })
        .catch(() => []);
      if (reqId !== this.reqSeq) return; // superseded by newer keystrokes
    }

    const items = computeSuggestions(parsed, {
      history: this.tracking.history(),
      pathCommands: this.pathCmds,
      builtins: SHELL_BUILTINS,
      dirEntries,
    });
    if (!items.length) return this.close();

    this.items = items;
    if (this.selected >= items.length) this.selected = items.length - 1;
    this.render();
    this.position();
    this.open = true;
    this.menu.style.display = "";
  }

  // ── Keyboard (called from the panel's custom key handler) ────────────────────

  /** Handle a key; returns true if consumed (so it must not reach the PTY). */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.open || e.type !== "keydown") return false;
    if (e.metaKey || e.ctrlKey || e.altKey) return false; // leave shortcuts alone
    switch (e.key) {
      case "ArrowDown":
        this.move(1);
        return true;
      case "ArrowUp":
        this.move(-1);
        return true;
      case "Tab":
        this.accept(this.items[Math.max(0, this.selected)]);
        return true;
      case "Enter":
        if (this.selected >= 0) {
          this.accept(this.items[this.selected]);
          return true;
        }
        this.close(); // nothing highlighted → let Enter run the command
        return false;
      case "Escape":
        this.close();
        return true;
      default:
        return false; // typing/backspace pass through; cursor-move re-refreshes
    }
  }

  private move(dir: 1 | -1): void {
    const n = this.items.length;
    if (!n) return;
    this.selected = this.selected < 0 ? (dir > 0 ? 0 : n - 1) : (this.selected + dir + n) % n;
    this.render();
  }

  private accept(s: Suggestion | undefined): void {
    if (!s) return;
    const line = this.readTyped();
    if (line === null) return this.close();
    const parsed = parseInput(line);
    const finalLine =
      s.scope === "line"
        ? s.replacement
        : line.slice(0, line.length - parsed.token.length) + s.replacement;
    // Ctrl+A (line start), Ctrl+K (kill to end), then the rewritten line. This
    // replaces only the current prompt line; the user still presses Enter to run.
    this.opts.write("\x01\x0b" + finalLine);
    this.close();
  }

  private close(): void {
    if (!this.open && this.menu.style.display === "none") {
      this.selected = -1;
      return;
    }
    this.open = false;
    this.selected = -1;
    this.menu.style.display = "none";
    this.menu.replaceChildren();
  }

  // ── Rendering / positioning ───────────────────────────────────────────────────

  private render(): void {
    this.menu.replaceChildren();
    this.items.forEach((s, i) => {
      const row = el("div", "term-ac-row" + (i === this.selected ? " is-active" : ""));
      row.append(glyph(ICON[s.type]));
      row.appendChild(highlight(s.label, s.indices));
      if (s.detail) row.appendChild(span(s.detail, "term-ac-detail"));
      row.addEventListener("mousedown", (ev) => {
        ev.preventDefault(); // keep terminal focus
        this.accept(s);
        this.term.focus();
      });
      row.addEventListener("mouseenter", () => {
        this.selected = i;
        this.render();
      });
      this.menu.appendChild(row);
    });
    const active = this.menu.children[this.selected] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }

  private position(): void {
    const buf = this.term.buffer.active;
    const rows = this.container.querySelector<HTMLElement>(".xterm-rows");
    const cw = rows && this.term.cols ? rows.clientWidth / this.term.cols : 8;
    const ch = rows && this.term.rows ? rows.clientHeight / this.term.rows : 17;
    const padL = 20;
    const padT = 6;
    const x = padL + buf.cursorX * cw;
    const yBelow = padT + (buf.cursorY + 1) * ch;
    const maxH = 280;
    const surfaceH = this.container.clientHeight;
    // Flip above the cursor when there isn't room below.
    const flip = yBelow + maxH > surfaceH && buf.cursorY * ch > surfaceH - yBelow;
    this.menu.style.left = `${Math.max(4, Math.min(x, this.container.clientWidth - 320))}px`;
    if (flip) {
      this.menu.style.bottom = `${surfaceH - (padT + buf.cursorY * ch)}px`;
      this.menu.style.top = "auto";
    } else {
      this.menu.style.top = `${yBelow}px`;
      this.menu.style.bottom = "auto";
    }
  }

  isOpen(): boolean {
    return this.open;
  }

  dispose(): void {
    if (this.rafPending) cancelAnimationFrame(this.rafPending);
    for (const d of this.disposables) d.dispose();
    this.menu.remove();
  }
}

function isPrintable(d: string): boolean {
  // A single non-control character (ignore arrows, ctrl-keys, escape sequences).
  return d.length === 1 && d >= " " && d !== "\x7f";
}

/** Build a label element with the matched characters emphasised. */
function highlight(label: string, indices: number[]): HTMLElement {
  const wrap = el("span", "term-ac-label");
  const set = new Set(indices);
  let run = "";
  let runMatch = false;
  const flush = (): void => {
    if (!run) return;
    if (runMatch) {
      const b = el("b", "term-ac-hit");
      b.textContent = run;
      wrap.appendChild(b);
    } else {
      wrap.appendChild(document.createTextNode(run));
    }
    run = "";
  };
  for (let i = 0; i < label.length; i++) {
    const m = set.has(i);
    if (m !== runMatch) {
      flush();
      runMatch = m;
    }
    run += label[i];
  }
  flush();
  return wrap;
}
