// Agent Access writes the app's OWN executable path into a client's MCP config
// (see mcpLaunch). Two ways that path stops existing:
//
//   · Gatekeeper App Translocation. A downloaded, quarantined app opened from
//     where it was unpacked (Downloads, the mounted DMG) runs from a random
//     read-only mount under /private/var/folders/…/AppTranslocation/…, which
//     disappears when the app quits. A config naming it works until then, and
//     the agent then fails to start with nothing on screen to say why. The app
//     now refuses to write that path, and says what to do: move GitStudio to
//     Applications and open it from there.
//   · The app was moved (or reinstalled elsewhere) after Add. The client's
//     config still names the old path. The card now notices the configured
//     command or server no longer exists, and offers Re-add.

import "./hermeticGit";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installMcp, isOnDiskImage, isTranslocated, mcpInfo, type McpRuntime } from "../src/main/mcpConfig";
import { reportableResultMessage } from "../src/main/expectedError";
import { removeTempRepo } from "./tmpRepo";

const scratch = mkdtempSync(join(tmpdir(), "gs-mcp-transloc-"));
after(() => removeTempRepo(scratch));

function touch(p: string, body = "// file\n"): string {
  mkdirSync(resolve(p, ".."), { recursive: true });
  writeFileSync(p, body);
  return p;
}

/** A packaged layout whose executable and server both exist, under `base`. */
function packagedAt(base: string): McpRuntime {
  const exe = touch(join(base, "GitStudio.app", "Contents", "MacOS", "GitStudio"));
  const res = join(base, "GitStudio.app", "Contents", "Resources");
  touch(join(res, "mcp", "gitstudio-mcp.js"));
  return {
    packaged: true,
    execPath: exe,
    resourcesPath: res,
    mainDir: join(res, "app.asar", "dist", "main"),
    userData: join(scratch, "userData"),
  };
}

function pointHomeAt(home: string): () => void {
  const keys = ["HOME", "USERPROFILE", "APPDATA"] as const;
  const saved = keys.map((k) => process.env[k]);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = join(home, "AppData", "Roaming");
  return () =>
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k];
      else process.env[k] = saved[i];
    });
}

const TRANSLOCATED =
  "/private/var/folders/xy/abc123/T/AppTranslocation/0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0/d/GitStudio.app/Contents/MacOS/GitStudio";

test("a translocated executable is recognised by its path, and nothing else is", () => {
  assert.equal(isTranslocated(TRANSLOCATED), true);
  assert.equal(isTranslocated("/Applications/GitStudio.app/Contents/MacOS/GitStudio"), false);
  assert.equal(isTranslocated("/Users/someone/Downloads/GitStudio.app/Contents/MacOS/GitStudio"), false);
});

test("Add refuses to write a translocated path, says why and what to do, and files nothing", () => {
  const home = join(scratch, "home-refuse");
  const restore = pointHomeAt(home);
  try {
    const rt = { ...packagedAt(join(scratch, "refuse")), execPath: TRANSLOCATED };
    const r = installMcp(undefined, { client: "cursor", write: false, destructive: false }, rt);
    assert.equal(r.ok, false);
    assert.equal(r.expected, true, "the user's state, not our defect");
    assert.equal(reportableResultMessage(r), undefined);
    assert.match(r.message, /Applications/);
    assert.match(r.message, /temporary|disappears|goes away/i);
    let wrote = true;
    try {
      readFileSync(join(home, ".cursor", "mcp.json"), "utf8");
    } catch {
      wrote = false;
    }
    assert.equal(wrote, false, "no config written that names a vanishing path");

    const info = mcpInfo(undefined, rt);
    assert.equal(info.available, false, "the card does not offer an Add that would be refused");
    assert.match(info.missing ?? "", /Applications/);
  } finally {
    restore();
  }
});

// The same vanishing path by another road: an app that was never quarantined
// (fetched with curl, or with the attribute cleared) is not translocated when
// it is opened from its disk image — it runs straight from
// /Volumes/<image>/GitStudio.app, and that path is gone the moment the image
// is ejected. A disk image puts the app at the ROOT of its volume; an app
// installed into an Applications folder on another drive is where its owner
// chose to keep it, and is left alone.
const ON_DISK_IMAGE = "/Volumes/GitStudio 2.0.1-arm64/GitStudio.app/Contents/MacOS/GitStudio";

test("an app run straight from a mounted disk image is recognised by its path", () => {
  assert.equal(isOnDiskImage(ON_DISK_IMAGE), true);
  assert.equal(isOnDiskImage("/Volumes/GitStudio/GitStudio.app/Contents/MacOS/GitStudio"), true);
  assert.equal(isOnDiskImage("/Applications/GitStudio.app/Contents/MacOS/GitStudio"), false);
  assert.equal(
    isOnDiskImage("/Volumes/Work SSD/Applications/GitStudio.app/Contents/MacOS/GitStudio"),
    false,
    "installed on another drive, in its Applications folder",
  );
  assert.equal(isOnDiskImage(TRANSLOCATED), false, "translocation has its own sentence");
  assert.equal(isOnDiskImage("C:\\Users\\someone\\AppData\\Local\\Programs\\GitStudio\\GitStudio.exe"), false);
});

test("Add refuses to write a disk-image path, says move GitStudio to Applications first, and files nothing", () => {
  const home = join(scratch, "home-dmg");
  const restore = pointHomeAt(home);
  try {
    const rt = { ...packagedAt(join(scratch, "dmg")), execPath: ON_DISK_IMAGE };
    const r = installMcp(undefined, { client: "cursor", write: false, destructive: false }, rt);
    assert.equal(r.ok, false);
    assert.equal(r.expected, true, "where the app runs from is the user's state, not our defect");
    assert.equal(reportableResultMessage(r), undefined);
    assert.match(r.message, /move GitStudio to Applications first/i);
    assert.match(r.message, /eject/i, "and why: the path goes away with the disk image");
    let wrote = true;
    try {
      readFileSync(join(home, ".cursor", "mcp.json"), "utf8");
    } catch {
      wrote = false;
    }
    assert.equal(wrote, false, "no config written that names a path on a disk image");

    const info = mcpInfo(undefined, rt);
    assert.equal(info.available, false, "the card does not offer an Add that would be refused");
    assert.match(info.missing ?? "", /move GitStudio to Applications first/i);
  } finally {
    restore();
  }
});

test("a client set up with a GitStudio that has since moved is noticed, and offered Re-add", () => {
  const home = join(scratch, "home-moved");
  const restore = pointHomeAt(home);
  try {
    const before = packagedAt(join(scratch, "before"));
    const added = installMcp(undefined, { client: "cursor", write: false, destructive: false }, before);
    assert.equal(added.ok, true, added.message);
    const now = packagedAt(join(scratch, "after"));

    // Still where it was: nothing to say.
    let cursor = mcpInfo(undefined, before).clients.find((c) => c.id === "cursor");
    assert.equal(cursor?.installed, true);
    assert.ok(!cursor?.stale, "the configured paths exist");

    // Moved: the configured executable is gone.
    rmSync(join(scratch, "before"), { recursive: true, force: true });
    cursor = mcpInfo(undefined, now).clients.find((c) => c.id === "cursor");
    assert.equal(cursor?.installed, true, "still configured");
    assert.equal(cursor?.stale, true, "…but pointing at a GitStudio that is no longer there");
    assert.match(cursor?.staleReason ?? "", /no longer/i);

    // Re-add writes the current path, and the card is quiet again.
    const readded = installMcp(undefined, { client: "cursor", write: false, destructive: false }, now);
    assert.equal(readded.ok, true, readded.message);
    cursor = mcpInfo(undefined, now).clients.find((c) => c.id === "cursor");
    assert.ok(!cursor?.stale);
  } finally {
    restore();
  }
});
