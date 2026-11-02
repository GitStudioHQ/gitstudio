import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { AppSettings } from "../src/main/appSettings";

// The settings store behind Settings → Repositories: defaults, persistence,
// the null-reset contract, and the "~"-shortened display path.

// A POSIX home, joined with POSIX rules. `join` is the HOST's, so on a Windows
// runner it turned "/Users/someone" + "GitStudio" into "\\Users\\someone\\GitStudio",
// which no longer starts with the home this test declared — and the `~` display
// this file exists to check had nothing to match against.
const HOME = "/Users/someone";
const DEF = posix.join(HOME, "GitStudio");

function dir(): string {
  return mkdtempSync(join(tmpdir(), "gitstudio-settings-"));
}

test("fresh store serves the defaults", async () => {
  const s = await AppSettings.load(dir(), { defaultCloneDir: DEF, home: HOME });
  assert.equal(s.effectiveCloneDir(), DEF);
  assert.equal(s.askWhereEveryTime(), false);
  const v = s.view();
  assert.equal(v.cloneDir, DEF);
  assert.equal(v.cloneDirDisplay, "~/GitStudio");
  assert.equal(v.cloneDirIsDefault, true);
});

test("update persists and reloads", async () => {
  const d = dir();
  const s = await AppSettings.load(d, { defaultCloneDir: DEF, home: HOME });
  await s.update({ cloneDir: "/Volumes/Work/src", askWhereEveryTime: true });
  const s2 = await AppSettings.load(d, { defaultCloneDir: DEF, home: HOME });
  assert.equal(s2.effectiveCloneDir(), "/Volumes/Work/src");
  assert.equal(s2.askWhereEveryTime(), true);
  // Outside home → shown verbatim, flagged non-default.
  const v = s2.view();
  assert.equal(v.cloneDirDisplay, "/Volumes/Work/src");
  assert.equal(v.cloneDirIsDefault, false);
});

test("cloneDir: null resets to the default", async () => {
  const d = dir();
  const s = await AppSettings.load(d, { defaultCloneDir: DEF, home: HOME });
  await s.update({ cloneDir: "/elsewhere" });
  const v = await s.update({ cloneDir: null });
  assert.equal(v.cloneDir, DEF);
  assert.equal(v.cloneDirIsDefault, true);
  // And the reset survives a reload.
  const s2 = await AppSettings.load(d, { defaultCloneDir: DEF, home: HOME });
  assert.equal(s2.effectiveCloneDir(), DEF);
});

test("a home-relative custom dir displays with ~", async () => {
  const s = await AppSettings.load(dir(), { defaultCloneDir: DEF, home: HOME });
  const v = await s.update({ cloneDir: posix.join(HOME, "Code") });
  assert.equal(v.cloneDirDisplay, "~/Code");
});

test("malformed JSON on disk starts fresh instead of crashing", async () => {
  const d = dir();
  writeFileSync(join(d, "app-settings.json"), "{not json", "utf8");
  const s = await AppSettings.load(d, { defaultCloneDir: DEF, home: HOME });
  assert.equal(s.effectiveCloneDir(), DEF);
});

test("junk-typed fields in the file are ignored", async () => {
  const d = dir();
  writeFileSync(
    join(d, "app-settings.json"),
    JSON.stringify({ cloneDir: 42, askWhereEveryTime: "yes" }),
    "utf8",
  );
  const s = await AppSettings.load(d, { defaultCloneDir: DEF, home: HOME });
  assert.equal(s.effectiveCloneDir(), DEF);
  assert.equal(s.askWhereEveryTime(), false);
});

test("the file on disk is the two persisted fields, nothing else", async () => {
  const d = dir();
  const s = await AppSettings.load(d, { defaultCloneDir: DEF, home: HOME });
  await s.update({ cloneDir: "/x", askWhereEveryTime: true });
  const raw = JSON.parse(readFileSync(join(d, "app-settings.json"), "utf8"));
  assert.deepEqual(raw, { cloneDir: "/x", askWhereEveryTime: true });
});


test("editor font size defaults, persists, and resets independently of clone preferences", async () => {
  const d = dir();
  const options = { defaultCloneDir: DEF, home: HOME };
  const s = await AppSettings.load(d, options);
  assert.equal(s.view().editorFontSize, 12.5);
  await s.update({ editorFontSize: 18 });
  const reloaded = await AppSettings.load(d, options);
  assert.equal(reloaded.view().editorFontSize, 18);
  await reloaded.update({ cloneDir: "/work" });
  assert.equal(reloaded.view().editorFontSize, 18);
  await reloaded.update({ editorFontSize: 12.5 });
  assert.equal((await AppSettings.load(d, options)).view().editorFontSize, 12.5);
});

test("invalid editor font sizes are ignored on update and load", async () => {
  for (const value of [0, -1, 5, 73, NaN, Infinity, "18", null]) {
    const d = dir();
    const options = { defaultCloneDir: DEF, home: HOME };
    const s = await AppSettings.load(d, options);
    await s.update({ editorFontSize: 18 });
    await s.update({ editorFontSize: value as number });
    assert.equal(s.view().editorFontSize, 18);
    writeFileSync(join(d, "app-settings.json"), JSON.stringify({ editorFontSize: value }));
    assert.equal((await AppSettings.load(d, options)).view().editorFontSize, 12.5);
  }
});
