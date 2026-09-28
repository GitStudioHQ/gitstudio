// The GitStudio extension's README hero (apps/extension/media/shots/hero.gif):
// one take in real VS Code, driven with real clicks and keys over CDP and
// recorded with Page.startScreencast, then resampled to a steady frame rate
// and encoded with gifski.
//
//   (cd apps/extension && npm run package && npx @vscode/vsce package --no-dependencies -o /tmp/gs-vsix/)
//   npx tsx scripts/extension-shots/hero.ts --vsix /tmp/gs-vsix [--out apps/extension/media/shots/hero.gif]
//
// The story, about nine seconds: three commits picked in the Commit Graph
// (Squash / Cherry-pick / Revert / Drop offered for all three), a stash opened
// to its files, one change of a file ticked in GitStudio's diff (the file is
// now partly staged), a message typed, Commit — and the new commit lands at
// the top of the graph and the rail.
//
// CDP input draws no pointer, so the page gets a drawn one (and a ring on
// each click) for the take; it takes no events. Needs ffmpeg and gifski.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cdp, Workbench, launchVsCode, sleep, jsLiteral, type Webview } from "./vscode";
import { changesView, graphView, openFile, openGraph, reset, rowBySubject } from "./ui";

const REPO = resolve(__dirname, "../..");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** The window of the take (CSS px, recorded at 2x). */
const WIN = { w: 1280, h: 800 };
const SIDEBAR = 316;
const MESSAGE = "feat(sitemap): escape URLs";

interface Frame {
  ts: number;
  file: string;
}

class Recorder {
  readonly frames: Frame[] = [];
  private n = 0;
  private listener?: (m: { method?: string; params?: Record<string, unknown>; sessionId?: string }) => void;
  started = 0;
  stopped = 0;

  constructor(
    private readonly wb: Workbench,
    private readonly dir: string,
  ) {}

  async start(): Promise<void> {
    const { c, sid } = this.wb;
    this.listener = (m) => {
      if (m.method !== "Page.screencastFrame" || m.sessionId !== sid) return;
      const p = m.params as { data: string; sessionId: number; metadata: { timestamp?: number } };
      c.send("Page.screencastFrameAck", { sessionId: p.sessionId }, sid).catch(() => undefined);
      const file = join(this.dir, `f${String(++this.n).padStart(5, "0")}.jpg`);
      writeFileSync(file, Buffer.from(p.data, "base64"));
      this.frames.push({ ts: p.metadata.timestamp ?? Date.now() / 1000, file });
    };
    c.listeners.add(this.listener as never);
    this.started = Date.now() / 1000;
    await c.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 }, sid);
  }

  async stop(): Promise<void> {
    this.stopped = Date.now() / 1000;
    await this.wb.c.send("Page.stopScreencast", {}, this.wb.sid);
    await sleep(300);
    if (this.listener) this.wb.c.listeners.delete(this.listener as never);
  }
}

/**
 * Frames with their timestamps -> a steady-rate GIF, `width` px wide, played
 * `speed` times as fast as it was recorded.
 */
function encode(rec: Recorder, work: string, out: string, fps: number, width: number, quality: number, speed: number): void {
  const frames = rec.frames.filter((f) => f.ts >= rec.started - 0.5).sort((a, b) => a.ts - b.ts);
  if (frames.length < 2) throw new Error(`only ${frames.length} frames recorded`);
  const end = Math.max(rec.stopped, frames[frames.length - 1].ts + 0.1);
  const lines = ["ffconcat version 1.0"];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].ts : end;
    lines.push(`file '${f.file}'`, `duration ${Math.max(0.001, (next - f.ts) / speed).toFixed(4)}`);
  });
  lines.push(`file '${frames[frames.length - 1].file}'`); // the concat demuxer drops the last duration otherwise
  const list = join(work, "frames.ffconcat");
  writeFileSync(list, lines.join("\n") + "\n");
  const png = join(work, "png");
  rmSync(png, { recursive: true, force: true });
  mkdirSync(png);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-vf", `fps=${fps},scale=${width}:-1:flags=lanczos`, "-start_number", "0", join(png, "%05d.png")], { stdio: "inherit" });
  const pngs = readdirSync(png).filter((f) => f.endsWith(".png")).sort().map((f) => join(png, f));
  execFileSync("gifski", ["--quiet", "--fps", String(fps), "--quality", String(quality), "--width", String(width), "-o", out, ...pngs], { stdio: "inherit" });
  console.log(`${out}: ${pngs.length} frames, ${(pngs.length / fps).toFixed(1)} s, ${(statSync(out).size / 1024 / 1024).toFixed(2)} MB`);
}

async function main(): Promise<void> {
  const vsix = flag("vsix");
  if (!vsix) {
    console.error("usage: hero.ts --vsix <dir with the .vsix> [--out apps/extension/media/shots/hero.gif] [--port 9892] [--fps 15] [--width 1200] [--quality 90] [--speed 1.15] [--demo /tmp/gs-demo-hero] [--keep-frames]");
    process.exit(2);
  }
  const out = resolve(flag("out") ?? join(REPO, "apps/extension/media/shots/hero.gif"));
  const port = Number(flag("port") ?? 9892);
  const demo = flag("demo") ?? "/tmp/gs-demo-hero";
  const fps = Number(flag("fps") ?? 20);
  const width = Number(flag("width") ?? 1200);
  const quality = Number(flag("quality") ?? 90);
  const speed = Number(flag("speed") ?? 1.25);
  const work = mkdtempSync(join(tmpdir(), "gs-hero-"));
  const framesDir = join(work, "frames");
  mkdirSync(framesDir);

  execFileSync("bash", [join(REPO, "scripts/extension-shots/make-demo-repo.sh"), demo], { stdio: "pipe" });
  const vs = launchVsCode({
    vsixDir: resolve(vsix),
    folder: join(demo, "lumen"),
    profile: join(work, "profile"),
    port,
    width: WIN.w,
    height: WIN.h,
    theme: "Default Dark Modern",
    settings: {
      // No hover cards over the take.
      "workbench.hover.delay": 10000,
      "editor.hover.enabled": false,
    },
  });
  let c: Cdp | undefined;
  let rec: Recorder | undefined;
  try {
    c = await Cdp.connect(port);
    const wb = await Workbench.attach(c);
    const size = await wb.size();
    if (size.w !== WIN.w || size.h !== WIN.h) throw new Error(`the window is ${size.w}x${size.h}, not ${WIN.w}x${WIN.h}`);
    await sleep(4000);

    // ── the set: GitStudio's side bar, the ticks diff above, the graph below ──
    await reset(wb);
    await wb.setSidebarWidth(SIDEBAR);
    await wb.setPane("Worktrees", false);
    await wb.setPane("Pull Requests", false);
    await wb.setPane("Changes", true);
    await wb.setPane("Commits", true);
    await openFile(wb, "src/sitemap.ts");
    await wb.clickAction(".editor-actions", "Stage Changes with Ticks");
    const diff = await wb.webview(`Q('.jb-stage-tick').length >= 2`, 20_000);
    await wb.command("View: Close Other Editors in Group");
    await openGraph(wb, false);
    await wb.setPanelHeight(Math.round(WIN.h * 0.47));
    await wb.command("Notifications: Clear All Notifications");
    const graph = await graphView(wb);
    const changes = await changesView(wb);
    await sleep(1500);
    await wb.verify("hero (start)", ["Diff: sitemap.ts", "Commit Graph", "Commit 2", "WIP: retry cache writes with backoff", "feat(build): write sitemap.xml next to the pages"]);

    // A synthetic pointer that moves from one frame to another never sends
    // the frame it left its pointerout, and the workbench keeps its hover
    // too: whatever was last under the pointer stays lit (a tooltip, a lane
    // highlight, Monaco's scrollbars, a tab). So the pointer leaves each page
    // along its top band — a quiet stretch of its toolbar, then the quiet
    // padding at its edge — straight into the next page.
    const quietIn = async (w: Webview, what: string, from?: number, to?: number) => {
      const s = await w.quietSpot({ topOnly: true, from, to });
      if (!s) throw new Error(`no quiet spot in ${what}`);
      return s;
    };
    const edgeOf = async (w: Webview, side: "left" | "right", at: { y: number }, what: string) => {
      const s = await w.edgeExit(side, at.y);
      if (!s) throw new Error(`no quiet ${side} edge in ${what}`);
      return s;
    };
    const changesExit = await quietIn(changes, "the Changes view's branch bar", 0.4, 0.7);
    const outOfChanges = [changesExit, await edgeOf(changes, "right", changesExit, "the Changes view")];
    const diffExit = await quietIn(diff, "the diff's toolbar", 0.4, 0.9);
    const changesHeader = (await wb.pane("Changes"))!.r;
    const outOfDiff = [
      diffExit,
      await edgeOf(diff, "left", diffExit, "the diff"),
      { x: changesHeader.x + changesHeader.w * 0.5, y: changesHeader.y + changesHeader.h / 2 },
    ];

    const start = await graph.frame();
    await wb.move(start.x + start.w * 0.7, start.y + start.h * 0.62);
    await wb.showCursor();
    await sleep(500);

    // ── the take ──
    rec = new Recorder(wb, framesDir);
    await rec.start();
    const watch = wb.watchForbidden();
    const t0 = Date.now();
    const mark = (what: string) => console.log(`${((Date.now() - t0) / 1000).toFixed(2)}s ${what}`);
    await sleep(400);
    // Clicked near the subject's start: when the details pane opens the
    // columns to the right move, and a pointer left over the author column
    // would bring up its card.
    const subject = (s: string) => `${rowBySubject(s)}.querySelector('.subject')`;
    await graph.click(subject("feat(build): write sitemap.xml next to the pages"), { glide: 450, dx: 28 });
    await sleep(350);
    await graph.click(subject("feat(config): turn the sitemap off with sitemap: false"), { modifiers: 4, glide: 250, dx: 34 });
    await sleep(150);
    await graph.click(subject("feat: sitemap.xml"), { modifiers: 4, glide: 250, dx: 30 });
    await graph.waitFor(`H('3 commits selected')`, 5_000);
    mark("three commits selected");
    // (the header's quiet stretch, as laid out now the details pane is open)
    const graphExit = await quietIn(graph, "the graph's header", 0.12, 0.55);
    const outOfGraph = [graphExit, await edgeOf(graph, "left", graphExit, "the graph")];
    await sleep(550);

    const stash = `Q('.stash-row').find((r) => r.textContent.includes('WIP: retry cache writes'))`;
    await changes.click(`${stash}.querySelector('.twisty')`, { glide: 800, via: outOfGraph });
    await changes.waitFor(`Q('.stash-file').length >= 2`, 5_000);
    mark("stash open");
    await sleep(400);

    await diff.click(`Q('.jb-stage-tick')[0]`, { glide: 750, via: outOfChanges });
    await changes.waitFor(`Q('.group--staged .row.is-file').some((r) => r.dataset.path === 'src/sitemap.ts')`, 5_000);
    mark("change staged");
    await sleep(400);

    // Clicked towards the box's right end, so the pointer does not sit on
    // the message as it is typed.
    await changes.click(`Q1('.message-wrap textarea') || Q1('textarea')`, { glide: 750, dx: 185, dy: 16, via: outOfDiff });
    await sleep(100);
    await wb.typeKeys(MESSAGE, 22);
    mark("message typed");
    await sleep(150);
    await changes.click(`Q('button').find((b) => /^\\s*Commit\\s+\\d/.test(b.textContent || ''))`, { glide: 320 });
    await graph.waitFor(`H(${jsLiteral(MESSAGE)})`, 8_000, "the new commit in the graph");
    mark("committed, in the graph");
    // At rest on a quiet stretch of the branch bar, beside Push 3.
    const rest = await quietIn(changes, "the Changes view's branch bar", 0.4, 0.7);
    await wb.move(rest.x, rest.y, 350);
    await sleep(1200);
    mark("end");
    await rec.stop();
    const seen = await watch.stop();
    if (seen.hits.length) throw new Error(`forbidden text on screen during the take: ${seen.hits.map((h) => JSON.stringify(h)).join(", ")}`);
    console.log(`checked the screen ${seen.samples} times during the take: nothing forbidden`);

    await wb.hideCursor();
    await wb.verify("hero (end)", [MESSAGE, "Push 3", "3 commits selected"]);
    encode(rec, work, out, fps, width, quality, speed);
  } finally {
    c?.close();
    vs.stop();
    if (!process.argv.includes("--keep-frames")) rmSync(work, { recursive: true, force: true });
    else console.log(`frames kept in ${work}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
