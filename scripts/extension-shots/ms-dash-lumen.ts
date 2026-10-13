// Merge Studio 1.4.0's conflicts dashboard on the lumen demo, stopped mid-rebase
// (feature/drafts onto main, four conflicted files). Real VS Code, isolated profile.
//
//   scripts/extension-shots/make-demo-repo.sh /tmp/gs-demo
//   (cd apps/merge-studio && npm run package && npx @vscode/vsce package --no-dependencies -o /tmp/ms-vsix/)
//   npx tsx scripts/extension-shots/ms-dash-lumen.ts <out-dir>
//
// It replaces site-shots.ts's ms-dashboard scene, which uses the merge test matrix.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Cdp, Workbench, launchVsCode, sleep } from "./vscode";
import { REST, reset, showSidebar } from "./ui";

const OUT = process.argv[2];
const PORT = 9897;
const EXPECT = ["Continue Rebase", "build.ts", "cli.ts", "config.ts", "build.test.ts"];
const BAD = /playground|Matrix Bot|f\.txt|Screenshot pending|Get Started with|Welcome/;

async function main(): Promise<void> {
  const vs = launchVsCode({
    vsixDir: "/tmp/ms-vsix",
    folder: "/tmp/gs-demo/lumen",
    profile: "/tmp/gs-msdash-profile",
    port: PORT,
    width: 1280,
    height: 820,
    theme: "Default Dark Modern",
  });
  let c: Cdp | undefined;
  try {
    c = await Cdp.connect(PORT);
    const wb = await Workbench.attach(c);
    const size = await wb.size();
    if (size.w !== 1280 || size.h !== 820) throw new Error(`window ${size.w}x${size.h}`);
    await sleep(6000);
    await reset(wb).catch(async () => {
      await wb.command("View: Close All Editors");
      await wb.command("Notifications: Clear All Notifications");
    });
    await showSidebar(wb, false).catch(() => undefined);
    await wb.command("Merge Studio: Resolve Conflicts");
    const d = await wb.webview(`H('Continue Rebase')`, 30_000);
    await wb.command("View: Close Other Editors in Group").catch(() => undefined);
    await wb.command("Notifications: Clear All Notifications").catch(() => undefined);
    await sleep(1500);
    await d.leave(REST);
    console.log("DASH TEXT:", await d.eval<string>(`D.body.innerText`));
    const ed = await wb.rect(".part.editor");
    const f = await d.frame();
    const bottom = await d.eval<number>(
      `Math.max(...[...D.body.querySelectorAll('button, a, h1, h2, li, [role=row], .row, footer, p, span')].filter((e) => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < innerHeight * 0.8).map((e) => e.getBoundingClientRect().bottom))`,
    );
    if (!ed) throw new Error("no editor part");
    const clip = { x: Math.round(ed.x), y: Math.round(ed.y), w: Math.round(ed.w), h: Math.round(Math.min(ed.y + ed.h, f.y + bottom + 28) - ed.y) };
    console.log("clip", JSON.stringify(clip));
    await wb.move(REST.x, REST.y);
    await sleep(600);
    writeFileSync(join(OUT, ".full-ms-dashboard.png"), await wb.screenshot());
    await wb.verify("ms-dashboard", EXPECT);
    const text = await wb.allText();
    const bad = BAD.exec(text);
    if (bad) throw new Error(`"${bad[0]}" on screen`);
    const png = await wb.screenshot(clip);
    await wb.verify("ms-dashboard", EXPECT);
    const file = join(OUT, "ms-dashboard.png");
    writeFileSync(file, png);
    execFileSync("oxipng", ["-o", "4", "--strip", "safe", "-q", file]);
    console.log("ok", file);
  } finally {
    c?.close();
    vs.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
