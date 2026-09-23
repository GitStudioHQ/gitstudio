// A windowless browser and a minimal DevTools-protocol client — enough to load
// a page, drive it, wait for Monaco to paint on a REAL clock (no virtual-time
// budget, which starves Monaco's rAF paint), and take a screenshot.
//
// The browser is Playwright's chrome-headless-shell, from GS_CHROME or its
// usual cache path — NEVER /Applications/Google Chrome.app, whose windows
// flash on the owner's screen (memory: headless-tests-never-drive-users-chrome).

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const HEADLESS_SHELL = join(
  homedir(),
  "Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell",
);

/** The windowless browser to drive, or a reason there is none. */
export function findHeadlessChrome(): string {
  const p = process.env.GS_CHROME || HEADLESS_SHELL;
  if (/Google Chrome\.app/.test(p)) {
    throw new Error(`refusing ${p}: use chrome-headless-shell (GS_CHROME), never the desktop Chrome`);
  }
  if (!existsSync(p)) throw new Error(`no headless browser at ${p} — set GS_CHROME to chrome-headless-shell`);
  return p;
}

type Listener = (params: Record<string, unknown>) => void;

export class Page {
  private id = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Map<string, Listener[]>();
  /** Uncaught exceptions and console errors the page produced. */
  readonly errors: string[] = [];

  constructor(
    private readonly ws: WebSocket,
    private readonly sessionId: string,
  ) {}

  /** Called by Browser for every message addressed to this session. */
  dispatch(msg: {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: { message: string };
  }): void {
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) for (const l of this.listeners.get(msg.method) ?? []) l(msg.params ?? {});
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id + 1_000_000;
    this.ws.send(JSON.stringify({ id, method, params, sessionId: this.sessionId }));
    return new Promise<T>((resolve, reject) =>
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }),
    );
  }

  on(method: string, l: Listener): void {
    const list = this.listeners.get(method) ?? [];
    list.push(l);
    this.listeners.set(method, list);
  }

  /** Evaluate an expression (awaited) and return its JSON value. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{
      result: { value?: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value as T;
  }

  /** Poll `predicate` (an expression) until it is truthy, or throw after `timeoutMs`. */
  async waitFor(predicate: string, timeoutMs = 20_000, what = predicate): Promise<void> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (await this.eval<boolean>(`!!(${predicate})`).catch(() => false)) return;
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /**
   * A PNG of the page, or of `clip` (CSS px). The image is in DEVICE pixels:
   * a clip whose edges sit on whole device pixels is copied, never resampled.
   */
  async screenshot(clip?: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
    const r = await this.send<{ data: string }>(
      "Page.captureScreenshot",
      clip ? { format: "png", clip: { ...clip, scale: 1 } } : { format: "png" },
    );
    return Buffer.from(r.data, "base64");
  }
}

export class Browser {
  private readonly pages = new Map<string, Page>();
  private id = 0;
  private readonly pending = new Map<number, (v: Record<string, unknown>) => void>();

  private constructor(
    private readonly proc: ChildProcess,
    private readonly ws: WebSocket,
    private readonly profile: string,
  ) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.sessionId) {
        this.pages.get(msg.sessionId)?.dispatch(msg);
      } else if (msg.id !== undefined) {
        this.pending.get(msg.id)?.(msg.result ?? {});
        this.pending.delete(msg.id);
      }
    });
  }

  static async launch(opts: { width?: number; height?: number } = {}): Promise<Browser> {
    const chrome = findHeadlessChrome();
    const profile = mkdtempSync(join(tmpdir(), "gs-merge-e2e-chrome-"));
    const proc = spawn(
      chrome,
      [
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-sandbox",
        "--no-first-run",
        "--allow-file-access-from-files",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        `--window-size=${opts.width ?? 1600},${opts.height ?? 1000}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const cleanup = () => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* gone */
      }
      removeProfile(profile);
    };
    process.once("exit", cleanup);
    const url = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const t = setTimeout(() => reject(new Error(`no DevTools endpoint from ${chrome}:\n${buf}`)), 20_000);
      proc.stderr!.on("data", (d: Buffer) => {
        buf += d.toString();
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
        if (m) {
          clearTimeout(t);
          resolve(m[1]);
        }
      });
      proc.once("exit", (code) => reject(new Error(`${chrome} exited (${code}):\n${buf}`)));
    });
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("DevTools socket failed")), { once: true });
    });
    return new Browser(proc, ws, profile);
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  /** A fresh tab at `width`×`height` CSS px, rendered at `scale`. */
  async newPage(width: number, height: number, scale = 2): Promise<Page> {
    const { targetId } = (await this.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const { sessionId } = (await this.send("Target.attachToTarget", { targetId, flatten: true })) as {
      sessionId: string;
    };
    const page = new Page(this.ws, sessionId);
    this.pages.set(sessionId, page);
    page.on("Runtime.exceptionThrown", (p) => {
      const d = (p as { exceptionDetails?: { text?: string; exception?: { description?: string } } }).exceptionDetails;
      page.errors.push(`exception: ${d?.exception?.description ?? d?.text ?? "?"}`);
    });
    page.on("Runtime.consoleAPICalled", (p) => {
      const e = p as { type?: string; args?: Array<{ value?: unknown; description?: string }> };
      if (e.type === "error")
        page.errors.push(`console.error: ${(e.args ?? []).map((a) => a.value ?? a.description).join(" ")}`);
    });
    await page.send("Runtime.enable");
    await page.send("Page.enable");
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
    return page;
  }

  async goto(page: Page, url: string): Promise<void> {
    await page.send("Page.navigate", { url });
    await page.waitFor(`document.readyState === "complete"`, 30_000, "the page to load");
  }

  async closePage(page: Page): Promise<void> {
    for (const [sid, p] of this.pages) {
      if (p === page) {
        this.pages.delete(sid);
        await Promise.race([page.send("Page.close").catch(() => undefined), new Promise((r) => setTimeout(r, 1000))]);
      }
    }
  }

  async close(): Promise<void> {
    // The browser may exit before it answers.
    await Promise.race([this.send("Browser.close"), new Promise((r) => setTimeout(r, 1000))]);
    this.ws.close();
    try {
      this.proc.kill("SIGKILL");
    } catch {
      /* gone */
    }
    removeProfile(this.profile);
  }
}

/**
 * Removes a browser profile. A killed Chrome's helpers can still be writing
 * its cache as it goes (ENOTEMPTY): retried, and a profile left behind in the
 * temp directory is no reason to fail a measurement that has already run —
 * this also runs on process exit, where a throw turns exit 0 into 1.
 */
function removeProfile(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* left in the temp directory */
  }
}
