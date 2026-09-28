// An isolated, background VS Code driven over the DevTools protocol — the
// recipe of scripts/merge-e2e/dashboardClicks.ts, packaged for the
// extension's README media (apps/extension/SHOTS.md).
//
// Its own --user-data-dir and --extensions-dir, the test VSIX installed into
// them, started with `open -g -j -n` (never brought to the front, never
// focused, whatever else is open), 2x device pixels from
// --force-device-scale-factor=2, and the window opened at the capture size:
// with a viewport override of another size, Page.captureScreenshot hangs.
// Git runs with no global or system config, so nothing of the owner's (a
// name, signing, hooks, credential helpers) reaches the demo repository.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsLiteral } from "../test/js-literal.mjs";

export const APP = process.env.GS_VSCODE_APP ?? "/Applications/Visual Studio Code.app";
const CODE_CLI = join(APP, "Contents/Resources/app/bin/code");
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export { jsLiteral };

/** One pointer step of a glide: ~30 a second, twice the hero's frame rate. */
const STEP_MS = 30;

/**
 * Text no image may carry: the owner's name and account, a real mail
 * provider, a home directory, any GitHub account but the project's.
 */
export const FORBIDDEN =
  /anton|arnaudov|@(gmail|googlemail|icloud|me|mac|outlook|hotmail|live|yahoo|proton|protonmail)\.|\/Users\/|\/home\/|github\.com\/[a-z0-9-]+\b(?<!GitStudioHQ)/i;

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
}

export class Cdp {
  private id = 0;
  private readonly pending = new Map<number, (m: CdpMessage) => void>();
  readonly listeners = new Set<(m: CdpMessage) => void>();

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as CdpMessage;
      if (m.id !== undefined && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      } else if (m.method) {
        for (const l of this.listeners) l(m);
      }
    };
  }

  static async connect(port: number, timeoutMs = 90_000): Promise<Cdp> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      try {
        const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string };
        const ws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.onopen = res;
          ws.onerror = rej;
        });
        return new Cdp(ws);
      } catch {
        if (Date.now() > until) throw new Error(`no DevTools on port ${port}`);
        await sleep(500);
      }
    }
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res((m.result ?? {}) as T)));
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async attach(targetId: string): Promise<string> {
    const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    await this.send("Runtime.enable", {}, sessionId);
    return sessionId;
  }

  async eval<T>(sessionId: string, expression: string): Promise<T> {
    const r = await this.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (r.exceptionDetails) throw new Error(`in the page: ${JSON.stringify(r.exceptionDetails).slice(0, 800)}`);
    return r.result?.value as T;
  }

  close(): void {
    this.ws.close();
  }
}

// ── an isolated VS Code ─────────────────────────────────────────────────────

export interface LaunchOptions {
  vsixDir: string;
  folder: string;
  /** Holds the profile (user data + extensions); removed by stop() unless keepProfile. */
  profile: string;
  port: number;
  width: number;
  height: number;
  theme: string;
  settings?: Record<string, unknown>;
  keepProfile?: boolean;
}

export interface Running {
  settingsFile: string;
  stop(): void;
}

export function baseSettings(theme: string): Record<string, unknown> {
  return {
    "workbench.colorTheme": theme,
    "workbench.startupEditor": "none",
    "workbench.tips.enabled": false,
    "workbench.enableExperiments": false,
    "workbench.welcomePage.walkthroughs.openOnInstall": false,
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "security.workspace.trust.enabled": false,
    "window.restoreWindows": "none",
    "window.newWindowDimensions": "default",
    "window.commandCenter": true,
    "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false,
    "extensions.ignoreRecommendations": true,
    "update.mode": "none",
    "update.showReleaseNotes": false,
    "telemetry.telemetryLevel": "off",
    // No Copilot or chat in any image (and the profile is signed in to nothing).
    "chat.disableAIFeatures": true,
    "chat.commandCenter.enabled": false,
    // VS Code's own blame and checks would crowd GitStudio's.
    "git.blame.editorDecoration.enabled": false,
    "git.blame.statusBarItem.enabled": false,
    "git.autofetch": false,
    "git.openRepositoryInParentFolders": "never",
    "typescript.validate.enable": false,
    "javascript.validate.enable": false,
    "editor.lightbulb.enabled": "off",
    "editor.minimap.enabled": false,
    "editor.stickyScroll.enabled": false,
    "gitstudio.errorReporting.enabled": false,
  };
}

/** The window's saved state, so the first window opens at the capture size. */
function seedWindowState(udd: string, w: number, h: number): void {
  const state = JSON.stringify({
    windowsState: {
      lastActiveWindow: { uiState: { mode: 1, x: 40, y: 40, width: w, height: h } },
      openedWindows: [],
    },
  });
  mkdirSync(join(udd, "User", "globalStorage"), { recursive: true });
  writeFileSync(join(udd, "User", "globalStorage", "storage.json"), state);
  writeFileSync(join(udd, "storage.json"), state);
}

export function launchVsCode(o: LaunchOptions): Running {
  const udd = join(o.profile, "udd");
  const ext = join(o.profile, "ext");
  mkdirSync(join(udd, "User"), { recursive: true });
  mkdirSync(ext, { recursive: true });
  const settingsFile = join(udd, "User", "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ ...baseSettings(o.theme), ...(o.settings ?? {}) }, null, 2));
  seedWindowState(udd, o.width, o.height);
  // VS Code keeps its main socket in the user-data-dir, and macOS caps a
  // socket's path at 103 bytes: reach the profile through a short link.
  const link = `/tmp/gs-shots-${o.port}`;
  try {
    unlinkSync(link);
  } catch {
    // none yet
  }
  symlinkSync(udd, link);
  // An agent's shell may carry ELECTRON_RUN_AS_NODE: VS Code would start as
  // plain Node and quit at once.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const vsixes = readdirSync(o.vsixDir).filter((f) => f.endsWith(".vsix"));
  if (!vsixes.length) throw new Error(`no .vsix in ${o.vsixDir}`);
  for (const v of vsixes) {
    execFileSync(CODE_CLI, [`--user-data-dir=${link}`, `--extensions-dir=${ext}`, "--install-extension", join(o.vsixDir, v), "--force"], {
      env,
      stdio: "pipe",
    });
  }
  const args = [
    // It runs behind the owner's windows: keep it painting and its timers honest.
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    // A window launched hidden has no screen to take 2x from.
    "--force-device-scale-factor=2",
    `--user-data-dir=${link}`,
    `--extensions-dir=${ext}`,
    `--remote-debugging-port=${o.port}`,
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    "--new-window",
    o.folder,
  ];
  // -g: never brought to the front; -j: launched hidden; -n: its own
  // instance, whatever else is open. --env reaches the app itself (the
  // shell's environment does not pass through Launch Services).
  execFileSync(
    "open",
    [
      "-g", "-j", "-n",
      "--env", "GIT_CONFIG_GLOBAL=/dev/null",
      "--env", "GIT_CONFIG_NOSYSTEM=1",
      "--env", "GIT_TERMINAL_PROMPT=0",
      "-a", APP, "--args", ...args,
    ],
    { env },
  );
  const ours = (): number[] =>
    execFileSync("ps", ["ax", "-o", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes(link))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((p) => p > 0 && p !== process.pid);
  return {
    settingsFile,
    stop() {
      for (const p of ours()) {
        try {
          process.kill(p, "SIGTERM");
        } catch {
          // gone
        }
      }
      const until = Date.now() + 8_000;
      while (ours().length && Date.now() < until) execFileSync("sleep", ["0.5"]);
      for (const p of ours()) {
        try {
          process.kill(p, "SIGKILL");
        } catch {
          // gone
        }
      }
      try {
        unlinkSync(link);
      } catch {
        // gone
      }
      if (!o.keepProfile) rmSync(o.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

export function setSetting(settingsFile: string, key: string, value: unknown): void {
  const cur = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
  cur[key] = value;
  writeFileSync(settingsFile, JSON.stringify(cur, null, 2));
}

// ── the workbench and its webviews ──────────────────────────────────────────

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Every text on a page: shadow roots, input values and placeholders
// included; script and style bodies not.
const DEEP_TEXT = `((doc) => { const out = []; const code = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/; const walk = (root) => { const tw = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT); let n = tw.currentNode; while (n) { if (n.nodeType === 3) { if (!code.test((n.parentNode && n.parentNode.nodeName) || '')) out.push(n.nodeValue); } else { if (n.shadowRoot) walk(n.shadowRoot); if (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA') out.push(n.value || '', n.placeholder || ''); } n = tw.nextNode(); } }; walk(doc.body); return out.join(' '); })`;

// D: the webview page's document; Q(sel): every match, through shadow roots
// (the graph and the rail are Lit elements); Q1(sel): the first; T(): every
// text on the page, shadow roots included.
const INNER = `const F = document.querySelector('iframe#active-frame'); const W = F && F.contentWindow, D = F && F.contentDocument;
const Q = (sel, root = D) => { const out = []; const walk = (r) => { if (!r) return; out.push(...r.querySelectorAll(sel)); for (const e of r.querySelectorAll('*')) if (e.shadowRoot) walk(e.shadowRoot); }; walk(root); return out; };
const Q1 = (sel) => Q(sel)[0];
const T = () => D && D.body ? ${DEEP_TEXT}(D) : '';
const H = (s) => T().replace(/\\s+/g, '').includes(String(s).replace(/\\s+/g, ''));`;

// quiet(x, y), in a webview page: nothing there reacts to a pointer — no
// tooltip, control, row that lights up, or editor (Monaco shows its
// scrollbars under a pointer).
const QUIET = `const quiet = (x, y) => {
  let e = D.elementFromPoint(x, y);
  while (e && e.shadowRoot) { const inner = e.shadowRoot.elementFromPoint(x, y); if (!inner || inner === e) break; e = inner; }
  if (!e || e === D.body || e === D.documentElement) return true;
  if (e.closest('[data-tip],[title],button,a,input,textarea,select,[role=treeitem],[role=option],[role=button],.monaco-editor,.row,.cr-commit,.wt-row,.stash-row,.chip,.jb-stage-tick')) return false;
  // a container's padding, not a label's text
  return ![...e.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
};`;

// Text an editor draws with CSS (blame annotations, inline blame, other
// decorations): not in the DOM's text, but on the screen all the same.
const DECORATION_TEXT = `((doc) => [...doc.querySelectorAll('.monaco-editor .view-lines span, .monaco-editor .margin-view-overlays div, .monaco-editor .view-overlays div, .monaco-editor .contentWidgets *')].flatMap((e) => ['::before', '::after'].map((p) => getComputedStyle(e, p).content)).filter((c) => c && c !== 'none' && c !== 'normal').join(' '))`;

export class Workbench {
  private readonly sessions = new Map<string, string>();
  /** Where the pointer is (workbench CSS px). */
  pointer = { x: 700, y: 450 };
  private cursorOn = false;

  constructor(
    readonly c: Cdp,
    readonly sid: string,
  ) {}

  static async attach(c: Cdp): Promise<Workbench> {
    const until = Date.now() + 90_000;
    for (;;) {
      const { targetInfos } = await c.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
      const page = targetInfos.find((t) => t.type === "page" && /workbench\.html/.test(t.url));
      if (page) {
        const sid = await c.attach(page.targetId);
        await c.send("Page.enable", {}, sid);
        // Behave as the focused window a person clicks in — without focusing
        // (or raising) any real window.
        await c.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sid).catch(() => undefined);
        return new Workbench(c, sid);
      }
      if (Date.now() > until) throw new Error("no workbench window");
      await sleep(500);
    }
  }

  eval<T>(expr: string): Promise<T> {
    return this.c.eval<T>(this.sid, expr);
  }

  async waitFor(expr: string, timeoutMs = 30_000, what = expr): Promise<void> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (await this.eval<boolean>(`!!(${expr})`).catch(() => false)) return;
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
      await sleep(150);
    }
  }

  /** A PNG of the window, or of `clip` (CSS px), in device pixels. */
  async screenshot(clip?: Rect): Promise<Buffer> {
    const r = await this.c.send<{ data: string }>(
      "Page.captureScreenshot",
      clip ? { format: "png", clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 1 } } : { format: "png" },
      this.sid,
    );
    return Buffer.from(r.data, "base64");
  }

  // ── input ──

  /** Runs a command from the palette, as a person would. */
  async command(title: string): Promise<void> {
    await this.key("F1", "F1", 112);
    await this.waitFor(`document.querySelector('.quick-input-widget') && document.querySelector('.quick-input-widget').style.display !== 'none'`, 10_000, "the palette");
    await sleep(150);
    await this.type(title);
    await this.waitFor(
      `[...document.querySelectorAll('.quick-input-list .monaco-list-row')].some((r) => r.getAttribute('aria-label') && r.getAttribute('aria-label').toLowerCase().includes(${jsLiteral(title.toLowerCase())}))`,
      10_000,
      `"${title}" in the palette`,
    );
    await sleep(250);
    await this.key("Enter", "Enter", 13);
    await sleep(400);
  }

  async type(text: string, delayMs = 0): Promise<void> {
    if (!delayMs) {
      await this.c.send("Input.insertText", { text }, this.sid);
      return;
    }
    for (const ch of text) {
      await this.c.send("Input.insertText", { text: ch }, this.sid);
      await sleep(delayMs);
    }
  }

  /**
   * Types `text` as key presses, one character at a time. Unlike type()
   * (Input.insertText, which reaches the workbench's own document only), key
   * events are routed to whichever frame has focus — a webview's textarea too.
   */
  async typeKeys(text: string, delayMs = 0): Promise<void> {
    for (const ch of text) {
      const up = ch.toUpperCase();
      const code = /[a-z]/i.test(ch) ? `Key${up}` : /\d/.test(ch) ? `Digit${ch}` : ch === " " ? "Space" : "";
      const keyCode = /[a-z0-9]/i.test(ch) ? up.charCodeAt(0) : ch === " " ? 32 : 0;
      await this.c.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: keyCode }, this.sid);
      await this.c.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code, windowsVirtualKeyCode: keyCode }, this.sid);
      if (delayMs) await sleep(delayMs);
    }
  }

  /** A key press; modifiers: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
  async key(key: string, code: string, keyCode: number, modifiers = 0): Promise<void> {
    await this.c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, modifiers }, this.sid);
    if (key.length === 1 && !(modifiers & 6)) {
      await this.c.send("Input.dispatchKeyEvent", { type: "char", key, text: key, code, windowsVirtualKeyCode: keyCode, modifiers }, this.sid);
    }
    await this.c.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, modifiers }, this.sid);
  }

  /** Moves the pointer from where it is, along an eased path, in `ms`. */
  async move(x: number, y: number, ms = 0): Promise<void> {
    const from = { ...this.pointer };
    const steps = ms > 0 ? Math.max(2, Math.round(ms / STEP_MS)) : 1;
    const t0 = Date.now();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      await this.pointTo(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
      if (steps > 1) {
        const due = t0 + (ms * i) / steps;
        const wait = due - Date.now();
        if (wait > 0) await sleep(wait);
      }
    }
    this.pointer = { x, y };
  }

  /**
   * Moves the pointer through `via` to (x, y) in `ms`, eased over the whole
   * path. Straight segments, on purpose: a path that must leave a webview
   * through one quiet spot cannot be allowed to curve over its neighbours.
   */
  async glide(via: { x: number; y: number }[], x: number, y: number, ms: number): Promise<void> {
    const pts = [{ ...this.pointer }, ...via, { x, y }];
    if (pts.length === 2 || ms <= 0) return this.move(x, y, ms);
    const len = [0];
    for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const total = len[len.length - 1];
    const steps = Math.max(2, Math.round(ms / STEP_MS));
    const t0 = Date.now();
    let j = 0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const s = (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2) * total;
      // Every corner is visited, however fast the step: the corners are the
      // quiet spots the path must pass through.
      while (j < len.length - 2 && len[j + 1] < s) {
        j++;
        await this.pointTo(pts[j].x, pts[j].y);
      }
      const u = Math.min(1, Math.max(0, (s - len[j]) / (len[j + 1] - len[j] || 1)));
      await this.pointTo(pts[j].x + (pts[j + 1].x - pts[j].x) * u, pts[j].y + (pts[j + 1].y - pts[j].y) * u);
      const wait = t0 + (ms * i) / steps - Date.now();
      if (wait > 0) await sleep(wait);
    }
    this.pointer = { x, y };
  }

  private async pointTo(x: number, y: number): Promise<void> {
    await this.c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, this.sid);
    if (this.cursorOn) await this.eval(`window.__gsCursor && window.__gsCursor(${x}, ${y})`);
  }

  async click(x: number, y: number, opts: { modifiers?: number; button?: "left" | "right"; count?: number; glide?: number; via?: { x: number; y: number }[] } = {}): Promise<void> {
    if (opts.via?.length) await this.glide(opts.via, x, y, opts.glide ?? 600);
    else await this.move(x, y, opts.glide ?? 0);
    const button = opts.button ?? "left";
    const base = { x, y, button, modifiers: opts.modifiers ?? 0 };
    if (this.cursorOn) await this.eval(`window.__gsClick && window.__gsClick()`);
    for (let n = 1; n <= (opts.count ?? 1); n++) {
      await this.c.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed", clickCount: n }, this.sid);
      await sleep(40);
      await this.c.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased", clickCount: n }, this.sid);
    }
  }

  /** Presses at `from`, moves to `to`, releases: a sash or a drag. */
  async drag(from: { x: number; y: number }, to: { x: number; y: number }, ms = 300): Promise<void> {
    await this.move(from.x, from.y);
    await this.c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 }, this.sid);
    const steps = Math.max(2, Math.round(ms / 16));
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await this.c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 }, this.sid);
      await sleep(16);
    }
    await this.c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 }, this.sid);
    this.pointer = { ...to };
  }

  // ── the drawn pointer (the hero only: CDP input draws no cursor) ──

  async showCursor(): Promise<void> {
    await this.eval(`(() => {
      if (window.__gsCursor) return;
      const box = document.createElement('div');
      box.id = 'gs-demo-cursor';
      box.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:30px;z-index:2147483647;pointer-events:none;will-change:transform;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));';
      // Built node by node: the workbench's Trusted Types policy refuses innerHTML.
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('width', '22'); svg.setAttribute('height', '30'); svg.setAttribute('viewBox', '0 0 22 30');
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', 'M3 2.5 L3 23 L8.2 18 L11.8 26.4 L15.2 25 L11.7 16.8 L18.8 16.8 Z');
      path.setAttribute('fill', '#141414'); path.setAttribute('stroke', '#ffffff'); path.setAttribute('stroke-width', '1.7'); path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
      box.appendChild(svg);
      const ring = document.createElement('div');
      ring.style.cssText = 'position:fixed;left:0;top:0;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;border:2.5px solid #8e78f6;background:rgba(142,120,246,.18);z-index:2147483646;pointer-events:none;opacity:0;transform:scale(.4);';
      document.body.appendChild(ring);
      document.body.appendChild(box);
      let at = [0, 0];
      window.__gsCursor = (x, y) => { at = [x, y]; box.style.transform = 'translate(' + (x - 3) + 'px,' + (y - 2.5) + 'px)'; };
      window.__gsClick = () => {
        ring.style.left = at[0] + 'px'; ring.style.top = at[1] + 'px';
        ring.animate([{ opacity: 0.95, transform: 'scale(.35)' }, { opacity: 0, transform: 'scale(1.25)' }], { duration: 420, easing: 'cubic-bezier(.2,.7,.3,1)' });
      };
    })()`);
    this.cursorOn = true;
    await this.eval(`window.__gsCursor(${this.pointer.x}, ${this.pointer.y})`);
  }

  async hideCursor(): Promise<void> {
    this.cursorOn = false;
    await this.eval(`(() => { document.getElementById('gs-demo-cursor')?.remove(); delete window.__gsCursor; delete window.__gsClick; })()`);
  }

  // ── layout ──

  async rect(selector: string): Promise<Rect | null> {
    return this.eval(
      `(() => { const e = document.querySelector(${jsLiteral(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); if (!r.width) return null; return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`,
    );
  }

  async size(): Promise<{ w: number; h: number }> {
    return this.eval(`({ w: innerWidth, h: innerHeight })`);
  }

  /** Clicks an action button (title bar, view or panel) by its aria-label prefix. */
  async clickAction(scope: string, label: string, glide = 0): Promise<void> {
    const r = await this.eval<Rect | null>(
      `(() => { const b = [...document.querySelectorAll(${jsLiteral(scope + " .action-label")})].find((a) => (a.getAttribute('aria-label') || '').startsWith(${jsLiteral(label)})); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`,
    );
    if (!r || !r.w) throw new Error(`no "${label}" action in ${scope}`);
    await this.click(r.x + r.w / 2, r.y + r.h / 2, { glide });
  }

  /** A side-bar view's header: where it is and whether it is open. */
  async pane(title: string): Promise<{ r: Rect; open: boolean } | null> {
    return this.eval(
      `(() => { const h = [...document.querySelectorAll('.sidebar .pane-header')].find((h) => (h.querySelector('h3.title')?.textContent || '').trim() === ${jsLiteral(title)}); if (!h) return null; const r = h.getBoundingClientRect(); return { r: { x: r.left, y: r.top, w: r.width, h: r.height }, open: h.getAttribute('aria-expanded') === 'true' }; })()`,
    );
  }

  async setPane(title: string, open: boolean): Promise<void> {
    const p = await this.pane(title);
    if (!p) throw new Error(`no "${title}" view`);
    if (p.open === open) return;
    await this.click(p.r.x + 40, p.r.y + p.r.h / 2);
    await sleep(500);
  }

  /** Makes the side bar `width` CSS px wide by dragging its sash. */
  async setSidebarWidth(width: number): Promise<void> {
    const sb = await this.rect(".part.sidebar");
    if (!sb) throw new Error("no side bar");
    const sash = await this.eval<Rect | null>(
      `(() => { const right = ${sb.x + sb.w}; const s = [...document.querySelectorAll('.monaco-sash.vertical')].map((e) => e.getBoundingClientRect()).find((r) => r.width && Math.abs(r.left + r.width / 2 - right) < 6); return s ? { x: s.left, y: s.top, w: s.width, h: s.height } : null; })()`,
    );
    if (!sash) throw new Error("no side-bar sash");
    const y = sash.y + sash.h / 2;
    await this.drag({ x: sash.x + sash.w / 2, y }, { x: sb.x + width, y });
    await sleep(400);
  }

  /** Makes the panel `height` CSS px tall by dragging its sash. */
  async setPanelHeight(height: number): Promise<void> {
    const p = await this.rect(".part.panel");
    if (!p) throw new Error("no panel");
    const sash = await this.eval<Rect | null>(
      `(() => { const top = ${p.y}; const s = [...document.querySelectorAll('.monaco-sash.horizontal')].map((e) => e.getBoundingClientRect()).find((r) => r.height && r.width > 200 && Math.abs(r.top + r.height / 2 - top) < 6); return s ? { x: s.left, y: s.top, w: s.width, h: s.height } : null; })()`,
    );
    if (!sash) throw new Error("no panel sash");
    const x = sash.x + sash.w / 2;
    await this.drag({ x, y: sash.y + sash.h / 2 }, { x, y: p.y + p.h - height });
    await sleep(400);
  }

  // ── webviews ──

  private async session(targetId: string): Promise<string> {
    let sid = this.sessions.get(targetId);
    if (!sid) {
      sid = await this.c.attach(targetId);
      this.sessions.set(targetId, sid);
    }
    return sid;
  }

  /** Every webview whose frame is on screen now. */
  async webviews(): Promise<Webview[]> {
    const { targetInfos } = await this.c.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
    const out: Webview[] = [];
    for (const t of targetInfos) {
      if (t.type !== "iframe" || !/^vscode-webview:/.test(t.url)) continue;
      try {
        const id = new URL(t.url).searchParams.get("id") ?? "";
        const visible = await this.eval<boolean>(
          `[...document.querySelectorAll('iframe')].some((f) => (f.src || '').includes(${jsLiteral(id)}) && f.getBoundingClientRect().width > 0 && f.getBoundingClientRect().height > 0 && getComputedStyle(f.parentElement).visibility !== 'hidden')`,
        );
        if (!visible) continue;
        out.push(new Webview(this, await this.session(t.targetId), id));
      } catch {
        // gone between the listing and the question
      }
    }
    return out;
  }

  /** The webview whose page matches `probe` (an expression over D, Q, Q1). */
  async webview(probe: string, timeoutMs = 30_000): Promise<Webview> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      for (const w of await this.webviews()) {
        const ok = await w.eval<boolean>(`!!(D && (${probe}))`).catch(() => false);
        if (ok) return w;
      }
      if (Date.now() > until) throw new Error(`no webview matching ${probe}`);
      await sleep(400);
    }
  }

  /** Text the workbench's editors draw with CSS (blame annotations and the like). */
  decorationText(): Promise<string> {
    return this.eval<string>(`${DECORATION_TEXT}(document)`);
  }

  /** Every text on screen: the workbench's, its editors' decorations, and every visible webview's. */
  async allText(): Promise<string> {
    const parts = [await this.eval<string>(`${DEEP_TEXT}(document) + ' ' + document.title + ' ' + ${DECORATION_TEXT}(document)`)];
    for (const w of await this.webviews()) {
      parts.push(await w.eval<string>(`D && D.body ? ${DEEP_TEXT}(D) + ' ' + ${DECORATION_TEXT}(D) : ''`).catch(() => ""));
    }
    return parts.join("\n");
  }

  /**
   * Reads everything on screen every `everyMs` until stopped and keeps any
   * FORBIDDEN text it finds: the check for a recording, whose screens pass
   * by between the ones verify() sees.
   */
  watchForbidden(everyMs = 700): { stop(): Promise<{ samples: number; hits: string[] }> } {
    let on = true;
    let samples = 0;
    const hits: string[] = [];
    const loop = (async () => {
      while (on) {
        try {
          const text = await this.allText();
          samples++;
          for (const t of [text, text.replace(/\s+/g, "")]) {
            const bad = FORBIDDEN.exec(t);
            if (bad) hits.push(t.slice(Math.max(0, bad.index - 40), bad.index + 40));
          }
        } catch {
          // a webview between two states: the next sample reads it
        }
        await sleep(everyMs);
      }
    })();
    return {
      async stop() {
        on = false;
        await loop;
        return { samples, hits };
      },
    };
  }

  /**
   * Throws unless every `expect` is on screen (compared without whitespace:
   * a chip's text can be split across elements) and nothing FORBIDDEN is.
   */
  async verify(what: string, expect: string[]): Promise<void> {
    const text = await this.allText();
    for (const t of [text, text.replace(/\s+/g, "")]) {
      const bad = FORBIDDEN.exec(t);
      if (bad) throw new Error(`${what}: forbidden text on screen: "${t.slice(Math.max(0, bad.index - 40), bad.index + 40)}"`);
    }
    const flat = text.replace(/\s+/g, "");
    const missing = expect.filter((e) => !flat.includes(e.replace(/\s+/g, "")));
    if (missing.length) throw new Error(`${what}: not on screen: ${missing.map((m) => JSON.stringify(m)).join(", ")}`);
  }
}

export class Webview {
  constructor(
    readonly wb: Workbench,
    readonly sid: string,
    readonly id: string,
  ) {}

  /** Evaluate with D (the page's document), W (its window), Q and Q1 in scope. */
  eval<T>(body: string): Promise<T> {
    return this.wb.c.eval<T>(this.sid, `(() => { ${INNER} return (${body}); })()`);
  }

  async waitFor(expr: string, timeoutMs = 30_000, what = expr): Promise<void> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      if (await this.eval<boolean>(`!!(${expr})`).catch(() => false)) return;
      if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
      await sleep(150);
    }
  }

  /** The frame of this webview's page, in workbench CSS px. */
  async frame(): Promise<Rect> {
    const outer = await this.wb.eval<Rect | null>(
      `(() => { const f = [...document.querySelectorAll('iframe')].find((f) => (f.src || '').includes(${jsLiteral(this.id)})); if (!f) return null; const r = f.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`,
    );
    if (!outer) throw new Error("the webview's frame is gone");
    const inner = await this.wb.c.eval<{ x: number; y: number }>(
      this.sid,
      `(() => { const r = document.querySelector('iframe#active-frame').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`,
    );
    return { x: outer.x + inner.x, y: outer.y + inner.y, w: outer.w - inner.x, h: outer.h - inner.y };
  }

  /** Where the element `elExpr` (an expression over D, Q, Q1) is, in workbench CSS px; scrolled into view. */
  async rect(elExpr: string): Promise<Rect> {
    const r = await this.eval<Rect | null>(
      `(() => { const e = ${elExpr}; if (!e) return null; e.scrollIntoView({ block: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`,
    );
    if (!r) throw new Error(`no element: ${elExpr}`);
    const f = await this.frame();
    return { x: f.x + r.x, y: f.y + r.y, w: r.w, h: r.h };
  }

  async centre(elExpr: string): Promise<{ x: number; y: number }> {
    const r = await this.rect(elExpr);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  /** Clicks the element's centre, or (dx, dy) from its top-left corner. */
  async click(
    elExpr: string,
    opts: { modifiers?: number; button?: "left" | "right"; glide?: number; count?: number; dx?: number; dy?: number; via?: { x: number; y: number }[] } = {},
  ): Promise<void> {
    const r = await this.rect(elExpr);
    const x = opts.dx !== undefined ? r.x + opts.dx : r.x + r.w / 2;
    const y = opts.dy !== undefined ? r.y + opts.dy : r.y + r.h / 2;
    await this.wb.click(x, y, opts);
  }

  /**
   * Takes the pointer out of this page without leaving a tooltip behind: a
   * synthetic pointer that jumps from a webview into the workbench never
   * sends the page its pointerout, so first rest it on an empty spot of the
   * page itself, then leave.
   */
  async leave(to: { x: number; y: number }): Promise<void> {
    const spot = await this.quietSpot();
    if (spot) {
      await this.wb.move(spot.x, spot.y);
      await sleep(80);
    }
    await this.wb.move(to.x, to.y);
  }

  /**
   * A spot on this page (workbench CSS px) that reacts to nothing: no
   * tooltip, no control, no row that lights up, no editor (Monaco shows its
   * scrollbars under a pointer). The page's top band first — toolbars have
   * empty stretches — then its bottom half, unless `topOnly`.
   */
  async quietSpot(opts: { topOnly?: boolean; from?: number; to?: number } = {}): Promise<{ x: number; y: number } | null> {
    const f = await this.frame();
    const spot = await this.eval<{ x: number; y: number } | null>(`(() => {
      const Hh = D.documentElement.clientHeight, Wd = D.documentElement.clientWidth;
      ${QUIET}
      for (let y = 8; y < 60; y += 6) for (let x = Wd * ${opts.from ?? 0.45}; x < Wd * ${opts.to ?? 0.9}; x += 16) if (quiet(x, y)) return { x, y };
      if (${!!opts.topOnly}) return null;
      for (let y = Hh - 6; y > Hh / 2; y -= 12) for (const x of [Wd * 0.5, Wd - 14, 14]) if (quiet(x, y)) return { x, y };
      return null;
    })()`);
    return spot && { x: f.x + spot.x, y: f.y + spot.y };
  }

  /**
   * The quiet spot just inside this page's left or right edge, at height `y`
   * (workbench CSS px) or the nearest height to it that is quiet: where a
   * pointer can leave the page sideways without leaving anything lit.
   */
  async edgeExit(side: "left" | "right", y: number): Promise<{ x: number; y: number } | null> {
    const f = await this.frame();
    const spot = await this.eval<{ x: number; y: number } | null>(`(() => {
      const Wd = D.documentElement.clientWidth;
      ${QUIET}
      const x = ${side === "left" ? 2 : "Wd - 2"};
      const y0 = ${y - f.y};
      for (let d = 0; d <= 14; d += 2) for (const yy of [y0 - d, y0 + d]) if (quiet(x, yy)) return { x, y: yy };
      return null;
    })()`);
    return spot && { x: f.x + spot.x, y: f.y + spot.y };
  }

  text(): Promise<string> {
    return this.eval<string>(`D.body.innerText`);
  }
}
