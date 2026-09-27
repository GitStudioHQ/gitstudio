// What the Changes view's host sends the page about stashes, against real git.
//
// Every state post — the onDidChange firehose sends several a second while
// files are saved — carried every stash's full file list. One `git stash -u`
// over an unignored dependency folder made a stash of thousands of files, and
// each post then carried hundreds of KB for a stash nobody had opened.
//
// Now a row carries its file COUNT; its files ride along only while the
// stashes' files together stay small (STASH_INLINE_FILES, newest first), and
// the page asks for the rest when it opens one ("stashReadFiles" →
// "stashFilesRead"). A stash never changes, so the page keeps what it read.
//
// The cells:
//   rows     small stashes (files inline) · one too big for the budget
//            (a count only) · the budget spent by newer ones
//   read     a listed stash · a sha that is not a stash's · not a sha at all

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changesHost, scratchRepo } from "./changesHost";
import { STASH_INLINE_FILES, stashRows } from "../src/changes/stashRows";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((f) => f()));

interface Row {
  sha: string;
  text: string;
  count: number;
  files?: { path: string }[];
}

test("rows: a count always; the files only while they stay few — a stash of 450 files sends none of them", async () => {
  const repo = scratchRepo("stash-payload");
  cleanups.push(repo.done);
  writeFileSync(join(repo.dir, "a.ts"), "base\n");
  repo.git("add", ".");
  repo.git("commit", "-qm", "base");
  // The oldest: an accident — a dependency folder stashed with -u.
  mkdirSync(join(repo.dir, "deps"));
  for (let i = 0; i < 450; i++) writeFileSync(join(repo.dir, "deps", `f${i}.js`), `${i}\n`);
  repo.git("stash", "push", "-q", "-u", "-m", "oops, deps too");
  // The newest: an ordinary one.
  writeFileSync(join(repo.dir, "a.ts"), "edited\n");
  repo.git("stash", "push", "-q", "-m", "small");
  const [small, big] = repo.git("stash", "list", "--format=%H").trim().split("\n");

  const host = changesHost(repo.dir);
  cleanups.push(host.dispose);
  await host.idle();
  host.posted.length = 0;
  await host.send({ type: "ready" });
  await host.idle();
  const withRows = host.posted.filter((m) => m.type === "state" && Array.isArray(m.stashes));
  assert.ok(withRows.length > 0, "a post carried the list");
  const rows = withRows.at(-1)!.stashes as Row[];
  assert.deepEqual(
    rows.map((r) => [r.sha, r.text, r.count, r.files ? r.files.length : "not carried"]),
    [
      [small, "small", 1, 1],
      [big, "oops, deps too", 450, "not carried"],
    ],
  );
  assert.ok(JSON.stringify(rows).length < 2000, `the list is small: ${JSON.stringify(rows).length} bytes`);

  // The page opens the big one: its files, on request.
  host.posted.length = 0;
  await host.send({ type: "stashReadFiles", sha: big });
  const read = host.posted.filter((m) => m.type === "stashFilesRead");
  assert.equal(read.length, 1);
  assert.equal(read[0].sha, big);
  const files = read[0].files as { path: string; status: string }[];
  assert.equal(files.length, 450);
  assert.deepEqual(files[0], { path: "deps/f0.js", status: "U" });

  // Not a stash, or not a sha at all: nothing to read, and it says so.
  for (const sha of ["f".repeat(40), "--output=/tmp/x", ""]) {
    host.posted.length = 0;
    await host.send({ type: "stashReadFiles", sha });
    assert.deepEqual(
      host.posted.filter((m) => m.type === "stashFilesRead"),
      [{ type: "stashFilesRead", sha, files: null }],
      `for ${JSON.stringify(sha)}`,
    );
  }
});

test("stashRows: the newest stashes' files ride along until the budget is spent; every row keeps its count", () => {
  const entry = (n: number) => ({ sha: String(n).repeat(40).slice(0, 40), ref: `stash@{${n}}`, message: `On main: s${n}`, time: 1000 - n });
  const files = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `f${i}`, status: "M" as const }));
  const half = Math.floor(STASH_INLINE_FILES / 2);
  const rows = stashRows(
    [entry(1), entry(2), entry(3), entry(4), entry(5)],
    [files(half), files(STASH_INLINE_FILES + 1), files(STASH_INLINE_FILES - half), files(1), undefined],
  );
  assert.deepEqual(
    rows.map((r) => [r.text, r.count, r.files ? r.files.length : "-"]),
    [
      ["s1", half, half],
      ["s2", STASH_INLINE_FILES + 1, "-"],
      ["s3", STASH_INLINE_FILES - half, STASH_INLINE_FILES - half],
      ["s4", 1, "-"],
      // Unreadable: nothing to count, and nothing to carry.
      ["s5", 0, 0],
    ],
  );
  // Each row's age is the host's one formatter's ("3h", "2d"), as the
  // Commits list and the push review say it — the page has none of its own.
  const aged = stashRows([entry(1), entry(2)], [files(1), files(1)], 999 + 2 * 3600);
  assert.deepEqual(aged.map((r) => r.rel), ["2h", "2h"]);
  assert.equal(stashRows([entry(1)], [files(1)], 999 + 40 * 86400)[0]?.rel, "1mo");
});
