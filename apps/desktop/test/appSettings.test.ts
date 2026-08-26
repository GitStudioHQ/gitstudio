import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppSettings } from "../src/main/appSettings";

// The settings store behind Settings → Repositories: defaults, persistence,
// the null-reset contract, and the "~"-shortened display path.

const HOME = "/Users/someone";
const DEF = join(HOME, "GitStudio");

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
  const v = await s.update({ cloneDir: join(HOME, "Code") });
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
