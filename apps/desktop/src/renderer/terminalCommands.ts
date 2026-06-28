// Command "blocks" for the integrated terminal.
//
// Reads the OSC 133/633 markers the shell emits (see main/shellIntegration.ts)
// and builds a live model of every command: its text, cwd, exit code, timing,
// and the buffer region it produced. From that model we draw a status dot in the
// terminal's left gutter per command, let the user jump between commands, and
// copy a command's text or its full output, or re-run it. This is the Warp-style
// usability layer, implemented entirely on top of xterm.js.

import type { IDecoration, IDisposable, IMarker, Terminal } from "@xterm/xterm";

export interface TermCommand {
  id: number;
  /** The command line as typed (from OSC 633;E), if known. */
  commandLine: string;
  /** Working directory when the command ran (from OSC 633;P), if known. */
  cwd?: string;
  /** Process exit code once finished (from OSC 133;D). */
  exitCode?: number;
  state: "running" | "done";
  startedAt: number;
  endedAt?: number;
  /** Marker at the prompt/command line — anchors the gutter dot + navigation. */
  promptMarker?: IMarker;
  /** Marker at the first line of output — anchors copy-output extraction. */
  outputMarker?: IMarker;
  decoration?: IDecoration;
}

export interface CommandTrackingOptions {
  /** Write raw data to the PTY (used by re-run). */
  write: (data: string) => void;
  /** Fired whenever the command list or selection changes (drives the toolbar). */
  onChange?: () => void;
}

export class CommandTracking {
  private readonly cmds: TermCommand[] = [];
  /** The command currently being assembled between prompts. */
  private pending?: TermCommand;
  private seq = 0;
  private selectedId = -1;
  private readonly disposables: IDisposable[] = [];

  constructor(
    private readonly term: Terminal,
    private readonly opts: CommandTrackingOptions,
  ) {}

  /** Register the OSC handlers. Call once, after term.open(). */
  attach(): void {
    this.disposables.push(
      this.term.parser.registerOscHandler(133, (data) => this.onFinalTerm(data)),
      this.term.parser.registerOscHandler(633, (data) => this.onVscode(data)),
    );
  }

  // ── OSC parsing ─────────────────────────────────────────────────────────────

  /** OSC 133 ; A | C | D[;code] — prompt start / output start / command done. */
  private onFinalTerm(data: string): boolean {
    const kind = data[0];
    if (kind === "A") {
      // A pending command that never ran (empty prompt, redraw) leaks its marker.
      if (this.pending && !this.pending.outputMarker) {
        this.pending.promptMarker?.dispose();
      }
      // New prompt boundary: open a fresh pending command anchored here.
      this.pending = {
        id: ++this.seq,
        commandLine: "",
        state: "running",
        startedAt: Date.now(),
        promptMarker: this.term.registerMarker(0) ?? undefined,
      };
    } else if (kind === "C") {
      // Output begins — mark it and surface the command as running.
      const c = this.pending;
      if (c) {
        c.outputMarker = this.term.registerMarker(0) ?? undefined;
        c.startedAt = Date.now();
        if (!this.cmds.includes(c)) this.cmds.push(c);
        this.decorate(c);
        this.emit();
      }
    } else if (kind === "D") {
      // Command finished with an exit code.
      const code = data.length > 2 ? Number.parseInt(data.slice(2), 10) : 0;
      const c = this.pending ?? this.cmds[this.cmds.length - 1];
      if (c) {
        c.exitCode = Number.isFinite(code) ? code : 0;
        c.state = "done";
        c.endedAt = Date.now();
        if (!this.cmds.includes(c)) this.cmds.push(c);
        this.decorate(c);
        this.applyDotState(c);
        this.emit();
      }
      this.pending = undefined;
    }
    return true;
  }

  /** OSC 633 ; E ; <cmdline>  |  P ; Cwd=<path> — command text / cwd. */
  private onVscode(data: string): boolean {
    if (data.startsWith("E;")) {
      if (this.pending) this.pending.commandLine = data.slice(2);
    } else if (data.startsWith("P;Cwd=")) {
      if (this.pending) this.pending.cwd = data.slice(6);
    }
    return true;
  }

  // ── Gutter decorations ───────────────────────────────────────────────────────

  private decorate(c: TermCommand): void {
    if (c.decoration || !c.promptMarker || c.promptMarker.line < 0) return;
    const dec = this.term.registerDecoration({ marker: c.promptMarker, x: 0, width: 1 });
    if (!dec) return;
    c.decoration = dec;
    dec.onRender(() => this.applyDotState(c));
  }

  /** Reflect a command's state (running / ok / error / selected) onto its dot. */
  private applyDotState(c: TermCommand): void {
    const el = c.decoration?.element;
    if (!el) return;
    const status =
      c.state === "running" ? "running" : (c.exitCode ?? 0) === 0 ? "ok" : "error";
    el.className = `term-cmd-dot is-${status}` + (c.id === this.selectedId ? " is-selected" : "");
    el.title =
      (c.commandLine || "(command)") +
      (c.state === "done" ? `  ·  exit ${c.exitCode ?? 0}${this.durationOf(c)}` : "  ·  running…");
  }

  private durationOf(c: TermCommand): string {
    if (!c.endedAt) return "";
    const ms = c.endedAt - c.startedAt;
    if (ms < 1000) return `  ·  ${ms}ms`;
    return `  ·  ${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  }

  // ── Navigation ───────────────────────────────────────────────────────────────

  /** Commands that still have a live anchor in the buffer. */
  private navigable(): TermCommand[] {
    return this.cmds.filter((c) => c.promptMarker && c.promptMarker.line >= 0);
  }

  selectPrev(): void {
    this.step(-1);
  }
  selectNext(): void {
    this.step(1);
  }

  private step(dir: 1 | -1): void {
    const list = this.navigable();
    if (!list.length) return;
    let idx = list.findIndex((c) => c.id === this.selectedId);
    if (idx < 0) idx = dir < 0 ? list.length : -1;
    idx = Math.min(list.length - 1, Math.max(0, idx + dir));
    this.select(list[idx]);
  }

  select(c: TermCommand | undefined): void {
    if (!c?.promptMarker) return;
    const prev = this.cmds.find((x) => x.id === this.selectedId);
    this.selectedId = c.id;
    if (prev) this.applyDotState(prev);
    this.applyDotState(c);
    this.term.scrollToLine(Math.max(0, c.promptMarker.line - 1));
    this.emit();
  }

  selected(): TermCommand | undefined {
    return this.cmds.find((c) => c.id === this.selectedId);
  }

  hasCommands(): boolean {
    return this.navigable().length > 0;
  }

  /** The tracked commands, oldest first (read-only view). */
  commands(): readonly TermCommand[] {
    return this.cmds;
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  async copyCommand(c = this.selected()): Promise<void> {
    if (c?.commandLine) await writeClipboard(c.commandLine);
  }

  async copyOutput(c = this.selected()): Promise<void> {
    const text = this.outputText(c);
    if (text) await writeClipboard(text);
  }

  rerun(c = this.selected()): void {
    if (c?.commandLine) this.opts.write(c.commandLine + "\r");
  }

  /** The buffer text a command produced (output start → next prompt / end). */
  private outputText(c = this.selected()): string {
    if (!c?.outputMarker || c.outputMarker.line < 0) return "";
    const buf = this.term.buffer.active;
    const start = c.outputMarker.line;
    const idx = this.cmds.indexOf(c);
    const next = this.cmds[idx + 1];
    const end =
      next?.promptMarker && next.promptMarker.line >= 0
        ? next.promptMarker.line
        : buf.length;
    const lines: string[] = [];
    for (let i = start; i < end && i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n").replace(/\n+$/, "");
  }

  private emit(): void {
    this.opts.onChange?.();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const c of this.cmds) {
      c.decoration?.dispose();
      c.promptMarker?.dispose();
      c.outputMarker?.dispose();
    }
    this.cmds.length = 0;
    this.pending = undefined;
  }
}

/** Best-effort clipboard write (Electron renderer secure context). */
async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard unavailable — ignore */
  }
}
