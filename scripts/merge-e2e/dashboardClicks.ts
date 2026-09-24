// The conflicts list in REAL VS Code: press a row's button, and prove nothing
// else on the page moves.
//
// The owner, 24 Sep 2026, on the build whose headless checks all passed:
// "clicking accept left on the first row flashes and refreshes all other rows,
// and buttons like merge disappear and reappear again … it looks like a server
// side website when u click a button and rerenders the whole page". What the
// real extension host sends, when, and how often, is exactly what a headless
// page fed hand-written states cannot show — so this drives the real thing:
//
//   1. installs the given VSIXs into an ISOLATED VS Code (its own
//      --user-data-dir and --extensions-dir under --out), launched in the
//      background (`open -g`: it never comes to the front, nothing raises or
//      focuses it), with a DevTools port;
//   2. opens the repository (stopped with conflicts), where the dashboard
//      opens on its own;
//   3. for each scenario, inside the dashboard's webview: records every host
//      message, every DOM mutation, and every button's look on every frame;
//      records the SCREEN (a CDP screencast); presses the button with real
//      input (Input.dispatchMouseEvent — a real click, a real hold); waits for
//      every host push to settle; and judges:
//        - no mutation outside the pressed row, the progress bar, and the
//          footer's count;
//        - no button on another row (or the footer) ever changed its look —
//          colour, visibility, place, disabled or locked;
//        - the page was not reloaded (same document, same dashboard node);
//        - on the screen, frame by frame, no pixel changed outside those same
//          places.
//   4. quits that VS Code and deletes its profile (the recordings stay).
//
// Scenarios, in order, on one repository: Accept Yours on the FIRST row,
// Accept Theirs on a MIDDLE row, Delete the file (a modify/delete row), Hold
// to undo (the first resolved row), and a file resolved from a TERMINAL
// (`git checkout --theirs` + `git add`, no click).
//
// It cannot run in CI (a real VS Code, a window, the macOS `open`). Run it:
//
//   # 1. the VSIXs (GitStudio, and Merge Studio beside it, as the owner runs them)
//   (cd apps/extension && npm run package && npx @vscode/vsce package --no-dependencies -o /tmp/vsix/)
//   (cd apps/merge-studio && npm run package && npx @vscode/vsce package --no-dependencies -o /tmp/vsix/)
//   # 2. a repository stopped with conflicts: yours, or the matrix's (built for you with --scenario)
//   npx tsx scripts/merge-e2e/dashboardClicks.ts --vsix /tmp/vsix --repo ~/merge-playground/quick-rebase --out /tmp/clicks
//   npx tsx scripts/merge-e2e/dashboardClicks.ts --vsix /tmp/vsix --scenario issue12.merge --out /tmp/clicks
//
// Options:
//   --vsix <dir>        every *.vsix in it is installed into the isolated profile
//   --repo <path>       a repository stopped mid-operation with conflicts (it is CHANGED: files get resolved)
//   --scenario <op.style>  instead of --repo: build that matrix scenario (fixtures.sh) under --out
//   --out <dir>         recordings, reports and the (deleted afterwards) profile
//   --port <n>          DevTools port, default 9873
//   --theme <name>      default "Default Dark Modern"
//   --settle <ms>       wait after each press for the host's pushes, default 4000 (>= 3000)
//   --shots a,b         after the scenarios, screenshot the list in each of these themes
//   --keep-profile      keep the isolated profile (default: deleted with the window)
//   --only 3,4,5        run only these scenarios (by number), e.g. again after a disturbed run
//
// Writes, per scenario, <out>/<scenario>/: report.json (the verdict and why),
// messages.json (every host message, as received), frames/*.png (the webview,
// every frame of the screencast, half size) and strip.png (the frames around
// the press); and <out>/replay.json — the messages of every scenario in
// order, which packages/webview-ui/test/conflictsReplay.test.ts replays
// headlessly through the same judge (copy it to
// packages/webview-ui/test/fixtures/vscodeDashboardClicks.json).

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { crop, decodePng, encodePng, sheet, shrink, type Image } from "./png";
import { buildMatrix } from "./oracle";

const APP = process.env.GS_VSCODE_APP ?? "/Applications/Visual Studio Code.app";
const CODE_CLI = join(APP, "Contents/Resources/app/bin/code");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── options ──────────────────────────────────────────────────────────────────

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

interface Options {
  vsix: string;
  repo: string;
  out: string;
  port: number;
  theme: string;
  settle: number;
  shots: string[];
  keepProfile: boolean;
}

// ── a DevTools client (browser-level socket, flattened sessions) ─────────────

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
}

class Cdp {
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

// ── an isolated VS Code ──────────────────────────────────────────────────────

interface Running {
  stop(): void;
}

function vsixesIn(dir: string): string[] {
  const all = readdirSync(dir).filter((f) => f.endsWith(".vsix"));
  if (all.length === 0) throw new Error(`no .vsix in ${dir}`);
  return all.map((f) => join(dir, f));
}

function launchVsCode(o: Options): Running {
  const prof = join(o.out, "profile");
  const udd = join(prof, "udd");
  const ext = join(prof, "ext");
  mkdirSync(join(udd, "User"), { recursive: true });
  mkdirSync(ext, { recursive: true });
  writeFileSync(
    join(udd, "User", "settings.json"),
    JSON.stringify(
      {
        "workbench.startupEditor": "none",
        "workbench.colorTheme": o.theme,
        "security.workspace.trust.enabled": false,
        "window.restoreWindows": "none",
        "extensions.autoUpdate": false,
        "extensions.autoCheckUpdates": false,
        "extensions.ignoreRecommendations": true,
        "update.mode": "none",
        "telemetry.telemetryLevel": "off",
        "workbench.secondarySideBar.defaultVisibility": "hidden",
        "workbench.tips.enabled": false,
      },
      null,
      2,
    ),
  );
  // VS Code keeps its main socket in the user-data-dir, and macOS caps a
  // socket's path at 103 bytes: reach the profile through a short link.
  const link = `/tmp/gs-dash-${o.port}`;
  try {
    unlinkSync(link);
  } catch {
    // none yet
  }
  symlinkSync(udd, link);
  // An agent's shell may carry ELECTRON_RUN_AS_NODE: VS Code would start as
  // plain Node and quit at once.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  for (const v of vsixesIn(o.vsix)) {
    execFileSync(CODE_CLI, [`--user-data-dir=${link}`, `--extensions-dir=${ext}`, "--install-extension", v, "--force"], {
      env,
      stdio: "pipe",
    });
  }
  const args = [
    // It runs behind the owner's windows: keep it painting and its timers honest.
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    `--user-data-dir=${link}`,
    `--extensions-dir=${ext}`,
    `--remote-debugging-port=${o.port}`,
    "--disable-workspace-trust",
    "--skip-welcome",
    "--skip-release-notes",
    "--new-window",
    o.repo,
  ];
  if (process.platform === "darwin") {
    // -g: never brought to the front; -n: its own instance, whatever else is open.
    execFileSync("open", ["-g", "-n", "-a", APP, "--args", ...args], { env });
  } else {
    spawn(process.env.GS_VSCODE_BIN ?? "code", args, { env, detached: true, stdio: "ignore" }).unref();
  }
  const ours = (): number[] =>
    execFileSync("ps", ["ax", "-o", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes(`--user-data-dir=${link}`))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((p) => p > 0 && p !== process.pid);
  return {
    stop() {
      for (const p of ours()) {
        try {
          process.kill(p, "SIGTERM");
        } catch {
          // gone
        }
      }
      const until = Date.now() + 10_000;
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
      if (!o.keepProfile) rmSync(prof, { recursive: true, force: true });
    },
  };
}

// ── the dashboard's webview ──────────────────────────────────────────────────

/** Evaluated in the webview's outer document: D / W are the page's own. */
const INNER = `
  const F = document.querySelector('iframe#active-frame');
  const W = F.contentWindow, D = F.contentDocument;
`;

interface RowInfo {
  path: string;
  resolved: boolean;
  busy: boolean;
  buttons: { key: string; text: string }[];
}

interface Frame {
  sid: string;
  id: string;
}

/** Every conflicts dashboard in the window now, with whose it is (GitStudio's, or Merge Studio's). */
async function dashboards(c: Cdp, pageSid: string): Promise<(Frame & { brand: string })[]> {
  const out: (Frame & { brand: string })[] = [];
  const { targetInfos } = await c.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
  for (const t of targetInfos) {
    if (t.type !== "iframe" || !/^vscode-webview:/.test(t.url)) continue;
    // A webview can come and go between the listing and the question: skip it.
    try {
      const id = new URL(t.url).searchParams.get("id") ?? "";
      const inPage = await c.eval<boolean>(pageSid, `[...document.querySelectorAll('iframe')].some((f) => (f.src || '').includes(${JSON.stringify(id)}))`);
      if (!inPage) continue;
      const sid = await c.attach(t.targetId);
      const brand = await c.eval<string | null>(
        sid,
        `(() => { const f = document.querySelector('iframe#active-frame'); const d = f && f.contentDocument; if (!d || !d.querySelector('.cd-dash .cd-row')) return null; return d.querySelector('.cd-mark .cd-mark-svg') ? 'merge-studio' : 'gitstudio'; })()`,
      );
      if (brand) out.push({ sid, id, brand });
    } catch {
      // gone
    }
  }
  return out;
}

/**
 * The dashboard to drive: GitStudio's when both products are installed (it
 * owns the automatic behaviour; Merge Studio's stands down), and only once
 * the same one has been there for two looks in a row.
 */
async function findDashboard(c: Cdp, pageSid: string): Promise<Frame> {
  const until = Date.now() + 90_000;
  let last = "";
  for (;;) {
    const all = await dashboards(c, pageSid);
    const pick = all.find((d) => d.brand === "gitstudio") ?? all[0];
    if (pick && pick.id === last) {
      if (all.length > 1) console.log(`note: ${all.length} dashboards open (${all.map((d) => d.brand).join(", ")}); driving ${pick.brand}'s`);
      return { sid: pick.sid, id: pick.id };
    }
    last = pick?.id ?? "";
    if (Date.now() > until) throw new Error("the conflicts dashboard never showed (is the repository stopped with conflicts?)");
    await sleep(1500);
  }
}

/** Where the webview's page sits in the workbench page (CSS px). */
async function frameRect(c: Cdp, pageSid: string, f: Frame): Promise<{ x: number; y: number; w: number; h: number }> {
  const outer = await c.eval<{ x: number; y: number; w: number; h: number } | null>(
    pageSid,
    `(() => { const f = [...document.querySelectorAll('iframe')].find((f) => (f.src || '').includes(${JSON.stringify(f.id)})); if (!f) return null; const r = f.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`,
  );
  if (!outer) throw new Error("the dashboard's frame is not in the workbench");
  const inner = await c.eval<{ x: number; y: number }>(f.sid, `(() => { const r = document.querySelector('iframe#active-frame').getBoundingClientRect(); return { x: r.left, y: r.top }; })()`);
  return { x: outer.x + inner.x, y: outer.y + inner.y, w: outer.w - inner.x, h: outer.h - inner.y };
}

const ROWS = `(() => { ${INNER}
  return [...D.querySelectorAll('.cd-row')].map((r) => ({
    path: r.dataset.path,
    resolved: r.classList.contains('is-resolved'),
    busy: r.classList.contains('is-busy'),
    buttons: [...r.querySelectorAll('button[data-key]')].map((b) => ({ key: b.dataset.key, text: b.textContent.replace(/\\s+/g, ' ').trim() })),
  }));
})()`;

/**
 * The probe: every host message, every mutation, every button's look per
 * frame, and the places a press may change (its row, the progress bar, the
 * footer's count), measured before the press.
 */
const PROBE = (path: string) => `(() => { ${INNER}
  const t = () => Math.round(W.performance.now() * 10) / 10;
  if (W.__gsProbe) W.__gsProbe.stop();
  W.__gsDoc = W.__gsDoc || String(Math.random());
  const dash = D.querySelector('.cd-dash');
  dash.__gsNode = W.__gsDoc;
  const P = W.__gsProbe = { msgs: [], muts: [], looks: [], events: [], doc: W.__gsDoc };
  const PATH = ${JSON.stringify(path)};
  const rowOf = new WeakMap();
  const note = (root, p) => { const w = D.createTreeWalker(root, W.NodeFilter.SHOW_ALL); for (let n = w.currentNode; n; n = w.nextNode()) rowOf.set(n, p); };
  for (const r of D.querySelectorAll('.cd-row')) note(r, r.dataset.path);
  const zoneOf = (n) => {
    const p = rowOf.get(n);
    if (p !== undefined) return 'row:' + p;
    const e = n.nodeType === 1 ? n : n.parentElement;
    if (!e) return 'detached';
    if (e.closest('.cd-progress')) return 'progress';
    if (e.closest('.cd-why, .cd-counter')) return 'count';
    if (e === dash) return 'dashboard';
    const s = e.closest('.cd-dash > *');
    return s ? 'section:' + String(s.className).split(' ')[0] : 'outside';
  };
  const desc = (n) => n.nodeType === 3 ? '#text "' + n.nodeValue.slice(0, 40) + '"' : n.nodeType === 1 ? n.tagName.toLowerCase() + (n.getAttribute('class') ? '.' + n.getAttribute('class').trim().split(/\\s+/).join('.') : '') + (n.dataset && n.dataset.key ? '[' + n.dataset.key + ']' : '') : '#' + n.nodeType;
  const onMsg = (e) => P.msgs.push({ t: t(), data: JSON.parse(JSON.stringify(e.data)) });
  W.addEventListener('message', onMsg, true);
  const onPtr = (e) => { const k = e.target && e.target.closest && e.target.closest('[data-key]'); P.events.push({ t: t(), type: e.type, key: k ? k.dataset.key : null }); };
  for (const ty of ['pointerdown', 'pointerup', 'click']) D.addEventListener(ty, onPtr, true);
  // Anyone else at this window: the pointer moving (the press never moves it once
  // recording starts), a wheel, a key. The window is a real one on a machine in use.
  P.foreign = [];
  const onForeign = (e) => P.foreign.push({ t: t(), type: e.type, x: Math.round(e.clientX || 0), y: Math.round(e.clientY || 0), key: e.key });
  for (const ty of ['pointermove', 'wheel', 'keydown']) D.addEventListener(ty, onForeign, true);
  const mo = new W.MutationObserver((recs) => {
    for (const r of recs) {
      const zone = zoneOf(r.target);
      if (zone.startsWith('row:')) for (const n of r.addedNodes) note(n, zone.slice(4));
      P.muts.push({ t: t(), msg: P.msgs.length, zone, type: r.type, target: desc(r.target), attr: r.attributeName || undefined,
        key: r.target.dataset ? r.target.dataset.key : undefined, old: r.oldValue,
        now: r.type === 'attributes' ? r.target.getAttribute(r.attributeName) : r.type === 'characterData' ? r.target.nodeValue : undefined,
        added: r.addedNodes.length ? [...r.addedNodes].map(desc) : undefined, removed: r.removedNodes.length ? [...r.removedNodes].map(desc) : undefined });
    }
  });
  mo.observe(dash, { subtree: true, childList: true, attributes: true, attributeOldValue: true, characterData: true, characterDataOldValue: true });
  const last = new Map();
  let live = true;
  const look = () => {
    const now = t();
    for (const b of D.querySelectorAll('.cd-dash button[data-key]')) {
      const row = b.closest('.cd-row');
      const k = b.dataset.key;
      const cs = W.getComputedStyle(b);
      const r = b.getBoundingClientRect();
      const sig = [Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height), cs.visibility, cs.opacity, cs.display, cs.color, cs.backgroundColor, cs.borderTopColor, b.disabled ? 'disabled' : 'enabled', b.getAttribute('aria-disabled') === 'true' ? 'locked' : 'live'].join(' | ');
      const prev = last.get(k);
      if (prev && prev.sig !== sig) P.looks.push({ t: now, key: k, row: prev.row, from: prev.sig, to: sig });
      last.set(k, { sig, row: row ? row.dataset.path : null });
    }
    for (const [k, v] of [...last]) {
      if (!D.querySelector('[data-key="' + W.CSS.escape(k) + '"]')) { P.looks.push({ t: now, key: k, row: v.row, from: v.sig, to: 'GONE' }); last.delete(k); }
    }
    if (live) W.requestAnimationFrame(look);
  };
  look();
  P.stop = () => { live = false; mo.disconnect(); W.removeEventListener('message', onMsg, true); for (const ty of ['pointerdown', 'pointerup', 'click']) D.removeEventListener(ty, onPtr, true); for (const ty of ['pointermove', 'wheel', 'keydown']) D.removeEventListener(ty, onForeign, true); };
  // The places a press may change, in the page's CSS px.
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const row = [...D.querySelectorAll('.cd-row')].find((r) => r.dataset.path === PATH);
  const count = D.querySelector('.cd-why, .cd-counter');
  const cont = D.querySelector('.cd-foot [data-key="continue"]');
  const zones = [box(row), box(D.querySelector('.cd-progress'))];
  if (count) {
    const c = box(count);
    const right = cont ? box(cont).x - 2 : c.x + c.w + 40;
    zones.push({ x: c.x - 80, y: c.y - 2, w: right - (c.x - 80), h: c.h + 4 });
  }
  return { zones: zones.filter(Boolean), dpr: W.devicePixelRatio };
})()`;

const COLLECT = `(() => { ${INNER}
  const P = W.__gsProbe;
  if (!P) return { reloaded: true };
  const dash = D.querySelector('.cd-dash');
  P.stop();
  // What the progress bar SHOWS against what its label says (the page's CSP
  // drops a style written as an attribute: a label that moves over a bar that
  // does not).
  const bar = D.querySelector('.cd-bar'), fill = D.querySelector('.cd-bar-fill'), label = D.querySelector('.cd-progress-label');
  const m = label ? /^(\\d+) of (\\d+)/.exec(label.textContent) : null;
  const progress = bar && fill && m ? { shown: fill.getBoundingClientRect().width / bar.getBoundingClientRect().width, said: Number(m[1]) / Number(m[2]), label: label.textContent } : null;
  return { msgs: P.msgs, muts: P.muts, looks: P.looks, events: P.events, foreign: P.foreign, progress,
    sameDocument: W.__gsDoc === P.doc, sameDashboard: !!dash && dash.__gsNode === P.doc };
})()`;

// ── scenarios ────────────────────────────────────────────────────────────────

interface Act {
  kind: "click" | "hold" | "terminal";
  path: string;
  key?: string;
  side?: "ours" | "theirs";
}

interface Scenario {
  name: string;
  what: string;
  pick(rows: RowInfo[]): Act | undefined;
}

const pendingText = (r: RowInfo) =>
  !r.resolved && !r.busy && r.buttons.some((b) => b.text === "Merge…") && r.buttons.some((b) => b.text === "Accept Theirs");

const SCENARIOS: Scenario[] = [
  {
    name: "1-accept-yours-first-row",
    what: "Accept Yours on the FIRST row",
    pick: (rows) => {
      const r = rows[0];
      const b = r && !r.resolved ? r.buttons.find((x) => x.key === `accept:yours:${r.path}`) : undefined;
      return b ? { kind: "click", path: r.path, key: b.key } : undefined;
    },
  },
  {
    name: "2-accept-theirs-middle-row",
    what: "Accept Theirs on a MIDDLE row",
    pick: (rows) => {
      const mid = Math.floor(rows.length / 2);
      const order = rows.map((r, i) => ({ r, d: Math.abs(i - mid) })).sort((a, b) => a.d - b.d);
      const r = order.map((o) => o.r).find(pendingText);
      return r ? { kind: "click", path: r.path, key: `accept:theirs:${r.path}` } : undefined;
    },
  },
  {
    name: "3-delete-the-file",
    what: "Delete the file (a row whose other side deleted it)",
    pick: (rows) => {
      for (const r of rows) {
        if (r.resolved || r.busy) continue;
        const b = r.buttons.find((x) => x.text === "Delete the file");
        if (b) return { kind: "click", path: r.path, key: b.key };
      }
      return undefined;
    },
  },
  {
    name: "4-hold-to-undo",
    what: "Hold to undo on the first resolved row",
    pick: (rows) => {
      const r = rows.find((x) => x.resolved && x.buttons.some((b) => b.key === `restore:${x.path}`));
      return r ? { kind: "hold", path: r.path, key: `restore:${r.path}` } : undefined;
    },
  },
  {
    name: "5-resolved-in-a-terminal",
    what: "a file resolved from a terminal (git checkout --theirs + git add), no click",
    pick: (rows) => {
      const r = [...rows].reverse().find(pendingText);
      return r ? { kind: "terminal", path: r.path, side: "theirs" } : undefined;
    },
  },
];

// ── one scenario ─────────────────────────────────────────────────────────────

/** The run was disturbed (someone else's input reached the window): no verdict either way. */
class Disturbed extends Error {}

interface Verdict {
  scenario: string;
  what: string;
  act: Act;
  pass: boolean;
  failures: string[];
  messages: number;
  mutations: { total: number; inRow: number; progressAndCount: number; elsewhere: number };
  frames: { total: number; afterPress: number; changedOutsideRow: number };
}

async function runScenario(
  c: Cdp,
  pageSid: string,
  dash: Frame,
  s: Scenario,
  o: Options,
): Promise<{ verdict: Verdict; messages: unknown[] } | undefined> {
  const rows = await c.eval<RowInfo[]>(dash.sid, ROWS);
  const act = s.pick(rows);
  if (!act) {
    console.log(`SKIP ${s.name}: no row to do it on`);
    return undefined;
  }
  const dir = join(o.out, s.name);
  mkdirSync(join(dir, "frames"), { recursive: true });
  const at = await frameRect(c, pageSid, dash);
  // The pointer goes to the button FIRST, and the hovers settle, before
  // anything is recorded: the row it leaves fades its own hover out, which is
  // the pointer's doing, not the press's.
  let x = at.x + at.w / 2;
  let y = at.y + 8;
  if (act.kind !== "terminal") {
    const r = await c.eval<{ x: number; y: number; w: number; h: number } | null>(
      dash.sid,
      // A long list scrolls: bring the row into view first (before anything is recorded).
      `(async () => { ${INNER} const b = D.querySelector('[data-key="' + CSS.escape(${JSON.stringify(act.key)}) + '"]'); if (!b) return null; b.scrollIntoView({ block: 'nearest' }); await new Promise((res) => setTimeout(res, 300)); const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`,
    );
    if (!r) throw new Error(`${s.name}: no button ${act.key}`);
    x = at.x + r.x + r.w / 2;
    y = at.y + r.y + r.h / 2;
  }
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, pageSid);
  await sleep(700);
  const probe = await c.eval<{ zones: { x: number; y: number; w: number; h: number }[]; dpr: number }>(dash.sid, PROBE(act.path));

  // The screen, every frame the compositor makes.
  const frames: { png: Buffer; ts: number; deviceWidth: number }[] = [];
  const onFrame = (m: CdpMessage) => {
    if (m.method !== "Page.screencastFrame" || m.sessionId !== pageSid) return;
    const p = m.params as { data: string; sessionId: number; metadata: { timestamp: number; deviceWidth: number } };
    frames.push({ png: Buffer.from(p.data, "base64"), ts: p.metadata.timestamp, deviceWidth: p.metadata.deviceWidth });
    void c.send("Page.screencastFrameAck", { sessionId: p.sessionId }, pageSid);
  };
  c.listeners.add(onFrame);
  await c.send("Page.startScreencast", { format: "png", everyNthFrame: 1 }, pageSid);
  await sleep(800);

  let pressedAt = 0;
  if (act.kind === "terminal") {
    pressedAt = Date.now() / 1000;
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    execFileSync("git", ["-C", o.repo, "checkout", `--${act.side}`, "--", act.path], { env });
    execFileSync("git", ["-C", o.repo, "add", "--", act.path], { env });
  } else {
    pressedAt = Date.now() / 1000;
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, pageSid);
    await sleep(act.kind === "hold" ? 750 + 550 : 50);
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, pageSid);
  }
  await sleep(Math.max(3000, o.settle));
  await c.send("Page.stopScreencast", {}, pageSid);
  await sleep(300);
  c.listeners.delete(onFrame);
  const got = await c.eval<{
    reloaded?: boolean;
    msgs: { t: number; data: unknown }[];
    muts: { zone: string; type: string; target: string; attr?: string; key?: string; old?: string; now?: string; added?: string[]; removed?: string[] }[];
    looks: { t: number; key: string; row: string | null; from: string; to: string }[];
    events: { t: number; type: string; key: string | null }[];
    progress: { shown: number; said: number; label: string } | null;
    foreign: { t: number; type: string; x: number; y: number; key?: string }[];
    sameDocument: boolean;
    sameDashboard: boolean;
  }>(dash.sid, COLLECT);

  if (got.foreign?.length) {
    // Someone used the window while it was recording (it is a real window on
    // a machine in use): what it saw is not the press's doing. Not a verdict.
    const f = got.foreign[0];
    throw new Disturbed(`${got.foreign.length} input events that were not the press (first: ${f.type} at ${f.x},${f.y})`);
  }
  const failures: string[] = [];
  if (got.reloaded || !got.sameDocument || !got.sameDashboard) failures.push("the page was reloaded or the dashboard rebuilt (the probe did not survive)");
  if (got.progress && Math.abs(got.progress.shown - got.progress.said) > 0.03) {
    failures.push(`the progress bar shows ${Math.round(got.progress.shown * 100)}% under "${got.progress.label}"`);
  }
  // What was written, and where.
  const mine = `row:${act.path}`;
  const allowed = (m: (typeof got.muts)[number]) =>
    m.zone === mine || m.zone === "progress" || m.zone === "count" || (m.key === "continue" && m.attr === "title");
  const elsewhere = (got.muts ?? []).filter((m) => !allowed(m));
  for (const m of elsewhere.slice(0, 12)) {
    failures.push(`written outside the pressed row: ${m.zone} ${m.type}${m.attr ? ` ${m.attr} ${JSON.stringify(m.old)} -> ${JSON.stringify(m.now)}` : ""} on ${m.target}${m.added ? ` +${m.added.join(",")}` : ""}${m.removed ? ` -${m.removed.join(",")}` : ""}`);
  }
  // What was SEEN on every other button, frame by frame.
  const otherLooks = (got.looks ?? []).filter((l) => l.row !== act.path);
  for (const l of otherLooks.slice(0, 12)) failures.push(`${l.key} changed its look: ${l.from} -> ${l.to}`);
  if (act.kind !== "terminal" && !(got.events ?? []).some((e) => e.type === "pointerdown" && e.key === act.key)) {
    failures.push(`the press never reached ${act.key}`);
  }

  // The screen: every frame after the press against the last one before it,
  // outside the places the press may change.
  const scale = frames.length ? decodePng(frames[0].png).width / frames[0].deviceWidth : 2;
  const crops: { img: Image; ms: number }[] = frames.map((f) => ({
    img: crop(decodePng(f.png), at.x * scale, at.y * scale, at.w * scale, at.h * scale),
    ms: Math.round((f.ts - pressedAt) * 1000),
  }));
  const zones = probe.zones.map((z) => ({ x: (z.x - 3) * scale, y: (z.y - 3) * scale, w: (z.w + 6) * scale, h: (z.h + 6) * scale }));
  const inZone = (x: number, y: number) => zones.some((z) => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h);
  const base = [...crops].reverse().find((f) => f.ms < 0) ?? crops[0];
  let changedFrames = 0;
  const frameNotes: { ms: number; changedOutside: number; box?: number[] }[] = [];
  for (const f of crops) {
    if (f.ms < 0 || !base || f.img.width !== base.img.width || f.img.height !== base.img.height) continue;
    let n = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < f.img.height; y++) {
      for (let x = 0; x < f.img.width; x++) {
        const i = (y * f.img.width + x) * 4;
        const d = Math.max(
          Math.abs(f.img.data[i] - base.img.data[i]),
          Math.abs(f.img.data[i + 1] - base.img.data[i + 1]),
          Math.abs(f.img.data[i + 2] - base.img.data[i + 2]),
        );
        if (d > 24 && !inZone(x, y)) {
          n++;
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
    }
    frameNotes.push({ ms: f.ms, changedOutside: n, ...(n ? { box: [x0, y0, x1, y1].map((v) => Math.round(v / scale)) } : {}) });
    if (n > 0) changedFrames++;
  }
  if (frameNotes.length === 0) {
    // A window that paints nothing (hidden, minimised) would pass the frame
    // check over no frames at all: the press itself changes its row, so a
    // recording without one frame after it saw nothing.
    failures.push("the screen recorded no frame after the press (is the window hidden or minimised?)");
  }
  if (changedFrames > 0) {
    const worst = frameNotes.filter((f) => f.changedOutside > 0).slice(0, 3);
    failures.push(`${changedFrames} frames changed outside the pressed row: ${worst.map((w) => `+${w.ms}ms ${w.changedOutside}px in [${w.box?.join(",")}]`).join("; ")}`);
  }
  // Keep the pictures: every frame (half size), and a strip around the press.
  crops.forEach((f, i) => {
    writeFileSync(join(dir, "frames", `${String(i).padStart(3, "0")}_${f.ms >= 0 ? "+" : ""}${f.ms}ms.png`), encodePng(shrink(f.img, 2)));
  });
  const around = crops.filter((f) => f.ms >= -120 && f.ms <= 1500);
  const pick = around.length > 16 ? around.filter((_, i) => i % Math.ceil(around.length / 16) === 0) : around;
  const strip = [...pick, crops[crops.length - 1]].filter(Boolean).map((f) => shrink(f.img, 4));
  if (strip.length) writeFileSync(join(dir, "strip.png"), encodePng(sheet(strip, 4)));

  const messages = (got.msgs ?? []).map((m) => ({ t: m.t, data: m.data }));
  const verdict: Verdict = {
    scenario: s.name,
    what: s.what,
    act,
    pass: failures.length === 0,
    failures,
    messages: messages.length,
    mutations: {
      total: got.muts?.length ?? 0,
      inRow: (got.muts ?? []).filter((m) => m.zone === mine).length,
      progressAndCount: (got.muts ?? []).filter((m) => m.zone === "progress" || m.zone === "count" || (m.key === "continue" && m.attr === "title")).length,
      elsewhere: elsewhere.length,
    },
    frames: { total: crops.length, afterPress: frameNotes.length, changedOutsideRow: changedFrames },
  };
  writeFileSync(join(dir, "report.json"), JSON.stringify({ ...verdict, frameNotes, zones: probe.zones, mutations: got.muts, looks: got.looks, events: got.events }, null, 1));
  writeFileSync(join(dir, "messages.json"), JSON.stringify(messages, null, 1));
  console.log(`${verdict.pass ? "PASS" : "FAIL"} ${s.name}: ${s.what} on ${act.path} — ${messages.length} host messages, ${verdict.mutations.inRow} writes in its row, ${verdict.mutations.progressAndCount} to the progress and count, ${verdict.mutations.elsewhere} elsewhere; ${changedFrames}/${frameNotes.length} frames changed outside it`);
  for (const f of failures) console.log(`   - ${f}`);
  return { verdict, messages };
}

// ── theme screenshots of the list ────────────────────────────────────────────

async function themeShots(c: Cdp, pageSid: string, o: Options): Promise<void> {
  const settings = join(o.out, "profile", "udd", "User", "settings.json");
  for (const theme of o.shots) {
    const cur = JSON.parse(readFileSync(settings, "utf8")) as Record<string, unknown>;
    cur["workbench.colorTheme"] = theme;
    writeFileSync(settings, JSON.stringify(cur, null, 2));
    await sleep(2500);
    const dash = await findDashboard(c, pageSid);
    const at = await frameRect(c, pageSid, dash);
    const shot = await c.send<{ data: string }>(
      "Page.captureScreenshot",
      { format: "png", clip: { x: at.x, y: at.y, width: at.w, height: at.h, scale: 1 } },
      pageSid,
    );
    const file = join(o.out, `list-${theme.replace(/\W+/g, "-").toLowerCase()}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    console.log(`shot ${file}`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const out = resolve(flag("out") ?? "/tmp/gs-dashboard-clicks");
  const vsix = flag("vsix");
  let repo = flag("repo");
  const scenario = flag("scenario");
  if (!vsix || (!repo && !scenario)) {
    console.error("usage: dashboardClicks.ts --vsix <dir> (--repo <stopped repository> | --scenario <op.style>) [--out <dir>] [--port 9873] [--settle 4000] [--shots 'Default Dark Modern,Default Light Modern'] [--keep-profile]");
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  if (!repo) {
    const [op, style] = scenario!.split(".");
    const target = join(out, "matrix");
    rmSync(target, { recursive: true, force: true });
    buildMatrix(target, { ops: [op], styles: [style] });
    repo = join(target, op, style);
  }
  if (!existsSync(join(repo, ".git"))) throw new Error(`not a repository: ${repo}`);
  const o: Options = {
    vsix: resolve(vsix),
    repo: resolve(repo),
    out,
    port: Number(flag("port") ?? 9873),
    theme: flag("theme") ?? "Default Dark Modern",
    settle: Number(flag("settle") ?? 4000),
    shots: (flag("shots") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    keepProfile: has("keep-profile"),
  };
  const vs = launchVsCode(o);
  let c: Cdp | undefined;
  let failed = false;
  let disturbed = false;
  try {
    c = await Cdp.connect(o.port);
    const { targetInfos } = await c.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
    const page = targetInfos.find((t) => t.type === "page" && /workbench\.html/.test(t.url));
    if (!page) throw new Error("no workbench window");
    const pageSid = await c.attach(page.targetId);
    // Behave as the focused window the owner clicks in — without focusing
    // (or raising) any real window.
    await c.send("Emulation.setFocusEmulationEnabled", { enabled: true }, pageSid).catch(() => undefined);
    const window = async (name: string) => {
      if (!process.env.GS_DASH_DEBUG) return;
      const s = await c!.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, pageSid);
      writeFileSync(join(o.out, `debug-${name}.png`), Buffer.from(s.data, "base64"));
    };
    await findDashboard(c, pageSid);
    await window("found");
    await sleep(2500); // the first git events after opening settle
    await window("settled");
    // A fresh profile's first-run notices (the coexistence question, the
    // blame note) sit over the dashboard's corner: close them, so the
    // recordings show the list.
    for (let i = 0; i < 3; i++) {
      await c.eval(pageSid, `(() => { for (const b of document.querySelectorAll('.notifications-toasts .codicon-notifications-clear')) b.click(); })()`);
      await sleep(500);
    }
    // Looked for again once the start has settled (Merge Studio's own
    // dashboard, if it opened too, has stood down by now).
    const dash = await findDashboard(c, pageSid);
    await window("ready");
    const log: { scenario: string; act: Act; messages: unknown[] }[] = [];
    const verdicts: Verdict[] = [];
    const only = (flag("only") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    for (const s of SCENARIOS.filter((x) => only.length === 0 || only.includes(x.name.split("-")[0]))) {
      let r: Awaited<ReturnType<typeof runScenario>>;
      try {
        r = await runScenario(c, pageSid, dash, s, o);
      } catch (e) {
        if (e instanceof Disturbed) {
          console.log(`DISTURBED ${s.name}: ${e.message} — someone used the window; run again on a fresh repository`);
          disturbed = true;
          break;
        }
        // The webview it was driving went away mid-press: that IS the page
        // being re-created — a failure, not a harness error.
        const still = (await dashboards(c, pageSid)).some((d) => d.id === dash.id);
        console.log(`FAIL ${s.name}: ${still ? "the probe failed" : "the dashboard's webview went away (re-created or closed)"}: ${e instanceof Error ? e.message : e}`);
        failed = true;
        break;
      }
      if (!r) continue;
      verdicts.push(r.verdict);
      log.push({ scenario: s.name, act: r.verdict.act, messages: r.messages });
      if (!r.verdict.pass) failed = true;
    }
    // The state on screen before the first press: the probe starts after the
    // page has it, so it is the first message with the pressed row as it was
    // (the host marks nothing else when a row goes busy — dashboardController).
    const firstState = (log[0]?.messages[0] as { data?: { state?: { files: { path: string; status: string }[] } } } | undefined)?.data?.state;
    const initial = firstState && {
      ...firstState,
      files: firstState.files.map((f) => (f.path === log[0].act.path && f.status === "busy" ? { ...f, status: "pending" } : f)),
    };
    writeFileSync(
      join(o.out, "replay.json"),
      JSON.stringify({ recordedWith: "scripts/merge-e2e/dashboardClicks.ts", repo: basename(o.repo), initial, scenarios: log }, null, 1),
    );
    writeFileSync(join(o.out, "summary.json"), JSON.stringify(verdicts, null, 1));
    if (o.shots.length) await themeShots(c, pageSid, o);
  } finally {
    c?.close();
    vs.stop();
  }
  console.log(failed ? "FAILED" : disturbed ? "DISTURBED: no verdict" : "PASSED: every press changed its own row, the progress and the count — nothing else, on the page or on the screen");
  process.exitCode = failed ? 1 : disturbed ? 3 : 0;
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
