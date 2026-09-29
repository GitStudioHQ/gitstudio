import { electron } from "./desktopMainFakeElectron";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pngFromIcns, withIcons, openEditor, revealRoot, editorsView } from "../src/main/editors";
import type { EditorView } from "../src/shared/ipc";
import { removeTempRepo } from "./tmpRepo";

// The OS-touching half of "Open in <editor>": reading an icon out of a macOS
// .icns, decorating the editor list with each app's real icon (and never a
// custom command's), launching the pick, and revealing the folder. Electron is
// the stub in desktopMainFakeElectron.ts; the launches are real spawns of this
// test's own node binary, so nothing but node is ever started.

const dir = mkdtempSync(join(tmpdir(), "gitstudio-editors-"));
after(() => removeTempRepo(dir));
electron.paths.temp = dir;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (tag: string): Buffer => Buffer.concat([PNG_MAGIC, Buffer.from(tag)]);

/** An .icns container: "icns" + total length, then type(4) length(4) data chunks. */
function icns(chunks: Array<[string, Buffer]>): Buffer {
  const parts = chunks.map(([type, data]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

let n = 0;
function file(bytes: Buffer): string {
  const p = join(dir, `icon-${n++}.icns`);
  writeFileSync(p, bytes);
  return p;
}

// ── .icns ──────────────────────────────────────────────────────────────────

test("the icns reader takes the smallest PNG rep that still covers a retina slot", () => {
  const p = file(
    icns([
      ["ic10", png("1024")],
      ["ic07", png("128")],
      ["ic12", png("64@2x")],
    ]),
  );
  assert.deepEqual(pngFromIcns(p), png("64@2x"));
});

test("the icns reader skips non-PNG reps and falls back to any PNG it found", () => {
  const argb = Buffer.from("ARGB-not-a-png-at-all");
  const p = file(
    icns([
      ["ic12", argb],
      ["zzzz", png("odd type")],
    ]),
  );
  assert.deepEqual(pngFromIcns(p), png("odd type"), "the legacy rep is not served as a PNG");
  assert.equal(pngFromIcns(file(icns([["it32", argb]]))), undefined, "no PNG at all is no icon");
});

test("the icns reader refuses what is not an icns, a missing file and a chunk that overruns", () => {
  assert.equal(pngFromIcns(join(dir, "not-there.icns")), undefined);
  assert.equal(pngFromIcns(file(Buffer.from("PNG? no, a text file"))), undefined);
  assert.equal(pngFromIcns(file(Buffer.from("icn"))), undefined, "shorter than a header");

  // A chunk whose length runs past the end stops the walk — it is not read
  // out of bounds, and the good chunk before it still counts.
  const good = icns([["ic07", png("ok")]]);
  const bad = Buffer.alloc(8);
  bad.write("ic12", 0, "ascii");
  bad.writeUInt32BE(10_000, 4);
  assert.deepEqual(pngFromIcns(file(Buffer.concat([good, bad]))), png("ok"));
});

// ── icons on the list ──────────────────────────────────────────────────────

const view = (editors: Array<Partial<EditorView> & { id: string }>): { editors: EditorView[]; defaultId?: string } => ({
  editors: editors.map((e) => ({ name: e.id, via: "cli", shown: true, isDefault: false, location: "", ...e }) as EditorView),
});

test("each editor wears the OS's icon for its executable; a custom command wears none", async () => {
  const code = join(dir, "bin", "code");
  const broken = join(dir, "bin", "vanished");
  const blank = join(dir, "bin", "blank");
  electron.icons[code] = "vscode-mark";
  electron.icons[broken] = new Error("ENOENT");
  electron.icons[blank] = "";
  const v = await withIcons(
    view([
      { id: "vscode", location: code },
      { id: "gone", location: broken },
      { id: "blank", location: blank },
      { id: "mine", via: "custom", location: "my-editor --wait {path}" },
      { id: "nowhere", location: "" },
    ]),
  );
  const byId = new Map(v.editors.map((e) => [e.id, e]));
  assert.equal(byId.get("vscode")?.icon, `data:image/png;base64,${Buffer.from("vscode-mark").toString("base64")}`);
  assert.equal(byId.get("gone")?.icon, undefined, "a path that vanished falls back to the glyph");
  assert.equal(byId.get("blank")?.icon, undefined, "an empty image is no icon");
  assert.equal("icon" in (byId.get("mine") ?? {}), false, "a command is not an application");
  assert.equal("icon" in (byId.get("nowhere") ?? {}), false);
  assert.equal(electron.iconAsks.includes("my-editor --wait {path}"), false, "never asked the OS about a command line");

  // Cached by path: the list repaints without asking the OS again.
  const asked = electron.iconAsks.length;
  electron.icons[code] = "changed";
  const again = await withIcons(view([{ id: "vscode", location: code }]));
  assert.equal(electron.iconAsks.length, asked);
  assert.equal(again.editors[0].icon, byId.get("vscode")?.icon);
});

function bundle(name: string, plist: string | undefined, icon?: Buffer, iconFile = "AppIcon.icns"): string {
  const b = join(dir, `${name}.app`);
  mkdirSync(join(b, "Contents", "Resources"), { recursive: true });
  if (plist !== undefined) writeFileSync(join(b, "Contents", "Info.plist"), plist);
  if (icon) writeFileSync(join(b, "Contents", "Resources", iconFile), icon);
  return b;
}

const plistNaming = (icon: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
  `<plist version="1.0"><dict><key>CFBundleIconFile</key><string>${icon}</string></dict></plist>\n`;

test(
  "a macOS bundle's icon is the icns its Info.plist names, decoded from its PNG rep",
  { skip: process.platform !== "darwin" && "reads bundles with macOS's own plutil" },
  async () => {
    const named = bundle("Named", plistNaming("AppIcon"), icns([["ic12", png("the real mark")]]));
    // The name may already carry the extension.
    const withExt = bundle("WithExt", plistNaming("Other.icns"), icns([["ic07", png("other mark")]]), "Other.icns");
    const v = await withIcons(view([{ id: "named", via: "app", location: named }, { id: "ext", via: "app", location: withExt }]));
    assert.equal(v.editors[0].icon, `data:image/png;base64,${Buffer.from(`png:${png("the real mark").length}@64x64`).toString("base64")}`);
    assert.match(v.editors[1].icon ?? "", /^data:image\/png;base64,/);
    assert.ok(electron.decoded.includes(PNG_MAGIC.toString("hex")), "the PNG rep was what got decoded");
    assert.equal(electron.iconAsks.includes(named), false, "the generic OS placeholder was never needed");
  },
);

test(
  "a bundle with no readable icon falls back to the OS's icon for it",
  { skip: process.platform !== "darwin" && "reads bundles with macOS's own plutil and sips" },
  async () => {
    const noPlist = bundle("NoPlist", undefined);
    const noPng = bundle("NoPng", plistNaming("AppIcon"), icns([["it32", Buffer.from("legacy rep only")]]));
    const emptyName = bundle("EmptyName", plistNaming(""));
    electron.icons[noPlist] = "generic";
    electron.icons[noPng] = "generic-too";
    const v = await withIcons(
      view([
        { id: "a", via: "app", location: noPlist },
        { id: "b", via: "app", location: noPng },
        { id: "c", via: "app", location: emptyName },
      ]),
    );
    assert.equal(v.editors[0].icon, `data:image/png;base64,${Buffer.from("generic").toString("base64")}`);
    assert.equal(v.editors[1].icon, `data:image/png;base64,${Buffer.from("generic-too").toString("base64")}`);
    assert.equal(v.editors[2].icon, undefined, "no icon anywhere: the glyph stands in");
    assert.ok(electron.iconAsks.includes(noPng), "sips could not decode it either, so the OS was asked");
  },
);

// ── launching ──────────────────────────────────────────────────────────────

const node = `"${process.execPath}"`;

/** Wait for a condition, with a generous cap — never a fixed sleep. */
async function until(cond: () => boolean, what: string, capMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > capMs) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("a custom editor command is launched with the folder substituted for {path}", async () => {
  const marker = join(dir, "launched.txt");
  const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, process.argv[1])`;
  const prefs = {
    hidden: [],
    custom: [{ id: "custom-1", name: "Mine", command: `${node} -e "${script.replace(/"/g, "'")}" {path}` }],
  };
  const res = await openEditor("custom-1", dir, prefs);
  assert.deepEqual(res, { ok: true });
  await until(() => existsSync(marker) && readFileSync(marker, "utf8").length > 0, "the editor to start");
  assert.equal(readFileSync(marker, "utf8"), dir, "it was handed the repository folder");
});

test("a custom editor whose program is not there reports that it could not launch", async () => {
  const prefs = { hidden: [], custom: [{ id: "c", name: "Ghost", command: join(dir, "no-such-editor-binary") }] };
  const res = await openEditor("c", dir, prefs);
  assert.equal(res.ok, false);
  assert.equal(res.expected, undefined, "we found it in Settings and could not start it: that is news");
  assert.match(res.message ?? "", /^Couldn't launch it: /);
});

test("a launch the OS refuses outright is answered, not thrown", async () => {
  // A NUL cannot be in an argument: spawn throws before any process exists.
  const prefs = { hidden: [], custom: [{ id: "c", name: "Mine", command: `${node} {path}` }] };
  const res = await openEditor("c", "bad\0folder", prefs);
  assert.equal(res.ok, false);
  assert.match(res.message ?? "", /null bytes|\\0|string without null/i);
});

test("an editor that is no longer installed is an expected state with a pointer to Settings", async () => {
  const res = await openEditor("an-editor-no-machine-has", dir, { hidden: [], custom: [] });
  assert.deepEqual(res, {
    ok: false,
    expected: true,
    message: "That editor isn't installed any more — check Settings ▸ Editors.",
  });
});

test("the editor view lists a custom editor, hidden or not, and defaults to the first shown", () => {
  const v = editorsView({
    hidden: ["mine-hidden"],
    custom: [
      { id: "mine-hidden", name: "Hidden", command: "hidden {path}" },
      { id: "mine", name: "Mine", command: "mine" },
    ],
    defaultId: "mine-hidden",
  });
  const hidden = v.editors.find((e) => e.id === "mine-hidden");
  const mine = v.editors.find((e) => e.id === "mine");
  assert.equal(hidden?.shown, false);
  assert.equal(hidden?.isDefault, false, "a hidden editor cannot be the default");
  assert.equal(mine?.via, "custom");
  assert.equal(mine?.location, "mine");
  assert.ok(v.defaultId, "something shown is the default");
  assert.notEqual(v.defaultId, "mine-hidden");
});

test("Reveal shows the repository folder in the file manager", () => {
  revealRoot(dir);
  assert.deepEqual(electron.shown, [dir]);
});
