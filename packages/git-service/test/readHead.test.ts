import { test } from "node:test";
import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, ftruncateSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHead } from "../src/OperationProvider";
import { removeTempRepo } from "./tmpRepo";

// The stash probe (OperationProvider.hasStashMarkers) looks for git's stash
// markers at the top of up to 50 unmerged files on every opState refresh. It
// promised to read STASH_PROBE_BYTES of each and read the WHOLE file instead,
// then sliced — binaries and all, every refresh.

test("readHead reads only the head of a file — a 3 GiB file still answers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-readhead-"));
  try {
    const p = join(dir, "huge.bin");
    // Sparse: 3 GiB of size and a few bytes of disk. A whole-file read refuses
    // anything past 2 GiB (ERR_FS_FILE_TOO_LARGE), so only a bounded read of
    // the head can answer at all.
    const fd = openSync(p, "w");
    writeSync(fd, "<<<<<<< Updated upstream\n");
    ftruncateSync(fd, 3 * 1024 ** 3);
    closeSync(fd);
    const head = await readHead(p, 64);
    assert.ok(head !== undefined, "the head of a huge file is readable");
    assert.ok(head!.startsWith("<<<<<<< Updated upstream\n"));
    assert.equal(Buffer.byteLength(head!.replace(/\0+$/, "")), "<<<<<<< Updated upstream\n".length);
  } finally {
    removeTempRepo(dir);
  }
});

test("readHead: a short file comes back whole, a missing one is undefined", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-readhead-"));
  try {
    const p = join(dir, "short.txt");
    const fd = openSync(p, "w");
    writeSync(fd, "abc\n");
    closeSync(fd);
    assert.equal(await readHead(p, 1024), "abc\n");
    assert.equal(await readHead(p, 2), "ab");
    assert.equal(await readHead(join(dir, "nope"), 10), undefined);
  } finally {
    removeTempRepo(dir);
  }
});
