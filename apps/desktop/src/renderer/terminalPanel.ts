// Integrated terminal — an xterm.js surface wired to the main-process PTY over
// the terminal:* IPC channels.
//
// CONTRACT (keep these signatures — renderer.ts mounts this):
//  • new TerminalPanel(container): owns an xterm Terminal + FitAddon inside
//    `container`, themed from the app's CSS tokens (re-themeable via applyTheme).
//  • open(): create a PTY session (terminal:create with the measured grid),
//    subscribe to terminal:data/exit, pipe xterm onData → terminal:write, and
//    fit. Safe to call once.
//  • layout(): re-fit + terminal:resize after a container resize.
//  • focus(): focus the xterm textarea.
//  • applyTheme(): re-read the CSS-token theme (on light/dark flips).
//  • dispose(): kill the session, dispose xterm, drop listeners.

import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { host } from "./bridge";

/** Read a CSS custom property off <body>, falling back to `fallback`. */
function token(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = styles.getPropertyValue(name).trim();
  return v || fallback;
}

export class TerminalPanel {
  private term: Terminal | null = null;
  private fit: FitAddon | null = null;
  /** The PTY session id from terminal:create, once open. */
  private id: string | null = null;
  /** Unsubscribe handles for the host.on subscriptions. */
  private offData: (() => void) | null = null;
  private offExit: (() => void) | null = null;
  /** Set by dispose() so an in-flight open() can bail out (and not leak the PTY). */
  private disposed = false;

  constructor(private readonly container: HTMLElement) {}

  /**
   * Build an xterm ITheme from the app's CSS tokens: background / foreground /
   * cursor / selection track the live theme; the 16 ANSI colors are a tasteful
   * fixed palette that reads well on both the dark and light editor surfaces.
   */
  private themeFromTokens(): ITheme {
    const styles = getComputedStyle(document.body);
    const background = token(styles, "--vscode-editor-background", "#12151c");
    const foreground = token(styles, "--vscode-editor-foreground", "#d7dae0");
    const cursor = token(styles, "--gs-accent", "#7c5cf0");
    const selectionBackground = token(
      styles,
      "--vscode-editor-selectionBackground",
      "#2a3a5a",
    );
    return {
      background,
      foreground,
      cursor,
      cursorAccent: background,
      selectionBackground,
      black: "#1c2029",
      red: "#ff6b6b",
      green: "#5ad48a",
      yellow: "#e8c468",
      blue: "#4aa5ff",
      magenta: "#c792ea",
      cyan: "#54c7d4",
      white: "#cdd2da",
      brightBlack: "#5a6273",
      brightRed: "#ff8585",
      brightGreen: "#7fe3a6",
      brightYellow: "#f2d489",
      brightBlue: "#74bcff",
      brightMagenta: "#d9b0f5",
      brightCyan: "#7fe0eb",
      brightWhite: "#f4f6fa",
    };
  }

  /** Create the PTY session and wire xterm ⇄ host. Safe to call once. */
  async open(): Promise<void> {
    if (this.term) {
      return;
    }

    const styles = getComputedStyle(document.body);
    const fontFamily = token(
      styles,
      "--vscode-editor-font-family",
      "ui-monospace, Menlo, monospace",
    );

    const term = new Terminal({
      fontFamily,
      fontSize: 12.5,
      cursorBlink: true,
      theme: this.themeFromTokens(),
      allowProposedApi: true,
      scrollback: 5000,
    });
    this.term = term;

    const fit = new FitAddon();
    this.fit = fit;
    term.loadAddon(fit);

    term.open(this.container);
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        /* container not laid out yet — layout() will retry */
      }
    });

    const session = await host.invoke("terminal:create", {
      cols: term.cols,
      rows: term.rows,
    });
    // dispose() may have run while terminal:create was in flight: bail out and
    // kill the just-created session so the backend PTY (and listeners) don't leak.
    if (this.disposed) {
      if (session) {
        void host.invoke("terminal:kill", { id: session.id });
      }
      return;
    }
    if (!session) {
      // Friendly degradation: no PTY backend (e.g. node-pty missing).
      term.write("\x1b[31mCould not start a terminal session.\x1b[0m\r\n");
      return;
    }
    this.id = session.id;

    this.offData = host.on("terminal:data", (m) => {
      if (m.id === this.id) {
        term.write(m.data);
      }
    });
    this.offExit = host.on("terminal:exit", (m) => {
      if (m.id === this.id) {
        term.write("\r\n[process exited]\r\n");
      }
    });

    term.onData((d) => {
      void host.invoke("terminal:write", { id: this.id!, data: d });
    });
  }

  /** Re-fit to the container and tell the PTY about the new grid. */
  layout(): void {
    const term = this.term;
    const fit = this.fit;
    if (!term || !fit) {
      return;
    }
    try {
      fit.fit();
      if (this.id) {
        void host.invoke("terminal:resize", {
          id: this.id,
          cols: term.cols,
          rows: term.rows,
        });
      }
    } catch {
      /* container hidden/zero-sized — ignore until the next layout() */
    }
  }

  /** Focus the xterm textarea. */
  focus(): void {
    this.term?.focus();
  }

  /** Re-read the CSS-token theme (on light/dark flips). */
  applyTheme(): void {
    if (this.term) {
      this.term.options.theme = this.themeFromTokens();
    }
  }

  /** Kill the session, dispose xterm, drop listeners. */
  dispose(): void {
    this.disposed = true;
    this.offData?.();
    this.offExit?.();
    this.offData = null;
    this.offExit = null;
    if (this.id) {
      void host.invoke("terminal:kill", { id: this.id });
    }
    this.id = null;
    this.term?.dispose();
    this.term = null;
    this.fit = null;
  }
}
